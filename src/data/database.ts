import Dexie, { type EntityTable } from "dexie";
import type { TelemetryEvent } from "@/src/core/types";
import type { BranchRecord, CheckpointRecord, ExecutionEventRecord, ExecutionRecord } from "@/src/executions/types";
import type { AutomationWorkflow } from "@/src/automation/types";

export interface SessionRecord {
  id: string;
  name: string;
  startedAt: number;
  eventCount: number;
}

export const observatoryDb = new Dexie("koko-observatory") as Dexie & {
  sessions: EntityTable<SessionRecord, "id">;
  events: EntityTable<TelemetryEvent, "id">;
  snapshots: EntityTable<{ id: string; createdAt: number; data: unknown }, "id">;
  recordings: EntityTable<{ id: string; createdAt: number; workflow: unknown }, "id">;
  executions: EntityTable<ExecutionRecord, "id">;
  executionEvents: EntityTable<ExecutionEventRecord, "id">;
  checkpoints: EntityTable<CheckpointRecord, "id">;
  branches: EntityTable<BranchRecord, "id">;
  automationWorkflows: EntityTable<AutomationWorkflow, "id">;
};

observatoryDb.version(1).stores({
  sessions: "id, startedAt",
  events: "id, sessionId, sequence, timestamp, kind, status",
  snapshots: "id, createdAt",
  recordings: "id, createdAt",
});

observatoryDb.version(2).stores({
  sessions: "id, startedAt",
  events: "id, sessionId, sequence, timestamp, kind, status",
  snapshots: "id, createdAt",
  recordings: "id, createdAt",
  executions: "id, rootExecutionId, startedAt, updatedAt, status",
  executionEvents: "id, executionId, sequence, timestamp, parentEventId",
  checkpoints: "id, executionId, createdAt, kind",
  branches: "id, executionId, parentExecutionId, rootExecutionId, createdAt",
});

observatoryDb.version(3).stores({
  sessions: "id, startedAt",
  events: "id, sessionId, sequence, timestamp, kind, status",
  snapshots: "id, createdAt",
  recordings: "id, createdAt",
  executions: "id, rootExecutionId, startedAt, updatedAt, status",
  executionEvents: "id, executionId, sequence, timestamp, parentEventId",
  checkpoints: "id, executionId, createdAt, kind",
  branches: "id, executionId, parentExecutionId, rootExecutionId, createdAt",
  automationWorkflows: "id, updatedAt, name, startUrl",
});
