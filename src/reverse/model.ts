import type { TelemetryEvent } from "@/src/core/types";
import { reverseSchemaVersion, type EvidenceClass, type ReverseEvidence, type ReverseGraphEdge, type ReverseGraphNode, type ReverseNodeType, type ReverseRelation, type ReverseTrace } from "./types.ts";

type RuntimeRecord = { recordId?: string; parentRecordId?: string; contextId?: string; sequence?: number; timestamp?: number; kind?: string; durationMs?: number; data?: Record<string, unknown> };

export function buildReverseTrace(events: TelemetryEvent[], sessionId?: string): ReverseTrace {
  const batches = events.filter((event) => event.name === "reverse-evidence-batch" && (!sessionId || event.payload.sessionId === sessionId));
  const started = [...events].reverse().find((event) => event.name === "reverse-session-started" && (!sessionId || event.payload.sessionId === sessionId));
  const selectedSession = sessionId ?? stringValue(started?.payload.sessionId) ?? stringValue(batches.at(-1)?.payload.sessionId) ?? "";
  const evidence: ReverseEvidence[] = [];
  const nodes: ReverseGraphNode[] = [];
  const edges: ReverseGraphEdge[] = [];
  const nodeByKey = new Map<string, ReverseGraphNode>();
  const nodeByEvidenceId = new Map<string, ReverseGraphNode>();
  const actions = new Map<string, ReverseGraphNode>();

  for (const batch of batches) {
    const actionId = stringValue(batch.payload.actionId) ?? batch.id;
    const action = batch.payload.action && typeof batch.payload.action === "object" ? batch.payload.action as Record<string, unknown> : {};
    const actionNode = ensureNode(nodeByKey, nodes, `action:${actionId}`, "UserAction", `${String(action.action ?? "action")} ${locatorLabel(action.locator)}`, { actionId, action });
    actions.set(actionId, actionNode);
    const rawRecords = Array.isArray(batch.payload.evidence) ? batch.payload.evidence : [];
    const actionEvidence: ReverseEvidence[] = rawRecords.flatMap((raw, index) => {
      if (!raw || typeof raw !== "object") return [];
      const record = raw as RuntimeRecord;
      const kind = typeof record.kind === "string" ? record.kind : "unknown";
      const data = record.data && typeof record.data === "object" ? record.data : {};
      const evidenceItem: ReverseEvidence = {
        id: `${batch.id}:${record.sequence ?? index}`,
        schemaVersion: reverseSchemaVersion,
        actionId,
        kind,
        evidenceClass: "OBSERVED",
        verificationStatus: "unverified",
        timestamp: typeof record.timestamp === "number" ? record.timestamp : batch.timestamp,
        durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
        recordId: stringValue(record.recordId) ?? stringValue(data.recordId) ?? `${batch.id}:${record.sequence ?? index}`,
        parentRecordId: stringValue(record.parentRecordId) ?? stringValue(data.parentRecordId),
        contextId: stringValue(record.contextId) ?? stringValue(data.contextId),
        frameId: stringId(data.frameId ?? batch.payload.frameId),
        executionContextId: stringId(data.executionContextId ?? batch.payload.executionContextId),
        requestId: stringValue(data.requestId),
        sourceLocation: parseSourceLocation(data.stack ?? data.registrationStack),
        mechanism: "page-runtime-probe",
        data,
        redacted: true,
        sourceEventId: batch.id,
      };
      evidence.push(evidenceItem);
      return [evidenceItem];
    });

    for (const item of actionEvidence) {
      const nodeSpec = nodeSpecFor(item);
      if (!nodeSpec) continue;
      const node = ensureNode(nodeByKey, nodes, `${nodeSpec.type}:${stableKey(item)}`, nodeSpec.type, nodeSpec.label, { ...nodeSpec.metadata, actionId });
      node.evidenceIds.push(item.id);
      nodeByEvidenceId.set(item.id, node);
      relate(edges, actionNode.id, node.id, relationFromAction(item), item, evidenceClassForRelation(item));
    }
  }

  for (const node of nodes) node.evidenceIds = [...new Set(node.evidenceIds)];
  linkObservedChains(nodes, edges, evidence, nodeByEvidenceId);
  const first = batches[0];
  return {
    schemaVersion: reverseSchemaVersion,
    sessionId: selectedSession,
    requestedUrl: stringValue(started?.payload.requestedUrl) ?? stringValue(first?.payload.requestedUrl) ?? "",
    startedAt: started?.timestamp ?? first?.timestamp ?? Date.now(),
    updatedAt: batches.at(-1)?.timestamp ?? started?.timestamp ?? Date.now(),
    mode: "targeted",
    nodes,
    edges,
    evidence,
    limitations: [
      "Event listeners registered before the reverse init script may be visible only as an observed DOM event, not as a named listener.",
      "Action-to-runtime relationships remain correlated unless the probe supplies an explicit parentRecordId.",
      "Explicit runtime parent links are limited to the page context captured by this probe; browser-internal and server-side work remains outside the graph.",
      "Server-side processing and browser-internal code are outside the captured page runtime boundary.",
    ],
    sourceEvents: batches,
  };
}

function nodeSpecFor(evidence: ReverseEvidence): { type: ReverseNodeType; label: string; metadata: Record<string, unknown> } | undefined {
  const data = evidence.data;
  switch (evidence.kind) {
    case "dom-event": return { type: "DOMEvent", label: `${String(data.eventType ?? "event")} on ${targetLabel(data.target)}`, metadata: data };
    case "event-listener-enter": return { type: "EventListener", label: `${String(data.listenerName ?? "listener")} (${String(data.eventType ?? "event")})`, metadata: data };
    case "event-listener-exit": return undefined;
    case "network-request": return { type: "NetworkRequest", label: `${String(data.method ?? "GET")} ${String(data.url ?? "request")}`, metadata: data };
    case "network-response": return { type: "NetworkResponse", label: `${String(data.status ?? 0)} ${String(data.url ?? "response")}`, metadata: data };
    case "dom-mutation": return { type: "DOMMutation", label: `${String(data.mutationType ?? "mutation")} ${targetLabel(data.target)}`, metadata: data };
    case "async-task": return { type: "AsyncTask", label: `${String(data.taskType ?? "async")} ${String(data.phase ?? "")}`, metadata: data };
    default: return undefined;
  }
}

function relationFromAction(evidence: ReverseEvidence): ReverseRelation {
  void evidence;
  // The automation action bounds the capture window. It does not identify
  // which page record caused another record, so keep this edge explicitly
  // observational rather than assigning a causal relation.
  return "CORRELATES_WITH";
}

function evidenceClassForRelation(evidence: ReverseEvidence): EvidenceClass {
  void evidence;
  // A capture action is the observation window, not a proof that every record
  // in that window was caused by the automation command.
  return "CORRELATED";
}

function linkObservedChains(nodes: ReverseGraphNode[], edges: ReverseGraphEdge[], evidence: ReverseEvidence[], nodeByEvidenceId: Map<string, ReverseGraphNode>) {
  const evidenceByRecordId = new Map(evidence.flatMap((item) => item.recordId ? [[item.recordId, item] as const] : []));
  const requests = new Map<string, ReverseGraphNode>();
  const responses = new Map<string, ReverseGraphNode>();
  for (const node of nodes) {
    const requestId = stringValue(node.metadata.requestId);
    if (!requestId) continue;
    if (node.type === "NetworkRequest") requests.set(requestId, node);
    if (node.type === "NetworkResponse") responses.set(requestId, node);
  }
  for (const [requestId, request] of requests) {
    const response = responses.get(requestId);
    const item = response && evidence.find((candidate) => candidate.id === response.evidenceIds[0]);
    if (response && item) relate(edges, request.id, response.id, "RECEIVES_RESPONSE", item, "OBSERVED");
  }
  // Parent IDs are emitted by the probe while the callback/task is running.
  // They are the only basis for cross-entity causal edges here; matching by
  // event type or timestamp would join unrelated listeners and requests.
  for (const child of evidence) {
    if (!child.parentRecordId) continue;
    const parent = evidenceByRecordId.get(child.parentRecordId);
    const source = parent ? nodeByEvidenceId.get(parent.id) : undefined;
    const target = nodeByEvidenceId.get(child.id);
    if (!parent || !source || !target) continue;
    const relation = explicitRelation(parent, child);
    relate(edges, source.id, target.id, relation, child, "OBSERVED");
  }
}

function explicitRelation(parent: ReverseEvidence, child: ReverseEvidence): ReverseRelation {
  if (child.kind === "event-listener-enter") return "HANDLED_BY";
  if (child.kind === "network-request") return "INITIATES_REQUEST";
  if (child.kind === "network-response") return "RECEIVES_RESPONSE";
  if (child.kind === "async-task") return String(child.data.phase) === "scheduled" ? "SCHEDULES" : "CALLS";
  if (child.kind === "dom-mutation") return "RENDERS";
  if (parent.kind === "dom-event") return "TRIGGERS";
  return "CORRELATES_WITH";
}

function ensureNode(map: Map<string, ReverseGraphNode>, nodes: ReverseGraphNode[], id: string, type: ReverseNodeType, label: string, metadata: Record<string, unknown>) {
  const existing = map.get(id);
  if (existing) return existing;
  const node = { id, type, label: label.slice(0, 240), evidenceIds: [], metadata };
  map.set(id, node);
  nodes.push(node);
  return node;
}

function relate(edges: ReverseGraphEdge[], source: string, target: string, relation: ReverseRelation, evidence: ReverseEvidence, evidenceClass: EvidenceClass) {
  if (source === target) return;
  const id = `${source}->${relation}->${target}`;
  const existing = edges.find((edge) => edge.id === id);
  if (existing) { existing.evidenceIds.push(evidence.id); return; }
  edges.push({ id, source, target, relation, evidenceIds: [evidence.id], evidenceClass, verificationStatus: "unverified", confidence: evidenceClass === "OBSERVED" ? 1 : 0.65, mechanism: evidence.mechanism });
}

function stableKey(evidence: ReverseEvidence) {
  const data = evidence.data;
  return `${evidence.actionId}:${evidence.kind}:${String(evidence.recordId ?? data.recordId ?? data.requestId ?? data.eventType ?? data.listenerName ?? data.mutationType ?? evidence.id)}`;
}

function parseSourceLocation(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/(?:at\s+)?(?:([^\s(]+)\s+\()?((?:https?|file):\/\/[^:)]+|[^\s:)]+):(\d+):(\d+)\)?/);
  if (!match) return { raw: raw.slice(0, 2000) };
  return { raw: raw.slice(0, 2000), functionName: match[1], url: match[2], line: Number(match[3]), column: Number(match[4]) };
}

function targetLabel(value: unknown) {
  if (!value || typeof value !== "object") return "target";
  const target = value as Record<string, unknown>;
  return [target.tag, target.id ? `#${target.id}` : "", target.role ? `[role=${target.role}]` : ""].filter(Boolean).join("") || "target";
}

function locatorLabel(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const locator = value as Record<string, unknown>;
  return String(locator.name ?? locator.value ?? "");
}

function stringValue(value: unknown) { return typeof value === "string" && value.length > 0 ? value : undefined; }
function stringId(value: unknown) { return value == null ? undefined : String(value); }
