import type { TelemetryEvent } from "./types";

export type MetricCategory = "network" | "javascript" | "render" | "dom" | "scheduler" | "memory";

const NON_MEASURED_STATES = new Set([
  "unavailable",
  "not-timed",
  "not timed",
  "boundary",
  "awaiting",
  "cached",
  "derived",
  "estimated",
  "reused",
  "not-applicable",
  "not-applicable-replay",
  "below-resolution",
  "error",
]);

export function measurementState(event: TelemetryEvent) {
  return String(event.payload.measurementState ?? event.payload.measurement ?? "").toLowerCase();
}

export function isMeasuredEvent(event: TelemetryEvent) {
  const status = String(event.status).toLowerCase();
  return event.duration > 0
    && Number.isFinite(event.duration)
    && status !== "error"
    && status !== "skipped"
    && !NON_MEASURED_STATES.has(measurementState(event));
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/** Duration that Core isolated for the OS subsystem, not a browser stage that merely carries a process sample. */
export function isolatedSystemDuration(event: TelemetryEvent) {
  if (event.payload.systemMeasurementState !== "measured") return 0;
  return isMeasuredEvent(event) ? event.duration : 0;
}

/** Nearest-rank on values that are already sorted and finite. */
export function nearestRank(sorted: readonly number[], rank: number) {
  if (!sorted.length) return 0;
  const clampedRank = Math.min(1, Math.max(0, rank));
  const index = Math.max(0, Math.ceil(sorted.length * clampedRank) - 1);
  return sorted[index] ?? 0;
}

/** Nearest-rank percentile: rank 0.95 selects ceil(n * 0.95) in sorted order. */
export function percentile(values: number[], rank: number) {
  if (!values.length) return 0;
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return nearestRank(sorted, rank);
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

export function bucketEventRate(events: TelemetryEvent[], options: { startMs?: number; endMs?: number; fillZeros?: boolean; maxBuckets?: number } = {}) {
  const buckets = new Map<number, number>();
  const timestamped = events.filter((event) => Number.isFinite(event.timestamp));
  const startMs = options.startMs ?? (timestamped.length ? Math.min(...timestamped.map((event) => event.timestamp)) : undefined);
  const endMs = options.endMs ?? (timestamped.length ? Math.max(...timestamped.map((event) => event.timestamp)) : undefined);
  for (const event of timestamped) {
    if (startMs != null && event.timestamp < startMs) continue;
    if (endMs != null && event.timestamp > endMs) continue;
    const second = Math.floor(event.timestamp / 1_000) * 1_000;
    buckets.set(second, (buckets.get(second) ?? 0) + 1);
  }
  if (options.fillZeros !== false && startMs != null && endMs != null && endMs >= startMs) {
    const first = Math.floor(startMs / 1_000) * 1_000;
    const last = Math.floor(endMs / 1_000) * 1_000;
    const boundedFirst = options.maxBuckets && last - first >= options.maxBuckets * 1_000
      ? last - (options.maxBuckets - 1) * 1_000
      : first;
    for (let second = boundedFirst; second <= last; second += 1_000) buckets.set(second, buckets.get(second) ?? 0);
  }
  const sorted = [...buckets.entries()].sort((left, right) => left[0] - right[0]);
  return options.maxBuckets ? sorted.slice(-options.maxBuckets) : sorted;
}

/** Per-second counts for the events currently retained. Add and remove instead of rescanning history. */
export function createEventRateLedger() {
  const counts = new Map<number, number>();
  const touch = (event: TelemetryEvent, delta: number) => {
    if (!Number.isFinite(event.timestamp)) return;
    const second = Math.floor(event.timestamp / 1_000) * 1_000;
    const next = (counts.get(second) ?? 0) + delta;
    if (next <= 0) counts.delete(second);
    else counts.set(second, next);
  };
  return {
    add(event: TelemetryEvent) { touch(event, 1); },
    remove(event: TelemetryEvent) { touch(event, -1); },
    clear() { counts.clear(); },
    snapshot(maxBuckets?: number) {
      let first = Infinity;
      let last = -Infinity;
      for (const second of counts.keys()) {
        if (second < first) first = second;
        if (second > last) last = second;
      }
      if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
      const start = maxBuckets && last - first >= maxBuckets * 1_000 ? last - (maxBuckets - 1) * 1_000 : first;
      const rows: Array<[number, number]> = [];
      for (let second = start; second <= last; second += 1_000) rows.push([second, counts.get(second) ?? 0]);
      return rows;
    },
  };
}

/** Measured durations of the trailing event window. The ring evicts from the front. */
export function createMeasuredDurationWindow(limit: number) {
  const slots: Array<number | null> = [];
  const measured: number[] = [];
  let slotStart = 0;
  let measuredStart = 0;
  return {
    push(event: TelemetryEvent) {
      const value = isMeasuredEvent(event) ? event.duration : null;
      slots.push(value);
      if (value != null) measured.push(value);
      if (slots.length - slotStart <= limit) return;
      const removed = slots[slotStart];
      slotStart += 1;
      if (removed != null) measuredStart += 1;
      if (slotStart * 2 > slots.length) {
        slots.splice(0, slotStart);
        slotStart = 0;
      }
      if (measuredStart * 2 > measured.length) {
        measured.splice(0, measuredStart);
        measuredStart = 0;
      }
    },
    clear() {
      slots.length = 0;
      measured.length = 0;
      slotStart = 0;
      measuredStart = 0;
    },
    percentile(rank: number) {
      const active = measured.slice(measuredStart).sort((left, right) => left - right);
      return nearestRank(active, rank);
    },
  };
}

export function eventsPerSecond(events: TelemetryEvent[], now = Date.now()) {
  const cutoff = now - 1_000;
  return events.filter((event) => event.timestamp > cutoff && event.timestamp <= now).length;
}
