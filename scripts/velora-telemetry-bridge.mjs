import { watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
const { fetch: sdkFetch } = await import("../../velora-sdk/dist/index.js");

const telemetryFile = process.env.VELORA_INTERNET_JOURNEY_FILE ?? "../.velora-observatory/internet-journey.jsonl";
const port = Number(process.env.VELORA_TELEMETRY_PORT ?? 9223);
const clients = new Set();
const veloraBinary = process.env.VELORA_BINARY ?? "../zig-out/bin/velora";
let offset = 0;
let pending = "";
let reading = false;
let inspections = Promise.resolve();

const server = new WebSocketServer({ host: "127.0.0.1", port, path: "/telemetry" });
server.on("connection", (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("message", (raw) => {
    try {
      const command = JSON.parse(raw.toString());
      if (command?.type !== "inspect-url" || typeof command.url !== "string") return;
      // Each SDK inspection launches a browser process. Serialize commands so
      // separate processes never append to the same JSONL file concurrently.
      inspections = inspections.then(() => sdkFetch(command.url, {
        format: "md",
        binary: veloraBinary,
        waitUntil: "load",
        timeout: 90_000,
      }))
        .catch((error) => console.error("Velora SDK inspect failed:", error));
    } catch (error) {
      console.error("Invalid telemetry command:", error);
    }
  });
});

function broadcast(line) {
  if (!line.trim()) return;
  try {
    JSON.parse(line);
  } catch {
    console.warn("Skipping malformed telemetry JSONL record");
    return;
  }
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(line);
  }
}

async function drain() {
  if (reading) return;
  reading = true;
  try {
    const info = await stat(telemetryFile);
    if (info.size < offset) {
      offset = 0;
      pending = "";
    }
    if (info.size === offset) return;
    const file = await open(telemetryFile, "r");
    try {
      const size = info.size - offset;
      const buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, offset);
      offset = info.size;
      const lines = (pending + buffer.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) broadcast(line);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(error);
  } finally {
    reading = false;
  }
}

watch(new URL("..", `file://${process.cwd()}/`), { recursive: false }, () => void drain());
setInterval(() => void drain(), 250);
console.log(`Velora telemetry bridge: ws://127.0.0.1:${port}/telemetry`);
console.log(`Reading: ${telemetryFile}`);
