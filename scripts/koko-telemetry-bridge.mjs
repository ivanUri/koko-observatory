import { watch } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kokoDataRoot = resolve(workspaceRoot, "koko-core");
const executionRoot = resolve(kokoDataRoot, ".koko-user-data/observatory-executions");
const telemetryFile = resolve(executionRoot, "telemetry.jsonl");
const port = Number(process.env.KOKO_TELEMETRY_PORT ?? 9223);
const clients = new Set();
const kokoBinary = process.env.KOKO_BINARY ?? resolve(kokoDataRoot, "zig-out/bin/koko");
await Promise.all([
  mkdir(executionRoot, { recursive: true }),
]);
let offset = 0;
let pending = "";
let reading = false;
let inspections = Promise.resolve();
let inspectionSequence = 0;
let activeInspection = null;
const executions = new Map();
let lifecycleSequence = Date.now();

const DEFAULT_RUN_OPTIONS = Object.freeze({
  waitUntil: "domstable",
  waitMs: 30_000,
  terminateMs: 90_000,
  waitSelector: "",
  waitScript: "",
  userAgent: "",
  extraHeaders: "",
  cookiePath: "",
  cookieJson: "",
  includeFrames: false,
});

// JSONL is an append-only local diagnostic file. Do not replay entries from a
// previous bridge/core process into a new Observatory session: those records
// may use an older schema and are not part of the user's next inspection.
try {
  offset = (await stat(telemetryFile)).size;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const server = new WebSocketServer({ host: "127.0.0.1", port, path: "/telemetry" });
server.on("connection", (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("message", (raw) => {
    try {
      const command = JSON.parse(raw.toString());
      if (command?.type === "execution.replay") {
        queueReplay(command);
        return;
      }
      if (command?.type !== "inspect-url" || typeof command.url !== "string") return;
      let requestedUrl;
      try {
        requestedUrl = new URL(command.url);
        if (requestedUrl.protocol !== "http:" && requestedUrl.protocol !== "https:") throw new Error("Unsupported URL scheme");
      } catch {
        console.warn(`Koko inspect rejected invalid URL: ${command.url}`);
        return;
      }
      // Each SDK inspection launches a browser process. Serialize commands so
      // separate processes never append to the same JSONL file concurrently.
      inspections = inspections.then(async () => {
        await drain();
        const options = normalizeRunOptions(command.options);
        activeInspection = createExecution("inspection", requestedUrl.href, undefined, options);
        emitInspectionState("started");
        try {
          // Run the Core fetch path instead of SDK Page.goto. The CLI path
          // owns the final Application storage snapshot, while JSONL remains
          // streamed live through drain() as the page loads.
          const dump = await runCoreInspection(command.url, undefined, activeInspection.options);
          await drain();
          emitSiteExport(dump.markdown, dump.html);
          emitInspectionState("completed");
        } catch (error) {
          await drain();
          const reason = typeof error?.message === "string" ? error.message : "Unknown navigation error";
          emitInspectionState("failed", error, reason);
          if (error?.code === "NAVIGATION_ERROR" || /CouldntResolveHost/i.test(reason)) {
            console.warn(`Koko inspect stopped: ${reason} (${command.url})`);
          } else {
            console.error("Koko SDK inspect failed:", error);
          }
        } finally {
          executions.set(activeInspection.id, activeInspection);
          activeInspection = null;
        }
      })
        .catch((error) => {
          console.error("Koko inspection queue failed:", error);
        });
    } catch (error) {
      console.error("Invalid telemetry command:", error);
    }
  });
});

function broadcast(line) {
  if (!line.trim()) return;
  let decoded;
  try {
    decoded = JSON.parse(line);
  } catch {
    console.warn("Skipping malformed telemetry JSONL record");
    return;
  }
  const events = Array.isArray(decoded) ? decoded : [decoded];
  const enriched = events
    .filter((event) => event && typeof event === "object" && !Array.isArray(event))
    .map((event) => activeInspection
      ? {
          ...event,
          payload: {
            ...(event.payload ?? {}),
            executionId: activeInspection.id,
            inspectionId: activeInspection.id,
            requestedUrl: activeInspection.requestedUrl,
          },
        }
      : event);
  if (activeInspection) activeInspection.events.push(...enriched);
  if (enriched.length) broadcastEvent(enriched);
}

function createExecution(kind, requestedUrl, parentExecutionId, options = DEFAULT_RUN_OPTIONS) {
  const id = `${kind}-${++inspectionSequence}`;
  return {
    id,
    requestedUrl,
    parentExecutionId,
    checkpointDirectory: resolve(executionRoot, id, "checkpoint"),
    browserDataDirectory: resolve(executionRoot, id, "browser-data"),
    optionsDirectory: resolve(executionRoot, id, "options"),
    options,
    events: [],
    lastExportProgressKey: "",
  };
}

function normalizeRunOptions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const waitUntil = ["load", "domcontentloaded", "networkidle", "domstable", "done"].includes(source.waitUntil)
    ? source.waitUntil
    : DEFAULT_RUN_OPTIONS.waitUntil;
  const positiveNumber = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), 24 * 60 * 60 * 1000) : fallback;
  };
  const text = (value) => typeof value === "string" ? value.trim() : "";
  return {
    waitUntil,
    waitMs: positiveNumber(source.waitMs, DEFAULT_RUN_OPTIONS.waitMs),
    terminateMs: positiveNumber(source.terminateMs, DEFAULT_RUN_OPTIONS.terminateMs),
    waitSelector: text(source.waitSelector),
    waitScript: text(source.waitScript),
    userAgent: text(source.userAgent),
    extraHeaders: typeof source.extraHeaders === "string" ? source.extraHeaders.trim() : "",
    cookiePath: text(source.cookiePath),
    cookieJson: typeof source.cookieJson === "string" ? source.cookieJson.trim() : "",
    includeFrames: source.includeFrames === true,
  };
}

function resolveLocalPath(value) {
  if (value.startsWith("~/")) return resolve(process.env.HOME ?? kokoDataRoot, value.slice(2));
  return resolve(kokoDataRoot, value);
}

async function prepareRunOptions(options) {
  const files = {};
  if (!activeInspection) return files;
  await mkdir(activeInspection.optionsDirectory, { recursive: true });
  files.html = resolve(activeInspection.optionsDirectory, "site.html");
  if (options.extraHeaders) {
    files.extraHeaders = resolve(activeInspection.optionsDirectory, "extra-headers.txt");
    await writeFile(files.extraHeaders, `${options.extraHeaders}\n`, "utf8");
  }
  if (options.cookieJson) {
    files.cookie = resolve(activeInspection.optionsDirectory, "cookies.json");
    await writeFile(files.cookie, `${options.cookieJson}\n`, "utf8");
  }
  return files;
}

function runCoreInspection(url, replay, options = activeInspection?.options ?? DEFAULT_RUN_OPTIONS) {
  const args = [
    "fetch", "--dump", "markdown", "--wait-until", options.waitUntil,
    "--wait-ms", String(options.waitMs),
    "--internet-journey-file", telemetryFile,
    "--telemetry-capture-bodies",
    // Controlled executions must not inherit an old profile HTTP cache: a
    // 304 has no response body and therefore cannot be replayed safely.
    "--user-data-dir", activeInspection.browserDataDirectory,
    "--execution-checkpoint-dir", activeInspection.checkpointDirectory,
  ];
  if (options.terminateMs > 0) args.push("--terminate-ms", String(options.terminateMs));
  if (options.includeFrames) args.push("--with-frames");
  const optionFilesPromise = prepareRunOptions(options);
  let htmlFile = "";
  const appendOptions = async () => {
    const files = await optionFilesPromise;
    htmlFile = files.html ?? "";
    const insertBeforeUrl = (values) => args.push(...values);
    if (options.waitSelector) insertBeforeUrl(["--wait-selector", options.waitSelector]);
    if (options.waitScript) insertBeforeUrl(["--wait-script", options.waitScript]);
    if (options.userAgent) insertBeforeUrl(["--user-agent", options.userAgent]);
    if (files.cookie) insertBeforeUrl(["--cookie", files.cookie]);
    else if (options.cookiePath) insertBeforeUrl(["--cookie", resolveLocalPath(options.cookiePath)]);
    if (files.extraHeaders) insertBeforeUrl(["--extra-headers-file", files.extraHeaders]);
    insertBeforeUrl(["--dump-html-file", files.html]);
  };
  if (replay) {
    args.push("--execution-restore-dir", replay.restoreDirectory, "--execution-replay-file", replay.policyFile);
  }
  return appendOptions().then(() => new Promise((resolveInspection, rejectInspection) => {
      args.push(url);
      const child = spawn(kokoBinary, args, {
        cwd: kokoDataRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let markdown = "";
      child.stdout.on("data", (chunk) => { markdown += chunk.toString("utf8"); });
      child.once("error", rejectInspection);
      child.once("close", (code, signal) => {
        if (code === 0 && !signal) {
          readFile(htmlFile, "utf8")
            .then((html) => resolveInspection({ markdown, html }))
            .catch(rejectInspection);
        } else rejectInspection(new Error(`Koko Core inspection ended with ${signal ?? `exit ${code}`}`));
      });
    }));
}

function emitSiteExport(markdown, finalHtml = "") {
  if (!activeInspection) return;
  const documentEvent = documentResponseEvent();
  const payload = documentEvent?.payload ?? {};
  // SPA response bodies often contain only the pre-hydration loading shell.
  // Prefer the final DOM serialized by Core after the configured wait.
  const html = typeof finalHtml === "string" && finalHtml.length > 0
    ? finalHtml
    : typeof payload.responseBody === "string" ? payload.responseBody : "";
  const markdownText = typeof markdown === "string" ? markdown : "";
  const siteExport = {
    url: typeof payload.url === "string" ? payload.url : activeInspection.requestedUrl,
    status: typeof payload.responseStatus === "number" ? payload.responseStatus : null,
    contentType: typeof payload.contentType === "string" ? payload.contentType : "text/html",
    html,
    markdown: markdownText,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    markdownBytes: Buffer.byteLength(markdownText, "utf8"),
    htmlCaptured: Boolean(html),
    markdownCaptured: Boolean(markdownText),
    bodyTruncated: payload.bodyTruncated === true,
    sourceEventId: documentEvent?.id ?? null,
    complete: true,
  };
  const event = siteExportEvent("site-export-ready", siteExport);
  activeInspection.events.push(event);
  broadcastEvent(event);
}

function documentResponseEvent() {
  if (!activeInspection) return undefined;
  return [...activeInspection.events].reverse().find((event) => {
    const payload = event?.payload ?? {};
    if (event?.kind !== "network" || payload.journeyStage !== "response") return false;
    if (payload.bodyCaptureState !== "captured" || typeof payload.responseBody !== "string") return false;
    return payload.resourceType === "document" || String(payload.contentType ?? "").toLowerCase().includes("html");
  });
}

function siteExportEvent(name, siteExport) {
  return {
    id: `${activeInspection.id}:${name}:${Date.now()}`,
    sessionId: activeInspection.id,
    sequence: ++lifecycleSequence,
    timestamp: Date.now(),
    duration: 0,
    kind: "log",
    name,
    status: siteExport.htmlCaptured || siteExport.markdownCaptured ? "ok" : "warning",
    payload: {
      executionId: activeInspection.id,
      inspectionId: activeInspection.id,
      requestedUrl: activeInspection.requestedUrl,
      siteExport,
      source: "koko-core",
    },
  };
}

async function drainSiteExportProgress() {
  if (!activeInspection) return;
  const htmlFile = resolve(activeInspection.optionsDirectory, "site.html");
  let info;
  try {
    info = await stat(htmlFile);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Unable to inspect partial site export:", error);
    return;
  }
  if (!info.size) return;
  const key = `${info.size}:${info.mtimeMs}`;
  if (key === activeInspection.lastExportProgressKey) return;
  let html;
  try {
    html = await readFile(htmlFile, "utf8");
  } catch {
    return;
  }
  if (!html) return;
  activeInspection.lastExportProgressKey = key;
  const documentEvent = documentResponseEvent();
  const payload = documentEvent?.payload ?? {};
  const siteExport = {
    url: typeof payload.url === "string" ? payload.url : activeInspection.requestedUrl,
    status: typeof payload.responseStatus === "number" ? payload.responseStatus : null,
    contentType: typeof payload.contentType === "string" ? payload.contentType : "text/html",
    html,
    markdown: "",
    htmlBytes: Buffer.byteLength(html, "utf8"),
    markdownBytes: 0,
    htmlCaptured: true,
    markdownCaptured: false,
    bodyTruncated: false,
    sourceEventId: documentEvent?.id ?? null,
    complete: false,
  };
  // Progress artifacts are broadcast live but are intentionally not appended
  // to activeInspection.events: replay policy and the durable event history
  // should not retain every full HTML snapshot.
  broadcastEvent(siteExportEvent("site-export-progress", siteExport));
}

function queueReplay(command) {
  const source = typeof command.executionId === "string" ? executions.get(command.executionId) : undefined;
  if (!source) {
    if (typeof command.executionId === "string") {
      emitReplayRejected(
        { id: command.executionId, requestedUrl: "Unknown URL" },
        "This inspection is not available to the live bridge. Inspect the URL again, then replay from the new execution.",
      );
    }
    return;
  }
  const policy = policyFromRecordedInputs(source.events);
  if (!policy.rules.length) {
    emitReplayRejected(source, "No complete text response inputs were captured for this execution.");
    return;
  }
  inspections = inspections.then(async () => {
    await drain();
    activeInspection = createExecution("replay", source.requestedUrl, source.id, source.options);
    const policyFile = resolve(executionRoot, activeInspection.id, "replay-policy.json");
    await mkdir(dirname(policyFile), { recursive: true });
    await writeFile(policyFile, JSON.stringify(policy));
    emitInspectionState("started");
    try {
      const dump = await runCoreInspection(source.requestedUrl, { restoreDirectory: source.checkpointDirectory, policyFile }, activeInspection.options);
      await drain();
      emitSiteExport(dump.markdown, dump.html);
      emitInspectionState("completed");
    } catch (error) {
      await drain();
      const reason = typeof error?.message === "string" ? error.message : "Unknown replay error";
      emitInspectionState("failed", error, reason);
      console.error("Koko replay failed:", error);
    } finally {
      executions.set(activeInspection.id, activeInspection);
      activeInspection = null;
    }
  }).catch((error) => console.error("Koko replay queue failed:", error));
}

function policyFromRecordedInputs(events) {
  const rules = new Map();
  for (const event of events) {
    const payload = event?.payload ?? {};
    if (payload.journeyStage !== "response" || typeof payload.url !== "string" || typeof payload.responseBody !== "string") continue;
    if (payload.bodyCaptureState !== "captured" || payload.bodyTruncated === true) continue;
    const method = typeof payload.method === "string" ? payload.method : "GET";
    const status = typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : 200;
    const key = `${method}\n${payload.url}`;
    rules.set(key, {
      method,
      url: payload.url,
      status,
      headers: headersFromTelemetry(payload.responseHeaders),
      body: payload.responseBody,
    });
  }
  return { mode: "strict", rules: [...rules.values()] };
}

function headersFromTelemetry(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [];
    return [{ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }];
  });
}

function emitReplayRejected(source, message) {
  const timestamp = Date.now();
  broadcastEvent({
    id: `${source.id}:replay-rejected:${timestamp}`,
    sessionId: source.id,
    sequence: ++lifecycleSequence,
    timestamp,
    duration: 0,
    kind: "log",
    name: "replay-rejected",
    status: "error",
    payload: {
      executionId: source.id,
      inspectionId: source.id,
      requestedUrl: source.requestedUrl,
      replayError: message,
      source: "koko-observatory",
    },
  });
}

function broadcastEvent(event) {
  const payload = JSON.stringify(event);
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function emitInspectionState(state, error, message) {
  if (!activeInspection) return;
  const timestamp = Date.now();
  const errorCode = typeof error?.code === "string"
    ? error.code
    : typeof error?.payload?.error?.message === "string"
      ? error.payload.error.message
      : undefined;
  broadcastEvent({
    id: `${activeInspection.id}:${state}:${timestamp}`,
    sessionId: activeInspection.id,
    sequence: ++lifecycleSequence,
    timestamp,
    duration: 0,
    kind: "log",
    name: `inspection-${state}`,
    status: state === "failed" ? "error" : "ok",
    payload: {
      inspectionId: activeInspection.id,
      executionId: activeInspection.id,
      executionParentId: activeInspection.parentExecutionId,
      requestedUrl: activeInspection.requestedUrl,
      inspectionState: state,
      errorCode,
      errorMessage: message,
      runOptions: activeInspection.options ? {
        waitUntil: activeInspection.options.waitUntil,
        waitMs: activeInspection.options.waitMs,
        terminateMs: activeInspection.options.terminateMs,
        waitSelectorConfigured: Boolean(activeInspection.options.waitSelector),
        waitScriptConfigured: Boolean(activeInspection.options.waitScript),
        userAgentConfigured: Boolean(activeInspection.options.userAgent),
        fixedHeadersConfigured: Boolean(activeInspection.options.extraHeaders),
        cookiesConfigured: Boolean(activeInspection.options.cookieJson || activeInspection.options.cookiePath),
        includeFrames: activeInspection.options.includeFrames === true,
      } : undefined,
      source: "koko-sdk",
    },
  });
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

watch(new URL("..", `file://${process.cwd()}/`), { recursive: false }, () => {
  void drain();
  void drainSiteExportProgress();
});
setInterval(() => {
  void drain();
  void drainSiteExportProgress();
}, 250);
console.log(`Koko telemetry bridge: ws://127.0.0.1:${port}/telemetry`);
console.log(`Reading: ${telemetryFile}`);
