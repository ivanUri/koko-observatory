import assert from "node:assert/strict";
import test from "node:test";
import { groupNetworkTransfers } from "../src/core/network-metrics.ts";

function event(sequence, stage, duration, overrides = {}) {
  return {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    timestamp: 1_000 + sequence,
    duration,
    kind: "network",
    name: stage,
    status: "ok",
    payload: { executionId: "execution", journeyStage: stage, requestId: 1, url: "https://example.com/data", measurement: duration ? "measured" : "boundary", ...overrides },
  };
}

test("aggregates one transfer and excludes boundary/error durations", () => {
  const transfers = groupNetworkTransfers([
    event(1, "queue", 2),
    event(2, "request", 5),
    event(3, "response", 7),
    { ...event(4, "server", 99, { measurement: "measured" }), status: "error" },
    event(5, "received", 0, { measurement: "boundary" }),
  ]);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].duration, 14);
});

test("keeps concurrent same-URL request IDs as separate transfers", () => {
  const transfers = groupNetworkTransfers([
    event(1, "queue", 1, { requestId: 10 }),
    event(2, "response", 3, { requestId: 10 }),
    event(3, "queue", 2, { requestId: 11 }),
    event(4, "response", 4, { requestId: 11 }),
  ]);
  assert.deepEqual(transfers.map((transfer) => transfer.duration), [4, 6]);
  assert.deepEqual(transfers.map((transfer) => transfer.requestId), ["10", "11"]);
});
