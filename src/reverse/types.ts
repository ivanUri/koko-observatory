import type { TelemetryEvent } from "@/src/core/types";

export const reverseSchemaVersion = 2;

export type EvidenceClass = "OBSERVED" | "CORRELATED" | "INFERRED" | "VERIFIED" | "UNKNOWN";
export type VerificationStatus = "unverified" | "verified" | "contradicted";

export type ReverseNodeType =
  | "UserAction"
  | "DOMEvent"
  | "EventListener"
  | "FunctionCall"
  | "AsyncTask"
  | "NetworkRequest"
  | "NetworkResponse"
  | "StateChange"
  | "DOMMutation"
  | "Script"
  | "ExecutionContext";

export type ReverseRelation =
  | "TRIGGERS"
  | "HANDLED_BY"
  | "CALLS"
  | "SCHEDULES"
  | "INITIATES_REQUEST"
  | "RECEIVES_RESPONSE"
  | "CONSUMES"
  | "UPDATES"
  | "RENDERS"
  | "CORRELATES_WITH";

export interface ReverseSourceLocation {
  url?: string;
  line?: number;
  column?: number;
  functionName?: string;
  raw?: string;
  sourceMap?: { source?: string; line?: number; column?: number };
}

export interface ReverseEvidence {
  id: string;
  schemaVersion: number;
  actionId: string;
  kind: string;
  evidenceClass: EvidenceClass;
  verificationStatus: VerificationStatus;
  timestamp: number;
  durationMs?: number;
  recordId?: string;
  parentRecordId?: string;
  contextId?: string;
  frameId?: string;
  executionContextId?: string;
  scriptId?: string;
  requestId?: string;
  sourceLocation?: ReverseSourceLocation;
  mechanism: string;
  data: Record<string, unknown>;
  redacted: boolean;
  sourceEventId?: string;
}

export interface ReverseGraphNode {
  id: string;
  type: ReverseNodeType;
  label: string;
  evidenceIds: string[];
  metadata: Record<string, unknown>;
}

export interface ReverseGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: ReverseRelation;
  evidenceIds: string[];
  evidenceClass: EvidenceClass;
  verificationStatus: VerificationStatus;
  confidence?: number;
  mechanism: string;
}

export interface ReverseTrace {
  schemaVersion: number;
  sessionId: string;
  requestedUrl: string;
  startedAt: number;
  updatedAt: number;
  mode: "off" | "basic" | "targeted" | "deep";
  nodes: ReverseGraphNode[];
  edges: ReverseGraphEdge[];
  evidence: ReverseEvidence[];
  limitations: string[];
  sourceEvents: TelemetryEvent[];
}

export interface ReverseActionSummary {
  actionId: string;
  action: string;
  locator?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
  status: "completed" | "failed" | "unknown";
}
