/// <reference lib="webworker" />

import { Index } from "flexsearch";
import type { TelemetryEvent, WorkerSnapshot } from "@/src/core/types";

const MAX_EVENTS = 1_000_000;
const GRAPH_WINDOW = 500;
const RATE_WINDOW = 180;
const events: TelemetryEvent[] = [];
const rates: Array<[number, number]> = [];
const search = new Index({ tokenize: "forward", cache: 100 });

self.onmessage = ({ data }: MessageEvent<{ type: "append"; batch: TelemetryEvent[] }>) => {
  if (data.type !== "append") return;
  events.push(...data.batch);
  data.batch.forEach((event) => {
    search.add(event.sequence, `${event.kind} ${event.name} ${JSON.stringify(event.payload)}`);
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  const now = Date.now();
  rates.push([now, data.batch.length * 3.57]);
  if (rates.length > RATE_WINDOW) rates.splice(0, rates.length - RATE_WINDOW);

  const durations = events
    .slice(-5_000)
    .map((event) => event.duration)
    .sort((a, b) => a - b);
  const graphSource = events.slice(-GRAPH_WINDOW);
  const graphEdges = buildGraphEdges(graphSource);
  const snapshot: WorkerSnapshot = {
    events: data.batch,
    rates,
    p95: durations[Math.floor(durations.length * 0.95)] ?? 0,
    graphNodes: graphSource.map((event) => ({
      id: event.id,
      label: event.name,
      kind: event.kind,
      duration: event.duration,
      status: event.status,
    })),
    graphEdges,
  };
  self.postMessage(snapshot);
};

function buildGraphEdges(source: TelemetryEvent[]) {
  const ids = new Set(source.map((event) => event.id));
  const causal = source.filter((event) => event.parentId && ids.has(event.parentId)).map((event) => ({ id: `parent:${event.parentId}-${event.id}`, source: event.parentId!, target: event.id, relation: "parent" as const }));
  const causalPairs = new Set(causal.map((edge) => `${edge.source}->${edge.target}`));
  const bySession = Map.groupBy(source, (event) => event.sessionId);
  const sequence = [...bySession].flatMap(([sessionId, sessionEvents]) => {
    const ordered = [...sessionEvents].sort((a,b) => a.sequence-b.sequence);
    return ordered.slice(1).flatMap((event, index) => {
      const previous = ordered[index];
      if (!previous || causalPairs.has(`${previous.id}->${event.id}`)) return [];
      return [{ id: `sequence:${sessionId}:${previous.id}-${event.id}`, source: previous.id, target: event.id, relation: "sequence" as const }];
    });
  });
  return [...causal, ...sequence];
}

export {};
