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
  phase: "idle" | "running" | "received" | "error";
  recording: boolean;
  recordedEvents: TelemetryEvent[];
  revealedCount: number;
  activeUrl?: string;
  expanded?: string;
  play: (playing: boolean) => void;
  seek: (cursor: number) => void;
  setSpeed: (speed: .5 | 1 | 2) => void;
  setMode: (mode: "education" | "developer") => void;
  setQuery: (query: string) => void;
  setInputUrl: (url: string) => void;
  toggleRecording: () => void;
  revealNext: () => void;
  toggle: (id: string) => void;
  ingest: (events: TelemetryEvent[]) => void;
  nodes: JourneyNode[];
}

export const useInternetJourneyStore = create<InternetJourneyState>((set) => ({
  cursor: 0, playing: false, speed: 1, mode: "education", query: "",
  phase: "idle", recording: false, recordedEvents: [], revealedCount: 0, activeUrl: undefined,
  nodes: internetJourneyNodes,
  play: (playing) => set({ playing }),
  seek: (cursor) => set({ cursor: Math.max(0, Math.min(internetJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), setMode: (mode) => set({ mode }), setQuery: (query) => set({ query }),
  toggleRecording: () => set((state) => ({ recording: !state.recording, recordedEvents: state.recording ? state.recordedEvents : [] })),
  revealNext: () => set((state) => ({ revealedCount: Math.min(internetJourneyNodes.length, state.revealedCount + 1) })),
  setInputUrl: (url) => set((state) => {
    const next = state.nodes.map((node) => ({ ...node, metadata: { ...node.metadata, summary: [...node.metadata.summary] } }));
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
      if (input) { input.status = "complete"; input.metadata.estimated = false; }
      if (input) input.metadata.measurement = "not-timed";
      if (parsedNode) parsedNode.metadata.summary = [{ label: "Absolute URL", value: "true" }, { label: "Origin", value: parsed.origin }];
      if (parsedNode) { parsedNode.status = "complete"; parsedNode.metadata.estimated = false; }
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
        node.metadata.summary = [{ label: "State", value: "Not reached because URL validation failed" }];
      }
      return { nodes: next, activeUrl: url, phase: "error", cursor: 0, playing: false, revealedCount: next.length };
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
    return { nodes: next, activeUrl: new URL(url).href, phase: "running", cursor: 1, playing: false, revealedCount: 1 };
  }),
  toggle: (id) => set((state) => ({ expanded: state.expanded === id ? undefined : id })),
  ingest: (events) => set((state) => {
    const next = state.nodes.map((node) => ({ ...node, metadata: { ...node.metadata, summary: [...node.metadata.summary] } }));
    for (const event of events) {
      if (event.kind !== "network") continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.requestedUrl === "string" && state.activeUrl) {
        try {
          if (new URL(payload.requestedUrl).href !== state.activeUrl) continue;
        } catch { continue; }
      }
      const stage = typeof payload.journeyStage === "string" ? payload.journeyStage : undefined;
      const node = stage ? next.find((candidate) => candidate.id === stage) : undefined;
      if (!node) continue;
      if (typeof payload.url === "string") {
        try {
          const parsed = new URL(payload.url);
          const input = next.find((candidate) => candidate.id === "url-input");
          const parsedNode = next.find((candidate) => candidate.id === "url-parse");
          if (input) {
            input.metadata.estimated = false;
            input.metadata.summary = [
              { label: "Protocol", value: parsed.protocol.replace(":", "") },
              { label: "Hostname", value: parsed.hostname },
              { label: "Port", value: parsed.port || (parsed.protocol === "https:" ? "443" : "80") },
              { label: "Path", value: parsed.pathname },
              { label: "Query", value: parsed.search.slice(1) || "—" },
              { label: "Fragment", value: parsed.hash.slice(1) || "—" },
            ];
          }
          if (parsedNode) {
            parsedNode.metadata.estimated = false;
            parsedNode.metadata.summary = [{ label: "Absolute URL", value: "true" }, { label: "Origin", value: parsed.origin }];
          }
        } catch {}
      }
      node.duration = event.duration;
      node.timestamp = event.timestamp;
      node.metadata.estimated = false;
      const measurement = payload.measurement;
      node.metadata.measurement = measurement === "boundary" || measurement === "reused" || measurement === "unavailable" || measurement === "not-timed"
        ? measurement
        : event.duration > 0 ? "measured" : "unavailable";
      node.status = event.status === "error"
        ? "error"
        : (event.status as string) === "skipped"
          ? "skipped"
          : node.metadata.measurement === "unavailable" ? "unavailable" : "complete";
      node.metadata.raw = JSON.stringify({ event, measurement: node.metadata.measurement }, null, 2);
      const measured = node.metadata.measurement === "measured" ? `${event.duration.toFixed(3)} ms` : "Unavailable";
      const isHttp3 = payload.httpVersion === "h3";
      if (stage === "tcp" && isHttp3) {
        node.title = "QUIC transport";
        node.description = "HTTP/3 uses QUIC over UDP instead of TCP.";
      }
      if (stage === "tls" && isHttp3) {
        node.title = "QUIC crypto handshake";
        node.description = "TLS 1.3 key establishment is integrated into the QUIC handshake.";
      }
      if (stage === "dns") node.metadata.summary = [
        { label: "Lookup time", value: measured },
        { label: typeof payload.primaryIp === "string" && payload.primaryIp.includes(":") ? "AAAA" : "A", value: typeof payload.primaryIp === "string" ? payload.primaryIp : "Unavailable" },
        { label: "TTL", value: "Unavailable from libcurl timing" },
        { label: "CNAME", value: "Unavailable from libcurl timing" },
      ];
      if (stage === "queue") node.metadata.summary = [
        { label: "Queue time", value: measured },
        { label: "Measurement", value: "libcurl scheduler queue" },
      ];
      if (stage === "cache") node.metadata.summary = [
        { label: "Decision", value: typeof payload.cacheDecision === "string" ? payload.cacheDecision : "Unavailable" },
        { label: "Status", value: payload.responseStatus === 304 ? "Revalidated" : "Network response" },
      ];
      if (stage === "routing") node.metadata.summary = [
        { label: "Route hops", value: "Unavailable without traceroute" },
        { label: "Scope", value: "Not exposed by libcurl" },
      ];
      if (stage === "proxy") node.metadata.summary = [
        { label: "Used", value: payload.usedProxy === true ? "Yes" : "No" },
        { label: "Tunnel timing", value: "Not exposed separately" },
      ];
      if (stage === "tcp") node.metadata.summary = [
        { label: isHttp3 ? "QUIC connect time" : "TCP connect time", value: measured },
        { label: "Remote IP", value: typeof payload.primaryIp === "string" ? payload.primaryIp : "Unavailable" },
        { label: "Retransmissions", value: "Unavailable from browser" },
      ];
      if (stage === "tls") node.metadata.summary = [
        { label: isHttp3 ? "QUIC crypto time" : "TLS handshake time", value: measured },
        { label: "Protocol", value: typeof payload.httpVersion === "string" ? payload.httpVersion : "Unavailable" },
        { label: "Certificate", value: "Not captured yet" },
      ];
      if (stage === "request") node.metadata.summary = [
        { label: "Preparation/send time", value: measured },
        { label: "Method", value: typeof payload.method === "string" ? payload.method : "Unavailable" },
        { label: "URL", value: typeof payload.url === "string" ? payload.url : "Unavailable" },
        { label: "Headers", value: "Not captured yet" },
      ];
      if (stage === "redirect") node.metadata.summary = [
        { label: "Redirect count", value: typeof payload.redirectCount === "number" ? `${payload.redirectCount}` : "Unavailable" },
        { label: "Per-hop timing", value: "Not captured yet" },
      ];
      if (stage === "server") node.metadata.summary = [
        { label: "Time to first byte", value: measured },
        { label: "Application", value: "Unavailable from browser" },
        { label: "Database", value: "Unavailable from browser" },
      ];
      if (stage === "response") node.metadata.summary = [
        { label: "Transfer time", value: measured },
        { label: "Status", value: typeof payload.responseStatus === "number" ? `${payload.responseStatus}` : "Unavailable" },
        { label: "Body size", value: typeof payload.responseBodyBytes === "number" ? `${payload.responseBodyBytes} B` : "Unavailable" },
        { label: "HTTP version", value: typeof payload.httpVersion === "string" ? payload.httpVersion : "Unavailable" },
        { label: "Content-Type", value: typeof payload.contentType === "string" ? payload.contentType : "Not provided" },
        { label: "Content-Encoding", value: typeof payload.contentEncoding === "string" ? payload.contentEncoding : "Not provided" },
        { label: "Cache-Control", value: typeof payload.cacheControl === "string" ? payload.cacheControl : "Not provided" },
        { label: "Redirects", value: typeof payload.redirectCount === "number" ? `${payload.redirectCount}` : "0" },
        { label: "Server", value: typeof payload.server === "string" ? payload.server : "Not disclosed" },
        { label: "Via", value: typeof payload.via === "string" ? payload.via : "Not provided" },
        { label: "Age", value: typeof payload.age === "string" ? payload.age : "Not provided" },
        { label: "ETag", value: typeof payload.etag === "string" ? payload.etag : "Not provided" },
      ];
      if (stage === "received") node.metadata.summary = [
        { label: "State", value: "Response received" },
        { label: "Boundary", value: "Continue to Browser Journey" },
      ];
      if (typeof payload.url === "string") node.metadata.summary = node.metadata.summary.map((item) => item.label === "URL" ? { ...item, value: payload.url as string } : item);
      if (typeof payload.responseStatus === "number") node.metadata.summary = node.metadata.summary.map((item) => item.label === "Status" ? { ...item, value: `${payload.responseStatus}` } : item);
      if (typeof payload.responseBodyBytes === "number") node.metadata.summary = node.metadata.summary.map((item) => item.label === "Body size" ? { ...item, value: `${payload.responseBodyBytes} B` } : item);
      if (typeof payload.httpVersion === "string" && stage === "response") {
        node.metadata.summary = [...node.metadata.summary.filter((item) => item.label !== "HTTP version"), { label: "HTTP version", value: payload.httpVersion }];
      }
      if (event.status === "error") {
        const failedIndex = next.findIndex((candidate) => candidate.id === node.id);
        const payloadError = typeof payload.error === "string" ? payload.error
          : typeof payload.errorMessage === "string" ? payload.errorMessage
          : typeof payload.failureReason === "string" ? payload.failureReason : "Network operation failed";
        node.metadata.summary = [
          { label: "Failure", value: payloadError },
          { label: "Failure stage", value: node.title },
          { label: "URL", value: typeof payload.url === "string" ? payload.url : state.activeUrl ?? "Unavailable" },
          { label: "Timestamp", value: new Date(event.timestamp).toISOString() },
          ...node.metadata.summary.filter((item) => !["Failure", "Failure stage", "URL", "Timestamp"].includes(item.label)),
        ];
        node.metadata.explanation = `${node.description} The operation failed here, so later network stages were not reached.`;
        for (let index = failedIndex + 1; index < next.length; index += 1) {
          const skipped = next[index];
          skipped.status = "skipped";
          skipped.duration = 0;
          skipped.timestamp = 0;
          skipped.metadata.estimated = false;
          skipped.metadata.measurement = "unavailable";
          skipped.metadata.summary = [{ label: "State", value: `Not reached: ${node.title} failed` }];
        }
      }
    }
    const failed = next.some((node) => node.status === "error");
    const received = next.find((node) => node.id === "received")?.status === "complete";
    return {
      nodes: next,
      phase: failed ? "error" : received ? "received" : state.phase,
      recordedEvents: state.recording ? [...state.recordedEvents, ...events] : state.recordedEvents,
    };
  }),
}));
