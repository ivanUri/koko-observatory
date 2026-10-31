import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRuntime } from "../src/core/forensics.ts";

const event = (id, patch = {}) => ({
  id,
  sessionId: "session-1",
  sequence: Number(id.replace(/\D/g, "")) || 1,
  timestamp: 1_000,
  duration: 0,
  kind: "log",
  name: id,
  status: "ok",
  payload: {},
  ...patch,
});

test("forensics reports the measured slow network stage with its evidence id", () => {
  const report = diagnoseRuntime([event("server-1", {
    duration: 820,
    kind: "network",
    name: "server",
    payload: { journeyStage: "server", url: "https://example.test/" },
  })]);
  assert.equal(report.state, "attention");
  assert.equal(report.findings[0].id, "slow-network-stage");
  assert.deepEqual(report.findings[0].evidenceIds, ["server-1"]);
  assert.equal(report.findings[0].confidence, "measured");
  assert.deepEqual(report.findings[0].evidence[0], {
    eventId: "server-1",
    role: "primary",
    kind: "network",
    destination: "network",
    url: "https://example.test/",
  });
  assert.equal(report.bottleneck.layer, "network");
  assert.match(report.bottleneck.headline, /Network bottleneck candidate/);
  assert.equal(report.bottleneck.chain[1].evidenceIds[0], "server-1");
});

test("bottleneck report preserves the browser evidence chain and script context", () => {
  const report = diagnoseRuntime([event("js-1", {
    duration: 450,
    kind: "javascript",
    name: "script",
    payload: { browserStage: "javascript", scriptUrl: "https://cdn.example/app.js", functionName: "hydrateApp", measurementState: "measured" },
  })]);
  assert.equal(report.bottleneck.layer, "runtime");
  assert.match(report.bottleneck.headline, /Browser bottleneck candidate/);
  assert.equal(report.bottleneck.chain[1].evidenceIds[0], "js-1");
  assert.equal(report.bottleneck.chain.some((step) => step.label === "Script/resource context" && step.value.endsWith("app.js")), true);
  assert.equal(report.bottleneck.chain.some((step) => step.label === "Function context" && step.value === "hydrateApp"), true);
});

test("healthy bottleneck report keeps the observed response-to-lifecycle path", () => {
  const report = diagnoseRuntime([
    event("response-1", { kind: "network", name: "response", timestamp: 1_000, duration: 4, payload: { journeyStage: "response", responseStatus: 200, url: "https://example.test/" } }),
    event("dcl-1", { kind: "navigation", name: "domcontentloaded", timestamp: 1_120, payload: { lifecycleStage: "domcontentloaded", url: "https://example.test/" } }),
  ]);
  assert.equal(report.bottleneck.state, "healthy");
  assert.equal(report.bottleneck.layer, "none");
  assert.equal(report.bottleneck.chain.some((step) => step.label === "Document response"), true);
  assert.equal(report.bottleneck.chain.some((step) => step.label === "domcontentloaded" && step.value.includes("+120.0 ms")), true);
});

test("forensics prioritizes direct runtime errors", () => {
  const report = diagnoseRuntime([event("js-error", { kind: "javascript", name: "uncaught", status: "error", payload: { message: "boom" } })]);
  assert.equal(report.findings[0].severity, "critical");
  assert.equal(report.findings[0].id, "runtime-errors");
});

test("forensics does not infer a bottleneck from a short event sequence", () => {
  const report = diagnoseRuntime([
    event("dns-1", { duration: 8, kind: "network", name: "dns", payload: { journeyStage: "dns" } }),
    event("server-1", { duration: 40, kind: "network", name: "server", payload: { journeyStage: "server" } }),
  ]);
  assert.equal(report.state, "healthy");
  assert.equal(report.findings.length, 0);
});

test("forensics ignores invalid or truncated probe JSON", () => {
  const report = diagnoseRuntime([event("probe-1", { name: "web-vital", payload: { probeJson: "{truncated" } })]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.state, "healthy");
});

test("forensics counts one HTTP failure once per request, not once per stage", () => {
  const stages = ["queue", "server", "response", "received"].map((stage, index) => event(`http-${stage}`, {
    kind: "network",
    name: stage,
    duration: stage === "server" ? 10 : 0,
    payload: {
      executionId: "execution-1",
      requestId: 41,
      url: "https://example.test/api",
      journeyStage: stage,
      responseStatus: 500,
      terminalStatus: "ok",
      measurement: stage === "received" ? "boundary" : "measured",
    },
    sequence: index + 1,
  }));
  const report = diagnoseRuntime(stages);
  const finding = report.findings.find((item) => item.id === "http-errors");
  assert.equal(finding?.title, "1 HTTP error request");
  assert.deepEqual(finding?.evidenceIds, ["http-response"]);
  assert.equal(report.findings.some((item) => item.id === "network-failures"), false);
});

test("forensics scopes findings to the top-level frame and loader", () => {
  const report = diagnoseRuntime([
    event("document", {
      kind: "network",
      name: "queue",
      payload: { topLevelNavigation: true, frameId: 1, loaderId: 7, resourceType: "Document", url: "https://example.test/", journeyStage: "queue" },
    }),
    event("iframe-server", {
      kind: "network",
      name: "server",
      duration: 2_000,
      payload: { frameId: 2, loaderId: 8, resourceType: "Document", url: "https://third-party.test/frame", journeyStage: "server", measurement: "measured" },
    }),
  ]);
  assert.equal(report.scope.mode, "top-level-loader");
  assert.equal(report.scope.frameId, 1);
  assert.equal(report.findings.length, 0);
});

test("forensics ignores Web Vitals emitted by a child frame", () => {
  const report = diagnoseRuntime([
    event("document", {
      kind: "network",
      name: "queue",
      payload: { topLevelNavigation: true, frameId: 1, loaderId: 7, resourceType: "Document", url: "https://example.test/", journeyStage: "queue" },
    }),
    event("child-fcp", {
      kind: "render",
      name: "web-vital",
      payload: { frameId: 2, loaderId: 8, probeJson: JSON.stringify({ name: "FCP", value: 9_000 }) },
    }),
  ]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.state, "healthy");
});

test("forensics does not duplicate an inspection failure as a runtime error", () => {
  const report = diagnoseRuntime([event("inspection-error", {
    kind: "log",
    status: "error",
    payload: { inspectionState: "failed", errorCode: "navigation_timeout" },
  })]);
  assert.deepEqual(report.findings.map((finding) => finding.id), ["inspection-failed"]);
  assert.equal(report.findings[0].confidence, "direct");
  assert.equal(report.findings[0].evidence[0].destination, "timeline");
});

test("forensics reports the largest measured resource without estimating bytes", () => {
  const report = diagnoseRuntime([
    event("large-response", {
      kind: "network",
      name: "response",
      payload: {
        executionId: "execution-large",
        requestId: 91,
        url: "https://example.test/app.js",
        journeyStage: "response",
        responseStatus: 200,
        responseBodyBytes: 1_500_000,
        uncompressedSizeBytes: 2_500_000,
        responseMemoryState: "decoded_body",
        resourceType: "Script",
      },
    }),
  ]);
  const finding = report.findings.find((item) => item.id === "large-resource");
  assert.equal(finding?.measurement?.value, 2_500_000);
  assert.equal(finding?.measurement?.unit, "bytes");
  assert.equal(finding?.evidence[0].requestId, "91");
  assert.equal(finding?.evidence[0].destination, "network");
});

test("forensics keeps explicit failures ahead of larger measured breaches", () => {
  const report = diagnoseRuntime([
    event("inspection-error", { kind: "log", status: "error", payload: { inspectionState: "failed", errorCode: "core_failed" } }),
    event("very-slow-server", { kind: "network", duration: 9_000, payload: { journeyStage: "server", measurement: "measured" } }),
  ]);
  assert.equal(report.findings[0].id, "inspection-failed");
  assert.equal(report.bottleneck.evidenceIds[0], "inspection-error");
});
