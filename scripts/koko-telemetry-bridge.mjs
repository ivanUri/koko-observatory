import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { selectDocumentResponse } from "../src/core/document-transfer.ts";
import { REVERSE_RUNTIME_PROBE } from "../src/reverse/runtime-probe.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kokoDataRoot = process.env.KOKO_DATA_ROOT ? resolve(process.env.KOKO_DATA_ROOT) : resolve(workspaceRoot, "../koko-core");
const executionRoot = resolve(kokoDataRoot, ".koko-user-data/observatory-executions");
const port = Number(process.env.KOKO_TELEMETRY_PORT ?? 9223);
const automationPort = Number(process.env.KOKO_AUTOMATION_MCP_PORT ?? 9224);
const clients = new Set();
const kokoBinary = process.env.KOKO_BINARY ?? resolve(kokoDataRoot, "zig-out/bin/koko");
const probeBundle = resolve(workspaceRoot, "public/generated/koko-observatory-probe.js");
await Promise.all([
  mkdir(executionRoot, { recursive: true }),
]);
let telemetrySource = { path: "", offset: 0, pending: "" };
let reading = false;
let inspections = Promise.resolve();
let inspectionSequence = await latestExecutionSequence();
let activeInspection = null;
const executions = new Map();
let lifecycleSequence = Date.now();
let automationSession = null;
let automationRpcSequence = 0;
let automationQueue = Promise.resolve();

const DEFAULT_RUN_OPTIONS = Object.freeze({
  // The UI observes lifecycle milestones instead of making the user choose a
  // blocking wait policy. Core returns at DCL, then keeps the page alive for a
  // bounded window so hydration/lazy resources can continue in the background.
  waitUntil: "domcontentloaded",
  waitMs: 30_000,
  observeMs: 10_000,
  terminateMs: 90_000,
  expandLazy: false,
  maxScrolls: 80,
  scrollSettleMs: 250,
  waitSelector: "",
  waitScript: "",
  userAgent: "",
  extraHeaders: "",
  cookiePath: "",
  cookieJson: "",
  includeFrames: false,
  accessibilityAudit: true,
});

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
      if (command?.type === "execution.clear-all") {
        inspections = inspections.then(async () => {
          await drain();
          await stopAutomationSession();
          const removed = await clearExecutionArtifacts();
          broadcastEvent({
            id: `bridge:execution-data-cleared:${Date.now()}`,
            sessionId: "bridge",
            sequence: ++lifecycleSequence,
            timestamp: Date.now(),
            duration: 0,
            kind: "log",
            name: "execution-data-cleared",
            status: "ok",
            payload: { removed, source: "koko-observatory" },
          });
        }).catch((error) => console.error("Koko execution data cleanup failed:", error));
        return;
      }
      if (typeof command?.type === "string" && command.type.startsWith("automation.")) {
        automationQueue = automationQueue.then(() => handleAutomationCommand(command)).catch((error) => {
          console.error("Koko automation command failed:", error);
          emitAutomationEvent("automation-step-failed", "error", { error: error instanceof Error ? error.message : String(error) });
        });
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
      // A new URL is a browser-style navigation: stop the previous Core
      // process immediately, then let the existing queue start the replacement
      // after the old process has closed and its final telemetry has drained.
      const previousCancellation = cancelActiveInspection("replaced by a new inspection");
      // Each SDK inspection launches a browser process. Serialize commands so
      // separate processes never append to the same JSONL file concurrently.
      inspections = inspections.then(async () => {
        await previousCancellation;
        await drain();
        const options = withKnownSiteReadinessWait(requestedUrl, normalizeRunOptions(command.options));
        let attempt = 0;
        while (true) {
          activeInspection = createExecution("inspection", requestedUrl.href, undefined, options);
          activeInspection.attempt = attempt + 1;
          await beginTelemetry(activeInspection);
          emitInspectionState("started");
          try {
            // Run the Core fetch path instead of SDK Page.goto. The CLI path
            // owns the final Application storage snapshot, while JSONL remains
            // streamed live through drain() as the page loads.
            const dump = await runCoreInspection(command.url, undefined, activeInspection.options, activeInspection);
            if (activeInspection.cancelRequested) throw new Error("Inspection cancelled after Core completed");
            await drain();
            emitSiteExport(dump.markdown, dump.html);
            emitInspectionState("completed");
            executions.set(activeInspection.id, activeInspection);
            activeInspection = null;
            break;
          } catch (error) {
            await drain();
            const reason = typeof error?.message === "string" ? error.message : "Unknown navigation error";
            if (activeInspection.cancelRequested) {
              emitInspectionState("cancelled", undefined, activeInspection.cancelReason ?? "Inspection replaced by a newer URL");
              executions.set(activeInspection.id, activeInspection);
              activeInspection = null;
              break;
            }
            const retryableCrash = attempt < 2 && /SIGABRT|SIGSEGV|SIGBUS/i.test(reason);
            if (retryableCrash) {
              const failedAttempt = activeInspection;
              broadcastEvent({
                id: `${failedAttempt.id}:retrying:${Date.now()}`,
                sessionId: failedAttempt.id,
                sequence: ++lifecycleSequence,
                timestamp: Date.now(),
                duration: 0,
                kind: "log",
                name: "inspection-retrying",
                status: "warning",
                payload: {
                  executionId: failedAttempt.id,
                  inspectionId: failedAttempt.id,
                  requestedUrl: failedAttempt.requestedUrl,
                  attempt: failedAttempt.attempt,
                  nextAttempt: failedAttempt.attempt + 1,
                  reason,
                  source: "koko-sdk",
                },
              });
              executions.set(failedAttempt.id, failedAttempt);
              activeInspection = null;
              attempt += 1;
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * attempt));
              continue;
            }
            emitInspectionState("failed", error, reason);
            if (error?.code === "NAVIGATION_ERROR" || /CouldntResolveHost/i.test(reason)) {
              console.warn(`Koko inspect stopped: ${reason} (${command.url})`);
            } else {
              console.error("Koko SDK inspect failed:", error);
            }
            executions.set(activeInspection.id, activeInspection);
            activeInspection = null;
            break;
          }
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
    telemetryFile: resolve(executionRoot, id, "telemetry.jsonl"),
    options,
    events: [],
    lastExportProgressKey: "",
  };
}

async function latestExecutionSequence() {
  const entries = await readdir(executionRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries.reduce((latest, entry) => {
    if (!entry.isDirectory()) return latest;
    const match = /^(?:inspection|replay)-(\d+)$/.exec(entry.name);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
}

async function clearExecutionArtifacts() {
  const entries = await readdir(executionRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || (activeInspection && entry.name === activeInspection.id)) continue;
    await rm(resolve(executionRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  executions.clear();
  return removed;
}

async function handleAutomationCommand(command) {
  switch (command.type) {
    case "automation.start":
      return startAutomationSession(command);
    case "automation.stop":
      return stopAutomationSession();
    case "automation.discover":
      return discoverAutomationSession();
    case "automation.execute":
    case "automation.retry":
      return executeAutomationStep(command.step);
    case "automation.run":
      return runAutomationWorkflow(command.steps);
    case "automation.reset":
      await stopAutomationSession();
      return;
    default:
      throw new Error(`Unsupported automation command: ${command.type}`);
  }
}

async function startAutomationSession(command) {
  if (automationSession) await stopAutomationSession();
  const id = `automation-${Date.now()}`;
  const dataDirectory = resolve(executionRoot, id, "browser-data");
  await mkdir(dataDirectory, { recursive: true });
  const child = spawn(kokoBinary, [
    "mcp", "--host", "127.0.0.1", "--port", String(automationPort), "--max-sessions", "1",
    "--user-data-dir", dataDirectory,
  ], { cwd: kokoDataRoot, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout?.on("data", (chunk) => console.log(`[koko-automation] ${chunk.toString("utf8").trim()}`));
  try {
    await waitForAutomationServer(child);
    const initialized = await automationRpc({
      jsonrpc: "2.0", id: ++automationRpcSequence, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "koko-observatory", version: "0.1.0" },
      },
    });
    await automationRpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, initialized.sessionId);
    automationSession = { id, child, dataDirectory, sessionId: initialized.sessionId, url: "", title: "", reverseEnabled: command.reverse === true };
    if (automationSession.reverseEnabled) {
      await automationCall("addInitScript", { script: REVERSE_RUNTIME_PROBE });
    }
    // A newly initialized MCP session has no page yet. Discovery APIs require
    // currentFrame(), so only take a snapshot after the first navigation.
    emitAutomationEvent("automation-session-started", "ok", {
      sessionId: id,
      url: "",
      title: "",
      elements: [],
      snapshot: "",
    });
    if (typeof command.url === "string" && command.url.trim()) {
      await automationCall("goto", { url: command.url.trim(), waitUntil: command.waitUntil ?? "domcontentloaded", timeout: command.timeoutMs ?? 30_000 });
      const state = await automationSnapshot();
      automationSession.url = state.url;
      automationSession.title = state.title;
      emitAutomationEvent("automation-discovery-ready", "ok", { sessionId: id, ...state });
      if (automationSession.reverseEnabled) {
        await drainReverseRuntime();
        emitReverseEvent("reverse-session-started", { requestedUrl: state.url, title: state.title, mode: "targeted", capabilities: ["dom-events", "event-listeners", "network", "dom-mutations", "async-tasks"] });
      }
    }
  } catch (error) {
    if (!child.killed) child.kill("SIGTERM");
    throw error;
  }
}

async function stopAutomationSession() {
  const session = automationSession;
  if (!session) return;
  automationSession = null;
  try {
    await automationRpc(undefined, session.sessionId, "DELETE");
  } catch {
    // The Core process may already have exited; continue cleanup below.
  }
  if (!session.child.killed) session.child.kill("SIGTERM");
  if (session.child.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => session.child.once("close", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
    ]);
  }
  emitAutomationEvent("automation-session-stopped", "ok", { sessionId: session.id });
}

async function discoverAutomationSession() {
  ensureAutomationSession();
  const state = await automationSnapshot();
  automationSession.url = state.url;
  automationSession.title = state.title;
  emitAutomationEvent("automation-discovery-ready", "ok", { sessionId: automationSession.id, ...state });
}

async function executeAutomationStep(step) {
  ensureAutomationSession();
  if (!step || typeof step.action !== "string") throw new Error("Automation step is missing an action");
  const startedAt = Date.now();
  const safeStep = sanitizeAutomationStep(step);
  emitAutomationEvent("automation-step-started", "ok", { sessionId: automationSession.id, stepId: step.id, step: safeStep });
  let marker;
  try {
    if (automationSession.reverseEnabled) await drainReverseRuntime();
    const args = await automationArguments(step);
    marker = args._automationMarker;
    const toolArguments = { ...args };
    delete toolArguments._automationMarker;
    await automationCall(actionToolName(step.action), toolArguments);
    if (automationSession.reverseEnabled) {
      const evidence = await drainReverseRuntime();
      emitReverseEvent("reverse-evidence-batch", {
        actionId: step.id,
        action: safeStep,
        evidence,
        collection: { mechanism: "page-runtime-probe", bounded: true, maxRecords: 400 },
      });
    }
    const state = await automationSnapshot();
    automationSession.url = state.url;
    automationSession.title = state.title;
    emitAutomationEvent("automation-step-completed", "ok", {
      sessionId: automationSession.id,
      stepId: step.id,
      step: safeStep,
      durationMs: Date.now() - startedAt,
      ...state,
    });
  } catch (error) {
    emitAutomationEvent("automation-step-failed", "error", {
      sessionId: automationSession.id,
      stepId: step.id,
      step: safeStep,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (marker) await cleanupAutomationMarker(marker);
  }
}

async function runAutomationWorkflow(steps) {
  ensureAutomationSession();
  if (!Array.isArray(steps)) throw new Error("Automation workflow steps must be an array");
  for (const step of steps) await executeAutomationStep(step);
  emitAutomationEvent("automation-workflow-completed", "ok", { sessionId: automationSession.id, count: steps.length, url: automationSession.url, title: automationSession.title });
}

function actionToolName(action) {
  const name = ({ navigate: "goto", click: "click", fill: "fill", select: "selectOption", check: "setChecked", press: "press", hover: "hover", scroll: "scroll", wait: "waitForSelector" })[action];
  if (!name) throw new Error(`Unsupported automation action: ${action}`);
  return name;
}

async function automationArguments(step) {
  if (step.action === "navigate") return { url: String(step.value ?? ""), waitUntil: step.waitUntil ?? "domcontentloaded", timeout: step.timeoutMs ?? 30_000 };
  if (step.action === "wait") return { selector: locatorToSelector(step.locator), timeout: step.timeoutMs ?? 5_000 };
  if (step.action === "scroll") return {
    ...(step.x !== undefined ? { x: step.x } : {}),
    ...(step.y !== undefined ? { y: step.y } : {}),
    ...(step.locator ? await resolveAutomationLocator(step.locator) : {}),
  };
  const resolved = await resolveAutomationLocator(step.locator);
  if (step.action === "fill") return { ...resolved, text: String(step.value ?? "") };
  if (step.action === "select") return { ...resolved, value: String(step.value ?? "") };
  if (step.action === "check") return { ...resolved, checked: step.checked === true };
  if (step.action === "press") return { ...resolved, key: String(step.key ?? "Enter") };
  return resolved;
}

async function resolveAutomationLocator(locator) {
  if (!locator || typeof locator.kind !== "string" || typeof locator.value !== "string" || !locator.value.trim()) throw new Error("Action requires an element locator");
  const elements = await automationInteractiveElements();
  let matches = elements.filter((element) => matchesLocator(element, locator));
  if (locator.kind === "css" && !matches.length) matches = await resolveCssLocator(locator.value);
  if (!matches.length) throw new Error(`No element matched ${locator.kind}: ${locator.value}`);
  if (matches.length > 1) throw new Error(`Locator matched ${matches.length} elements; make it more specific`);
  if (!matches[0].backendNodeId) throw new Error("Matched element has no active backend node id");
  return { backendNodeId: matches[0].backendNodeId, ...(matches[0]._automationMarker ? { _automationMarker: matches[0]._automationMarker } : {}) };
}

function matchesLocator(element, locator) {
  const value = locator.value.trim().toLowerCase();
  if (locator.kind === "role") return String(element.role ?? "").toLowerCase() === value && (!locator.name || String(element.name ?? "").toLowerCase().includes(locator.name.toLowerCase()));
  if (locator.kind === "id") return element.id === locator.value;
  if (locator.kind === "name") return element.elementName === locator.value;
  if (locator.kind === "placeholder") return element.placeholder === locator.value;
  return false;
}

async function resolveCssLocator(selector) {
  // Use a temporary id so arbitrary CSS selectors can be resolved through the
  // existing interactiveElements MCP tool without exposing Evaluate in UI.
  const marker = `__koko_automation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const script = `(() => { const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]; nodes.forEach((el, index) => el.setAttribute("id", ${JSON.stringify(marker)} + "_" + index)); return JSON.stringify({ count: nodes.length }); })()`;
  const result = await automationCall("evaluate", { script });
  let count = 0;
  try { count = JSON.parse(extractToolText(result) || "{}").count ?? 0; } catch { /* keep no match */ }
  if (count > 1) {
    await cleanupAutomationMarker(marker);
    throw new Error(`Locator matched ${count} elements; make it more specific`);
  }
  if (!count) {
    await cleanupAutomationMarker(marker);
    return [];
  }
  const refreshed = await automationInteractiveElements();
  return refreshed.filter((element) => element.id === `${marker}_0`).map((element) => ({ ...element, _automationMarker: marker }));
}

async function cleanupAutomationMarker(marker) {
  try {
    await automationCall("evaluate", { script: `(() => { document.querySelectorAll("[id^=${JSON.stringify(marker)}]").forEach((el) => el.removeAttribute("id")); return true; })()` });
  } catch {
    // Cleanup is best effort; navigation may have already replaced the DOM.
  }
}

function escapeCssIdentifier(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function locatorToSelector(locator) {
  if (!locator) throw new Error("Wait action requires a locator");
  if (locator.kind === "css") return locator.value;
  if (locator.kind === "id") return `#${escapeCssIdentifier(locator.value)}`;
  if (locator.kind === "placeholder") return `[placeholder=${JSON.stringify(locator.value)}]`;
  if (locator.kind === "name") return `[name=${JSON.stringify(locator.value)}]`;
  throw new Error("Wait action supports CSS, id, name or placeholder locators");
}

async function automationSnapshot() {
  const elements = await automationInteractiveElements();
  const semantic = await automationCall("semantic_tree", {});
  const meta = await automationCall("evaluate", { script: "JSON.stringify({url: location.href, title: document.title})" });
  let parsedMeta = {};
  try { parsedMeta = JSON.parse(extractToolText(meta) || "{}"); } catch { /* keep empty metadata */ }
  return { url: parsedMeta.url ?? automationSession?.url ?? "", title: parsedMeta.title ?? "", elements, snapshot: extractToolText(semantic) ?? "" };
}

async function automationInteractiveElements() {
  const result = await automationCall("interactiveElements", {});
  try { return JSON.parse(extractToolText(result) || "[]"); } catch { return []; }
}

function sanitizeAutomationStep(step) {
  const copy = { ...step };
  if (copy.action === "fill" && typeof copy.value === "string") copy.value = copy.value.length ? `${copy.value.slice(0, 2)}•••` : "";
  return copy;
}

function ensureAutomationSession() {
  if (!automationSession) throw new Error("Automation session is not running");
}

async function waitForAutomationServer(child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Automation Core exited with code ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${automationPort}/mcp`);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  child.kill("SIGTERM");
  throw new Error("Timed out waiting for Koko MCP automation server");
}

async function automationRpc(body, sessionId, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${automationPort}/mcp`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const assignedSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  // JSON-RPC notifications do not have a response body. Koko's MCP transport
  // acknowledges them with 202, while session deletion uses 204.
  if (response.status === 202 || response.status === 204) {
    return { sessionId: assignedSessionId, result: undefined };
  }
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`MCP returned invalid JSON (${response.status})`); }
  if (!response.ok || parsed.error) throw new Error(parsed.error?.message ?? `MCP request failed (${response.status})`);
  return { sessionId: assignedSessionId, result: parsed.result };
}

async function automationCall(name, args) {
  ensureAutomationSession();
  const response = await automationRpc({ jsonrpc: "2.0", id: ++automationRpcSequence, method: "tools/call", params: { name, arguments: args } }, automationSession.sessionId);
  automationSession.sessionId = response.sessionId;
  if (response.result?.isError === true) throw new Error(extractToolText(response.result) ?? `Koko action failed: ${name}`);
  return response.result;
}

function extractToolText(result) {
  const content = result?.content;
  const text = Array.isArray(content) ? content.find((item) => item.type === "text")?.text : undefined;
  return typeof text === "string" ? text : undefined;
}

function emitAutomationEvent(name, status, payload = {}, duration = 0) {
  const timestamp = Date.now();
  broadcastEvent({ id: `automation:${name}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, sessionId: automationSession?.id ?? "automation", sequence: ++lifecycleSequence, timestamp, duration, kind: "log", name, status, payload: { ...payload, source: "koko-observatory" } });
}

function emitReverseEvent(name, payload = {}, status = "ok") {
  if (!automationSession) return;
  const timestamp = Date.now();
  broadcastEvent({
    id: `reverse:${automationSession.id}:${name}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`,
    sessionId: automationSession.id,
    sequence: ++lifecycleSequence,
    timestamp,
    duration: 0,
    kind: "javascript",
    name,
    status,
    payload: {
      ...payload,
      sessionId: automationSession.id,
      requestedUrl: automationSession.url,
      reverseSchemaVersion: 2,
      source: "koko-reverse-engine",
    },
  });
}

async function drainReverseRuntime() {
  const result = await automationCall("evaluate", { script: "window.__kokoReverseRuntime?.drain?.() ?? '[]'" });
  const raw = extractToolText(result) ?? "[]";
  let value = raw;
  try { value = JSON.parse(raw); } catch { /* the MCP result may already be plain text */ }
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = []; }
  }
  return Array.isArray(value) ? value.slice(0, 400) : [];
}

async function beginTelemetry(execution) {
  await mkdir(dirname(execution.telemetryFile), { recursive: true });
  telemetrySource = { path: execution.telemetryFile, offset: 0, pending: "" };
}

function cancelActiveInspection(reason) {
  const inspection = activeInspection;
  if (!inspection) return Promise.resolve();
  inspection.cancelRequested = true;
  inspection.cancelReason = reason;
  if (inspection.cancelPromise) return inspection.cancelPromise;
  const child = inspection.child;
  if (!child || child.exitCode !== null) return Promise.resolve();
  inspection.cancelPromise = new Promise((resolveCancellation) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveCancellation();
    };
    child.once("close", settle);
    try { child.kill("SIGTERM"); } catch { settle(); return; }
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* already closed */ }
        setTimeout(settle, 1_000);
      } else {
        settle();
      }
    }, 2_000);
  });
  return inspection.cancelPromise;
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
  const boundedInteger = (value, fallback, maximum) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
  };
  const text = (value) => typeof value === "string" ? value.trim() : "";
  return {
    waitUntil,
    waitMs: positiveNumber(source.waitMs, DEFAULT_RUN_OPTIONS.waitMs),
    observeMs: positiveNumber(source.observeMs, DEFAULT_RUN_OPTIONS.observeMs),
    terminateMs: positiveNumber(source.terminateMs, DEFAULT_RUN_OPTIONS.terminateMs),
    expandLazy: source.expandLazy === true || source.expand_lazy === true,
    maxScrolls: boundedInteger(source.maxScrolls ?? source.max_scrolls, DEFAULT_RUN_OPTIONS.maxScrolls, 10_000),
    scrollSettleMs: positiveNumber(source.scrollSettleMs ?? source.scroll_settle_ms, DEFAULT_RUN_OPTIONS.scrollSettleMs),
    waitSelector: text(source.waitSelector),
    waitScript: text(source.waitScript),
    userAgent: text(source.userAgent),
    extraHeaders: typeof source.extraHeaders === "string" ? source.extraHeaders.trim() : "",
    cookiePath: text(source.cookiePath),
    cookieJson: typeof source.cookieJson === "string" ? source.cookieJson.trim() : "",
    includeFrames: source.includeFrames === true,
    accessibilityAudit: source.accessibilityAudit !== false,
  };
}

// Some sites do their real navigation after DOMContentLoaded. Zalo is one of
// those sites: chat.zalo.me first renders a loading shell, calls its bootstrap
// APIs and then redirects unauthenticated users to id.zalo.me/account. A short
// background observation window must not decide when the export snapshot is
// taken, otherwise Observatory persists only that shell. Keep this narrowly
// scoped and let an explicit user wait condition win.
const ZALO_READINESS_WAIT_SCRIPT = `(() => {
  const loginBody = document.querySelector(".zLogin-layout .body");
  if (loginBody) return loginBody.children.length > 0;
  if (location.hostname !== "chat.zalo.me") return false;
  const app = document.querySelector("#app");
  return Boolean(app && app.children.length > 0 && !app.querySelector("#loading-page"));
})()`;

function withKnownSiteReadinessWait(url, options) {
  if (options.waitSelector || options.waitScript || url.hostname !== "chat.zalo.me") return options;
  return {
    ...options,
    // The default is already 30 seconds; preserve a smaller user value only
    // when they supplied an explicit selector/script, handled above. Zalo's
    // auth bootstrap can legitimately need the full readiness timeout.
    waitMs: Math.max(options.waitMs, 30_000),
    waitScript: ZALO_READINESS_WAIT_SCRIPT,
  };
}

function resolveLocalPath(value) {
  if (value.startsWith("~/")) return resolve(process.env.HOME ?? kokoDataRoot, value.slice(2));
  return resolve(kokoDataRoot, value);
}

async function prepareRunOptions(options, inspection = activeInspection) {
  const files = {};
  if (!inspection || inspection.cancelRequested) return files;
  await mkdir(inspection.optionsDirectory, { recursive: true });
  files.html = resolve(inspection.optionsDirectory, "site.html");
  files.probe = resolve(inspection.optionsDirectory, "probe.js");
  const probe = await readFile(probeBundle, "utf8");
  const probeOptions = JSON.stringify({ accessibilityAudit: options.accessibilityAudit !== false });
  // The config must precede the bundled probe because Core evaluates the
  // injected file before the document parser starts.
  await writeFile(files.probe, `window.__kokoProbeOptions=${probeOptions};\n${probe}`, "utf8");
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

function runCoreInspection(url, replay, options = activeInspection?.options ?? DEFAULT_RUN_OPTIONS, inspection = activeInspection) {
  if (!inspection) return Promise.reject(new Error("No active inspection"));
  const args = [
    "fetch", "--dump", "markdown", "--wait-until", options.waitUntil,
    "--wait-ms", String(options.waitMs),
    "--observe-ms", String(options.observeMs),
    "--internet-journey-file", inspection.telemetryFile,
    // Observatory is an explicit local inspection surface, so it opts into
    // bounded text/JSON bodies without requiring users to manage an env var.
    "--telemetry-capture-bodies",
    // Controlled executions must not inherit an old profile HTTP cache: a
    // 304 has no response body and therefore cannot be replayed safely.
    "--user-data-dir", inspection.browserDataDirectory,
    "--execution-checkpoint-dir", inspection.checkpointDirectory,
  ];
  if (options.terminateMs > 0) args.push("--terminate-ms", String(options.terminateMs));
  if (options.expandLazy) {
    args.push("--expand-lazy", "--max-scrolls", String(options.maxScrolls), "--scroll-settle-ms", String(options.scrollSettleMs));
  }
  if (options.includeFrames) args.push("--with-frames");
  const optionFilesPromise = prepareRunOptions(options, inspection);
  let htmlFile = "";
  const appendOptions = async () => {
    const files = await optionFilesPromise;
    htmlFile = files.html ?? "";
    const insertBeforeUrl = (values) => args.push(...values);
    if (options.waitSelector) insertBeforeUrl(["--wait-selector", options.waitSelector]);
    if (options.waitScript) insertBeforeUrl(["--wait-script", options.waitScript]);
    if (files.probe) insertBeforeUrl(["--inject-script-file", files.probe]);
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
      if (inspection.cancelRequested) {
        rejectInspection(new Error("Inspection cancelled before Core started"));
        return;
      }
      args.push(url);
      const child = spawn(kokoBinary, args, {
        cwd: kokoDataRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
      });
      inspection.child = child;
      let markdown = "";
      child.stdout.on("data", (chunk) => { markdown += chunk.toString("utf8"); });
      child.once("error", rejectInspection);
      child.once("close", (code, signal) => {
        inspection.child = undefined;
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
  const inspection = activeInspection;
  const documentEvent = documentResponseEvent(inspection);
  const payload = documentEvent?.payload ?? {};
  const contentType = typeof payload.contentType === "string" ? payload.contentType : "text/html";
  const responseBody = typeof payload.responseBody === "string" ? payload.responseBody : "";
  const htmlResponse = isHtmlResponse(contentType, responseBody);
  // SPA response bodies often contain only the pre-hydration loading shell.
  // Prefer the final DOM serialized by Core after the configured wait, but
  // never use that browser-generated wrapper for JSON or plain-text APIs.
  const html = htmlResponse
    ? typeof finalHtml === "string" && finalHtml.length > 0 ? finalHtml : responseBody
    : "";
  const body = htmlResponse ? "" : responseBody;
  const markdownText = htmlResponse && typeof markdown === "string" ? markdown : "";
  const siteExport = {
    url: typeof payload.url === "string" ? payload.url : inspection.requestedUrl,
    status: typeof payload.responseStatus === "number" ? payload.responseStatus : null,
    contentType,
    html,
    body,
    markdown: markdownText,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    markdownBytes: Buffer.byteLength(markdownText, "utf8"),
    htmlCaptured: Boolean(html),
    bodyCaptured: Boolean(body),
    markdownCaptured: Boolean(markdownText),
    bodyTruncated: payload.bodyTruncated === true,
    sourceEventId: documentEvent?.id ?? null,
    complete: true,
  };
  const event = siteExportEvent("site-export-ready", siteExport, inspection);
  inspection.events.push(event);
  broadcastEvent(event);
}

function documentResponseEvent(inspection = activeInspection) {
  if (!inspection) return undefined;
  return selectDocumentResponse(inspection.events, inspection.requestedUrl);
}

function isHtmlResponse(contentType, body = "") {
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes("application/json") || normalized.includes("+json")) return false;
  if (normalized.includes("text/html") || normalized.includes("application/xhtml+xml")) return true;
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
}

function siteExportEvent(name, siteExport, inspection = activeInspection) {
  if (!inspection) return undefined;
  return {
    id: `${inspection.id}:${name}:${Date.now()}`,
    sessionId: inspection.id,
    sequence: ++lifecycleSequence,
    timestamp: Date.now(),
    duration: 0,
    kind: "log",
    name,
    status: siteExport.htmlCaptured || siteExport.bodyCaptured || siteExport.markdownCaptured ? "ok" : "warning",
    payload: {
      executionId: inspection.id,
      inspectionId: inspection.id,
      requestedUrl: inspection.requestedUrl,
      siteExport,
      source: "koko-core",
    },
  };
}

async function drainSiteExportProgress() {
  const inspection = activeInspection;
  if (!inspection) return;
  const htmlFile = resolve(inspection.optionsDirectory, "site.html");
  let info;
  let html = "";
  try {
    info = await stat(htmlFile);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Unable to inspect partial site export:", error);
    info = undefined;
  }
  if (info?.size) {
    try {
      html = await readFile(htmlFile, "utf8");
    } catch {
      html = "";
    }
  }
  // The inspection can finish while the file read above is in flight. Never
  // publish progress for a completed inspection or read from a replacement
  // inspection that started after this function began.
  if (activeInspection !== inspection) return;
  const documentEvent = documentResponseEvent(inspection);
  const payload = documentEvent?.payload ?? {};
  const contentType = typeof payload.contentType === "string" ? payload.contentType : "text/html";
  const responseBody = typeof payload.responseBody === "string" ? payload.responseBody : "";
  const htmlResponse = isHtmlResponse(contentType, responseBody);
  // `--dump-html-file` is written after the Core command finishes. The
  // captured document response, however, is available as soon as navigation
  // receives its first body, so use it as the live seed and replace it with
  // the serialized DOM file when Core writes that later snapshot.
  if (!html && htmlResponse) html = responseBody;
  const body = htmlResponse ? "" : responseBody;
  if (!html && !body) return;
  // Core refreshes the sidecar on a timer. Only publish when the actual
  // document bytes changed; mtime alone would make the UI repaint every tick.
  const contentHash = createHash("sha1").update(html).update(body).digest("hex");
  const key = `${documentEvent?.id ?? "none"}:${contentHash}`;
  if (key === inspection.lastExportProgressKey) return;
  inspection.lastExportProgressKey = key;
  const siteExport = {
    url: typeof payload.url === "string" ? payload.url : inspection.requestedUrl,
    status: typeof payload.responseStatus === "number" ? payload.responseStatus : null,
    contentType,
    html: htmlResponse ? html : "",
    body,
    markdown: "",
    htmlBytes: htmlResponse ? Buffer.byteLength(html, "utf8") : 0,
    bodyBytes: htmlResponse ? 0 : Buffer.byteLength(body, "utf8"),
    markdownBytes: 0,
    htmlCaptured: htmlResponse,
    bodyCaptured: !htmlResponse && Boolean(responseBody),
    markdownCaptured: false,
    bodyTruncated: payload.bodyTruncated === true,
    sourceEventId: documentEvent?.id ?? null,
    complete: false,
  };
  // Progress artifacts are broadcast live but are intentionally not appended
  // to activeInspection.events: replay policy and the durable event history
  // should not retain every full HTML snapshot.
  const event = siteExportEvent("site-export-progress", siteExport, inspection);
  if (event) broadcastEvent(event);
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
  const replayPlan = normalizeReplayPlan(command.replayPlan);
  const policy = policyFromRecordedInputs(source.events, replayPlan);
  if (!policy.rules.length) {
    emitReplayRejected(source, "No complete text response inputs were captured for this execution.");
    return;
  }
  inspections = inspections.then(async () => {
    await drain();
    activeInspection = createExecution("replay", source.requestedUrl, source.id, source.options);
    activeInspection.replayPlan = replayPlan;
    await beginTelemetry(activeInspection);
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

function normalizeReplayPlan(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mode = source.mode === "fallback" ? "fallback" : "strict";
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const disabledKeys = Array.isArray(source.disabledKeys)
    ? [...new Set(source.disabledKeys.map(text).filter(Boolean))]
    : [];
  const overrides = Array.isArray(source.overrides)
    ? source.overrides.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const key = text(item.key);
      if (!key) return [];
      const status = Number(item.status);
      const headers = Array.isArray(item.headers)
        ? item.headers.flatMap((header) => {
          if (!header || typeof header !== "object") return [];
          const name = text(header.name);
          const value = text(header.value);
          return name ? [{ name, value }] : [];
        })
        : undefined;
      return [{
        key,
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
        ...(typeof item.body === "string" ? { body: item.body } : {}),
        ...(headers ? { headers } : {}),
      }];
    })
    : [];
  const breakpoints = Array.isArray(source.breakpoints)
    ? source.breakpoints.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const key = text(item.key);
      return key ? [{ key, ...(text(item.label) ? { label: text(item.label) } : {}) }] : [];
    })
    : [];
  return { mode, disabledKeys, overrides, breakpoints };
}

function policyFromRecordedInputs(events, replayPlan = normalizeReplayPlan()) {
  const rules = new Map();
  const overrides = new Map(replayPlan.overrides.map((override) => [override.key, override]));
  const disabled = new Set(replayPlan.disabledKeys);
  for (const event of events) {
    const payload = event?.payload ?? {};
    if (payload.journeyStage !== "response" || typeof payload.url !== "string" || typeof payload.responseBody !== "string") continue;
    if (payload.bodyCaptureState !== "captured" || payload.bodyTruncated === true) continue;
    const method = typeof payload.method === "string" ? payload.method : "GET";
    const key = `${method}\n${payload.url}`;
    if (disabled.has(key)) continue;
    const status = typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : 200;
    const override = overrides.get(key);
    rules.set(key, {
      method,
      url: payload.url,
      status: override?.status ?? status,
      headers: override?.headers ?? headersFromTelemetry(payload.responseHeaders),
      body: override?.body ?? payload.responseBody,
    });
  }
  const breakpoints = replayPlan.breakpoints.flatMap((breakpoint) => {
    const separator = breakpoint.key.indexOf("\n");
    if (separator <= 0) return [];
    const method = breakpoint.key.slice(0, separator);
    const url = breakpoint.key.slice(separator + 1);
    if (!url || !rules.has(breakpoint.key)) return [];
    return [{ method, url, ...(breakpoint.label ? { label: breakpoint.label } : {}) }];
  });
  return { mode: replayPlan.mode, rules: [...rules.values()], breakpoints };
}

function headersFromTelemetry(raw) {
  if (typeof raw !== "string") return [];
  // Older Core builds emitted the two characters `\\n`. Accept both forms
  // so an existing recording can still produce a valid replay policy.
  return raw.replaceAll("\\n", "\n").split(/\r?\n/).flatMap((line) => {
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
      executionStatus: state === "completed" ? "completed" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : "recording",
      errorCode,
      errorMessage: message,
      runOptions: activeInspection.options ? {
        waitUntil: activeInspection.options.waitUntil,
        waitMs: activeInspection.options.waitMs,
        observeMs: activeInspection.options.observeMs,
        terminateMs: activeInspection.options.terminateMs,
        expandLazy: activeInspection.options.expandLazy === true,
        maxScrolls: activeInspection.options.maxScrolls,
        scrollSettleMs: activeInspection.options.scrollSettleMs,
        waitSelectorConfigured: Boolean(activeInspection.options.waitSelector),
        waitScriptConfigured: Boolean(activeInspection.options.waitScript),
        userAgentConfigured: Boolean(activeInspection.options.userAgent),
        fixedHeadersConfigured: Boolean(activeInspection.options.extraHeaders),
        cookiesConfigured: Boolean(activeInspection.options.cookieJson || activeInspection.options.cookiePath),
        includeFrames: activeInspection.options.includeFrames === true,
      } : undefined,
      replayPlan: activeInspection.replayPlan ? {
        mode: activeInspection.replayPlan.mode,
        disabledCount: activeInspection.replayPlan.disabledKeys.length,
        overrideCount: activeInspection.replayPlan.overrides.length,
        breakpointCount: activeInspection.replayPlan.breakpoints.length,
      } : undefined,
      source: "koko-sdk",
    },
  });
}

async function drain() {
  if (reading) return;
  const source = telemetrySource;
  if (!source.path) return;
  reading = true;
  try {
    const info = await stat(source.path);
    if (info.size < source.offset) {
      source.offset = 0;
      source.pending = "";
    }
    if (info.size === source.offset) return;
    const file = await open(source.path, "r");
    try {
      const size = info.size - source.offset;
      const buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, source.offset);
      source.offset = info.size;
      const lines = (source.pending + buffer.toString("utf8")).split("\n");
      source.pending = lines.pop() ?? "";
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
console.log(`Execution telemetry root: ${executionRoot}`);
