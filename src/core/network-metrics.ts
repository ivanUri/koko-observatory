import type { TelemetryEvent } from "./types";
import { isMeasuredEvent, utf8ByteLength } from "./metrics.ts";

export const networkStageOrder = ["queue", "cache", "dns", "routing", "proxy", "tcp", "tls", "request", "redirect", "server", "response", "received"] as const;

export interface NetworkTransfer {
  key: string;
  events: TelemetryEvent[];
  duration: number;
  url: string;
  executionId: string;
  sessionId: string;
  requestId?: string;
}

export function groupNetworkTransfers(events: TelemetryEvent[]): NetworkTransfer[] {
  const groups = new Map<string, TelemetryEvent[]>();
  const active = new Map<string, { key: string; seen: Set<string>; index: number }>();
  for (const event of [...events].filter((candidate) => candidate.kind === "network").sort((a, b) => a.sequence - b.sequence)) {
    const payload = event.payload;
    const execution = event.payload.executionId == null ? event.sessionId : String(event.payload.executionId);
    const url = String(payload.url ?? payload.requestedUrl ?? "URL unavailable");
    const requestId = payload.requestId == null ? undefined : String(payload.requestId);
    const base = requestId ? `${execution}|request:${requestId}` : `${execution}|url:${url}`;
    const stage = String(payload.journeyStage ?? event.name);
    const current = active.get(base);
    const startsTransfer = stage === "queue" || !current || current.seen.has(stage) || current.seen.has("received");
    const group = startsTransfer ? { key: `${base}|${(current?.index ?? -1) + 1}`, seen: new Set<string>(), index: (current?.index ?? -1) + 1 } : current;
    active.set(base, group);
    group.seen.add(stage);
    groups.set(group.key, [...(groups.get(group.key) ?? []), event]);
  }
  return [...groups].map(([key, grouped]) => {
    const ordered = [...grouped].sort((a, b) => {
      const left = networkStageOrder.indexOf(String(a.payload.journeyStage ?? a.name) as typeof networkStageOrder[number]);
      const right = networkStageOrder.indexOf(String(b.payload.journeyStage ?? b.name) as typeof networkStageOrder[number]);
      return left - right || a.sequence - b.sequence;
    });
    const terminal = ordered.at(-1)!;
    return {
      key,
      events: ordered,
      duration: ordered.reduce((sum, event) => sum + (isMeasuredEvent(event) ? event.duration : 0), 0),
      url: String(terminal.payload.url ?? terminal.payload.requestedUrl ?? "Unavailable"),
      executionId: terminal.payload.executionId == null ? terminal.sessionId : String(terminal.payload.executionId),
      sessionId: terminal.sessionId,
      requestId: terminal.payload.requestId == null ? undefined : String(terminal.payload.requestId),
    };
  });
}

const DECODED_BODY_STATES = new Set(["decoded_body", "fulfilled_from_replay"]);

export interface TransferSizes {
  transferredBytes?: number;
  decodedBytes?: number;
}

/** Wire bytes stay in `transferredBytes`. `decodedBytes` is the body after content decoding, when that length was actually observed. */
export function resolveTransferSizes(input: {
  transferredBytes?: number;
  uncompressedBytes?: number;
  responseMemoryState?: string;
  responseBody?: string;
  bodyTruncated?: boolean;
  contentEncoding?: string;
}): TransferSizes {
  const transferred = finiteNumber(input.transferredBytes);
  const uncompressed = finiteNumber(input.uncompressedBytes);
  const state = input.responseMemoryState;
  if (state != null && DECODED_BODY_STATES.has(state)) return { transferredBytes: transferred, decodedBytes: uncompressed };
  if (state === "body_not_retained") return { transferredBytes: transferred, decodedBytes: undefined };
  if (uncompressed != null && uncompressed !== transferred && state !== "estimated_from_transfer_size") {
    return { transferredBytes: transferred, decodedBytes: uncompressed };
  }
  // Older captures copied the wire size into uncompressedSizeBytes. A capture that was not truncated is the decoded text.
  if (input.responseBody && input.bodyTruncated !== true) {
    return { transferredBytes: transferred, decodedBytes: utf8ByteLength(input.responseBody) };
  }
  if (!contentEncodingCompressed(input.contentEncoding)) {
    return { transferredBytes: transferred, decodedBytes: uncompressed ?? transferred };
  }
  return { transferredBytes: transferred, decodedBytes: undefined };
}

export function httpStatusFailed(statusCode: number | undefined) {
  return statusCode != null && statusCode >= 400;
}

export function matchesNetworkType(typeFilter: string, request: { resourceType?: string; contentType?: string; url: string }) {
  if (typeFilter === "all") return true;
  const resourceType = (request.resourceType ?? "").toLowerCase();
  const contentType = (request.contentType ?? "").toLowerCase();
  if (typeFilter === "xhr") return resourceType === "xhr" || resourceType === "fetch" || contentType.includes("json") || contentType.includes("xml");
  if (typeFilter === "script") return resourceType === "script" || resourceType === "worker" || contentType.includes("javascript") || contentType.includes("script") || request.url.endsWith(".js");
  if (typeFilter === "doc") return resourceType === "document" || contentType.includes("html") || contentType.includes("text/plain");
  if (typeFilter === "css") return resourceType === "stylesheet" || contentType.includes("css");
  if (typeFilter === "media") return ["image", "media", "font"].includes(resourceType) || contentType.includes("image") || contentType.includes("video") || contentType.includes("audio") || contentType.includes("font");
  return true;
}

/** A negative connection id is libcurl's missing conn_id, not a connection. */
export function observedConnectionId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric >= 0 ? String(numeric) : undefined;
  return trimmed;
}

export function connectionReuse(value: unknown): "yes" | "no" | "unavailable" {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unavailable";
}

export function headerEntries(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  return raw.replaceAll("\\n", "\n").split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [];
    const name = line.slice(0, separator).trim();
    if (!name) return [];
    return [[name, line.slice(separator + 1).trim()] as [string, string]];
  });
}

/** Cache-related means the header name contains "cache", plus the stored freshness and validator fields Age and ETag. */
export function cacheHeaderSummary(responseHeaders: string | undefined, structured: { cacheControl?: string; age?: string; etag?: string }) {
  const matched = headerEntries(responseHeaders).filter(([name]) => isCacheRelatedHeader(name));
  if (matched.length) return matched.map(([name, value]) => `${name}: ${value}`).join("; ");
  const fallback = [
    structured.cacheControl ? `cache-control: ${structured.cacheControl}` : undefined,
    structured.age ? `age: ${structured.age}` : undefined,
    structured.etag ? `etag: ${structured.etag}` : undefined,
  ].filter((entry): entry is string => entry != null);
  return fallback.length ? fallback.join("; ") : "None captured";
}

export interface NetworkRequestSummary {
  key: string;
  events: TelemetryEvent[];
  sessionId: string;
  executionId: string;
  inspectionId: string;
  url: string;
  method: string;
  resourceType?: string;
  requestId?: number;
  frameId?: number;
  loaderId?: number;
  protocol: string;
  remoteIp: string;
  connectionId?: string;
  statusCode?: number;
  transferredBytes?: number;
  decodedBytes?: number;
  duration: number;
  terminalStatus: "ok" | "error";
  failed: boolean;
  transportFailed: boolean;
  httpError: boolean;
  connectionReused: "yes" | "no" | "unavailable";
  usedProxy: boolean;
  redirectCount?: number;
  contentType?: string;
  contentEncoding?: string;
  cacheDecision?: string;
  cacheHeaders: string;
  requestHeaders?: string;
  responseHeaders?: string;
  requestBody?: string;
  responseBody?: string;
  bodyTruncated: boolean;
  headers: { "Cache-Control"?: string; Server?: string; Age?: string; Via?: string; ETag?: string };
  failure?: string;
}

export function aggregateNetworkRequests(events: TelemetryEvent[]): NetworkRequestSummary[] {
  return groupNetworkTransfers(events).map(({ key, events: grouped, duration }) => {
    const ordered = [...grouped].sort((left, right) => stageIndex(left) - stageIndex(right) || left.sequence - right.sequence);
    const terminal = [...ordered].reverse().find((event) => event.payload.terminalStatus != null || event.payload.responseStatus != null) ?? ordered.at(-1)!;
    const payload = terminal.payload;
    const statusEvent = ordered.find((event) => event.status === "error");
    const statusCode = typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : undefined;
    const responseBody = transferField(ordered, "responseBody");
    const contentEncoding = payloadString(payload, "contentEncoding");
    const sizes = resolveTransferSizes({
      transferredBytes: latestPayloadNumber(ordered, "responseBodyBytes"),
      uncompressedBytes: latestPayloadNumber(ordered, "uncompressedSizeBytes"),
      responseMemoryState: latestPayloadString(ordered, "responseMemoryState"),
      responseBody,
      bodyTruncated: ordered.some((event) => event.payload.bodyTruncated === true),
      contentEncoding,
    });
    const transportFailed = statusEvent != null || payload.terminalStatus === "error";
    const httpError = httpStatusFailed(statusCode);
    return {
      key,
      events: ordered,
      sessionId: terminal.sessionId,
      executionId: executionIdOf(terminal),
      inspectionId: String(payload.inspectionId ?? "Unavailable"),
      url: String(payload.url ?? payload.requestedUrl ?? "Unavailable"),
      method: String(payload.method ?? "GET"),
      resourceType: payloadString(payload, "resourceType"),
      requestId: typeof payload.requestId === "number" ? payload.requestId : undefined,
      frameId: typeof payload.frameId === "number" ? payload.frameId : undefined,
      loaderId: typeof payload.loaderId === "number" ? payload.loaderId : undefined,
      protocol: String(payload.httpVersion ?? "Unavailable"),
      remoteIp: String(payload.primaryIp ?? "Unavailable"),
      connectionId: observedConnectionId(payload.connectionId),
      statusCode,
      transferredBytes: sizes.transferredBytes,
      decodedBytes: sizes.decodedBytes,
      duration,
      terminalStatus: transportFailed ? "error" : "ok",
      failed: transportFailed || httpError,
      transportFailed,
      httpError,
      connectionReused: connectionReuse(payload.connectionReused),
      usedProxy: payload.usedProxy === true,
      redirectCount: typeof payload.redirectCount === "number" ? payload.redirectCount : undefined,
      contentType: payloadString(payload, "contentType"),
      contentEncoding,
      cacheDecision: payloadString(payload, "cacheDecision"),
      cacheHeaders: cacheHeaderSummary(payloadString(payload, "responseHeaders"), {
        cacheControl: payloadString(payload, "cacheControl"),
        age: payloadString(payload, "age"),
        etag: payloadString(payload, "etag"),
      }),
      requestHeaders: payloadString(payload, "requestHeaders"),
      responseHeaders: payloadString(payload, "responseHeaders"),
      requestBody: transferField(ordered, "requestBody") ?? payloadString(payload, "postData"),
      responseBody,
      bodyTruncated: ordered.some((event) => event.payload.bodyTruncated === true),
      headers: {
        "Cache-Control": payloadString(payload, "cacheControl"),
        Server: payloadString(payload, "server"),
        Age: payloadString(payload, "age"),
        Via: payloadString(payload, "via"),
        ETag: payloadString(payload, "etag"),
      },
      failure: statusEvent ? String(statusEvent.payload.error ?? statusEvent.payload.errorMessage ?? statusEvent.payload.failureReason ?? "Network operation failed") : undefined,
    };
  }).sort((left, right) => (right.events.at(-1)?.timestamp ?? 0) - (left.events.at(-1)?.timestamp ?? 0));
}

function stageIndex(event: TelemetryEvent) {
  return networkStageOrder.indexOf(String(event.payload.journeyStage ?? event.name) as typeof networkStageOrder[number]);
}

function executionIdOf(event: TelemetryEvent) {
  const explicit = event.payload.executionId ?? event.payload.execution_id;
  return typeof explicit === "string" && explicit.length ? explicit : event.sessionId;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function latestPayloadNumber(events: TelemetryEvent[], key: string) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = finiteNumber(events[index]?.payload[key]);
    if (value != null) return value;
  }
  return undefined;
}

function latestPayloadString(events: TelemetryEvent[], key: string) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = payloadString(events[index]?.payload ?? {}, key);
    if (value) return value;
  }
  return undefined;
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.length ? value : undefined;
}

function transferField(events: TelemetryEvent[], key: string) {
  for (const event of events) {
    const value = payloadString(event.payload, key);
    if (value) return value;
  }
  return undefined;
}

function contentEncodingCompressed(encoding: string | undefined) {
  if (!encoding) return false;
  return encoding.split(",").some((token) => {
    const name = token.trim().toLowerCase();
    return name.length > 0 && name !== "identity";
  });
}

function isCacheRelatedHeader(name: string) {
  const normalized = name.trim().toLowerCase();
  return normalized.includes("cache") || normalized === "age" || normalized === "etag";
}
