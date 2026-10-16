import { create } from "zustand";
import type { TelemetryEvent } from "@/src/core/types";
import { isMeasuredEvent } from "@/src/core/metrics";
import { lockDocumentRequest, matchesLockedDocument } from "@/src/core/document-transfer";
import { browserJourneyNodes } from "./data";
import type { BrowserJourneyNode } from "./types";
import { buildTrace, extendTrace, type BrowserTrace } from "./trace-model";

const stageByKind: Partial<Record<TelemetryEvent["kind"], string>> = { dom: "dom", javascript: "javascript", scheduler: "event-loop", render: "paint", memory: "raster" };
const traceEventIds = new Set<string>();

function replaceTraceIds(events: TelemetryEvent[]) {
  traceEventIds.clear();
  for (const event of events) traceEventIds.add(event.id);
}

export const useBrowserJourneyStore = create<{
  nodes: BrowserJourneyNode[]; trace: BrowserTrace; cursor: number; playing: boolean; speed: .5 | 1 | 2; revealed: number;
  phase: "idle" | "waiting" | "running" | "complete" | "blocked"; blockedReason?: string; navigationRequestId?: string;
  play: (value: boolean) => void; seek: (value: number) => void; setSpeed: (value: .5 | 1 | 2) => void; reveal: () => void; reset: () => void; clear: () => void; block: (reason: string) => void; ingest: (events: TelemetryEvent[]) => void;
}>((set) => ({
  nodes: browserJourneyNodes, trace: buildTrace([]), cursor: 0, playing: false, speed: 1, revealed: 0, phase: "idle", blockedReason: undefined, navigationRequestId: undefined,
  play: (playing) => set({ playing }), seek: (cursor) => set({ cursor: Math.max(0, Math.min(browserJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), reveal: () => set((state) => ({ revealed: Math.min(browserJourneyNodes.length, state.revealed + 1) })),
  reset: () => {
    traceEventIds.clear();
    set({ nodes: browserJourneyNodes.map((item) => ({ ...item, metadata: {} })), trace: buildTrace([]), cursor: 0, playing: false, revealed: 0, phase: "waiting", blockedReason: undefined, navigationRequestId: undefined });
  },
  clear: () => {
    traceEventIds.clear();
    set({ nodes: browserJourneyNodes.map((item) => ({ ...item, metadata: {} })), trace: buildTrace([]), cursor: 0, playing: false, revealed: 0, phase: "idle", blockedReason: undefined, navigationRequestId: undefined });
  },
  block: (blockedReason) => set({ phase: "blocked", blockedReason, revealed: 0, playing: false }),
  ingest: (events) => set((state) => {
    const fresh: TelemetryEvent[] = [];
    for (const event of events) {
      if (traceEventIds.has(event.id)) continue;
      traceEventIds.add(event.id);
      fresh.push(event);
    }
    if (!fresh.length) return state;
    const nodes = state.nodes.map((item) => ({ ...item, metadata: { ...item.metadata } }));
    const markBoundary = (id: string, source: string, metadata: Record<string, string | number> = {}) => {
      const item = nodes.find((candidate) => candidate.id === id);
      if (!item || item.status === "complete") return;
      item.status = "complete";
      item.metadata = { ...item.metadata, ...metadata, measurement: "Boundary derived from Koko telemetry", source };
    };
    let phase = state.phase;
    let blockedReason = state.blockedReason;
    let revealed = state.revealed;
    let navigationRequestId = state.navigationRequestId;
    for (const event of fresh) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.inspectionState === "completed") {
        // The reveal timer is only a presentation aid. Do not make the user
        // wait through one animation tick per browser stage after Core has
        // already declared the inspection complete.
        phase = "complete";
        revealed = nodes.length;
        continue;
      }
      if (event.kind === "network") {
        navigationRequestId = lockDocumentRequest(payload, navigationRequestId);
        // A failed image, beacon or XHR must not freeze the browser pipeline.
        // Only the locked document navigation can do that, and only its
        // response duration is attributed to the response node.
        if (!matchesLockedDocument(payload, navigationRequestId)) continue;
        if (event.status === "error") {
          const failedStage = typeof payload.failureStage === "string" ? payload.failureStage : typeof payload.journeyStage === "string" ? payload.journeyStage : "network request";
          phase = "blocked";
          blockedReason = `Internet Journey failed at ${failedStage}. No HTTP response entered the browser pipeline.`;
          revealed = 0;
          continue;
        }
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
      const measuredDuration = isMeasuredEvent(event) ? event.duration : 0;
      // The document emits a measured response stage and then a zero-duration
      // received boundary. Keep the measured value. Do not add every
      // subresource: those events never reach this node.
      target.duration = event.kind === "network"
        ? (measuredDuration > 0 ? measuredDuration : target.duration)
        : target.duration + measuredDuration;
      target.timestamp = event.timestamp; target.status = event.status === "error" ? "error" : "complete";
      target.metadata = { events: Number(target.metadata.events ?? 0) + 1, lastEvent: event.name, measurement: typeof payload.measurementState === "string" ? payload.measurementState : "Koko telemetry" };
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
        markBoundary("cache", "Network cache decision", { cacheDecision: typeof payload.cacheDecision === "string" ? payload.cacheDecision : "not-observed" });
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
    const trace = extendTrace(state.trace, fresh);
    if (trace.events.length < traceEventIds.size) replaceTraceIds(trace.events);
    return { nodes, phase, blockedReason, revealed, navigationRequestId, trace };
  }),
}));
