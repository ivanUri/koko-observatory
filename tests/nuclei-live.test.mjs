import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createNucleiScanner } from "../scripts/nuclei-scanner.mjs";

test("real Nuclei detects a harmless local HTTP fixture", { skip: process.env.KOKO_TEST_NUCLEI_LIVE !== "1", timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("koko-nuclei-integration-marker"); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  try {
    const events = [];
    await new Promise((done, reject) => {
      const scanner = createNucleiScanner({ binary: resolve(".tools/bin/nuclei"), templatesDir: resolve("tests/fixtures/nuclei"), emit: (event) => {
        events.push(event);
        if (event.name === "nuclei-completed") done();
        if (event.name === "nuclei-failed") reject(new Error(event.payload.error));
      } });
      scanner.start({ executionId: "test", scanId: "test", target: `http://127.0.0.1:${server.address().port}/`, profile: "technologies", authorized: true, captureEvidence: true });
    });
    assert.equal(events.find((event) => event.name === "nuclei-finding")?.payload.finding.templateId, "koko-integration-fixture");
    assert.match(events.find((event) => event.name === "nuclei-finding")?.payload.finding.response, /koko-nuclei-integration-marker/);
    assert.equal(events.at(-1).payload.findings, 1);
  } finally { await new Promise((done) => server.close(done)); }
});
