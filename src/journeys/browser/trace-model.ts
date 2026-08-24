import type { TelemetryEvent } from "@/src/core/types";
import { isMeasuredEvent } from "@/src/core/metrics";

export type MeasurementState = "measured" | "estimated" | "derived" | "reused" | "cached" | "below-resolution" | "unavailable" | "not-applicable" | "error";
export interface BrowserSpan { id: string; stage: string; start: number; duration: number; thread: string; process: string; state: MeasurementState; event: TelemetryEvent; }
export interface BrowserFrame { id: string; start: number; duration: number; spans: string[]; presented: boolean; }
export interface BrowserResource { id: string; url: string; type: string; duration: number; cache: string; size?: number; }
export interface BrowserCall { id: string; parentId?: string; name: string; kind: string; url?: string; start: number; duration: number; depth: number; }
export interface BrowserTrace { sessionId?: string; navigationId?: string; events: TelemetryEvent[]; spans: BrowserSpan[]; frames: BrowserFrame[]; resources: BrowserResource[]; }

const ownership: Record<string, [string, string]> = {
  dom: ["Renderer", "Main"], javascript: ["Renderer", "Main"], scheduler: ["Renderer", "Main"],
  render: ["Renderer", "Compositor"], memory: ["Renderer", "Worker"], network: ["Browser", "Network"],
};
export function buildTrace(events: TelemetryEvent[]): BrowserTrace {
  const spans = events.map((event) => {
    const [process, thread] = ownership[event.kind] ?? ["Browser", "Unknown"];
    const payload = event.payload as Record<string, unknown>;
    const rawState = String(payload.measurementState ?? payload.measurement ?? "").toLowerCase();
    const state = event.status === "error" ? "error" : isMeasuredEvent(event) ? "measured" : ["estimated", "derived", "reused", "cached", "below-resolution", "unavailable", "not-applicable"].includes(rawState) ? rawState as MeasurementState : "unavailable";
    return { id: event.id, stage: typeof payload.browserStage === "string" ? payload.browserStage : event.kind, start: event.timestamp, duration: event.duration, process, thread, state, event };
  });
  const resourceGroups = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    if (event.kind !== "network" || !(typeof event.payload.resourceType === "string" || typeof event.payload.initiatorType === "string" || ["preload", "resource"].includes(String(event.payload.browserStage ?? "")))) continue;
    const requestId = event.payload.requestId == null ? undefined : String(event.payload.requestId);
    const key = requestId ? `${event.sessionId}|request:${requestId}` : `event:${event.id}`;
    resourceGroups.set(key, [...(resourceGroups.get(key) ?? []), event]);
  }
  const resources = [...resourceGroups].map(([key, grouped]) => {
    const ordered = [...grouped].sort((a, b) => a.sequence - b.sequence);
    const latest = ordered.at(-1)!;
    return { id: key, url: String(latest.payload.url ?? "Unknown"), type: String(latest.payload.resourceType ?? latest.payload.contentType ?? "resource"), duration: ordered.reduce((sum, event) => sum + Math.max(0, event.duration), 0), cache: String(latest.payload.cacheStatus ?? latest.payload.cacheDecision ?? "Unavailable"), size: typeof latest.payload.responseBodyBytes === "number" ? latest.payload.responseBodyBytes : undefined };
  });
  const frames = events.filter((event) => event.kind === "render" && ["frame", "present", "composite"].includes(String(event.payload.browserStage ?? event.name))).map((event) => ({ id: event.id, start: event.timestamp, duration: event.duration, spans: [], presented: String(event.payload.browserStage ?? event.name) === "frame" || String(event.payload.browserStage ?? event.name) === "present" }));
  return { sessionId: events.at(-1)?.sessionId, events, spans, frames, resources };
}

export function browserCalls(events: TelemetryEvent[]): BrowserCall[] {
  return events.flatMap((event) => {
    const p = event.payload;
    if (event.kind !== "javascript" || typeof p.functionName !== "string") return [];
    return [{ id: String(p.callId ?? event.id), parentId: typeof p.parentCallId === "string" ? p.parentCallId : undefined, name: p.functionName, kind: String(p.callKind ?? "script"), url: typeof p.scriptUrl === "string" ? p.scriptUrl : undefined, start: event.timestamp, duration: event.duration, depth: typeof p.callDepth === "number" ? p.callDepth : 0 }];
  });
}
