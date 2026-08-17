import { create } from "zustand";
import type { TelemetryEvent } from "@/src/core/types";
import { loadArtifacts, persistBranch, persistCheckpoint, persistEvents } from "./artifact-store";
import {
  executionCapabilitiesFor,
  executionIdFor,
  executionStatusFor,
  type BranchRecord,
  type CheckpointRecord,
  type ExecutionRecord,
} from "./types";

interface ExecutionState {
  executions: ExecutionRecord[];
  checkpoints: CheckpointRecord[];
  branches: BranchRecord[];
  activeExecutionId?: string;
  hydrated: boolean;
  ingest: (events: TelemetryEvent[]) => void;
  hydrate: () => Promise<void>;
  select: (executionId?: string) => void;
  bookmark: (event?: TelemetryEvent) => void;
  createViewBranch: (checkpointId?: string) => void;
}

export const useExecutionStore = create<ExecutionState>((set, get) => ({
  executions: [],
  checkpoints: [],
  branches: [],
  hydrated: false,
  ingest: (events) => {
    if (!events.length) return;
    const incoming = new Map<string, ExecutionRecord>();
    const replayExecution = events.find((event) => {
      const parentExecutionId = event.payload.executionParentId ?? event.payload.execution_parent_id;
      return typeof parentExecutionId === "string" && parentExecutionId.length > 0;
    });
    const coreCheckpoints = events.map(checkpointFromCoreEvent).filter((checkpoint): checkpoint is CheckpointRecord => checkpoint !== undefined);
    for (const event of events) {
      const id = executionIdFor(event);
      const previous = incoming.get(id) ?? get().executions.find((execution) => execution.id === id);
      const capabilities = new Set([...(previous?.capabilities ?? ["recording", "causal-graph", "bookmark"]), ...executionCapabilitiesFor(event)]);
      incoming.set(id, {
        id,
        schemaVersion: 1,
        rootExecutionId: previous?.rootExecutionId ?? id,
        sourceSessionIds: [...new Set([...(previous?.sourceSessionIds ?? []), event.sessionId])],
        status: executionStatusFor(event) ?? (event.payload.inspectionState === "completed" ? "completed" : event.payload.inspectionState === "failed" ? "failed" : previous?.status ?? "recording"),
        fidelity: previous?.fidelity ?? "playback-only",
        capabilities: [...capabilities],
        startedAt: Math.min(previous?.startedAt ?? event.timestamp, event.timestamp),
        updatedAt: Math.max(previous?.updatedAt ?? 0, event.timestamp),
        eventCount: (previous?.eventCount ?? 0) + 1,
        latestSequence: Math.max(previous?.latestSequence ?? 0, event.sequence),
        latestEventId: event.id,
      });
    }
    const newCheckpoints: CheckpointRecord[] = [];
    set((state) => {
      const known = new Set(state.checkpoints.map((checkpoint) => checkpoint.id));
      for (const checkpoint of coreCheckpoints) {
        if (!known.has(checkpoint.id)) newCheckpoints.push(checkpoint);
      }
      return {
        executions: mergeExecutions(state.executions, [...incoming.values()]),
        checkpoints: [...newCheckpoints, ...state.checkpoints],
        activeExecutionId: replayExecution ? executionIdFor(replayExecution) : state.activeExecutionId ?? executionIdFor(events.at(-1)!),
      };
    });
    void persistEvents(events).catch(() => undefined);
    for (const checkpoint of newCheckpoints) void persistCheckpoint(checkpoint).catch(() => undefined);
  },
  hydrate: async () => {
    if (get().hydrated) return;
    const artifacts = await loadArtifacts().catch(() => ({ executions: [], checkpoints: [], branches: [] }));
    set((state) => ({
      executions: mergeExecutions(artifacts.executions, state.executions),
      checkpoints: artifacts.checkpoints,
      branches: artifacts.branches,
      activeExecutionId: state.activeExecutionId ?? artifacts.executions[0]?.id,
      hydrated: true,
    }));
  },
  select: (activeExecutionId) => set({ activeExecutionId }),
  bookmark: (event) => {
    const executionId = event ? executionIdFor(event) : get().activeExecutionId;
    if (!executionId) return;
    const execution = get().executions.find((item) => item.id === executionId);
    const now = Date.now();
    const checkpoint: CheckpointRecord = {
      id: `bookmark:${executionId}:${event?.id ?? now}`,
      executionId,
      kind: "bookmark",
      eventId: event?.id ?? execution?.latestEventId,
      eventCursor: event?.sequence ?? execution?.latestSequence ?? 0,
      createdAt: now,
      stateCoverage: ["telemetry"],
      replayable: false,
      note: "View-only bookmark. Core has not supplied a reconstructible state manifest.",
    };
    set((state) => ({ checkpoints: [checkpoint, ...state.checkpoints] }));
    void persistCheckpoint(checkpoint).catch(() => undefined);
  },
  createViewBranch: (checkpointId) => {
    const checkpoint = checkpointId ? get().checkpoints.find((item) => item.id === checkpointId) : get().checkpoints.find((item) => item.executionId === get().activeExecutionId);
    const executionId = checkpoint?.executionId ?? get().activeExecutionId;
    if (!executionId) return;
    const parent = get().executions.find((item) => item.id === executionId);
    const now = Date.now();
    const branch: BranchRecord = {
      id: `branch:${executionId}:${now}`,
      executionId: `branch:${executionId}:${now}`,
      rootExecutionId: parent?.rootExecutionId ?? executionId,
      parentExecutionId: executionId,
      checkpointId: checkpoint?.id,
      createdAt: now,
      mode: "view-only",
      overrides: 0,
    };
    set((state) => ({ branches: [branch, ...state.branches] }));
    void persistBranch(branch).catch(() => undefined);
  },
}));

function mergeExecutions(current: ExecutionRecord[], incoming: ExecutionRecord[]) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) records.set(record.id, { ...records.get(record.id), ...record });
  return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function checkpointFromCoreEvent(event: TelemetryEvent): CheckpointRecord | undefined {
  const raw = event.payload.executionCheckpoint;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const checkpoint = raw as Record<string, unknown>;
  if (checkpoint.kind !== "reconstructible") return undefined;
  const coverage = Array.isArray(checkpoint.stateCoverage)
    ? checkpoint.stateCoverage.filter((value): value is CheckpointRecord["stateCoverage"][number] =>
      value === "telemetry" || value === "screenshot" || value === "browser-state" || value === "network-inputs" || value === "agent-state")
    : ["browser-state"] as CheckpointRecord["stateCoverage"];
  return {
    id: `core:${executionIdFor(event)}:${event.id}`,
    executionId: executionIdFor(event),
    kind: "reconstructible",
    eventId: event.id,
    eventCursor: event.sequence,
    createdAt: event.timestamp,
    stateCoverage: coverage.length ? coverage : ["browser-state"],
    replayable: checkpoint.replayable === true,
    note: "Core wrote a reconstructible manifest (cookies and web storage). JavaScript heap and server-side state are intentionally out of scope.",
  };
}
