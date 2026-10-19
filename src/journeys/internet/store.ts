import { create } from "zustand";
import type { TelemetryEvent } from "@/src/core/types";
import { isMeasuredEvent } from "@/src/core/metrics";
import { internetJourneyNodes } from "./data";
import { applyNetworkEvent, cloneJourneyNodes, inspectionKey, mergeOtherTransfers, projectInspection, type OtherTransfer } from "./project";
import type { JourneyNode } from "./types";

interface InternetJourneyState {
  cursor: number;
  playing: boolean;
  speed: .5 | 1 | 2;
  mode: "education" | "developer";
  query: string;
  phase: "idle" | "running" | "received" | "error";
  recording: boolean;
  recordedEvents: TelemetryEvent[];
  revealedCount: number;
  activeUrl?: string;
  navigationRequestId?: string;
  executionId?: string;
  otherTransfers: OtherTransfer[];
  expanded?: string;
  play: (playing: boolean) => void;
  seek: (cursor: number) => void;
  setSpeed: (speed: .5 | 1 | 2) => void;
  setMode: (mode: "education" | "developer") => void;
  setQuery: (query: string) => void;
  setInputUrl: (url: string) => void;
  toggleRecording: () => void;
  clear: () => void;
  revealNext: () => void;
  toggle: (id: string) => void;
  ingest: (events: TelemetryEvent[]) => void;
  showStoredInspection: (events: TelemetryEvent[]) => void;
  nodes: JourneyNode[];
}

const idleNodes = () => cloneJourneyNodes(internetJourneyNodes);

export const useInternetJourneyStore = create<InternetJourneyState>((set) => ({
  cursor: 0, playing: false, speed: 1, mode: "education", query: "",
  phase: "idle", recording: false, recordedEvents: [], revealedCount: 0, activeUrl: undefined, navigationRequestId: undefined,
  executionId: undefined, otherTransfers: [],
  nodes: idleNodes(),
  play: (playing) => set({ playing }),
  seek: (cursor) => set({ cursor: Math.max(0, Math.min(internetJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), setMode: (mode) => set({ mode }), setQuery: (query) => set({ query }),
  clear: () => set({
    cursor: 0, playing: false, phase: "idle", recording: false, recordedEvents: [], revealedCount: 0,
    activeUrl: undefined, navigationRequestId: undefined, executionId: undefined, otherTransfers: [], expanded: undefined, nodes: idleNodes(),
  }),
  toggleRecording: () => set((state) => ({ recording: !state.recording, recordedEvents: state.recording ? state.recordedEvents : [] })),
  revealNext: () => set((state) => ({ revealedCount: Math.min(internetJourneyNodes.length, state.revealedCount + 1) })),
  // Start from the template so a previous HTTP/3 title cannot stick to the next document.
  setInputUrl: (url) => set(() => {
    const next = idleNodes();
    try {
      const parsed = new URL(url);
      const input = next.find((node) => node.id === "url-input");
      const parsedNode = next.find((node) => node.id === "url-parse");
      const routing = next.find((node) => node.id === "routing");
      if (input) input.metadata.summary = [
        { label: "Protocol", value: parsed.protocol.replace(":", "") }, { label: "Hostname", value: parsed.hostname },
        { label: "Port", value: parsed.port || (parsed.protocol === "https:" ? "443" : "80") },
        { label: "Path", value: parsed.pathname }, { label: "Query", value: parsed.search.slice(1) || "—" },
        { label: "Fragment", value: parsed.hash.slice(1) || "—" },
      ];
      if (input) { input.status = "complete"; input.metadata.estimated = false; input.metadata.explanation = `The document URL is ${parsed.href}.`; input.metadata.issues = []; }
      if (input) input.metadata.measurement = "not-timed";
      if (parsedNode) parsedNode.metadata.summary = [{ label: "Absolute URL", value: "true" }, { label: "Origin", value: parsed.origin }];
      if (parsedNode) { parsedNode.status = "complete"; parsedNode.metadata.estimated = false; parsedNode.metadata.explanation = `Parsed origin is ${parsed.origin}.`; parsedNode.metadata.issues = []; }
      if (parsedNode) parsedNode.metadata.measurement = "not-timed";
      if (routing) {
        routing.status = "skipped";
        routing.metadata.estimated = false;
        routing.metadata.measurement = "unavailable";
        routing.metadata.summary = [
          { label: "Route hops", value: "Unavailable without traceroute" },
          { label: "CDN", value: "Not inferred without response evidence" },
          { label: "Load balancer", value: "Not observable from browser" },
        ];
      }
    } catch {
      const input = next.find((node) => node.id === "url-input");
      if (input) {
        input.status = "error";
        input.metadata.estimated = false;
        input.metadata.measurement = "unavailable";
        input.metadata.summary = [
          { label: "Input", value: url || "(empty)" },
          { label: "Validation", value: "Invalid absolute URL" },
          { label: "Failure", value: "URL parsing stopped the journey" },
        ];
        input.metadata.explanation = "The request cannot start because the input is not a valid absolute URL with a supported scheme.";
        input.metadata.issues = ["Missing scheme (for example https://), malformed hostname, or invalid URL characters."];
        input.metadata.raw = JSON.stringify({ input: url, error: "Invalid absolute URL" }, null, 2);
      }
      for (const node of next) {
        if (node.id === "url-input") continue;
        node.status = "skipped";
        node.duration = 0;
        node.timestamp = 0;
        node.metadata.estimated = false;
        node.metadata.measurement = "unavailable";
        node.metadata.explanation = "Not reached because URL validation failed.";
        node.metadata.issues = [];
        node.metadata.practices = [];
        node.metadata.summary = [{ label: "State", value: "Not reached because URL validation failed" }];
      }
      return { nodes: next, activeUrl: url, navigationRequestId: undefined, executionId: undefined, otherTransfers: [], phase: "error", cursor: 0, playing: false, revealedCount: next.length };
    }
    for (const node of next) {
      if (node.id !== "url-input" && node.id !== "url-parse" && node.id !== "routing") {
        node.duration = 0;
        node.timestamp = 0;
        node.status = "pending";
        node.metadata.estimated = true;
        node.metadata.measurement = node.id === "received" ? "boundary" : "unavailable";
      }
    }
    return { nodes: next, activeUrl: new URL(url).href, navigationRequestId: undefined, executionId: undefined, otherTransfers: [], phase: "running", cursor: 1, playing: false, revealedCount: 1 };
  }),
  toggle: (id) => set((state) => ({ expanded: state.expanded === id ? undefined : id })),
  ingest: (events) => set((state) => {
    const recordedEvents = state.recording ? [...state.recordedEvents, ...events] : state.recordedEvents;
    let executionId = state.executionId;
    const accepted: TelemetryEvent[] = [];
    for (const event of events) {
      if (event.kind !== "network") continue;
      const key = inspectionKey(event);
      if (executionId && key && key !== executionId) continue;
      if (!executionId && key) executionId = key;
      accepted.push(event);
    }
    if (!accepted.length) return recordedEvents === state.recordedEvents ? {} : { recordedEvents };
    const nodes = cloneJourneyNodes(state.nodes);
    let navigationRequestId = state.navigationRequestId;
    let activeUrl = state.activeUrl;
    let otherTransfers = state.otherTransfers;
    for (const event of accepted) {
      const result = applyNetworkEvent(nodes, event, navigationRequestId, activeUrl, isMeasuredEvent(event) ? event.duration : 0);
      navigationRequestId = result.navigationRequestId;
      activeUrl = result.activeUrl;
      otherTransfers = [...mergeOtherTransfers(otherTransfers, result.otherTransfer)];
    }
    const failed = nodes.some((node) => node.status === "error");
    const received = nodes.find((node) => node.id === "received")?.status === "complete";
    return {
      nodes,
      navigationRequestId,
      executionId,
      otherTransfers,
      activeUrl,
      phase: failed ? "error" : received ? "received" : state.phase === "idle" && navigationRequestId ? "running" : state.phase,
      recordedEvents,
    };
  }),
  // History can arrive after the user has already started a new inspect. Only an idle page accepts it.
  showStoredInspection: (events) => set((state) => {
    if (state.phase !== "idle") return {};
    const projected = projectInspection(internetJourneyNodes, events);
    if (!projected.navigationRequestId) return {};
    return {
      nodes: projected.nodes,
      navigationRequestId: projected.navigationRequestId,
      executionId: projected.executionId,
      otherTransfers: projected.otherTransfers,
      phase: projected.phase,
      activeUrl: projected.activeUrl,
      revealedCount: internetJourneyNodes.length,
      cursor: 0,
      playing: false,
    };
  }),
}));
