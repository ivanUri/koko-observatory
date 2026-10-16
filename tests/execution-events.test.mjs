import assert from "node:assert/strict";
import test from "node:test";
import { selectNewEvents } from "../src/executions/types.ts";

const event = (id, executionId = "exec") => ({
  id,
  sessionId: "session",
  sequence: 1,
  timestamp: 1,
  duration: 0,
  kind: "network",
  name: "response",
  status: "ok",
  payload: { executionId },
});

test("keeps the first new execution event and skips stored or repeated ids", () => {
  const selected = selectNewEvents(
    [event("a"), event("a"), event("b"), event("c", "other")],
    new Set(["exec:b"]),
  );
  assert.deepEqual(selected.map((item) => item.id), ["a", "c"]);
});
