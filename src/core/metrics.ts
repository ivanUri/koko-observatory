import type { TelemetryEvent } from "./types";

export type MetricCategory = "network" | "javascript" | "render" | "dom" | "scheduler" | "memory";

const NON_MEASURED_STATES = new Set(["unavailable", "not-timed", "not timed", "boundary", "awaiting"]);

export function measurementState(event: TelemetryEvent) {
  return String(event.payload.measurementState ?? event.payload.measurement ?? "").toLowerCase();
}

export function isMeasuredEvent(event: TelemetryEvent) {
  return event.duration > 0 && Number.isFinite(event.duration) && !NON_MEASURED_STATES.has(measurementState(event));
}

/** Nearest-rank percentile: rank 0.95 selects ceil(n * 0.95) in sorted order. */
export function percentile(values: number[], rank: number) {
  if (!values.length) return 0;
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const clampedRank = Math.min(1, Math.max(0, rank));
  const index = Math.max(0, Math.ceil(sorted.length * clampedRank) - 1);
  return sorted[index] ?? 0;
}

export function measuredPercentile(events: TelemetryEvent[], rank: number) {
  return percentile(events.filter(isMeasuredEvent).map((event) => event.duration), rank);
}

/** Maps Core's browserStage payload to the dashboard's latency categories. */
export function metricCategory(event: TelemetryEvent): MetricCategory | undefined {
  const browserStage = typeof event.payload.browserStage === "string" ? event.payload.browserStage : undefined;
  if (browserStage === "javascript") return "javascript";
  if (browserStage === "dom" || browserStage === "mutations") return "dom";
  if (browserStage === "event-loop" || browserStage === "scheduler") return "scheduler";
  if (["style", "layout", "paint", "layers", "raster", "composite", "frame", "present"].includes(browserStage ?? "")) return "render";
  if (browserStage) return undefined;
  if (event.kind === "network") return "network";
  if (event.kind === "javascript" || event.kind === "render" || event.kind === "dom" || event.kind === "scheduler" || event.kind === "memory") return event.kind;
  return undefined;
}

export function bucketEventRate(events: TelemetryEvent[]) {
  const buckets = new Map<number, number>();
  for (const event of events) {
    const second = Math.floor(event.timestamp / 1_000) * 1_000;
    buckets.set(second, (buckets.get(second) ?? 0) + 1);
  }
  return [...buckets.entries()].sort((left, right) => left[0] - right[0]);
}

export function eventsPerSecond(events: TelemetryEvent[], now = Date.now()) {
  const cutoff = now - 1_000;
  return events.filter((event) => event.timestamp > cutoff && event.timestamp <= now).length;
}
