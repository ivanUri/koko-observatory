import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Observatory product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Velora Observatory<\/title>/i);
  assert.match(html, /Velora runtime monitor/);
  assert.match(html, /Event throughput/);
  assert.match(html, /Observatory plugins/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps pipeline and UI state outside React component state", async () => {
  const [app, pipeline, stores] = await Promise.all([
    readFile(new URL("../src/components/observatory-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/core/pipeline.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/stores/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(pipeline, /new Worker/);
  assert.match(pipeline, /observatoryBus/);
  assert.match(stores, /useTelemetryStore/);
  assert.match(stores, /useGraphStore/);
  assert.doesNotMatch(app, /useState/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
});

test("Overview derives operational metrics from telemetry", async () => {
  const panels = await readFile(new URL("../src/components/panels.tsx", import.meta.url), "utf8");
  assert.match(panels, /latestNumber\(events/);
  assert.match(panels, /percentile\(events/);
  assert.match(panels, /No crash signal/);
  assert.doesNotMatch(panels, /Active sessions.*1,243|JS heap \(P95\).*128 MB|Crash rate.*0\.05%/);
});

test("URL inspection is global and not duplicated in Internet Journey", async () => {
  const [shell, journey] = await Promise.all([
    readFile(new URL("../src/components/observatory-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/journeys/internet/internet-journey-panel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /GlobalInspector/);
  assert.match(shell, /velora:inspect-url/);
  assert.match(shell, /Global URL inspector/);
  assert.doesNotMatch(journey, /Inspect URL/);
});

test("Internet Journey ends at the HTTP response boundary", async () => {
  const data = await readFile(new URL("../src/journeys/internet/data.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/journeys/internet/internet-journey-panel.tsx", import.meta.url), "utf8");
  assert.match(data, /Browser receives response/);
  assert.match(data, /Request queue/);
  assert.match(data, /Cache decision/);
  assert.match(data, /Proxy \/ tunnel/);
  assert.match(data, /Redirect chain/);
  assert.match(panel, /Internet Journey stops here/);
  assert.doesNotMatch(data, /HTML parsing|DOM construction|Event Loop|GPU/);
});

test("Internet Journey does not present missing measurements as zero milliseconds", async () => {
  const [panel, store, sink] = await Promise.all([
    readFile(new URL("../src/journeys/internet/internet-journey-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/journeys/internet/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/runtime/network/InternetJourneySink.zig", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /measurement === "unavailable"/);
  assert.match(panel, /return "Not timed"/);
  assert.match(panel, /return "Boundary"/);
  assert.match(panel, /return "Reused"/);
  assert.match(store, /event\.duration > 0 \? "measured" : "unavailable"/);
  assert.match(sink, /\.measurement = "boundary"/);
  assert.match(sink, /timing\.num_connects == 0 and timing\.connection_id >= 0/);
  assert.match(sink, /durationMeasurement\("tcp", 0, "measured", true\)/);
  assert.match(sink, /CURLINFO_QUEUE_TIME_T|queue_us/);
  assert.match(sink, /failed and std\.mem\.eql\(u8, stage\.id, "received"\)/);
});

test("Internet Journey snapshots completed transfers before connection release", async () => {
  const client = await readFile(new URL("../../src/core/browser/HttpClient.zig", import.meta.url), "utf8");
  const emit = client.indexOf("transfer.emitInternetJourney(msg.conn, false)");
  const release = client.indexOf("transfer.releaseConn()", emit);
  assert.ok(emit >= 0, "terminal journey emission is missing");
  assert.ok(release > emit, "the easy handle was released before its final timing snapshot");
  assert.doesNotMatch(client, /Headers are the first point[\s\S]{0,500}emitInternetJourney/);
  assert.match(client, /status == 204 or status == 304 or transfer\.req\.params\.method == \.HEAD/);
});
