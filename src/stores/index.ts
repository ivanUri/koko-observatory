import { create } from "zustand";
import type { GraphEdgeModel, GraphNodeModel, TelemetryEvent } from "@/src/core/types";

const MAX_VISIBLE_EVENTS = 10_000;

interface TelemetryState {
  events: TelemetryEvent[];
  total: number;
  rate: Array<[number, number]>;
  p95: number;
  status: "connecting" | "live" | "paused" | "offline";
  lastEventAt?: number;
  append: (events: TelemetryEvent[], rate: Array<[number, number]>, p95: number) => void;
  setStatus: (status: TelemetryState["status"]) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  events: [],
  total: 0,
  rate: [],
  p95: 0,
  status: "offline",
  lastEventAt: undefined,
  append: (events, rate, p95) =>
    set((state) => ({
      events: [...state.events, ...events].slice(-MAX_VISIBLE_EVENTS),
      total: state.total + events.length,
      rate,
      p95,
      lastEventAt: events.length ? events[events.length - 1].timestamp : state.lastEventAt,
    })),
  setStatus: (status) => set({ status }),
}));

export const useGraphStore = create<{
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  layout: "dagre" | "elk" | "force" | "tree" | "radial";
  update: (nodes: GraphNodeModel[], edges: GraphEdgeModel[]) => void;
  setLayout: (layout: "dagre" | "elk" | "force" | "tree" | "radial") => void;
}>((set) => ({
  nodes: [],
  edges: [],
  layout: "dagre",
  update: (nodes, edges) => set({ nodes, edges }),
  setLayout: (layout) => set({ layout }),
}));

export const useTimelineStore = create<{
  range: [number, number];
  zoom: number;
  setRange: (range: [number, number]) => void;
}>((set) => ({ range: [0, Date.now()], zoom: 1, setRange: (range) => set({ range }) }));

export const useNetworkStore = create<{
  filter: string;
  setFilter: (filter: string) => void;
}>((set) => ({ filter: "", setFilter: (filter) => set({ filter }) }));

export const useUIStore = create<{
  activePlugin: string;
  sidebarCollapsed: boolean;
  commandOpen: boolean;
  inspectorUrl: string;
  inspecting: boolean;
  setActivePlugin: (id: string) => void;
  toggleSidebar: () => void;
  setCommandOpen: (open: boolean) => void;
  setInspectorUrl: (url: string) => void;
  setInspecting: (inspecting: boolean) => void;
}>((set) => ({
  activePlugin: "overview",
  sidebarCollapsed: false,
  commandOpen: false,
  inspectorUrl: "https://example.com",
  inspecting: false,
  setActivePlugin: (activePlugin) => set({ activePlugin }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setInspectorUrl: (inspectorUrl) => set({ inspectorUrl }),
  setInspecting: (inspecting) => set({ inspecting }),
}));

export const useSettingsStore = create<{
  retention: number;
  sampleRate: number;
  setSampleRate: (sampleRate: number) => void;
}>((set) => ({ retention: 1_000_000, sampleRate: 1, setSampleRate: (sampleRate) => set({ sampleRate }) }));

export const useSelectionStore = create<{
  eventId?: string;
  select: (eventId?: string) => void;
}>((set) => ({ select: (eventId) => set({ eventId }) }));

export const useReplayStore = create<{
  status: "idle" | "recording" | "replaying";
  cursor: number;
  setStatus: (status: "idle" | "recording" | "replaying") => void;
  seek: (cursor: number) => void;
}>((set) => ({ status: "idle", cursor: 0, setStatus: (status) => set({ status }), seek: (cursor) => set({ cursor }) }));
