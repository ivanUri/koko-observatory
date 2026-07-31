import Dexie, { type EntityTable } from "dexie";
import type { TelemetryEvent } from "@/src/core/types";

export interface SessionRecord {
  id: string;
  name: string;
  startedAt: number;
  eventCount: number;
}

export const observatoryDb = new Dexie("velora-observatory") as Dexie & {
  sessions: EntityTable<SessionRecord, "id">;
  events: EntityTable<TelemetryEvent, "id">;
  snapshots: EntityTable<{ id: string; createdAt: number; data: unknown }, "id">;
  recordings: EntityTable<{ id: string; createdAt: number; workflow: unknown }, "id">;
};

observatoryDb.version(1).stores({
  sessions: "id, startedAt",
  events: "id, sessionId, sequence, timestamp, kind, status",
  snapshots: "id, createdAt",
  recordings: "id, createdAt",
});
