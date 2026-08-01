import { create } from "zustand";
import type { TelemetryEvent } from "@/src/core/types";
import { browserJourneyNodes } from "./data";
import type { BrowserJourneyNode } from "./types";
import { buildTrace, type BrowserTrace } from "./trace-model";

const stageByKind: Partial<Record<TelemetryEvent["kind"], string>> = { dom: "dom", javascript: "javascript", scheduler: "event-loop", render: "paint", memory: "raster" };

export const useBrowserJourneyStore = create<{
  nodes: BrowserJourneyNode[]; trace: BrowserTrace; cursor: number; playing: boolean; speed: .5 | 1 | 2; revealed: number;
  play: (value: boolean) => void; seek: (value: number) => void; setSpeed: (value: .5 | 1 | 2) => void; reveal: () => void; reset: () => void; ingest: (events: TelemetryEvent[]) => void;
}>((set) => ({
  nodes: browserJourneyNodes, trace: buildTrace([]), cursor: 0, playing: false, speed: 1, revealed: browserJourneyNodes.length,
  play: (playing) => set({ playing }), seek: (cursor) => set({ cursor: Math.max(0, Math.min(browserJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), reveal: () => set((state) => ({ revealed: Math.min(browserJourneyNodes.length, state.revealed + 1) })),
  reset: () => set({ nodes: browserJourneyNodes, trace: buildTrace([]), cursor: 0, playing: false, revealed: browserJourneyNodes.length }),
  ingest: (events) => set((state) => {
    const nodes = state.nodes.map((item) => ({ ...item, metadata: { ...item.metadata } }));
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const stage = typeof payload.browserStage === "string" ? payload.browserStage :
        (event.kind === "network" && (payload.journeyStage === "received" || payload.journeyStage === "response") ? "response" : stageByKind[event.kind]);
      const target = nodes.find((item) => item.id === stage);
      if (!target) continue;
      target.duration += event.duration; target.timestamp = event.timestamp; target.status = event.status === "error" ? "active" : "complete";
      target.metadata = { events: Number(target.metadata.events ?? 0) + 1, lastEvent: event.name, measurement: "Velora telemetry" };
      if (typeof payload.scriptUrl === "string") target.metadata.scriptUrl = payload.scriptUrl;
      if (typeof payload.scriptKind === "string") target.metadata.scriptKind = payload.scriptKind;
      for (const key of ["contentType", "contentEncoding", "responseMemoryState"]) if (typeof payload[key] === "string") target.metadata[key] = payload[key] as string;
      for (const key of ["compressedSizeBytes", "uncompressedSizeBytes", "responseMemoryBytes", "responseBodyBytes"]) if (typeof payload[key] === "number") target.metadata[key] = payload[key] as number;
    }
    return { nodes, trace: buildTrace([...state.trace.events, ...events].slice(-50_000)) };
  }),
}));
