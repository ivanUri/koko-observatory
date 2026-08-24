import assert from "node:assert/strict";
import test from "node:test";
import { bucketEventRate, eventsPerSecond, isMeasuredEvent, metricCategory, percentile } from "../src/core/metrics.ts";

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
});

test("uses browserStage for latency category attribution", () => {
  assert.equal(metricCategory(event({ payload: { browserStage: "javascript", measurementState: "measured" } })), "javascript");
  assert.equal(metricCategory(event({ payload: { browserStage: "dom", measurementState: "measured" } })), "dom");
  assert.equal(metricCategory(event({ payload: { browserStage: "layout", measurementState: "measured" } })), "render");
  assert.equal(metricCategory(event({ payload: { browserStage: "html-parser", measurementState: "measured" } })), undefined);
  assert.equal(metricCategory(event({ kind: "network", payload: {} })), "network");
});

test("calculates current throughput instead of returning a stale last bucket", () => {
  const events = [event({ id: "old", timestamp: 8_500 }), event({ id: "current", timestamp: 9_500 })];
  assert.equal(eventsPerSecond(events, 10_000), 1);
  assert.deepEqual(bucketEventRate(events), [[8_000, 1], [9_000, 1]]);
});
