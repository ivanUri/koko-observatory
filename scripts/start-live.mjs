import { spawn } from "node:child_process";
import { resolve } from "node:path";
const env = {
  ...process.env,
  NEXT_PUBLIC_KOKO_TELEMETRY_URL: process.env.NEXT_PUBLIC_KOKO_TELEMETRY_URL ?? "ws://127.0.0.1:9223/telemetry",
};

const bridge = spawn(process.execPath, ["--experimental-strip-types", resolve("scripts/koko-telemetry-bridge.mjs")], { env, stdio: "inherit" });
// Resolve the repository-local executable. A direct `node scripts/start-live.mjs`
// invocation does not inherit npm's node_modules/.bin PATH entry.
const vinext = resolve("node_modules/.bin/vinext");
const web = spawn(vinext, ["dev", ...process.argv.slice(2)], { env, stdio: "inherit" });
const shutdown = () => { bridge.kill("SIGTERM"); web.kill("SIGTERM"); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", (code) => { bridge.kill("SIGTERM"); process.exit(code ?? 0); });
