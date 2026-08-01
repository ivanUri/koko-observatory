import type { TelemetryEvent } from "@/src/core/types";

export type MeasurementState = "measured" | "estimated" | "derived" | "reused" | "cached" | "below-resolution" | "unavailable" | "not-applicable";
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
    return { id: event.id, stage: typeof payload.browserStage === "string" ? payload.browserStage : event.kind, start: event.timestamp, duration: event.duration, process, thread, state: "measured" as const, event };
  });
  const resources = events.filter((event) => event.kind === "network").map((event) => ({ id: event.id, url: String(event.payload.url ?? "Unknown"), type: String(event.payload.contentType ?? "resource"), duration: event.duration, cache: String(event.payload.cacheStatus ?? "Unavailable"), size: typeof event.payload.responseBodyBytes === "number" ? event.payload.responseBodyBytes : undefined }));
  return { sessionId: events.at(-1)?.sessionId, events, spans, frames: [], resources };
}

export function browserCalls(events: TelemetryEvent[]): BrowserCall[] {
  return events.flatMap((event) => {
    const p = event.payload;
    if (event.kind !== "javascript" || typeof p.functionName !== "string") return [];
    return [{ id: String(p.callId ?? event.id), parentId: typeof p.parentCallId === "string" ? p.parentCallId : undefined, name: p.functionName, kind: String(p.callKind ?? "script"), url: typeof p.scriptUrl === "string" ? p.scriptUrl : undefined, start: event.timestamp, duration: event.duration, depth: typeof p.callDepth === "number" ? p.callDepth : 0 }];
  });
}
