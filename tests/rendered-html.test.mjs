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
  assert.match(html, /Runtime overview/);
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
