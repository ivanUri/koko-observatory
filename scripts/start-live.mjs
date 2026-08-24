import { spawn } from "node:child_process";
import { resolve } from "node:path";
const env = {
  ...process.env,
  NEXT_PUBLIC_KOKO_TELEMETRY_URL: process.env.NEXT_PUBLIC_KOKO_TELEMETRY_URL ?? "ws://127.0.0.1:9223/telemetry",
};

const bridge = spawn(process.execPath, [resolve("scripts/koko-telemetry-bridge.mjs")], { env, stdio: "inherit" });
const web = spawn("vinext", ["dev"], { env, stdio: "inherit" });
const shutdown = () => { bridge.kill("SIGTERM"); web.kill("SIGTERM"); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", (code) => { bridge.kill("SIGTERM"); process.exit(code ?? 0); });
