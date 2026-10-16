import assert from "node:assert/strict";
import test from "node:test";
import { buildTrace, extendTrace } from "../src/journeys/browser/trace-model.ts";

const event = (overrides = {}) => ({
  id: "event",
  sessionId: "session",
  sequence: 1,
  timestamp: 1_000,
  duration: 5,
  kind: "network",
  name: "response",
  status: "ok",
  payload: { resourceType: "Script", requestId: 7, url: "https://example.test/app.js", measurementState: "measured" },
  ...overrides,
});

function visible(trace) {
  return {
    ids: trace.events.map((item) => item.id),
    spans: trace.spans.map(({ id, stage, duration, state }) => ({ id, stage, duration, state })),
    frames: trace.frames,
    resources: trace.resources,
  };
}

test("extends a browser trace without rebuilding the retained events", () => {
  const first = [event({ id: "dns", sequence: 1, duration: 2, payload: { resourceType: "Script", requestId: 7, url: "https://example.test/app.js", journeyStage: "dns", measurementState: "measured" } })];
  const second = [
    event({ id: "response", sequence: 2, duration: 8, payload: { resourceType: "Script", requestId: 7, url: "https://example.test/app.js", responseBodyBytes: 40, measurementState: "measured" } }),
    event({ id: "paint", kind: "render", name: "present", sequence: 3, duration: 1, payload: { browserStage: "present", presentedFrameId: "frame-1", measurementState: "measured" } }),
  ];
  const repeatedFrame = event({ id: "paint-again", kind: "render", name: "present", sequence: 4, duration: 1, payload: { browserStage: "present", presentedFrameId: "frame-1", measurementState: "measured" } });
  const extended = extendTrace(extendTrace(buildTrace(first), second), [repeatedFrame]);
  const combined = [...first, ...second, repeatedFrame];
  assert.deepEqual(visible(extended), visible(buildTrace(combined)));
  assert.equal(extended.frames.length, 1);
});

test("drops the oldest browser events when the retained window is full", () => {
  const filler = Array.from({ length: 50_000 }, (_, index) => event({ id: `event-${index}`, sequence: index, payload: { browserStage: "javascript", measurementState: "measured" }, kind: "javascript", name: "script" }));
  const newest = event({ id: "newest", sequence: 50_000, payload: { browserStage: "javascript", measurementState: "measured" }, kind: "javascript", name: "script" });
  const slid = extendTrace(buildTrace(filler), [newest]);
  assert.equal(slid.events.length, 50_000);
  assert.equal(slid.events[0].id, "event-1");
  assert.equal(slid.events.at(-1).id, "newest");
  assert.equal(slid.spans[0].id, "event-1");
  assert.equal(slid.spans.at(-1).id, "newest");
});
