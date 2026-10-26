import type { TelemetryEvent } from "../../core/types.ts";
import { isMeasuredEvent } from "../../core/metrics.ts";

export type MeasurementState = "measured" | "estimated" | "derived" | "reused" | "cached" | "below-resolution" | "unavailable" | "not-applicable" | "error";
export interface BrowserSpan { id: string; stage: string; start: number; duration: number; thread: string; process: string; state: MeasurementState; event: TelemetryEvent; }
export interface BrowserFrame { id: string; start: number; duration: number; spans: string[]; presented: boolean; }
export interface BrowserResource { id: string; url: string; type: string; duration: number; cache: string; size?: number; }
export interface BrowserCall { id: string; parentId?: string; name: string; kind: string; url?: string; start: number; duration: number; depth: number; }
export interface BrowserTrace {
  sessionId?: string;
  navigationId?: string;
  events: TelemetryEvent[];
  spans: BrowserSpan[];
  frames: BrowserFrame[];
  resources: BrowserResource[];
  presentedFrameIds: Set<string>;
  resourceSequence: Map<string, number>;
}

/** Retained browser trace. Appending stays inside this window instead of copying a new cap. */
export const traceEventLimit = 50_000;

const ownership: Record<string, [string, string]> = {
  dom: ["Renderer", "Main"], javascript: ["Renderer", "Main"], scheduler: ["Renderer", "Main"],
  render: ["Renderer", "Compositor"], memory: ["Renderer", "Worker"], network: ["Browser", "Network"],
};

function spanFromEvent(event: TelemetryEvent): BrowserSpan {
  const browserStage = typeof event.payload.browserStage === "string" ? event.payload.browserStage : undefined;
  const ownerKind = browserStage === "javascript" ? "javascript" : browserStage === "event-loop" || browserStage === "scheduler" ? "scheduler" : browserStage === "dom" || browserStage === "mutations" ? "dom" : browserStage ? "render" : ["dom", "javascript", "scheduler", "network"].includes(event.kind) ? event.kind : undefined;
  const payload = event.payload as Record<string, unknown>;
  const [fallbackProcess, fallbackThread] = ownership[ownerKind] ?? ["Browser", "Unknown"];
  const process = typeof payload.processName === "string" ? payload.processName : typeof payload.process === "string" ? payload.process : fallbackProcess;
  const thread = typeof payload.threadName === "string" ? payload.threadName : typeof payload.thread === "string" ? payload.thread : fallbackThread;
  const rawState = String(payload.measurementState ?? payload.measurement ?? "").toLowerCase();
  const state = event.status === "error" ? "error" : isMeasuredEvent(event) ? "measured" : ["estimated", "derived", "reused", "cached", "below-resolution", "unavailable", "not-applicable"].includes(rawState) ? rawState as MeasurementState : "unavailable";
  return { id: event.id, stage: browserStage === "frame" ? "document-complete" : browserStage ?? event.kind, start: event.timestamp, duration: isMeasuredEvent(event) ? event.duration : 0, process, thread, state, event };
}

function resourceKey(event: TelemetryEvent) {
  if (event.kind !== "network" || !(typeof event.payload.resourceType === "string" || typeof event.payload.initiatorType === "string" || ["preload", "resource"].includes(String(event.payload.browserStage ?? "")))) return undefined;
  const requestId = event.payload.requestId == null ? undefined : String(event.payload.requestId);
  return requestId ? `${event.sessionId}|request:${requestId}` : `event:${event.id}`;
}

function resourceFrom(event: TelemetryEvent, id: string, duration: number): BrowserResource {
  return {
    id,
    url: String(event.payload.url ?? "Unknown"),
    type: String(event.payload.resourceType ?? event.payload.contentType ?? "resource"),
    duration,
    cache: String(event.payload.cacheStatus ?? event.payload.cacheDecision ?? "Unavailable"),
    size: typeof event.payload.responseBodyBytes === "number" ? event.payload.responseBodyBytes : undefined,
  };
}

function mergeResources(resources: BrowserResource[], events: TelemetryEvent[], sequences: Map<string, number>) {
  const byId = new Map(resources.map((resource) => [resource.id, { ...resource }]));
  for (const event of events) {
    const key = resourceKey(event);
    if (!key) continue;
    const duration = isMeasuredEvent(event) ? event.duration : 0;
    const previous = byId.get(key);
    const previousSequence = sequences.get(key);
    if (!previous || previousSequence == null) {
      byId.set(key, resourceFrom(event, key, duration));
      sequences.set(key, event.sequence);
      continue;
    }
    previous.duration += duration;
    if (event.sequence >= previousSequence) {
      const latest = resourceFrom(event, key, previous.duration);
      byId.set(key, latest);
      sequences.set(key, event.sequence);
    }
  }
  return [...byId.values()];
}

function framesFrom(events: TelemetryEvent[], presentedIds: Set<string>) {
  const frames: BrowserFrame[] = [];
  for (const event of events) {
    if (event.kind !== "render") continue;
    const stage = String(event.payload.browserStage ?? event.name);
    if (!["frame", "present", "composite"].includes(stage)) continue;
    const presented = stage === "present" || event.payload.presentedFrameId != null;
    const presentationId = presented ? String(event.payload.presentedFrameId ?? event.id) : undefined;
    if (presentationId && presentedIds.has(presentationId)) continue;
    if (presentationId) presentedIds.add(presentationId);
    frames.push({ id: event.id, start: event.timestamp, duration: isMeasuredEvent(event) ? event.duration : 0, spans: [], presented });
  }
  return frames;
}

export function buildTrace(events: TelemetryEvent[]): BrowserTrace {
  const presentedFrameIds = new Set<string>();
  const resourceSequence = new Map<string, number>();
  return {
    sessionId: events.at(-1)?.sessionId,
    events,
    spans: events.map(spanFromEvent),
    frames: framesFrom(events, presentedFrameIds),
    resources: mergeResources([], events, resourceSequence),
    presentedFrameIds,
    resourceSequence,
  };
}

/** Append events that are not already in the trace. Rebuild only when the retained window slides. */
export function extendTrace(trace: BrowserTrace, batch: TelemetryEvent[]): BrowserTrace {
  if (!batch.length) return trace;
  if (trace.events.length + batch.length > traceEventLimit) {
    return buildTrace([...trace.events, ...batch].slice(-traceEventLimit));
  }
  const presentedFrameIds = new Set(trace.presentedFrameIds);
  const resourceSequence = new Map(trace.resourceSequence);
  return {
    sessionId: batch.at(-1)?.sessionId ?? trace.sessionId,
    navigationId: trace.navigationId,
    events: trace.events.concat(batch),
    spans: trace.spans.concat(batch.map(spanFromEvent)),
    frames: trace.frames.concat(framesFrom(batch, presentedFrameIds)),
    resources: mergeResources(trace.resources, batch, resourceSequence),
    presentedFrameIds,
    resourceSequence,
  };
}

export function browserCalls(events: TelemetryEvent[]): BrowserCall[] {
  return events.flatMap((event) => {
    const p = event.payload;
    if (event.kind !== "javascript" || typeof p.functionName !== "string") return [];
    return [{ id: String(p.callId ?? event.id), parentId: typeof p.parentCallId === "string" ? p.parentCallId : undefined, name: p.functionName, kind: String(p.callKind ?? "script"), url: typeof p.scriptUrl === "string" ? p.scriptUrl : undefined, start: event.timestamp, duration: isMeasuredEvent(event) ? event.duration : 0, depth: typeof p.callDepth === "number" ? p.callDepth : 0 }];
  });
}
