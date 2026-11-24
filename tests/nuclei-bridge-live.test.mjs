import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

test("bridge routes a real Nuclei scan into execution telemetry", { skip: process.env.KOKO_TEST_NUCLEI_LIVE !== "1", timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => res.end("koko-nuclei-integration-marker"));
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const reservation = createServer();
  await new Promise((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  const bridgePort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const dataRoot = await mkdtemp(join(tmpdir(), "koko-nuclei-bridge-test-"));
  const bridge = spawn(process.execPath, ["--experimental-strip-types", "scripts/koko-telemetry-bridge.mjs"], { env: { ...process.env, KOKO_DATA_ROOT: dataRoot, KOKO_TELEMETRY_PORT: String(bridgePort), KOKO_NUCLEI_BINARY: resolve(".tools/bin/nuclei"), KOKO_NUCLEI_TEMPLATES_DIR: resolve("tests/fixtures/nuclei") }, stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  try {
    await new Promise((done, reject) => {
      let output = "";
      bridge.stdout.on("data", (chunk) => { output += chunk; if (output.includes("Koko telemetry bridge:")) done(); });
      bridge.once("error", reject);
      bridge.once("exit", (code) => reject(new Error(`Bridge exited early: ${code}`)));
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/telemetry`, { origin: "http://localhost:4000" });
      try { await new Promise((done, reject) => { socket.once("open", done); socket.once("error", reject); }); break; }
      catch (error) { if (attempt === 39) throw error; await new Promise((done) => setTimeout(done, 50)); }
    }
    const events = [];
    await new Promise((done, reject) => {
      socket.on("message", (raw) => {
        const value = JSON.parse(raw.toString());
        for (const event of Array.isArray(value) ? value : [value]) {
          if (event.payload?.scanId !== "bridge-test") continue;
          events.push(event);
          if (event.name === "nuclei-completed") done();
          if (event.name === "nuclei-failed") reject(new Error(event.payload.error));
        }
      });
      socket.send(JSON.stringify({ type: "nuclei.start", executionId: "inspection-test", scanId: "bridge-test", target: `http://127.0.0.1:${server.address().port}/`, profile: "technologies", authorized: true }));
    });
    assert.deepEqual(events.map((event) => event.name), ["nuclei-started", "nuclei-finding", "nuclei-completed"]);
    assert.equal(events[1].payload.executionId, "inspection-test");
    assert.equal(events[1].payload.finding.templateId, "koko-integration-fixture");
  } finally {
    socket?.terminate();
    bridge.kill("SIGTERM");
    await new Promise((done) => server.close(done));
    await rm(dataRoot, { recursive: true, force: true });
  }
});
