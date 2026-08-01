import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const env = {
  ...process.env,
  VELORA_BINARY: process.env.VELORA_BINARY ?? resolve(root, "zig-out/bin/velora"),
  VELORA_INTERNET_JOURNEY_FILE: process.env.VELORA_INTERNET_JOURNEY_FILE ?? resolve(root, ".velora-observatory/internet-journey.jsonl"),
  NEXT_PUBLIC_VELORA_TELEMETRY_URL: process.env.NEXT_PUBLIC_VELORA_TELEMETRY_URL ?? "ws://127.0.0.1:9223/telemetry",
};

const bridge = spawn(process.execPath, [resolve("scripts/velora-telemetry-bridge.mjs")], { env, stdio: "inherit" });
const web = spawn("npm", ["run", "dev"], { env, stdio: "inherit" });
const shutdown = () => { bridge.kill("SIGTERM"); web.kill("SIGTERM"); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", (code) => { bridge.kill("SIGTERM"); process.exit(code ?? 0); });
