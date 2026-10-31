import assert from "node:assert/strict";
import test from "node:test";
import { evidenceHref, eventIdFromSearch } from "../src/core/evidence-links.ts";

test("evidence links preserve the exact event across diagnostic surfaces", () => {
  assert.equal(evidenceHref({ id: "request / 7", kind: "network" }), "/network?event=request%20%2F%207");
  assert.equal(evidenceHref({ id: "js-error-2", kind: "javascript" }), "/inspector?event=js-error-2");
  assert.equal(evidenceHref({ id: "load-3", kind: "navigation" }, "timeline"), "/timeline?event=load-3");
});

test("event query parsing rejects empty selections", () => {
  assert.equal(eventIdFromSearch("?event=js-error-2"), "js-error-2");
  assert.equal(eventIdFromSearch("?event=%20%20"), undefined);
  assert.equal(eventIdFromSearch("?execution=latest"), undefined);
});
