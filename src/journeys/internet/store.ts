import { create } from "zustand";
import { internetJourneyNodes } from "./data";
import type { TelemetryEvent } from "@/src/core/types";
import type { JourneyNode } from "./types";

interface InternetJourneyState {
  cursor: number;
  playing: boolean;
  speed: .5 | 1 | 2;
  mode: "education" | "developer";
  query: string;
  expanded?: string;
  play: (playing: boolean) => void;
  seek: (cursor: number) => void;
  setSpeed: (speed: .5 | 1 | 2) => void;
  setMode: (mode: "education" | "developer") => void;
  setQuery: (query: string) => void;
  toggle: (id: string) => void;
  ingest: (events: TelemetryEvent[]) => void;
  nodes: JourneyNode[];
}

export const useInternetJourneyStore = create<InternetJourneyState>((set) => ({
  cursor: internetJourneyNodes.length - 1, playing: false, speed: 1, mode: "education", query: "",
  nodes: internetJourneyNodes,
  play: (playing) => set({ playing }),
  seek: (cursor) => set({ cursor: Math.max(0, Math.min(internetJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), setMode: (mode) => set({ mode }), setQuery: (query) => set({ query }),
  toggle: (id) => set((state) => ({ expanded: state.expanded === id ? undefined : id })),
  ingest: (events) => set((state) => {
    const next = state.nodes.map((node) => ({ ...node, metadata: { ...node.metadata, summary: [...node.metadata.summary] } }));
    for (const event of events) {
      if (event.kind !== "network") continue;
      const payload = event.payload as Record<string, unknown>;
      const stage = typeof payload.journeyStage === "string" ? payload.journeyStage : undefined;
      const node = stage ? next.find((candidate) => candidate.id === stage) : undefined;
      if (!node) continue;
      node.duration = event.duration;
      node.timestamp = event.timestamp;
      node.status = event.status === "error" ? "active" : "complete";
      node.metadata.estimated = false;
      if (typeof payload.url === "string") node.metadata.summary = node.metadata.summary.map((item) => item.label === "URL" ? { ...item, value: payload.url as string } : item);
      if (typeof payload.responseStatus === "number") node.metadata.summary = node.metadata.summary.map((item) => item.label === "Status" ? { ...item, value: `${payload.responseStatus}` } : item);
      if (typeof payload.responseBodyBytes === "number") node.metadata.summary = node.metadata.summary.map((item) => item.label === "Body size" ? { ...item, value: `${payload.responseBodyBytes} B` } : item);
    }
    return { nodes: next };
  }),
}));
