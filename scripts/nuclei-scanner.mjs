import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Fixed profiles keep UI input out of the command line and make each run's
// scope explicit. These are active HTTP checks, not passive inspection.
export const NUCLEI_PROFILES = Object.freeze({
  technologies: "http/technologies/",
  exposures: "http/exposures/",
  cves: "http/cves/",
});

const MAX_LINE_BYTES = 2_000_000;
const MAX_FINDINGS = 500;
const SCAN_TIMEOUT_MS = 120_000;
const short = (value, max = 500) => typeof value === "string" ? value.slice(0, max) : "";

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function httpEvidence(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, 16_384)
    .replace(/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:[^\r\n]*/gim, "$1: [redacted]")
    .replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+\S*?)\?\S*(\s+HTTP\/[^\r\n]*)/gim, "$1$2?[redacted]$3");
}

export function normalizeNucleiFinding(result, captureEvidence = false) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const id = short(result["template-id"], 200);
  if (!id) return undefined;
  const info = result.info && typeof result.info === "object" ? result.info : {};
  const classification = info.classification && typeof info.classification === "object" ? info.classification : {};
  const ids = Array.isArray(classification["cve-id"]) ? classification["cve-id"] : [classification["cve-id"]];
  const references = Array.isArray(info.reference) ? info.reference : [info.reference];
  return {
    templateId: id,
    title: short(info.name, 300) || id,
    severity: short(info.severity, 32) || "unknown",
    matchedAt: safeUrl(result["matched-at"] || result.host || ""),
    matcherName: short(result["matcher-name"], 150),
    cves: ids.filter((v) => typeof v === "string" && /^CVE-\d{4}-\d+$/i.test(v)).slice(0, 20),
    references: references.map(safeUrl).filter((url) => /^https?:\/\//.test(url)).slice(0, 10),
    evidence: captureEvidence ? "Request/response excerpts were retained; sensitive body content may remain." : "Template matcher reported a match; raw request/response was not retained.",
    ...(captureEvidence ? { request: httpEvidence(result.request), response: httpEvidence(result.response) } : {}),
  };
}

const localBinary = resolve(dirname(fileURLToPath(import.meta.url)), "../.tools/bin/nuclei");
const localTemplates = resolve(dirname(fileURLToPath(import.meta.url)), "../.tools/nuclei-templates");
export function createNucleiScanner({ emit, spawnProcess = spawn, binary = process.env.KOKO_NUCLEI_BINARY || (existsSync(localBinary) ? localBinary : "nuclei"), templatesDir = process.env.KOKO_NUCLEI_TEMPLATES_DIR || (existsSync(localTemplates) ? localTemplates : undefined) }) {
  let active;
  function send(command, state, details = {}) {
    emit({
      id: `nuclei:${command.scanId}:${state}:${details.index ?? 0}`,
      sessionId: command.executionId,
      sequence: Date.now(), timestamp: Date.now(), duration: 0,
      kind: "log", name: state === "finding" ? "nuclei-finding" : `nuclei-${state}`,
      status: state === "failed" ? "error" : state === "cancelled" ? "warning" : "ok",
      payload: { executionId: command.executionId, scanId: command.scanId, scanState: state, profile: command.profile, target: safeUrl(command.target), source: "nuclei", ...details },
    });
  }
  function start(command) {
    if (!command || typeof command.executionId !== "string" || !/^[-\w:]{1,100}$/.test(command.executionId) || typeof command.scanId !== "string" || !/^[-\w]{1,80}$/.test(command.scanId)) return;
    if (active) { send(command, "failed", { error: "Another Nuclei scan is already running." }); return; }
    let target;
    try {
      target = new URL(command.target);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.href.length > 2048) throw new Error();
      target.hash = "";
    } catch { send(command, "failed", { error: "Target must be a valid HTTP(S) URL without embedded credentials." }); return; }
    if (!Object.hasOwn(NUCLEI_PROFILES, command.profile)) { send(command, "failed", { error: "Unknown scan profile." }); return; }
    if (command.authorized !== true) { send(command, "failed", { error: "Confirm authorization before starting an active scan." }); return; }

    const templatePath = templatesDir ? resolve(templatesDir, NUCLEI_PROFILES[command.profile]) : NUCLEI_PROFILES[command.profile];
    const args = ["-u", target.href, "-t", templatePath, "-pt", "http", "-duc", "-ni", "-dr", "-rl", "5", "-c", "2", "-bs", "1", "-timeout", "5", "-retries", "0", "-silent", "-jsonl", "-no-color", "-omit-template"];
    if (command.captureEvidence !== true) args.push("-omit-raw");
    let child;
    try { child = spawnProcess(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch (error) { send(command, "failed", { error: short(error?.message) || "Unable to start Nuclei." }); return; }
    const run = { child, command, pending: "", count: 0, malformed: 0, stopReason: "", timer: undefined, killTimer: undefined };
    active = run;
    send(command, "started", { message: "Nuclei active HTTP scan started. Limits: 5 requests/s, 2 concurrent, 120 seconds." });
    const terminate = (reason) => {
      if (run.stopReason) return;
      run.stopReason = reason;
      child.kill("SIGTERM");
      if (active === run) {
        run.killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        run.killTimer.unref?.();
      }
    };
    run.terminate = terminate;
    const consume = (line) => {
      if (run.stopReason || !line.trim()) return;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { terminate("Scanner output exceeded the permitted line size."); return; }
      let result;
      try { result = normalizeNucleiFinding(JSON.parse(line), command.captureEvidence === true); } catch { run.malformed++; return; }
      if (!result) { run.malformed++; return; }
      if (run.count >= MAX_FINDINGS) { terminate("Finding limit reached; scan was stopped."); return; }
      send(command, "finding", { finding: result, index: ++run.count });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      run.pending += chunk;
      const lines = run.pending.split("\n");
      run.pending = lines.pop() || "";
      for (const line of lines) consume(line);
      if (Buffer.byteLength(run.pending) > MAX_LINE_BYTES) terminate("Scanner output exceeded the permitted line size.");
    });
    child.stderr?.resume();
    child.on("error", (error) => { run.error = error.code === "ENOENT" ? "Nuclei executable not found. Install Nuclei and its community templates, then restart the bridge." : short(error.message); });
    child.on("close", (code, signal) => {
      clearTimeout(run.timer);
      clearTimeout(run.killTimer);
      if (active !== run) return;
      if (run.pending) consume(run.pending);
      active = undefined;
      const details = { findings: run.count, malformed: run.malformed, exitCode: code, signal };
      if (run.stopReason === "cancelled") send(command, "cancelled", details);
      else if (run.error || run.stopReason || code !== 0) send(command, "failed", { ...details, error: run.error || run.stopReason || `Nuclei exited with code ${code}. Check that the selected community templates are installed and readable.` });
      else send(command, "completed", { ...details, message: "Scan completed; no finding does not imply the target is secure." });
    });
    run.timer = setTimeout(() => terminate("Scan timed out after 120 seconds."), SCAN_TIMEOUT_MS);
    run.timer.unref?.();
  }
  function stop(scanId) {
    if (!active || active.command.scanId !== scanId) return;
    active.terminate("cancelled");
  }
  return { start, stop };
}
