import { create } from "zustand";
import type { GraphEdgeModel, GraphNodeModel, TelemetryEvent } from "@/src/core/types";

const MAX_VISIBLE_EVENTS = 10_000;
const SETTINGS_STORAGE_KEY = "koko-observatory:settings";

export type InspectWaitUntil = "load" | "domcontentloaded" | "networkidle" | "domstable" | "done";

export interface ObservatorySettings {
  telemetryEndpoint: string;
  waitUntil: InspectWaitUntil;
  waitMs: number;
  observeMs: number;
  terminateMs: number;
  expandLazy: boolean;
  maxScrolls: number;
  scrollSettleMs: number;
  includeFrames: boolean;
  retention: number;
}

export const defaultObservatorySettings: ObservatorySettings = {
  telemetryEndpoint: process.env.NEXT_PUBLIC_KOKO_TELEMETRY_URL ?? "ws://127.0.0.1:9223/telemetry",
  waitUntil: "domcontentloaded",
  waitMs: 30_000,
  observeMs: 10_000,
  terminateMs: 90_000,
  expandLazy: false,
  maxScrolls: 80,
  scrollSettleMs: 250,
  includeFrames: false,
  retention: 10_000,
};

function persistSettings(settings: ObservatorySettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function readStoredSettings(): Partial<ObservatorySettings> {
  if (typeof window === "undefined") return {};
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null");
    return stored && typeof stored === "object" ? stored as Partial<ObservatorySettings> : {};
  } catch {
    return {};
  }
}

function validSettings(stored: Partial<ObservatorySettings>): ObservatorySettings {
  const waitUntil = ["load", "domcontentloaded", "networkidle", "domstable", "done"].includes(String(stored.waitUntil))
    ? stored.waitUntil as InspectWaitUntil
    : defaultObservatorySettings.waitUntil;
  const number = (value: unknown, fallback: number, maximum = 86_400_000) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.floor(parsed), maximum) : fallback;
  };
  return {
    telemetryEndpoint: typeof stored.telemetryEndpoint === "string" && stored.telemetryEndpoint.trim()
      ? stored.telemetryEndpoint.trim()
      : defaultObservatorySettings.telemetryEndpoint,
    waitUntil,
    waitMs: number(stored.waitMs, defaultObservatorySettings.waitMs),
    observeMs: number(stored.observeMs, defaultObservatorySettings.observeMs),
    terminateMs: number(stored.terminateMs, defaultObservatorySettings.terminateMs),
    expandLazy: stored.expandLazy === true,
    maxScrolls: number(stored.maxScrolls, defaultObservatorySettings.maxScrolls, 10_000),
    scrollSettleMs: number(stored.scrollSettleMs, defaultObservatorySettings.scrollSettleMs),
    includeFrames: stored.includeFrames === true,
    retention: number(stored.retention, defaultObservatorySettings.retention, MAX_VISIBLE_EVENTS),
  };
}

interface TelemetryState {
  events: TelemetryEvent[];
  total: number;
  retention: number;
  rate: Array<[number, number]>;
  p95: number;
  status: "connecting" | "live" | "paused" | "offline";
  lastEventAt?: number;
  append: (events: TelemetryEvent[], rate: Array<[number, number]>, p95: number) => void;
  hydrate: (events: TelemetryEvent[]) => void;
  setStatus: (status: TelemetryState["status"]) => void;
  setRetention: (retention: number) => void;
  clear: () => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  events: [],
  total: 0,
  retention: MAX_VISIBLE_EVENTS,
  rate: [],
  p95: 0,
  status: "offline",
  lastEventAt: undefined,
  append: (events, rate, p95) =>
    set((state) => ({
      events: [...state.events, ...events].slice(-Math.min(state.retention, MAX_VISIBLE_EVENTS)),
      total: state.total + events.length,
      rate,
      p95,
      lastEventAt: events.length ? events[events.length - 1].timestamp : state.lastEventAt,
    })),
  hydrate: (events) => set((state) => {
    if (!events.length) return state;
    const liveIds = new Set(state.events.map((event) => event.id));
    const restored = events.filter((event) => !liveIds.has(event.id));
    const merged = [...restored, ...state.events]
      .sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence)
      .slice(-Math.min(state.retention, MAX_VISIBLE_EVENTS));
    return {
      events: merged,
      total: Math.max(state.total, merged.length),
      lastEventAt: merged.at(-1)?.timestamp ?? state.lastEventAt,
    };
  }),
  setStatus: (status) => set({ status }),
  setRetention: (retention) => set((state) => ({ retention, events: state.events.slice(-retention) })),
  clear: () => set({ events: [], total: 0, rate: [], p95: 0, lastEventAt: undefined }),
}));

// HTML progress snapshots are deliberately separate from telemetry retention:
// only the latest snapshot is needed to render the live Export preview.
export const useExportStore = create<{
  progress?: TelemetryEvent;
  setProgress: (progress?: TelemetryEvent) => void;
}>((set) => ({
  progress: undefined,
  setProgress: (progress) => set({ progress }),
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
  inspectionStartedAt?: number;
  setActivePlugin: (id: string) => void;
  toggleSidebar: () => void;
  setCommandOpen: (open: boolean) => void;
  setInspectorUrl: (url: string) => void;
  setInspecting: (inspecting: boolean) => void;
  beginInspection: () => void;
}>((set) => ({
  activePlugin: "overview",
  sidebarCollapsed: false,
  commandOpen: false,
  inspectorUrl: "https://example.com",
  inspecting: false,
  inspectionStartedAt: undefined,
  setActivePlugin: (activePlugin) => set({ activePlugin }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setInspectorUrl: (inspectorUrl) => set({ inspectorUrl }),
  setInspecting: (inspecting) => set({ inspecting }),
  beginInspection: () => set({ inspectionStartedAt: Date.now() }),
}));

export const useSettingsStore = create<ObservatorySettings & {
  hydrated: boolean;
  sampleRate: number;
  hydrate: () => void;
  update: (patch: Partial<ObservatorySettings>) => void;
  reset: () => void;
  setSampleRate: (sampleRate: number) => void;
}>((set) => ({
  ...defaultObservatorySettings,
  hydrated: false,
  sampleRate: 1,
  hydrate: () => set((state) => {
    const settings = validSettings(readStoredSettings());
    return { ...state, ...settings, hydrated: true };
  }),
  update: (patch) => set((state) => {
    const settings = validSettings({ ...state, ...patch });
    persistSettings(settings);
    return { ...state, ...settings };
  }),
  reset: () => set(() => {
    persistSettings(defaultObservatorySettings);
    return { ...defaultObservatorySettings, hydrated: true, sampleRate: 1 };
  }),
  setSampleRate: (sampleRate) => set({ sampleRate }),
}));

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
