import { observatoryDb } from "@/src/data/database";
import type { TelemetryEvent } from "@/src/core/types";
import {
  eventParentId,
  executionCapabilitiesFor,
  executionIdFor,
  executionStatusFor,
  type BranchRecord,
  type CheckpointRecord,
  type ExecutionEventRecord,
  type ExecutionRecord,
} from "./types";

const localCapabilities: ExecutionRecord["capabilities"] = ["recording", "causal-graph", "bookmark"];

export async function persistEvents(events: TelemetryEvent[]) {
  if (!events.length || typeof window === "undefined") return;
  const records = new Map<string, ExecutionRecord>();
  const executionEvents: ExecutionEventRecord[] = [];
  const existingIds = [...new Set(events.map(executionIdFor))];
  const existing = await observatoryDb.executions.bulkGet(existingIds);
  const known = new Map(existing.filter((record): record is ExecutionRecord => Boolean(record)).map((record) => [record.id, record]));

  for (const event of events) {
    const executionId = executionIdFor(event);
    const previous = records.get(executionId) ?? known.get(executionId);
    const capabilities = new Set([...(previous?.capabilities ?? localCapabilities), ...executionCapabilitiesFor(event)]);
    const status = executionStatusFor(event) ?? statusFromLifecycle(event) ?? previous?.status ?? "recording";
    const record: ExecutionRecord = {
      id: executionId,
      schemaVersion: 1,
      rootExecutionId: previous?.rootExecutionId ?? executionId,
      sourceSessionIds: unique([...(previous?.sourceSessionIds ?? []), event.sessionId]),
      status,
      fidelity: previous?.fidelity ?? "playback-only",
      capabilities: [...capabilities],
      startedAt: Math.min(previous?.startedAt ?? event.timestamp, event.timestamp),
      updatedAt: Math.max(previous?.updatedAt ?? 0, event.timestamp),
      eventCount: (previous?.eventCount ?? 0) + 1,
      latestSequence: Math.max(previous?.latestSequence ?? 0, event.sequence),
      latestEventId: event.id,
    };
    records.set(executionId, record);
    executionEvents.push({
      id: `${executionId}:${event.id}`,
      executionId,
      eventId: event.id,
      parentEventId: eventParentId(event),
      timestamp: event.timestamp,
      sequence: event.sequence,
      event,
    });
  }

  await observatoryDb.transaction("rw", observatoryDb.executions, observatoryDb.executionEvents, async () => {
    await observatoryDb.executions.bulkPut([...records.values()]);
    await observatoryDb.executionEvents.bulkPut(executionEvents);
  });
}

export async function loadArtifacts() {
  if (typeof window === "undefined") return { executions: [], checkpoints: [], branches: [] };
  const [executions, checkpoints, branches] = await Promise.all([
    observatoryDb.executions.orderBy("updatedAt").reverse().toArray(),
    observatoryDb.checkpoints.orderBy("createdAt").reverse().toArray(),
    observatoryDb.branches.orderBy("createdAt").reverse().toArray(),
  ]);
  return { executions, checkpoints, branches };
}

export async function persistCheckpoint(checkpoint: CheckpointRecord) {
  if (typeof window !== "undefined") await observatoryDb.checkpoints.put(checkpoint);
}

export async function persistBranch(branch: BranchRecord) {
  if (typeof window !== "undefined") await observatoryDb.branches.put(branch);
}

function statusFromLifecycle(event: TelemetryEvent): ExecutionRecord["status"] | undefined {
  const state = event.payload.inspectionState;
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "started") return "recording";
  return undefined;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
