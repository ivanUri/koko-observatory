import { observatoryDb } from "@/src/data/database";
import type { TelemetryEvent } from "@/src/core/types";
import {
  eventParentId,
  executionCapabilitiesFor,
  executionEventKey,
  executionIdFor,
  executionStatusFor,
  selectNewEvents,
  type BranchRecord,
  type CheckpointRecord,
  type ExecutionEventRecord,
  type ExecutionRecord,
} from "./types";

const localCapabilities: ExecutionRecord["capabilities"] = ["recording", "causal-graph", "bookmark"];
let artifactGeneration = 0;

export async function persistEvents(events: TelemetryEvent[]) {
  if (!events.length || typeof window === "undefined") return;
  const generation = artifactGeneration;
  const candidateIds = [...new Set(events.map(executionEventKey))];
  const existingEventRecords = await observatoryDb.executionEvents.bulkGet(candidateIds);
  const existingEventIds = new Set(existingEventRecords.filter(Boolean).map((record) => record!.id));
  if (!selectNewEvents(events, existingEventIds).length) return;

  // A clear operation may have happened while the duplicate check was awaiting
  // IndexedDB. Do not let that stale write bring deleted executions back.
  if (generation !== artifactGeneration) return;
  await observatoryDb.transaction("rw", observatoryDb.executions, observatoryDb.executionEvents, async () => {
    if (generation !== artifactGeneration) return;
    // The read-write transaction sees a batch that committed first. Count and
    // insert only events that are still absent. This does not walk the table.
    const freshEventRecords = await observatoryDb.executionEvents.bulkGet(candidateIds);
    const storedEventIds = new Set(freshEventRecords.filter(Boolean).map((record) => record!.id));
    const uniqueEvents = selectNewEvents(events, storedEventIds);
    if (!uniqueEvents.length) return;
    const records = new Map<string, ExecutionRecord>();
    const executionEvents: ExecutionEventRecord[] = [];
    const existingIds = [...new Set(uniqueEvents.map(executionIdFor))];
    const existing = await observatoryDb.executions.bulkGet(existingIds);
    const known = new Map(existing.filter((record): record is ExecutionRecord => Boolean(record)).map((record) => [record.id, record]));

    for (const event of uniqueEvents) {
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

    await observatoryDb.executionEvents.bulkPut(executionEvents);
    await observatoryDb.executions.bulkPut([...records.values()]);
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

export async function loadRecentExecutionEvents(limit = 10_000) {
  if (typeof window === "undefined") return [];
  const records = await observatoryDb.executionEvents
    .orderBy("timestamp")
    .reverse()
    .limit(limit)
    .toArray();
  return records.reverse().map((record) => record.event);
}

export async function countStoredExecutionEvents() {
  if (typeof window === "undefined") return 0;
  return observatoryDb.executionEvents.count();
}

export async function clearStoredArtifacts() {
  if (typeof window === "undefined") return;
  artifactGeneration += 1;
  await observatoryDb.transaction(
    "rw",
    observatoryDb.sessions,
    observatoryDb.events,
    observatoryDb.snapshots,
    observatoryDb.recordings,
    observatoryDb.executions,
    observatoryDb.executionEvents,
    observatoryDb.checkpoints,
    observatoryDb.branches,
    observatoryDb.automationWorkflows,
    async () => {
      await Promise.all([
        observatoryDb.sessions.clear(),
        observatoryDb.events.clear(),
        observatoryDb.snapshots.clear(),
        observatoryDb.recordings.clear(),
        observatoryDb.executions.clear(),
        observatoryDb.executionEvents.clear(),
        observatoryDb.checkpoints.clear(),
        observatoryDb.branches.clear(),
        observatoryDb.automationWorkflows.clear(),
      ]);
    },
  );
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
