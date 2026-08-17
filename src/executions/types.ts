import type { TelemetryEvent } from "@/src/core/types";

export const executionSchemaVersion = 1;

export type ExecutionFidelity = "playback-only" | "action-rerun" | "reconstructed" | "exact-live";
export type ExecutionStatus = "recording" | "completed" | "failed" | "paused" | "unknown";
export type CheckpointKind = "bookmark" | "reconstructible" | "live";

export type ExecutionCapability =
  | "recording"
  | "causal-graph"
  | "bookmark"
  | "checkpoint-live"
  | "checkpoint-reconstruct"
  | "network-replay"
  | "branching"
  | "clock-control"
  | "random-control";

export interface ExecutionRecord {
  id: string;
  schemaVersion: number;
  rootExecutionId: string;
  sourceSessionIds: string[];
  status: ExecutionStatus;
  fidelity: ExecutionFidelity;
  capabilities: ExecutionCapability[];
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  latestSequence: number;
  latestEventId?: string;
}

export interface ExecutionEventRecord {
  id: string;
  executionId: string;
  eventId: string;
  parentEventId?: string;
  timestamp: number;
  sequence: number;
  event: TelemetryEvent;
}

export interface CheckpointRecord {
  id: string;
  executionId: string;
  kind: CheckpointKind;
  eventId?: string;
  eventCursor: number;
  createdAt: number;
  stateCoverage: Array<"telemetry" | "screenshot" | "browser-state" | "network-inputs" | "agent-state">;
  replayable: boolean;
  note: string;
}

export interface BranchRecord {
  id: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId: string;
  checkpointId?: string;
  createdAt: number;
  mode: "view-only" | "controlled";
  overrides: number;
}

export type ExecutionControlCommand =
  | { type: "execution.capabilities"; requestId: string }
  | { type: "execution.pause"; requestId: string; executionId: string }
  | { type: "execution.resume"; requestId: string; executionId: string }
  | { type: "execution.checkpoint.create"; requestId: string; executionId: string; kind: Exclude<CheckpointKind, "bookmark">; eventCursor: number }
  | { type: "execution.branch.create"; requestId: string; executionId: string; checkpointId: string; overrides: unknown[] };

export function executionIdFor(event: TelemetryEvent) {
  const explicit = stringPayload(event.payload, "executionId") ?? stringPayload(event.payload, "execution_id");
  return explicit ?? event.sessionId;
}

export function eventParentId(event: TelemetryEvent) {
  return event.parentId ?? stringPayload(event.payload, "causalParent") ?? stringPayload(event.payload, "causal_parent");
}

export function executionCapabilitiesFor(event: TelemetryEvent): ExecutionCapability[] {
  const raw = event.payload.executionCapabilities ?? event.payload.execution_capabilities;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isExecutionCapability);
}

export function executionStatusFor(event: TelemetryEvent): ExecutionStatus | undefined {
  const status = stringPayload(event.payload, "executionStatus") ?? stringPayload(event.payload, "execution_status");
  return status && isExecutionStatus(status) ? status : undefined;
}

function stringPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isExecutionCapability(value: unknown): value is ExecutionCapability {
  return typeof value === "string" && [
    "recording", "causal-graph", "bookmark", "checkpoint-live", "checkpoint-reconstruct",
    "network-replay", "branching", "clock-control", "random-control",
  ].includes(value);
}

function isExecutionStatus(value: string): value is ExecutionStatus {
  return ["recording", "completed", "failed", "paused", "unknown"].includes(value);
}
