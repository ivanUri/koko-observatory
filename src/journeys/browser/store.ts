import { create } from "zustand";
import type { TelemetryEvent } from "@/src/core/types";
import { browserJourneyNodes } from "./data";
import type { BrowserJourneyNode } from "./types";
import { buildTrace, type BrowserTrace } from "./trace-model";

const stageByKind: Partial<Record<TelemetryEvent["kind"], string>> = { dom: "dom", javascript: "javascript", scheduler: "event-loop", render: "paint", memory: "raster" };

export const useBrowserJourneyStore = create<{
  nodes: BrowserJourneyNode[]; trace: BrowserTrace; cursor: number; playing: boolean; speed: .5 | 1 | 2; revealed: number;
  phase: "idle" | "waiting" | "running" | "complete" | "blocked"; blockedReason?: string;
  play: (value: boolean) => void; seek: (value: number) => void; setSpeed: (value: .5 | 1 | 2) => void; reveal: () => void; reset: () => void; block: (reason: string) => void; ingest: (events: TelemetryEvent[]) => void;
}>((set) => ({
  nodes: browserJourneyNodes, trace: buildTrace([]), cursor: 0, playing: false, speed: 1, revealed: 0, phase: "idle", blockedReason: undefined,
  play: (playing) => set({ playing }), seek: (cursor) => set({ cursor: Math.max(0, Math.min(browserJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), reveal: () => set((state) => ({ revealed: Math.min(browserJourneyNodes.length, state.revealed + 1) })),
  reset: () => set({ nodes: browserJourneyNodes.map((item) => ({ ...item, metadata: {} })), trace: buildTrace([]), cursor: 0, playing: false, revealed: 0, phase: "waiting", blockedReason: undefined }),
  block: (blockedReason) => set({ phase: "blocked", blockedReason, revealed: 0, playing: false }),
  ingest: (events) => set((state) => {
    const nodes = state.nodes.map((item) => ({ ...item, metadata: { ...item.metadata } }));
    const markBoundary = (id: string, source: string, metadata: Record<string, string | number> = {}) => {
      const item = nodes.find((candidate) => candidate.id === id);
      if (!item || item.status === "complete") return;
      item.status = "complete";
      item.metadata = { ...item.metadata, ...metadata, measurement: "Boundary derived from Velora telemetry", source };
    };
    let phase = state.phase;
    let blockedReason = state.blockedReason;
    let revealed = state.revealed;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.kind === "network" && event.status === "error") {
        const failedStage = typeof payload.failureStage === "string" ? payload.failureStage : typeof payload.journeyStage === "string" ? payload.journeyStage : "network request";
        phase = "blocked";
        blockedReason = `Internet Journey failed at ${failedStage}. No HTTP response entered the browser pipeline.`;
        revealed = 0;
        continue;
      }
      if (phase === "blocked") continue;
      if (event.kind === "network" && payload.journeyStage === "received" && event.status === "ok") {
        phase = "running";
        revealed = Math.max(revealed, 1);
      }
      const stage = typeof payload.browserStage === "string" ? payload.browserStage :
        (event.kind === "network" && (payload.journeyStage === "received" || payload.journeyStage === "response") ? "response" : stageByKind[event.kind]);
      const target = nodes.find((item) => item.id === stage);
      if (!target) continue;
      target.duration += event.duration; target.timestamp = event.timestamp; target.status = event.status === "error" ? "active" : "complete";
      target.metadata = { events: Number(target.metadata.events ?? 0) + 1, lastEvent: event.name, measurement: typeof payload.measurementState === "string" ? payload.measurementState : "Velora telemetry" };
      if (typeof payload.scriptUrl === "string") target.metadata.scriptUrl = payload.scriptUrl;
      if (typeof payload.scriptKind === "string") target.metadata.scriptKind = payload.scriptKind;
      for (const key of ["contentType", "contentEncoding", "responseMemoryState"]) if (typeof payload[key] === "string") target.metadata[key] = payload[key] as string;
      for (const key of ["compressedSizeBytes", "uncompressedSizeBytes", "responseMemoryBytes", "responseBodyBytes"]) if (typeof payload[key] === "number") target.metadata[key] = payload[key] as number;
      if (stage === "response" && event.status === "ok") {
        markBoundary("decompression", "HTTP response metadata", {
          contentEncoding: typeof payload.contentEncoding === "string" ? payload.contentEncoding : "identity / not provided",
          compressedSizeBytes: typeof payload.compressedSizeBytes === "number" ? payload.compressedSizeBytes : 0,
          uncompressedSizeBytes: typeof payload.uncompressedSizeBytes === "number" ? payload.uncompressedSizeBytes : typeof payload.responseBodyBytes === "number" ? payload.responseBodyBytes : 0,
        });
        markBoundary("cache", "Network cache decision", { cacheDecision: typeof payload.cacheDecision === "string" ? payload.cacheDecision : "network" });
      }
      if (stage === "html-parser") markBoundary("preload", "HTML parser boundary", { measurement: "Scanner activity not timed separately" });
      if (stage === "dom") {
        const css = nodes.find((candidate) => candidate.id === "css-parser");
        if (css?.status === "pending") { css.status = "unavailable"; css.metadata = { measurement: "No typed CSS parser timing emitted", source: "DOM completion boundary" }; }
      }
      if (stage === "layout") markBoundary("style", "Layout requires resolved styles", { measurement: "Style completion boundary; duration not isolated" });
      if (stage === "frame" && target.status === "complete") {
        for (const [id, source] of [["paint", "Frame completion"], ["layers", "Frame completion"], ["raster", "Frame completion"], ["composite", "Frame presentation"]] as const) markBoundary(id, source, { measurement: "Completion boundary; duration not isolated" });
        for (const pending of nodes) {
          if (pending.status !== "pending") continue;
          pending.status = "unavailable";
          pending.metadata = { ...pending.metadata, measurement: "Core has no isolated typed signal for this stage", source: "Frame completed" };
        }
        phase = "complete";
      }
    }
    return { nodes, phase, blockedReason, revealed, trace: buildTrace([...state.trace.events, ...events].slice(-50_000)) };
  }),
}));
