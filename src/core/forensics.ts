import type { TelemetryEvent } from "./types.ts";
import { isMeasuredEvent, metricCategory } from "./metrics.ts";
import { aggregateNetworkRequests } from "./network-metrics.ts";

export type ForensicSeverity = "critical" | "warning" | "info";
export type ForensicCategory = "reliability" | "network" | "runtime" | "experience";
export type ForensicConfidence = "direct" | "measured";
export type ForensicEvidenceDestination = "network" | "inspector" | "timeline";

export interface ForensicEvidence {
  eventId: string;
  role: "primary" | "context";
  kind: TelemetryEvent["kind"];
  destination: ForensicEvidenceDestination;
  requestId?: string;
  frameId?: number;
  loaderId?: number;
  url?: string;
}

export interface ForensicMeasurement {
  value: number;
  unit: "ms" | "bytes" | "score";
  threshold?: number;
}

export interface RuntimeFinding {
  id: string;
  severity: ForensicSeverity;
  category: ForensicCategory;
  title: string;
  summary: string;
  evidenceIds: string[];
  evidence: ForensicEvidence[];
  confidence: ForensicConfidence;
  scope: ForensicScope;
  measurement?: ForensicMeasurement;
  value?: string;
}

type RuntimeFindingDraft = Omit<RuntimeFinding, "evidence" | "confidence" | "scope"> & {
  confidence: ForensicConfidence;
};

export type BottleneckLayer = "reliability" | "network" | "runtime" | "experience" | "none";

export interface BottleneckStep {
  label: string;
  value: string;
  evidenceIds: string[];
}

export interface BottleneckReport {
  state: "waiting" | "attention" | "healthy";
  layer: BottleneckLayer;
  headline: string;
  summary: string;
  confidence: "direct-evidence" | "no-breach" | "waiting";
  evidenceIds: string[];
  chain: BottleneckStep[];
  nextAction: string;
}

export interface RuntimeForensicsReport {
  state: "waiting" | "attention" | "healthy";
  headline: string;
  summary: string;
  findings: RuntimeFinding[];
  evidenceCount: number;
  measuredCount: number;
  scope: ForensicScope;
  bottleneck: BottleneckReport;
}

export interface ForensicScope {
  mode: "top-level-loader" | "inspection";
  frameId?: number;
  loaderId?: number;
  url?: string;
}

const networkThresholds: Record<string, number> = {
  dns: 200,
  tcp: 200,
  tls: 300,
  server: 500,
  response: 1_000,
};

const runtimeThresholds: Record<string, number> = {
  javascript: 200,
  dom: 200,
  scheduler: 200,
  render: 300,
};

const largeResourceThreshold = 1024 * 1024;

/**
 * Produce actionable findings from direct Core/probe measurements only.
 * This intentionally does not infer a root cause from event order or timing
 * proximity. Every finding points to at least one retained telemetry event.
 */
export function diagnoseRuntime(events: TelemetryEvent[]): RuntimeForensicsReport {
  const scope = resolveForensicScope(events);
  const scopedEvents = events.filter((event) => belongsToForensicScope(event, scope));
  const measured = scopedEvents.filter(isMeasuredEvent);
  if (!events.length) {
    return {
      state: "waiting",
      headline: "Run an inspection to collect evidence",
      summary: "Runtime Forensics needs a completed or live Core trace before it can report a bottleneck.",
      findings: [],
      evidenceCount: 0,
      measuredCount: 0,
      scope,
      bottleneck: waitingBottleneck(),
    };
  }

  const findings: RuntimeFindingDraft[] = [];
  const inspectionFailure = [...scopedEvents].reverse().find((event) => event.payload.inspectionState === "failed");
  if (inspectionFailure) {
    findings.push({
      id: "inspection-failed",
      severity: "critical",
      category: "reliability",
      title: "Inspection failed",
      summary: String(inspectionFailure.payload.errorMessage ?? inspectionFailure.payload.errorCode ?? "Core reported an inspection failure."),
      evidenceIds: [inspectionFailure.id],
      confidence: "direct",
    });
  }

  const errors = scopedEvents.filter((event) => event.status === "error"
    && event.kind !== "network"
    && event.id !== inspectionFailure?.id
    && event.payload.inspectionState == null);
  if (errors.length) {
    const latest = errors.at(-1)!;
    const message = stringPayload(latest.payload.message) ?? stringPayload(latest.payload.errorMessage);
    findings.push({
      id: "runtime-errors",
      severity: "critical",
      category: "reliability",
      title: `${errors.length} runtime error${errors.length === 1 ? "" : "s"} observed`,
      summary: message
        ? `${message}${stringPayload(latest.payload.scriptUrl) ? ` (${String(latest.payload.scriptUrl)})` : ""}. Core emitted this as a direct runtime error.`
        : "Core marked these signals as errors. Open the evidence instead of treating them as a guessed root cause.",
      evidenceIds: errors.slice(-8).map((event) => event.id),
      confidence: "direct",
    });
  }

  const networkRequests = aggregateNetworkRequests(scopedEvents);
  const httpErrors = networkRequests.filter((request) => request.httpError);
  if (httpErrors.length) {
    const latest = httpErrors.at(-1)!;
    findings.push({
      id: "http-errors",
      severity: "critical",
      category: "network",
      title: `${httpErrors.length} HTTP error request${httpErrors.length === 1 ? "" : "s"}`,
      summary: `${String(latest.statusCode)} returned for ${latest.url}. Each request is counted once using its request ID, not once per network stage.`,
      evidenceIds: httpErrors.slice(-8).flatMap(requestEvidenceIds),
      confidence: "direct",
      value: String(latest.statusCode),
    });
  }

  // A page can mark an HTTP 4xx/5xx response as an error event, but that is
  // still an HTTP failure rather than a transport failure. Keep the two
  // findings mutually exclusive so one request cannot be reported twice.
  const transportErrors = networkRequests.filter((request) => request.transportFailed && !request.httpError);
  if (transportErrors.length) {
    const latest = transportErrors.at(-1)!;
    findings.push({
      id: "network-failures",
      severity: "critical",
      category: "network",
      title: `${transportErrors.length} network transfer failure${transportErrors.length === 1 ? "" : "s"}`,
      summary: `${latest.failure ?? "The transfer ended before a successful response."} (${latest.url}).`,
      evidenceIds: transportErrors.slice(-8).flatMap(requestEvidenceIds),
      confidence: "direct",
    });
  }

  const largeResource = networkRequests
    .map((request) => ({ request, bytes: request.decodedBytes ?? request.transferredBytes }))
    .filter((item): item is { request: typeof networkRequests[number]; bytes: number } => item.bytes != null && item.bytes >= largeResourceThreshold)
    .sort((left, right) => right.bytes - left.bytes)[0];
  if (largeResource) {
    const sizeKind = largeResource.request.decodedBytes != null ? "decoded" : "transferred";
    findings.push({
      id: "large-resource",
      severity: "warning",
      category: "network",
      title: "Large resource observed",
      summary: `Core measured ${formatBytes(largeResource.bytes)} of ${sizeKind} data for ${largeResource.request.url}. This reports the largest measured request, not an estimate.`,
      evidenceIds: requestEvidenceIds(largeResource.request),
      confidence: "measured",
      measurement: { value: largeResource.bytes, unit: "bytes", threshold: largeResourceThreshold },
      value: formatBytes(largeResource.bytes),
    });
  }

  const slowNetwork = measured
    .filter((event) => event.kind === "network")
    .map((event) => ({ event, stage: String(event.payload.journeyStage ?? event.name) }))
    .filter(({ event, stage }) => (networkThresholds[stage] ?? Infinity) <= event.duration)
    .sort((left, right) => right.event.duration - left.event.duration)[0];
  if (slowNetwork) {
    const { event, stage } = slowNetwork;
    findings.push({
      id: "slow-network-stage",
      severity: "warning",
      category: "network",
      title: `Slowest ${stage} stage observed`,
      summary: `Core measured ${formatDuration(event.duration)} in the ${stage} stage for ${String(event.payload.url ?? "the request")}. This is a measured bottleneck candidate, not an inferred root cause.`,
      evidenceIds: [event.id],
      confidence: "measured",
      measurement: { value: event.duration, unit: "ms", threshold: networkThresholds[stage] },
      value: formatDuration(event.duration),
    });
  }

  const slowRuntime = measured
    .map((event) => ({ event, category: metricCategory(event) }))
    .filter(({ event, category }) => category != null && (runtimeThresholds[category] ?? Infinity) <= event.duration)
    .sort((left, right) => right.event.duration - left.event.duration)[0];
  if (slowRuntime?.category) {
    findings.push({
      id: "slow-runtime-stage",
      severity: "warning",
      category: "runtime",
      title: `Long ${slowRuntime.category} stage observed`,
      summary: runtimeFindingSummary(slowRuntime.event),
      evidenceIds: [slowRuntime.event.id],
      confidence: "measured",
      measurement: { value: slowRuntime.event.duration, unit: "ms", threshold: runtimeThresholds[slowRuntime.category] },
      value: formatDuration(slowRuntime.event.duration),
    });
  }

  findings.push(...lifecycleFindings(scopedEvents));
  findings.push(...vitalFindings(scopedEvents));
  findings.sort(compareFindingPriority);
  const limitedFindings = findings.slice(0, 5).map((finding) => materializeFinding(finding, scopedEvents, scope));
  const state = limitedFindings.some((finding) => finding.severity === "critical" || finding.severity === "warning") ? "attention" : "healthy";
  return {
    state,
    headline: state === "attention" ? `${limitedFindings.length} evidence-backed finding${limitedFindings.length === 1 ? "" : "s"}` : "No measured bottleneck detected",
    summary: state === "attention"
      ? "Start with the highest-severity finding. Every item below links to the telemetry that supports it."
      : "The retained trace contains no error or threshold breach covered by Runtime Forensics.",
    findings: limitedFindings,
    evidenceCount: scopedEvents.length,
    measuredCount: measured.length,
    scope,
    bottleneck: buildBottleneckReport(scopedEvents, limitedFindings),
  };
}

function waitingBottleneck(): BottleneckReport {
  return {
    state: "waiting",
    layer: "none",
    headline: "Run an inspection to identify the primary bottleneck",
    summary: "The report needs a retained Core trace before it can build an evidence chain.",
    confidence: "waiting",
    evidenceIds: [],
    chain: [],
    nextAction: "Inspect a URL and return to Overview.",
  };
}

function buildBottleneckReport(events: TelemetryEvent[], findings: RuntimeFinding[]): BottleneckReport {
  if (!events.length) return waitingBottleneck();
  const primary = [...findings].sort(compareFindingPriority)[0];
  if (!primary) {
    const measured = events.filter(isMeasuredEvent);
    return {
      state: "healthy",
      layer: "none",
      headline: "No evidence-backed bottleneck detected",
      summary: "The trace contains measured network/runtime signals, but none crossed the configured diagnostic budgets or emitted an error.",
      confidence: "no-breach",
      evidenceIds: [],
      chain: lifecycleChain(events),
      nextAction: measured.length ? "Use the journey tabs to inspect the measured critical path." : "Collect a run with measured Core stages.",
    };
  }
  const evidenceIds = [...new Set(primary.evidenceIds)];
  const chain = bottleneckChain(events, primary);
  return {
    state: "attention",
    layer: primary.category === "network" ? "network" : primary.category === "runtime" ? "runtime" : primary.category === "experience" ? "experience" : "reliability",
    headline: primary.id === "http-errors" || primary.id === "network-failures"
      ? `Primary reliability issue: ${primary.title}`
      : primary.category === "network"
        ? `Network bottleneck candidate: ${primary.title}`
      : primary.category === "runtime"
          ? `Browser bottleneck candidate: ${primary.title}`
          : primary.title,
    summary: `${primary.summary} The chain below contains only observed telemetry; it does not infer an unmeasured root cause.`,
    confidence: "direct-evidence",
    evidenceIds,
    chain,
    nextAction: primary.category === "network" ? "Open Network and inspect the request stages and response headers." : primary.category === "runtime" || primary.category === "experience" ? "Open Browser Journey and inspect the matching runtime or lifecycle event." : "Open the primary evidence and verify the failed or missing milestone.",
  };
}

function compareFindingPriority(left: RuntimeFindingDraft | RuntimeFinding, right: RuntimeFindingDraft | RuntimeFinding) {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity) return severity;
  const explicitPriority: Record<string, number> = {
    "inspection-failed": 0,
    "runtime-errors": 1,
    "http-errors": 2,
    "network-failures": 3,
    "lifecycle-not-reached": 4,
  };
  const priority = (explicitPriority[left.id] ?? 100) - (explicitPriority[right.id] ?? 100);
  if (priority) return priority;
  const breach = findingBreachScore(right) - findingBreachScore(left);
  if (breach) return breach;
  return left.id.localeCompare(right.id);
}

function findingBreachScore(finding: RuntimeFindingDraft | RuntimeFinding) {
  if (finding.measurement?.threshold) return finding.measurement.value / finding.measurement.threshold;
  if (!finding.value) return 0;
  const value = Number.parseFloat(finding.value);
  if (!Number.isFinite(value)) return 0;
  if (finding.id === "slow-network-stage") return value / 500;
  if (finding.id === "slow-runtime-stage") return value / 200;
  if (finding.id === "vital-lcp") return value / 4_000;
  if (finding.id === "vital-fcp") return value / 1_800;
  if (finding.id === "vital-ttfb") return value / 800;
  if (finding.id === "vital-inp") return value / 500;
  if (finding.id === "vital-cls") return value / .25;
  return 0;
}

function materializeFinding(finding: RuntimeFindingDraft, events: TelemetryEvent[], scope: ForensicScope): RuntimeFinding {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const evidence = [...new Set(finding.evidenceIds)].flatMap((eventId, index) => {
    const event = eventById.get(eventId);
    if (!event) return [];
    const requestId = event.payload.requestId == null ? undefined : String(event.payload.requestId);
    const frameId = numberPayload(event.payload.frameId);
    const loaderId = numberPayload(event.payload.loaderId);
    const url = stringPayload(event.payload.url) ?? stringPayload(event.payload.scriptUrl);
    return [{
      eventId,
      role: index === 0 ? "primary" as const : "context" as const,
      kind: event.kind,
      destination: evidenceDestination(event),
      ...(requestId ? { requestId } : {}),
      ...(frameId != null ? { frameId } : {}),
      ...(loaderId != null ? { loaderId } : {}),
      ...(url ? { url } : {}),
    }];
  });
  return { ...finding, evidenceIds: evidence.map((item) => item.eventId), evidence, scope };
}

function evidenceDestination(event: TelemetryEvent): ForensicEvidenceDestination {
  if (event.kind === "network") return "network";
  if (event.payload.inspectionState != null || event.payload.lifecycleStage != null || event.kind === "navigation") return "timeline";
  return "inspector";
}

function bottleneckChain(events: TelemetryEvent[], finding: RuntimeFinding): BottleneckStep[] {
  const evidence = finding.evidenceIds.map((id) => events.find((event) => event.id === id)).filter((event): event is TelemetryEvent => Boolean(event));
  const first = evidence[0];
  const chain: BottleneckStep[] = [{ label: "Observed finding", value: finding.title, evidenceIds: finding.evidenceIds }];
  if (first) {
    const stage = String(first.payload.browserStage ?? first.payload.journeyStage ?? first.name);
    const responseStatus = typeof first.payload.responseStatus === "number" ? first.payload.responseStatus : undefined;
    chain.push({
      label: finding.category === "network" ? "Network stage" : finding.category === "runtime" ? "Browser stage" : "Signal",
      value: responseStatus != null && responseStatus >= 400 ? `${stage} · HTTP ${responseStatus}` : `${stage} · ${formatDuration(first.duration)}`,
      evidenceIds: [first.id],
    });
    const url = stringPayload(first.payload.url) ?? stringPayload(first.payload.scriptUrl);
    if (url) chain.push({ label: finding.category === "runtime" ? "Script/resource context" : "Request", value: url, evidenceIds: [first.id] });
    const functionName = stringPayload(first.payload.functionName);
    if (functionName) chain.push({ label: "Function context", value: functionName, evidenceIds: [first.id] });
  }
  const lifecycle = lifecycleChain(events);
  for (const step of lifecycle) {
    if (!chain.some((item) => item.label === step.label && item.value === step.value)) chain.push(step);
  }
  return chain.slice(0, 6);
}

function lifecycleChain(events: TelemetryEvent[]): BottleneckStep[] {
  const allResponseCandidates = [...events]
    .filter((event) => event.kind === "network" && ["response", "received"].includes(String(event.payload.journeyStage ?? event.name)));
  const documentCandidates = allResponseCandidates
    .filter((event) => String(event.payload.resourceType ?? "").toLowerCase() === "document" || event.payload.topLevelNavigation === true);
  const responseCandidates = documentCandidates.length ? documentCandidates : allResponseCandidates;
  const response = (responseCandidates.find((event) => event.payload.topLevelNavigation === true && event.payload.journeyStage === "response")
    ?? responseCandidates.find((event) => event.payload.journeyStage === "response")
    ?? responseCandidates.find((event) => event.payload.topLevelNavigation === true)
    ?? responseCandidates.at(-1));
  if (!response) return [];
  const steps: BottleneckStep[] = [{ label: "Document response", value: `${formatDuration(response.duration)} · ${String(response.payload.responseStatus ?? "status unavailable")}`, evidenceIds: [response.id] }];
  const milestones = ["domcontentloaded", "load", "domstable", "networkidle"];
  for (const milestone of milestones) {
    const event = events.find((candidate) => String(candidate.payload.lifecycleStage ?? candidate.name).toLowerCase() === milestone
      && candidate.timestamp >= response.timestamp
      && sameDocumentContext(candidate, response));
    if (!event) continue;
    const delta = Math.max(0, event.timestamp - response.timestamp);
    steps.push({ label: milestone, value: `+${formatDuration(delta)} from response`, evidenceIds: [event.id] });
  }
  return steps;
}

function runtimeFindingSummary(event: TelemetryEvent) {
  const stage = String(event.payload.browserStage ?? event.name);
  const script = stringPayload(event.payload.scriptUrl);
  const functionName = stringPayload(event.payload.functionName);
  const context = [script, functionName].filter(Boolean).join(" · ");
  return `Core measured ${formatDuration(event.duration)} in ${stage}${context ? ` (${context})` : ""}.`;
}

function sameDocumentContext(left: TelemetryEvent, right: TelemetryEvent) {
  const leftFrame = numberPayload(left.payload.frameId);
  const rightFrame = numberPayload(right.payload.frameId);
  const leftLoader = numberPayload(left.payload.loaderId);
  const rightLoader = numberPayload(right.payload.loaderId);
  if (leftFrame != null && rightFrame != null && leftFrame !== rightFrame) return false;
  if (leftLoader != null && rightLoader != null && leftLoader !== rightLoader) return false;
  return true;
}

function resolveForensicScope(events: TelemetryEvent[]): ForensicScope {
  const document = events.find((event) => {
    const payload = event.payload;
    return event.kind === "network"
      && payload.topLevelNavigation === true
      && typeof payload.frameId === "number"
      && typeof payload.loaderId === "number";
  }) ?? events.find((event) => {
    const payload = event.payload;
    return event.kind === "network"
      && String(payload.resourceType ?? "").toLowerCase() === "document"
      && typeof payload.frameId === "number"
      && typeof payload.loaderId === "number";
  });
  if (!document) return { mode: "inspection" };
  return {
    mode: "top-level-loader",
    frameId: numberPayload(document.payload.frameId),
    loaderId: numberPayload(document.payload.loaderId),
    url: stringPayload(document.payload.url),
  };
}

function belongsToForensicScope(event: TelemetryEvent, scope: ForensicScope) {
  if (scope.mode === "inspection") return true;
  const frameId = numberPayload(event.payload.frameId);
  const loaderId = numberPayload(event.payload.loaderId);
  if (frameId != null && frameId !== scope.frameId) return false;
  if (loaderId != null && loaderId !== scope.loaderId) return false;
  return true;
}

function requestEvidenceIds(request: { events: TelemetryEvent[] }) {
  const evidence = request.events.find((event) => event.status === "error")
    ?? request.events.find((event) => event.payload.journeyStage === "response")
    ?? request.events.at(-1);
  return evidence ? [evidence.id] : [];
}

function lifecycleFindings(events: TelemetryEvent[]): RuntimeFindingDraft[] {
  const completed = [...events].reverse().find((event) => event.payload.inspectionState === "completed");
  if (!completed) return [];
  const runOptions = completed.payload.runOptions as Record<string, unknown> | undefined;
  const waitUntil = typeof runOptions?.waitUntil === "string" ? runOptions.waitUntil.toLowerCase() : undefined;
  const expected = waitUntil === "domcontentloaded" ? "domcontentloaded" : waitUntil === "load" ? "load" : waitUntil === "networkidle" ? "networkidle" : waitUntil === "domstable" ? "domstable" : undefined;
  if (!expected) return [];
  const reached = events.some((event) => String(event.payload.lifecycleStage ?? event.name).toLowerCase() === expected);
  if (reached) return [];
  return [{
    id: "lifecycle-not-reached",
    severity: "warning",
    category: "reliability",
    title: `${expected} milestone not observed`,
    summary: `The inspection completed, but Core did not emit the configured ${expected} lifecycle milestone. Treat later-page timing as incomplete.`,
    evidenceIds: [completed.id],
    confidence: "direct",
  }];
}

function vitalFindings(events: TelemetryEvent[]): RuntimeFindingDraft[] {
  const latest = new Map<string, { value: number; event: TelemetryEvent }>();
  for (const event of events) {
    if (event.name !== "web-vital" || typeof event.payload.probeJson !== "string") continue;
    try {
      const probe = JSON.parse(event.payload.probeJson) as { name?: unknown; value?: unknown };
      if (typeof probe.name === "string" && typeof probe.value === "number" && Number.isFinite(probe.value)) latest.set(probe.name, { value: probe.value, event });
    } catch {
      // Invalid or truncated probe JSON is not evidence and is ignored.
    }
  }
  const budgets: Record<string, { threshold: number; label: string }> = {
    LCP: { threshold: 4_000, label: "LCP" },
    FCP: { threshold: 1_800, label: "FCP" },
    TTFB: { threshold: 800, label: "TTFB" },
    INP: { threshold: 500, label: "INP" },
    CLS: { threshold: 0.25, label: "CLS" },
  };
  return [...latest].filter(([name, item]) => budgets[name] && item.value >= budgets[name].threshold).map(([name, item]) => ({
    id: `vital-${name.toLowerCase()}`,
    severity: "warning" as const,
    category: "experience" as const,
    title: `${budgets[name].label} exceeds the diagnostic budget`,
    summary: `${budgets[name].label} was measured at ${name === "CLS" ? item.value.toFixed(3) : formatDuration(item.value)} by the page probe.`,
    evidenceIds: [item.event.id],
    confidence: "measured" as const,
    measurement: { value: item.value, unit: name === "CLS" ? "score" as const : "ms" as const, threshold: budgets[name].threshold },
    value: name === "CLS" ? item.value.toFixed(3) : formatDuration(item.value),
  }));
}

function numberPayload(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringPayload(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function severityRank(severity: ForensicSeverity) {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

function formatDuration(value: number) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}
