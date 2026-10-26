import assert from "node:assert/strict";
import test from "node:test";
import { buildReverseTrace } from "../src/reverse/model.ts";
import { indexJavaScript, mapSourcePosition } from "../src/reverse/static-analysis.ts";

const event = (name, payload, sequence) => ({
  id: `${name}-${sequence}`,
  sessionId: "automation-test",
  sequence,
  timestamp: 1_000 + sequence,
  duration: 0,
  kind: "javascript",
  name,
  status: "ok",
  payload: { sessionId: "automation-test", ...payload },
});

test("reverse graph preserves observed evidence and links one request to its response", () => {
  const trace = buildReverseTrace([
    event("reverse-session-started", { requestedUrl: "https://example.test" }, 1),
    event("reverse-evidence-batch", {
      actionId: "click-1",
      action: { action: "click", locator: { kind: "css", value: "button" } },
      evidence: [
        { sequence: 1, timestamp: 1_001, kind: "dom-event", data: { eventType: "click", target: { tag: "button" } } },
        { sequence: 2, timestamp: 1_002, kind: "event-listener-enter", data: { eventType: "click", listenerName: "onClick" } },
        { sequence: 3, timestamp: 1_003, kind: "network-request", data: { requestId: "r1", method: "GET", url: "https://example.test/api" } },
        { sequence: 4, timestamp: 1_004, kind: "network-response", data: { requestId: "r1", status: 200, url: "https://example.test/api" } },
      ],
    }, 2),
  ]);
  assert.equal(trace.evidence.length, 4);
  assert.equal(trace.evidence.every((item) => item.evidenceClass === "OBSERVED"), true);
  assert.equal(trace.edges.some((edge) => edge.relation === "RECEIVES_RESPONSE" && edge.evidenceClass === "OBSERVED"), true);
  assert.equal(trace.edges.some((edge) => edge.relation === "HANDLED_BY"), true);
});

test("static analysis indexes functions, calls, imports and source-map positions", () => {
  const indexed = indexJavaScript("import x from 'pkg'; export function run() { return x.doWork(); }");
  assert.deepEqual(indexed.imports, ["pkg"]);
  assert.deepEqual(indexed.exports, ["run"]);
  assert.equal(indexed.functions[0].name, "run");
  assert.equal(indexed.calls[0].callee, "x.doWork");
  const mapped = mapSourcePosition(JSON.stringify({ version: 3, sources: ["src.ts"], names: [], mappings: "AAAA" }), 1, 0);
  assert.equal(mapped.source, "src.ts");
});
