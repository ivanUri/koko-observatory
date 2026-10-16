/// <reference lib="webworker" />

import type { TelemetryEvent, WorkerSnapshot } from "@/src/core/types";
import { createEventRateLedger, createMeasuredDurationWindow } from "@/src/core/metrics";

const MAX_EVENTS = 10_000;
const P95_WINDOW = 5_000;
const GRAPH_WINDOW = 500;
const RATE_WINDOW = 180;
const events: TelemetryEvent[] = [];
const rates: Array<[number, number]> = [];
const seenEventIds = new Set<string>();
const rateLedger = createEventRateLedger();
const durationWindow = createMeasuredDurationWindow(P95_WINDOW);

type WorkerCommand =
  | { type: "append"; batch: TelemetryEvent[]; generation: number }
  | { type: "clear"; generation: number };

self.onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  if (data.type === "clear") {
    events.length = 0;
    rates.length = 0;
    seenEventIds.clear();
    rateLedger.clear();
    durationWindow.clear();
    self.postMessage(snapshotFor([], data.generation));
    return;
  }
  if (data.type !== "append") return;
  const uniqueBatch: TelemetryEvent[] = [];
  for (const event of data.batch) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    uniqueBatch.push(event);
    rateLedger.add(event);
    durationWindow.push(event);
  }
  events.push(...uniqueBatch);
  if (events.length > MAX_EVENTS) {
    const dropped = events.splice(0, events.length - MAX_EVENTS);
    for (const event of dropped) {
      seenEventIds.delete(event.id);
      rateLedger.remove(event);
    }
  }

  self.postMessage(snapshotFor(uniqueBatch, data.generation));
};

function snapshotFor(batch: TelemetryEvent[], generation: number): WorkerSnapshot & { generation: number } {
  rates.splice(0, rates.length, ...rateLedger.snapshot(RATE_WINDOW));
  const graphSource = events.slice(-GRAPH_WINDOW);
  return {
    generation,
    events: batch,
    rates,
    p95: durationWindow.percentile(0.95),
    graphNodes: graphSource.map((event) => ({
      id: event.id,
      label: event.name,
      kind: event.kind,
      duration: event.duration,
      status: event.status,
    })),
    graphEdges: buildGraphEdges(graphSource),
  };
}

function buildGraphEdges(source: TelemetryEvent[]) {
  const ids = new Set(source.map((event) => event.id));
  // Event sequence is chronology, not proof of causality. Only render a
  // graph edge when Core emitted an explicit parent identity.
  return source
    .filter((event) => event.parentId && ids.has(event.parentId))
    .map((event) => ({ id: `parent:${event.parentId}-${event.id}`, source: event.parentId!, target: event.id, relation: "parent" as const }));
}

export {};
