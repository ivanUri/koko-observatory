import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { internetJourneyNodes } from "../src/journeys/internet/data.ts";
import { absentStageLabel, cloneJourneyNodes, projectInspection, waterfallReading } from "../src/journeys/internet/project.ts";

function event(sequence, stage, overrides = {}) {
  const payload = {
    journeyStage: stage,
    requestId: 1,
    resourceType: "Document",
    topLevelNavigation: true,
    url: "https://example.com/",
    measurement: "measured",
    inspectionId: "inspection-a",
    executionId: "inspection-a",
    ...overrides,
  };
  return {
    id: `${payload.inspectionId}-${payload.requestId}-${stage}-${sequence}`,
    sessionId: payload.sessionId ?? "session-a",
    sequence,
    timestamp: payload.timestamp ?? sequence,
    duration: payload.duration ?? 1,
    kind: "network",
    name: stage,
    status: payload.status ?? "ok",
    payload,
  };
}

function detail(nodes, id, label) {
  const node = nodes.find((candidate) => candidate.id === id);
  assert.ok(node, id);
  const value = node.metadata.summary.find((item) => item.label === label)?.value;
  return { node, value };
}

test("a script does not overwrite the document DNS, TCP, or TLS nodes", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(2, "dns", { primaryIp: "9.9.9.9", requestId: 2, resourceType: "Script", topLevelNavigation: false, url: "https://example.com/s.js", httpVersion: "h3", duration: 9 }),
    event(3, "tcp", { primaryIp: "9.9.9.9", requestId: 2, resourceType: "Script", topLevelNavigation: false, url: "https://example.com/s.js", httpVersion: "h3", duration: 9 }),
    event(4, "tls", { requestId: 2, resourceType: "Script", topLevelNavigation: false, url: "https://example.com/s.js", httpVersion: "h3", duration: 9 }),
    event(1, "dns", { primaryIp: "1.1.1.1", httpVersion: "h2", duration: 2.56 }),
    event(5, "tcp", { primaryIp: "1.1.1.1", httpVersion: "h2", duration: 29.416 }),
    event(6, "tls", { httpVersion: "h2", duration: 46.155 }),
  ]);
  assert.equal(detail(projected.nodes, "dns", "A").value, "1.1.1.1");
  assert.equal(detail(projected.nodes, "tcp", "Remote IP").value, "1.1.1.1");
  assert.equal(projected.nodes.find((node) => node.id === "tcp").title, "TCP connection");
  assert.equal(projected.nodes.find((node) => node.id === "tls").title, "TLS handshake");
  assert.deepEqual(projected.otherTransfers.map((transfer) => transfer.requestId), ["2"]);
  assert.equal(projected.otherTransfers[0].protocol, "h3");
  assert.equal(projected.otherTransfers[0].resourceType, "Script");
});

test("request headers and cache headers stay separate from the Koko cache decision", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "request", { method: "GET", requestHeaders: "Accept: text/html\nAccept-Encoding: br\nUser-Agent: koko" }),
    event(2, "cache", {
      cacheDecision: "not-observed",
      responseHeaders: "cf-cache-status: HIT\nage: 9\netag: \"abc\"",
      age: "9",
      etag: "\"abc\"",
    }),
  ]);
  const headers = detail(projected.nodes, "request", "Headers").value;
  assert.match(headers, /Accept: text\/html/);
  assert.doesNotMatch(headers, /Not captured yet/);
  assert.equal(detail(projected.nodes, "cache", "Koko cache decision").value, "not-observed");
  assert.match(detail(projected.nodes, "cache", "Cache headers").value, /cf-cache-status: HIT/);
  assert.doesNotMatch(JSON.stringify(projected.nodes.find((node) => node.id === "cache").metadata.summary), /Cache source not observable/);
});

test("zero redirects and an unused proxy are empty results", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "redirect", { redirectCount: 0, measurement: "unavailable", duration: 0 }),
    event(2, "proxy", { usedProxy: false, measurement: "unavailable", duration: 0 }),
  ]);
  const redirect = projected.nodes.find((node) => node.id === "redirect");
  const proxy = projected.nodes.find((node) => node.id === "proxy");
  assert.equal(detail(projected.nodes, "redirect", "Redirect count").value, "0");
  assert.equal(detail(projected.nodes, "redirect", "Per-hop timing").value, "No redirect");
  assert.equal(absentStageLabel(redirect), "No redirect");
  assert.equal(detail(projected.nodes, "proxy", "Used").value, "No");
  assert.equal(detail(projected.nodes, "proxy", "Tunnel timing").value, "No proxy");
  assert.equal(absentStageLabel(proxy), "No proxy");
});

test("a revalidated response keeps that cache status", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "cache", { cacheDecision: "revalidated", responseStatus: 304, responseHeaders: "etag: \"abc\"" }),
  ]);
  assert.equal(detail(projected.nodes, "cache", "Koko cache decision").value, "revalidated");
  assert.equal(detail(projected.nodes, "cache", "Status").value, "Revalidated");
});

test("a missing proxy is not reported as unused", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "proxy", { measurement: "unavailable", duration: 0 }),
  ]);
  const proxy = projected.nodes.find((node) => node.id === "proxy");
  assert.equal(detail(projected.nodes, "proxy", "Used").value, "Unavailable");
  assert.equal(absentStageLabel(proxy), undefined);
});

test("the later inspection wins when request ids collide", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "dns", { inspectionId: "inspection-old", executionId: "inspection-old", timestamp: 1_000, url: "https://example.com/", primaryIp: "1.1.1.1" }),
    event(2, "dns", { inspectionId: "inspection-old", executionId: "inspection-old", timestamp: 1_001, requestId: 2, resourceType: "Script", topLevelNavigation: false, url: "https://example.com/old.js", primaryIp: "9.9.9.9" }),
    event(1, "dns", { inspectionId: "inspection-new", executionId: "inspection-new", timestamp: 2_000, url: "https://other.example/", primaryIp: "8.8.8.8" }),
    event(2, "dns", { inspectionId: "inspection-new", executionId: "inspection-new", timestamp: 2_001, requestId: 2, resourceType: "Script", topLevelNavigation: false, url: "https://other.example/s.js", primaryIp: "8.8.4.4" }),
  ]);
  assert.equal(projected.executionId, "inspection-new");
  assert.equal(detail(projected.nodes, "url-input", "Hostname").value, "other.example");
  assert.equal(detail(projected.nodes, "dns", "A").value, "8.8.8.8");
  assert.deepEqual(projected.otherTransfers.map((transfer) => transfer.url), ["https://other.example/s.js"]);
});

test("an old capture uses the retained body as the decoded size", () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "response", {
      responseStatus: 200,
      responseBodyBytes: 334,
      uncompressedSizeBytes: 334,
      responseMemoryState: "estimated_from_transfer_size",
      responseBody: "x".repeat(577),
      bodyTruncated: false,
      contentEncoding: "br",
      httpVersion: "h2",
      duration: 3.52,
    }),
  ]);
  assert.equal(detail(projected.nodes, "response", "Transferred").value, "334 B");
  assert.equal(detail(projected.nodes, "response", "Decoded body").value, "577 B");
  assert.equal(detail(projected.nodes, "response", "HTTP version").value, "h2");
});

test("cloning the template does not keep an HTTP/3 title on the next document", () => {
  const clone = cloneJourneyNodes(internetJourneyNodes);
  clone.find((node) => node.id === "tcp").title = "QUIC transport";
  assert.equal(internetJourneyNodes.find((node) => node.id === "tcp").title, "TCP connection");
});

test("explanations describe the measured document instead of a shared textbook sentence", async () => {
  const projected = projectInspection(internetJourneyNodes, [
    event(1, "queue", { duration: 0.152 }),
    event(2, "dns", { primaryIp: "2606:4700:10::6814:179a", duration: 2.56, url: "https://example.com/" }),
    event(3, "tcp", { primaryIp: "2606:4700:10::6814:179a", duration: 29.416, connectionReused: false, numConnects: 1, connectionId: 0, httpVersion: "h2" }),
    event(4, "tls", { duration: 46.155, httpVersion: "h2" }),
    event(5, "request", { duration: 1.632, method: "GET", requestHeaders: "Accept: text/html" }),
    event(6, "redirect", { redirectCount: 0, measurement: "unavailable", duration: 0 }),
    event(7, "proxy", { usedProxy: false, measurement: "unavailable", duration: 0 }),
    event(8, "cache", { cacheDecision: "not-observed", responseHeaders: "age: 9\ncf-cache-status: HIT", duration: 0, measurement: "not-timed" }),
    event(9, "server", { duration: 33.57 }),
    event(10, "response", {
      duration: 3.52,
      responseStatus: 200,
      responseBodyBytes: 334,
      uncompressedSizeBytes: 334,
      responseMemoryState: "estimated_from_transfer_size",
      responseBody: "x".repeat(577),
      bodyTruncated: false,
      contentEncoding: "br",
      httpVersion: "h2",
    }),
  ]);
  const text = (id) => projected.nodes.find((node) => node.id === id).metadata.explanation;
  assert.match(text("dns"), /AAAA 2606:4700:10::6814:179a/);
  assert.match(projected.nodes.find((node) => node.id === "dns").metadata.issues.join(" "), /TTL and CNAME are not exposed by libcurl/);
  assert.equal(detail(projected.nodes, "tcp", "Connection reused").value, "No");
  assert.equal(detail(projected.nodes, "tcp", "Connects").value, "1");
  assert.equal(detail(projected.nodes, "tcp", "Connection").value, "0");
  assert.match(text("tcp"), /opened a new connection \(connects 1, connection 0\)/);
  assert.equal(detail(projected.nodes, "tls", "Certificate").value, "Not exposed by libcurl");
  assert.match(text("tls"), /Protocol h2 is the negotiated HTTP version/);
  assert.doesNotMatch(projected.nodes.find((node) => node.id === "tls").description, /certificate validation/);
  assert.match(text("cache"), /not-observed/);
  assert.match(text("cache"), /separate from cache headers/);
  assert.match(text("cache"), /cf-cache-status: HIT/);
  assert.match(text("redirect"), /without a redirect/);
  assert.match(text("proxy"), /did not use a proxy/);
  assert.match(text("response"), /334 B on the wire, decoded body 577 B/);
  assert.match(text("response"), /Content-Encoding is br/);
  assert.match(text("server"), /first response byte/);
  const reading = waterfallReading(projected.nodes);
  assert.match(reading, /TLS handshake is 46\.155 ms, 39% of the 117\.005 ms measured for this document/);
  assert.match(reading, /Redirects, proxies, and other transfers are outside this total/);
  const data = await readFile(new URL("../src/journeys/internet/data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(data, /Timeouts, invalid configuration/);
  assert.doesNotMatch(data, /certificate validation/);
});

test("playback keeps measured status and names the document scope", async () => {
  const panel = await readFile(new URL("../src/journeys/internet/internet-journey-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /highlighted: playing && index === cursor/);
  assert.match(panel, /journey-node--cursor/);
  assert.doesNotMatch(panel, /index < cursor \? "complete"/);
  assert.match(panel, /Top-level document only/);
  assert.match(panel, /waterfallReading/);
  assert.match(panel, /Not included/);
  assert.match(panel, /What the timings say/);
  assert.doesNotMatch(panel, /Common issues/);
  assert.match(panel, /Open Network/);
  assert.match(panel, /requestHeaders/);
  assert.match(panel, /responseHeaders/);
  assert.match(panel, /measurement === "unavailable"/);
  assert.match(panel, /return "Not timed"/);
  assert.match(panel, /return "Boundary"/);
  assert.match(panel, /return "Reused"/);
});
