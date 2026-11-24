import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNucleiScanner, normalizeNucleiFinding } from "../scripts/nuclei-scanner.mjs";

function harness() {
  const events = [];
  const invocations = [];
  const scanner = createNucleiScanner({ emit: (event) => events.push(event), binary: "nuclei", templatesDir: "", spawnProcess: (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit("close", null, "SIGTERM"); return true; };
    invocations.push({ binary, args, options, child });
    return child;
  } });
  return { events, invocations, scanner };
}
const command = { executionId: "inspection-341", scanId: "test-1", target: "http://localhost:4100/?token=secret", profile: "technologies", authorized: true };

test("streams findings, bounds scope and retains no raw response or query secrets", () => {
  const { scanner, events, invocations } = harness();
  scanner.start(command);
  const { args, options, child } = invocations[0];
  assert.equal(options.shell, false);
  assert.equal(args[args.indexOf("-t") + 1], "http/technologies/");
  for (const flag of ["-ni", "-dr", "-duc", "-omit-raw", "-rl", "-pt"]) assert.ok(args.includes(flag));
  child.stdout.write(JSON.stringify({ "template-id": "fixture", "matched-at": "http://localhost:4100/a?token=secret", info: { name: "Fixture", severity: "high", classification: { "cve-id": ["CVE-2025-12345"] } }, request: "secret", response: "secret" }) + "\n");
  child.emit("close", 0, null);
  assert.deepEqual(events.map((e) => e.name), ["nuclei-started", "nuclei-finding", "nuclei-completed"]);
  assert.equal(events[1].payload.finding.matchedAt, "http://localhost:4100/a");
  assert.equal(events[1].payload.executionId, "inspection-341");
  assert.ok(!JSON.stringify(events).includes("secret"));
  assert.equal(events[2].payload.findings, 1);
});

test("rejects unapproved scans and unrecognized profiles without spawning", () => {
  const { scanner, events, invocations } = harness();
  scanner.start({ ...command, authorized: false });
  scanner.start({ ...command, profile: "../../custom" });
  scanner.start({ ...command, target: "http://user:pass@localhost/" });
  assert.equal(invocations.length, 0);
  assert.deepEqual(events.map((e) => e.name), ["nuclei-failed", "nuclei-failed", "nuclei-failed"]);
});

test("cancellation and missing scanner produce distinct terminal states", () => {
  const { scanner, events, invocations } = harness();
  scanner.start(command);
  scanner.stop(command.scanId);
  assert.equal(events.at(-1).name, "nuclei-cancelled");
  scanner.start({ ...command, scanId: "test-2" });
  invocations[1].child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
  invocations[1].child.emit("close", -2, null);
  assert.equal(events.at(-1).name, "nuclei-failed");
  assert.match(events.at(-1).payload.error, /not found/i);
});

test("ignores malformed scanner data and rejects results without template identity", () => {
  assert.equal(normalizeNucleiFinding({ info: { name: "x" } }), undefined);
  const { scanner, events, invocations } = harness();
  scanner.start(command);
  invocations[0].child.stdout.write("not json\n{}\n");
  invocations[0].child.emit("close", 0, null);
  assert.equal(events.at(-1).payload.malformed, 2);
});

test("request and response excerpts are opt-in, bounded and redact common credential headers", () => {
  const input = { "template-id": "fixture", request: "GET /?token=secret HTTP/1.1\r\nAuthorization: Bearer secret\r\nCookie: token=secret\r\n\r\n", response: `HTTP/1.1 200 OK\r\nSet-Cookie: token=secret\r\n\r\n${"x".repeat(20_000)}` };
  assert.equal(normalizeNucleiFinding(input).request, undefined);
  const result = normalizeNucleiFinding(input, true);
  assert.ok(!result.request.includes("secret"));
  assert.ok(!result.response.includes("secret"));
  assert.ok(result.response.length <= 16_384);
  assert.match(result.request, /\?\[redacted\]/);
});
