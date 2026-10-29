import assert from "node:assert/strict";
import test from "node:test";
import { bucketEventRate, createEventRateLedger, createMeasuredDurationWindow, eventsPerSecond, isMeasuredEvent, isolatedSystemDuration, metricCategory, percentile, utf8ByteLength } from "../src/core/metrics.ts";

const event = (overrides = {}) => ({
  id: "event",
  sessionId: "session",
  sequence: 1,
  timestamp: 10_000,
  duration: 10,
  kind: "render",
  name: "paint",
  status: "ok",
  payload: { browserStage: "paint", measurementState: "measured" },
  ...overrides,
});

test("uses nearest-rank percentile consistently", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([], 0.95), 0);
});

test("excludes unavailable and boundary durations from measured metrics", () => {
  assert.equal(isMeasuredEvent(event()), true);
  assert.equal(isMeasuredEvent(event({ duration: 0 })), false);
  assert.equal(isMeasuredEvent(event({ payload: { measurement: "boundary" } })), false);
  assert.equal(isMeasuredEvent(event({ payload: { measurementState: "unavailable" } })), false);
  assert.equal(isMeasuredEvent(event({ status: "error" })), false);
  assert.equal(isMeasuredEvent(event({ payload: { measurementState: "not-applicable-replay" } })), false);
  assert.equal(isMeasuredEvent(event({ payload: { measurementState: "cached" } })), false);
});

test("uses browserStage for latency category attribution", () => {
  assert.equal(metricCategory(event({ payload: { browserStage: "javascript", measurementState: "measured" } })), "javascript");
  assert.equal(metricCategory(event({ payload: { browserStage: "dom", measurementState: "measured" } })), "dom");
  assert.equal(metricCategory(event({ payload: { browserStage: "animation-frame", measurementState: "measured" } })), "scheduler");
  assert.equal(metricCategory(event({ payload: { browserStage: "layout", measurementState: "measured" } })), "render");
  assert.equal(metricCategory(event({ payload: { browserStage: "html-parser", measurementState: "measured" } })), undefined);
  assert.equal(metricCategory(event({ kind: "network", payload: {} })), "network");
});

test("calculates current throughput instead of returning a stale last bucket", () => {
  const events = [event({ id: "old", timestamp: 8_500 }), event({ id: "current", timestamp: 9_500 })];
  assert.equal(eventsPerSecond(events, 10_000), 1);
  assert.deepEqual(bucketEventRate(events), [[8_000, 1], [9_000, 1]]);
  assert.deepEqual(bucketEventRate([event({ timestamp: 10_100 }), event({ timestamp: 12_100 })]), [[10_000, 1], [11_000, 0], [12_000, 1]]);
});

test("does not treat a browser stage duration as an operating-system measurement", () => {
  const script = event({
    kind: "javascript",
    duration: 12,
    payload: { browserStage: "javascript", measurementState: "measured", systemMeasurementState: "boundary", processId: 10, cpuPercent: 4 },
  });
  assert.equal(isolatedSystemDuration(script), 0);
  assert.equal(isolatedSystemDuration(event({ payload: { systemMeasurementState: "measured", measurementState: "measured", systemStage: "cpu" }, duration: 3 })), 3);
});

test("keeps the event rate as events enter and leave the retained window", () => {
  const ledger = createEventRateLedger();
  const retained = [event({ id: "a", timestamp: 1_100 }), event({ id: "b", timestamp: 3_400 }), event({ id: "c", timestamp: 5_900 })];
  for (const item of retained) ledger.add(item);
  assert.deepEqual(ledger.snapshot(2), bucketEventRate(retained, { maxBuckets: 2 }));
  ledger.remove(retained[0]);
  assert.deepEqual(ledger.snapshot(), bucketEventRate(retained.slice(1)));
  ledger.clear();
  assert.deepEqual(ledger.snapshot(180), []);
});

test("keeps nearest-rank p95 for the trailing event window", () => {
  const window = createMeasuredDurationWindow(3);
  const retained = [];
  for (const [id, duration] of [["a", 10], ["b", 0], ["c", 20], ["d", 40], ["e", 30]]) {
    const item = event({ id, duration, payload: { measurementState: duration > 0 ? "measured" : "boundary" } });
    retained.push(item);
    window.push(item);
    if (retained.length > 3) retained.shift();
  }
  const expected = percentile(retained.filter(isMeasuredEvent).map((item) => item.duration), 0.95);
  assert.equal(window.percentile(0.95), expected);
  assert.equal(expected, 40);
});

test("duration window matches the tail after older history leaves", () => {
  const maxEvents = 8;
  const windowLimit = 5;
  const events = [];
  const window = createMeasuredDurationWindow(windowLimit);
  const ledger = createEventRateLedger();
  for (let index = 0; index < 20; index += 1) {
    const item = event({ id: String(index), timestamp: index * 1_000 + 50, duration: index + 1 });
    events.push(item);
    ledger.add(item);
    window.push(item);
    if (events.length > maxEvents) {
      for (const dropped of events.splice(0, events.length - maxEvents)) ledger.remove(dropped);
    }
  }
  const tail = events.slice(-windowLimit);
  assert.equal(window.percentile(0.95), percentile(tail.filter(isMeasuredEvent).map((item) => item.duration), 0.95));
  assert.deepEqual(ledger.snapshot(4), bucketEventRate(events, { maxBuckets: 4 }));
});

test("counts UTF-8 bytes instead of UTF-16 code units", () => {
  assert.equal(utf8ByteLength("Xin chào 🌏"), new TextEncoder().encode("Xin chào 🌏").byteLength);
  assert.notEqual(utf8ByteLength("🌏"), "🌏".length);
});
