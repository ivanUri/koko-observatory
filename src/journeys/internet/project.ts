import type { TelemetryEvent } from "../../core/types.ts";
import { isMeasuredEvent } from "../../core/metrics.ts";
import { cacheHeaderSummary, connectionReuse, headerEntries, observedConnectionId, resolveTransferSizes } from "../../core/network-metrics.ts";
import { lockDocumentRequest, matchesLockedDocument } from "../../core/document-transfer.ts";
import type { JourneyDetail, JourneyMeasurement, JourneyNode, JourneyStatus } from "./types.ts";

export interface OtherTransfer {
  requestId: string;
  url?: string;
  resourceType?: string;
  protocol?: string;
}

export interface InspectionProjection {
  nodes: JourneyNode[];
  navigationRequestId?: string;
  executionId?: string;
  otherTransfers: OtherTransfer[];
  phase: "idle" | "running" | "received" | "error";
  activeUrl?: string;
}

export interface InternetJourneyAssessment {
  state: "incomplete" | "healthy" | "attention";
  headline: string;
  summary: string;
  stage?: string;
  value?: string;
  evidenceId?: string;
}

// These are explicit diagnostic budgets for the top-level document only. They
// are not claims about a site's ideal performance or about third-party work.
const internetStageBudgets: Record<string, number> = {
  dns: 200,
  tcp: 200,
  tls: 300,
  server: 500,
  response: 1_000,
};

interface ApplyResult {
  navigationRequestId?: string;
  activeUrl?: string;
  otherTransfer?: OtherTransfer;
}

/** Prefer the inspection id. Session id is only a fallback when no event carries one. */
export function inspectionKey(event: TelemetryEvent) {
  const payload = event.payload;
  for (const key of ["inspectionId", "executionId", "execution_id"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function eventsForLatestInspection(events: TelemetryEvent[]) {
  const keyed = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    const key = inspectionKey(event);
    if (!key) continue;
    const group = keyed.get(key);
    if (group) group.push(event);
    else keyed.set(key, [event]);
  }
  if (keyed.size) return selectLatest(keyed);
  const sessions = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const group = sessions.get(event.sessionId);
    if (group) group.push(event);
    else sessions.set(event.sessionId, [event]);
  }
  if (!sessions.size) return { events, executionId: undefined as string | undefined };
  return selectLatest(sessions);
}

export function cloneJourneyNodes(nodes: JourneyNode[]): JourneyNode[] {
  return nodes.map((node) => ({
    ...node,
    metadata: {
      ...node.metadata,
      summary: node.metadata.summary.map((item) => ({ ...item })),
      issues: [...node.metadata.issues],
      practices: [...node.metadata.practices],
    },
  }));
}

/**
 * Summarize only the top-level document transport represented by Internet
 * Journey nodes. Browser/runtime evidence is intentionally left to the next
 * journey so this result cannot accidentally claim a cross-layer root cause.
 */
export function assessInternetJourney(nodes: JourneyNode[]): InternetJourneyAssessment {
  const received = nodes.find((node) => node.id === "received");
  const measured = ["dns", "tcp", "tls", "server", "response"].flatMap((id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node && node.status === "complete" && node.metadata.measurement === "measured" ? [node] : [];
  });
  const failed = nodes.find((node) => node.status === "error");
  if (failed) {
    return {
      state: "attention",
      headline: `${failed.title} failed`,
      summary: failed.metadata.explanation,
      stage: failed.id,
      evidenceId: evidenceIdOf(failed),
    };
  }
  if (received?.status === "complete") {
    const status = Number(summaryValue(nodes.find((node) => node.id === "response"), "Status"));
    if (Number.isFinite(status) && status >= 400) {
      const response = nodes.find((node) => node.id === "response");
      return {
        state: "attention",
        headline: `Document returned HTTP ${status}`,
        summary: `The top-level document completed with HTTP ${status}. Open the response evidence for the server's status and headers.`,
        stage: "response",
        value: String(status),
        evidenceId: evidenceIdOf(response),
      };
    }
  }
  if (!measured.length) {
    return {
      state: "incomplete",
      headline: "Waiting for document transport evidence",
      summary: "Internet Journey has not received enough measured top-level stages to assess the document request.",
    };
  }
  const slow = measured
    .filter((node) => (internetStageBudgets[node.id] ?? Infinity) <= node.duration)
    .sort((left, right) => right.duration - left.duration)[0];
  if (slow) {
    return {
      state: "attention",
      headline: `Slow ${slow.title} stage observed`,
      summary: `${slow.title} took ${slow.duration.toFixed(3)} ms for the top-level document. This is a transport bottleneck candidate; Browser Journey is needed to assess later rendering work.`,
      stage: slow.id,
      value: `${slow.duration.toFixed(3)} ms`,
      evidenceId: evidenceIdOf(slow),
    };
  }
  return {
    state: "healthy",
    headline: "Document transport within diagnostic budgets",
    summary: "DNS, connection, TLS, server and response stages were measured without a covered threshold breach.",
  };
}

/** Duration label for a stage that happened and was empty, rather than a missing measurement. */
export function absentStageLabel(model: JourneyNode) {
  if (model.id === "redirect" && summaryValue(model, "Redirect count") === "0") return "No redirect";
  if (model.id === "proxy" && summaryValue(model, "Used") === "No") return "No proxy";
  return undefined;
}

export function mergeOtherTransfers(current: readonly OtherTransfer[], next: OtherTransfer | undefined) {
  if (!next) return current;
  const index = current.findIndex((item) => item.requestId === next.requestId);
  if (index < 0) return [...current, next];
  const previous = current[index];
  const merged: OtherTransfer = {
    requestId: next.requestId,
    url: next.url ?? previous.url,
    resourceType: next.resourceType ?? previous.resourceType,
    protocol: next.protocol ?? previous.protocol,
  };
  return current.map((item, itemIndex) => itemIndex === index ? merged : item);
}

/**
 * Write one network event onto a cloned journey.
 * Subresources keep their own request id and never overwrite the locked document's DNS, TCP, or TLS nodes.
 */
export function applyNetworkEvent(
  nodes: JourneyNode[],
  event: TelemetryEvent,
  navigationRequestId: string | undefined,
  activeUrl: string | undefined,
  durationMs: number,
): ApplyResult {
  if (event.kind !== "network") return { navigationRequestId, activeUrl };
  const payload = event.payload;
  const locked = lockDocumentRequest(payload, navigationRequestId);
  if (!matchesLockedDocument(payload, locked)) {
    return { navigationRequestId: locked, activeUrl, otherTransfer: otherTransfer(payload) };
  }
  const nextUrl = typeof payload.url === "string" ? payload.url : activeUrl;
  const stage = typeof payload.journeyStage === "string" ? payload.journeyStage : undefined;
  const node = stage ? nodes.find((candidate) => candidate.id === stage) : undefined;
  if (!node) return { navigationRequestId: locked, activeUrl: nextUrl };
  if (typeof payload.url === "string") fillUrlNodes(nodes, payload.url);
  node.duration = durationMs;
  node.timestamp = event.timestamp;
  node.metadata.estimated = false;
  node.metadata.measurement = measurementOf(event);
  node.status = stageStatus(event, node.metadata.measurement);
  node.metadata.raw = JSON.stringify({ event, measurement: node.metadata.measurement }, null, 2);
  const measured = node.metadata.measurement === "measured" ? `${event.duration.toFixed(3)} ms` : "Unavailable";
  const isHttp3 = payload.httpVersion === "h3";
  if (stage === "tcp" && isHttp3) {
    node.title = "QUIC transport";
    node.description = "HTTP/3 uses QUIC over UDP instead of TCP.";
  }
  if (stage === "tls" && isHttp3) {
    node.title = "QUIC crypto handshake";
    node.description = "TLS 1.3 key establishment is integrated into the QUIC handshake.";
  }
  if (stage === "dns") node.metadata.summary = [
    { label: "Lookup time", value: measured },
    { label: typeof payload.primaryIp === "string" && payload.primaryIp.includes(":") ? "AAAA" : "A", value: typeof payload.primaryIp === "string" ? payload.primaryIp : "Unavailable" },
    { label: "TTL", value: "Not exposed by libcurl" },
    { label: "CNAME", value: "Not exposed by libcurl" },
  ];
  if (stage === "queue") node.metadata.summary = [
    { label: "Queue time", value: measured },
    { label: "Measurement", value: "libcurl scheduler queue" },
  ];
  if (stage === "cache") node.metadata.summary = cacheSummary(payload);
  if (stage === "routing") node.metadata.summary = [
    { label: "Route hops", value: "Unavailable without traceroute" },
    { label: "Scope", value: "Not exposed by libcurl" },
  ];
  if (stage === "proxy") node.metadata.summary = proxySummary(payload);
  if (stage === "tcp") node.metadata.summary = tcpSummary(payload, measured, isHttp3);
  if (stage === "tls") node.metadata.summary = [
    { label: isHttp3 ? "QUIC crypto time" : "TLS handshake time", value: measured },
    { label: "Protocol", value: typeof payload.httpVersion === "string" ? payload.httpVersion : "Unavailable" },
    { label: "Certificate", value: "Not exposed by libcurl" },
  ];
  if (stage === "request") node.metadata.summary = [
    { label: "Preparation/send time", value: measured },
    { label: "Method", value: typeof payload.method === "string" ? payload.method : "Unavailable" },
    { label: "URL", value: typeof payload.url === "string" ? payload.url : "Unavailable" },
    { label: "Headers", value: headerBlock(payload.requestHeaders) },
  ];
  if (stage === "redirect") node.metadata.summary = redirectSummary(payload);
  if (stage === "server") node.metadata.summary = [
    { label: "Time to first byte", value: measured },
    { label: "Application", value: "Unavailable from browser" },
    { label: "Database", value: "Unavailable from browser" },
  ];
  if (stage === "response") node.metadata.summary = responseSummary(payload, measured);
  if (stage === "received") node.metadata.summary = [
    { label: "State", value: "Response received" },
    { label: "Boundary", value: "Continue to Browser Journey" },
  ];
  if (typeof payload.url === "string") node.metadata.summary = node.metadata.summary.map((item) => item.label === "URL" ? { ...item, value: payload.url as string } : item);
  if (typeof payload.responseStatus === "number") node.metadata.summary = node.metadata.summary.map((item) => item.label === "Status" ? { ...item, value: `${payload.responseStatus}` } : item);
  if (stage === "cache" && payload.responseStatus === 304) {
    node.metadata.summary = [...node.metadata.summary.filter((item) => item.label !== "Status"), { label: "Status", value: "Revalidated" }];
  }
  if (typeof payload.httpVersion === "string" && stage === "response") {
    node.metadata.summary = [...node.metadata.summary.filter((item) => item.label !== "HTTP version"), { label: "HTTP version", value: payload.httpVersion }];
  }
  explainAppliedStage(node);
  if (event.status === "error") failStage(nodes, node, event, payload, nextUrl);
  return { navigationRequestId: locked, activeUrl: nextUrl };
}

export function projectInspection(template: JourneyNode[], events: TelemetryEvent[]): InspectionProjection {
  const selected = eventsForLatestInspection(events);
  const nodes = cloneJourneyNodes(template);
  let navigationRequestId: string | undefined;
  let activeUrl: string | undefined;
  let otherTransfers: readonly OtherTransfer[] = [];
  const ordered = [...selected.events].sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp);
  for (const event of ordered) {
    const result = applyNetworkEvent(nodes, event, navigationRequestId, activeUrl, isMeasuredEvent(event) ? event.duration : 0);
    navigationRequestId = result.navigationRequestId;
    activeUrl = result.activeUrl;
    otherTransfers = mergeOtherTransfers(otherTransfers, result.otherTransfer);
  }
  return {
    nodes,
    navigationRequestId,
    executionId: selected.executionId,
    otherTransfers: [...otherTransfers],
    phase: journeyPhase(nodes, navigationRequestId),
    activeUrl,
  };
}

function selectLatest(groups: Map<string, TelemetryEvent[]>) {
  let executionId: string | undefined;
  let selected: TelemetryEvent[] = [];
  let bestTimestamp = -Infinity;
  let bestSequence = -Infinity;
  for (const [key, group] of groups) {
    let timestamp = -Infinity;
    let sequence = -Infinity;
    for (const event of group) {
      if (event.timestamp > timestamp || (event.timestamp === timestamp && event.sequence > sequence)) {
        timestamp = event.timestamp;
        sequence = event.sequence;
      }
    }
    if (timestamp > bestTimestamp || (timestamp === bestTimestamp && sequence >= bestSequence)) {
      bestTimestamp = timestamp;
      bestSequence = sequence;
      selected = group;
      executionId = key;
    }
  }
  return { events: selected, executionId };
}

function summaryValue(model: JourneyNode, label: string) {
  return model?.metadata.summary.find((item) => item.label === label)?.value;
}

function evidenceIdOf(model: JourneyNode | undefined) {
  if (!model?.metadata.raw) return undefined;
  try {
    const raw = JSON.parse(model.metadata.raw) as { event?: { id?: unknown } };
    return typeof raw.event?.id === "string" ? raw.event.id : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function headerBlock(raw: unknown) {
  const entries = headerEntries(text(raw));
  if (!entries.length) return "None captured";
  return entries.map(([name, value]) => `${name}: ${value}`).join("; ");
}

function otherTransfer(payload: Record<string, unknown>): OtherTransfer | undefined {
  if (payload.requestId == null) return undefined;
  return {
    requestId: String(payload.requestId),
    url: text(payload.url),
    resourceType: text(payload.resourceType),
    protocol: text(payload.httpVersion),
  };
}

function measurementOf(event: TelemetryEvent): JourneyMeasurement {
  const measurement = String(event.payload.measurementState ?? event.payload.measurement ?? "").toLowerCase();
  if (measurement === "boundary" || measurement === "reused" || measurement === "unavailable" || measurement === "not-timed") return measurement;
  if (measurement === "cached" || measurement === "derived" || measurement === "estimated" || measurement === "not-applicable" || measurement === "not-applicable-replay" || measurement === "below-resolution") {
    return measurement as JourneyMeasurement;
  }
  return isMeasuredEvent(event) ? "measured" : "unavailable";
}

function stageStatus(event: TelemetryEvent, measurement: JourneyMeasurement | undefined): JourneyStatus {
  if (event.status === "error") return "error";
  if ((event.status as string) === "skipped") return "skipped";
  return measurement === "unavailable" ? "unavailable" : "complete";
}

function fillUrlNodes(nodes: JourneyNode[], url: string) {
  try {
    const parsed = new URL(url);
    const input = nodes.find((candidate) => candidate.id === "url-input");
    const parsedNode = nodes.find((candidate) => candidate.id === "url-parse");
    if (input) {
      input.metadata.estimated = false;
      input.metadata.explanation = `The document URL is ${parsed.href}.`;
      input.metadata.issues = [];
      input.metadata.summary = [
        { label: "Protocol", value: parsed.protocol.replace(":", "") },
        { label: "Hostname", value: parsed.hostname },
        { label: "Port", value: parsed.port || (parsed.protocol === "https:" ? "443" : "80") },
        { label: "Path", value: parsed.pathname },
        { label: "Query", value: parsed.search.slice(1) || "—" },
        { label: "Fragment", value: parsed.hash.slice(1) || "—" },
      ];
    }
    if (parsedNode) {
      parsedNode.metadata.estimated = false;
      parsedNode.metadata.explanation = `Parsed origin is ${parsed.origin}.`;
      parsedNode.metadata.issues = [];
      parsedNode.metadata.summary = [{ label: "Absolute URL", value: "true" }, { label: "Origin", value: parsed.origin }];
    }
  } catch {
    // A transfer URL that is not absolute leaves the typed URL nodes unchanged.
  }
}

function cacheSummary(payload: Record<string, unknown>): JourneyDetail[] {
  const summary: JourneyDetail[] = [
    { label: "Koko cache decision", value: typeof payload.cacheDecision === "string" ? payload.cacheDecision : "Unavailable" },
    {
      label: "Cache headers",
      value: cacheHeaderSummary(text(payload.responseHeaders), {
        cacheControl: text(payload.cacheControl),
        age: text(payload.age),
        etag: text(payload.etag),
      }),
    },
  ];
  if (payload.responseStatus === 304) summary.push({ label: "Status", value: "Revalidated" });
  return summary;
}

function proxySummary(payload: Record<string, unknown>): JourneyDetail[] {
  const used = payload.usedProxy === true ? "Yes" : payload.usedProxy === false ? "No" : "Unavailable";
  const tunnel = payload.usedProxy === false ? "No proxy" : payload.usedProxy === true ? "Not exposed separately" : "Unavailable";
  return [
    { label: "Used", value: used },
    { label: "Tunnel timing", value: tunnel },
  ];
}

function redirectSummary(payload: Record<string, unknown>): JourneyDetail[] {
  const count = typeof payload.redirectCount === "number" ? payload.redirectCount : undefined;
  const perHop = count == null ? "Unavailable" : count === 0 ? "No redirect" : "Not captured per hop";
  return [
    { label: "Redirect count", value: count == null ? "Unavailable" : `${count}` },
    { label: "Per-hop timing", value: perHop },
  ];
}

function responseSummary(payload: Record<string, unknown>, measured: string): JourneyDetail[] {
  const sizes = resolveTransferSizes({
    transferredBytes: typeof payload.responseBodyBytes === "number" ? payload.responseBodyBytes : undefined,
    uncompressedBytes: typeof payload.uncompressedSizeBytes === "number" ? payload.uncompressedSizeBytes : undefined,
    responseMemoryState: text(payload.responseMemoryState),
    responseBody: text(payload.responseBody),
    bodyTruncated: payload.bodyTruncated === true,
    contentEncoding: text(payload.contentEncoding),
  });
  return [
    { label: "Transfer time", value: measured },
    { label: "Status", value: typeof payload.responseStatus === "number" ? `${payload.responseStatus}` : "Unavailable" },
    { label: "Transferred", value: sizes.transferredBytes == null ? "Unavailable" : `${sizes.transferredBytes} B` },
    { label: "Decoded body", value: sizes.decodedBytes == null ? "Unavailable" : `${sizes.decodedBytes} B` },
    { label: "HTTP version", value: typeof payload.httpVersion === "string" ? payload.httpVersion : "Unavailable" },
    { label: "Content-Type", value: typeof payload.contentType === "string" ? payload.contentType : "Not provided" },
    { label: "Content-Encoding", value: typeof payload.contentEncoding === "string" ? payload.contentEncoding : "Not provided" },
    { label: "Cache-Control", value: typeof payload.cacheControl === "string" ? payload.cacheControl : "Not provided" },
    { label: "Redirects", value: typeof payload.redirectCount === "number" ? `${payload.redirectCount}` : "0" },
    { label: "Server", value: typeof payload.server === "string" ? payload.server : "Not disclosed" },
    { label: "Via", value: typeof payload.via === "string" ? payload.via : "Not provided" },
    { label: "Age", value: typeof payload.age === "string" ? payload.age : "Not provided" },
    { label: "ETag", value: typeof payload.etag === "string" ? payload.etag : "Not provided" },
  ];
}

function failStage(nodes: JourneyNode[], node: JourneyNode, event: TelemetryEvent, payload: Record<string, unknown>, activeUrl: string | undefined) {
  const failedIndex = nodes.findIndex((candidate) => candidate.id === node.id);
  const payloadError = typeof payload.error === "string" ? payload.error
    : typeof payload.errorMessage === "string" ? payload.errorMessage
      : typeof payload.failureReason === "string" ? payload.failureReason : "Network operation failed";
  node.metadata.summary = [
    { label: "Failure", value: payloadError },
    { label: "Failure stage", value: node.title },
    { label: "URL", value: typeof payload.url === "string" ? payload.url : activeUrl ?? "Unavailable" },
    { label: "Timestamp", value: new Date(event.timestamp).toISOString() },
    ...node.metadata.summary.filter((item) => !["Failure", "Failure stage", "URL", "Timestamp"].includes(item.label)),
  ];
  node.metadata.explanation = `${node.description} The operation failed here, so later network stages were not reached.`;
  node.metadata.issues = [];
  node.metadata.practices = [];
  for (let index = failedIndex + 1; index < nodes.length; index += 1) {
    const skipped = nodes[index];
    skipped.status = "skipped";
    skipped.duration = 0;
    skipped.timestamp = 0;
    skipped.metadata.estimated = false;
    skipped.metadata.measurement = "unavailable";
    skipped.metadata.explanation = `Not reached: ${node.title} failed.`;
    skipped.metadata.issues = [];
    skipped.metadata.practices = [];
    skipped.metadata.summary = [{ label: "State", value: `Not reached: ${node.title} failed` }];
  }
}

const waterfallStages = ["queue", "dns", "tcp", "tls", "request", "server", "response"] as const;

/** One reading of the measured document bars. Redirects, proxies, and other transfers stay outside the total. */
export function waterfallReading(nodes: JourneyNode[]) {
  const measured = waterfallStages.flatMap((id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node && node.status === "complete" && node.metadata.measurement === "measured" && node.duration > 0 ? [node] : [];
  });
  if (!measured.length) return undefined;
  const total = measured.reduce((sum, node) => sum + node.duration, 0);
  const ordered = [...measured].sort((left, right) => right.duration - left.duration);
  const lead = ordered[0];
  const share = Math.round(lead.duration / total * 100);
  const next = ordered.slice(1, 3);
  const restSum = ordered.slice(3).reduce((sum, node) => sum + node.duration, 0);
  const nextText = next.length ? ` Next: ${next.map((node) => `${node.title} ${node.duration.toFixed(3)} ms`).join(", ")}.` : "";
  const restText = ordered.length > 3 ? ` The other measured stages sum to ${restSum.toFixed(3)} ms.` : "";
  return `${lead.title} is ${lead.duration.toFixed(3)} ms, ${share}% of the ${total.toFixed(3)} ms measured for this document.${nextText}${restText} Redirects, proxies, and other transfers are outside this total.`;
}

function tcpSummary(payload: Record<string, unknown>, measured: string, isHttp3: boolean): JourneyDetail[] {
  const reuse = connectionReuse(payload.connectionReused);
  const connects = typeof payload.numConnects === "number" && Number.isFinite(payload.numConnects) ? String(payload.numConnects) : "Unavailable";
  return [
    { label: isHttp3 ? "QUIC connect time" : "TCP connect time", value: measured },
    { label: "Remote IP", value: typeof payload.primaryIp === "string" ? payload.primaryIp : "Unavailable" },
    { label: "Connection reused", value: reuse === "yes" ? "Yes" : reuse === "no" ? "No" : "Unavailable" },
    { label: "Connects", value: connects },
    { label: "Connection", value: observedConnectionId(payload.connectionId) ?? "Unavailable" },
    { label: "Retransmissions", value: "Not exposed by libcurl" },
  ];
}

function explainAppliedStage(node: JourneyNode) {
  const value = (label: string) => summaryValue(node, label);
  const limits: string[] = [];
  let explanation = node.metadata.explanation;
  if (node.id === "queue") {
    explanation = `Queue time is ${value("Queue time") ?? "unavailable"}. This is libcurl's scheduler queue before the transfer started.`;
  }
  if (node.id === "dns") {
    const address = node.metadata.summary.find((item) => item.label === "A" || item.label === "AAAA");
    explanation = `Lookup time is ${value("Lookup time") ?? "unavailable"}. The result is ${address ? `${address.label} ${address.value}` : "unavailable"}.`;
    limits.push("TTL and CNAME are not exposed by libcurl.");
  }
  if (node.id === "routing") {
    explanation = "Individual route hops were not measured. libcurl does not expose a traceroute.";
  }
  if (node.id === "proxy") {
    const used = value("Used");
    explanation = used === "No"
      ? "This request did not use a proxy or CONNECT tunnel."
      : used === "Yes"
        ? "A proxy was used. Tunnel timing is not exposed separately."
        : "Proxy use was not reported.";
  }
  if (node.id === "tcp") {
    const timeLabel = node.metadata.summary.some((item) => item.label === "QUIC connect time") ? "QUIC connect time" : "TCP connect time";
    explanation = `${timeLabel} is ${value(timeLabel) ?? "unavailable"}, to ${value("Remote IP") ?? "an unavailable address"}. ${connectionSentence(value("Connection reused"), value("Connects"), value("Connection"))}`;
    limits.push("Retransmissions and the congestion window are not exposed by libcurl.");
  }
  if (node.id === "tls") {
    const quic = node.metadata.summary.some((item) => item.label === "QUIC crypto time");
    const timeLabel = quic ? "QUIC crypto time" : "TLS handshake time";
    explanation = `${timeLabel} is ${value(timeLabel) ?? "unavailable"}. Protocol ${value("Protocol") ?? "unavailable"} is the negotiated HTTP version, not a TLS version, cipher, or certificate issuer.`;
    node.description = quic
      ? "QUIC cryptographic handshake duration. The protocol field is the negotiated HTTP version."
      : "Handshake duration. The protocol field is the negotiated HTTP version.";
    limits.push("The certificate is not exposed by libcurl.");
  }
  if (node.id === "request") {
    explanation = `${value("Method") ?? "The request"} ${value("URL") ?? ""} took ${value("Preparation/send time") ?? "an unmeasured interval"} to prepare and send.`.replace(/\s+/g, " ").trim();
    limits.push("Cookie values are omitted from the captured headers.");
  }
  if (node.id === "redirect") {
    const count = value("Redirect count");
    explanation = count === "0"
      ? "Redirect count is 0. The response completed without a redirect."
      : count && count !== "Unavailable"
        ? `Redirect count is ${count}. Per-hop timing was not captured.`
        : "Redirect count was not reported.";
  }
  if (node.id === "cache") {
    const headers = value("Cache headers");
    explanation = `Koko cache decision is ${value("Koko cache decision") ?? "unavailable"}. That classification is separate from cache headers on the response.`;
    if (headers && headers !== "None captured") explanation += ` Captured cache headers: ${headers}.`;
    if (value("Status") === "Revalidated") explanation += " The response status is 304, so Koko classified it as revalidated.";
  }
  if (node.id === "server") {
    explanation = `Time to first byte is ${value("Time to first byte") ?? "unavailable"}. This is the wait after the request was sent until the first response byte.`;
    limits.push("Application and database time are not exposed.");
  }
  if (node.id === "response") {
    const encoding = value("Content-Encoding");
    explanation = `Transfer time is ${value("Transfer time") ?? "unavailable"}. ${value("Transferred") ?? "Unavailable"} on the wire, decoded body ${value("Decoded body") ?? "unavailable"}.`;
    if (encoding && encoding !== "Not provided" && encoding.toLowerCase() !== "identity") {
      explanation += ` Content-Encoding is ${encoding}, so the decoded size can differ from the wire size.`;
    }
  }
  if (node.id === "received") {
    explanation = "The document response has arrived. The stage times above are only this top-level document. Parsing continues in Browser Journey.";
  }
  node.metadata.explanation = explanation;
  node.metadata.issues = limits;
  node.metadata.practices = [];
}

function connectionSentence(reused: string | undefined, connects: string | undefined, id: string | undefined) {
  const connectsText = connects && connects !== "Unavailable" ? `connects ${connects}` : undefined;
  const idText = id && id !== "Unavailable" ? `connection ${id}` : undefined;
  const detail = [connectsText, idText].filter((item): item is string => item != null).join(", ");
  const suffix = detail ? ` (${detail})` : "";
  if (reused === "No") return `This document opened a new connection${suffix}.`;
  if (reused === "Yes") return id && id !== "Unavailable" ? `This document reused connection ${id}.` : "This document reused an existing connection.";
  return "Connection reuse was not reported.";
}

function journeyPhase(nodes: JourneyNode[], navigationRequestId: string | undefined): InspectionProjection["phase"] {
  if (nodes.some((node) => node.status === "error")) return "error";
  if (nodes.find((node) => node.id === "received")?.status === "complete") return "received";
  return navigationRequestId ? "running" : "idle";
}
