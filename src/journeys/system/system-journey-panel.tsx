"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, Cpu, Database, Files, Gauge, MemoryStick, Monitor, Network, Route, Server, Waypoints } from "lucide-react";
import type { TelemetryEvent } from "@/src/core/types";
import { useTelemetryStore } from "@/src/stores";

type StageKey = "browser-processes" | "thread-scheduler" | "cpu" | "memory" | "file-system" | "socket-layer" | "ipc" | "graphics-pipeline" | "gpu" | "display";
type Explorer = "processes" | "threads" | "memory" | "io" | "graphics" | "signals";

const stages: Array<{ key: StageKey; name: string; description: string; owner: string; Icon: typeof Server; fields: string[]; missing: string[] }> = [
  { key: "browser-processes", name: "Browser processes", description: "Browser work crosses from a renderer-owned stage into operating-system process and thread ownership.", owner: "Browser runtime / OS process", Icon: Server, fields: ["processId", "processName"], missing: ["process role", "parent PID", "process start/exit", "open handles"] },
  { key: "thread-scheduler", name: "Thread scheduler", description: "JavaScript, DOM and event-loop work is executed by a named thread while the kernel schedules that thread.", owner: "Renderer main thread / kernel scheduler", Icon: Waypoints, fields: ["threadId", "threadName", "contextSwitches", "cpuPercent"], missing: ["running/waiting state", "CPU affinity", "thread migration", "wait reason"] },
  { key: "cpu", name: "CPU", description: "Process CPU usage and logical CPU topology sampled at browser execution boundaries.", owner: "OS process sampler", Icon: Cpu, fields: ["cpuPercent", "logicalCpuCount", "contextSwitches"], missing: ["per-core utilization", "frequency", "hardware counters"] },
  { key: "memory", name: "Memory", description: "Resident process memory and host physical-memory capacity captured by the core sampler.", owner: "OS virtual-memory subsystem", Icon: MemoryStick, fields: ["residentMemoryBytes", "physicalMemoryBytes", "jsHeapBytes"], missing: ["private/shared split", "allocation map", "page faults", "heap snapshot"] },
  { key: "file-system", name: "File system", description: "Cumulative process block I/O counters expose file-system activity without attributing it to invented files.", owner: "Kernel file-system boundary", Icon: Files, fields: ["diskReadBytes", "diskWriteBytes"], missing: ["file path", "operation latency", "cache hit", "descriptor"] },
  { key: "socket-layer", name: "Socket layer", description: "Network request telemetry identifies connections, remote addresses and transferred bytes at the socket boundary.", owner: "Network stack", Icon: Network, fields: ["connectionId", "primaryIp", "requestBytes", "responseBodyBytes", "httpVersion"], missing: ["packet counters", "retransmissions", "NIC queue", "socket state"] },
  { key: "ipc", name: "IPC", description: "Messages between browser, renderer, network and GPU processes should be represented here when core emits IPC spans.", owner: "Browser IPC transport", Icon: Route, fields: ["ipcMessageId", "ipcChannel", "ipcBytes"], missing: ["message ID", "channel", "sender/receiver", "queue latency"] },
  { key: "graphics-pipeline", name: "Graphics pipeline", description: "Style, layout and paint boundaries feed display-list and graphics-driver work.", owner: "Renderer / compositor", Icon: Gauge, fields: ["displayListBytes", "paintCommands", "layerCount"], missing: ["paint command count", "layer tree", "driver submission", "swap chain"] },
  { key: "gpu", name: "GPU", description: "Raster and composite boundaries indicate GPU-owned work; utilization requires driver telemetry.", owner: "GPU process / graphics driver", Icon: Database, fields: ["gpuPercent", "gpuMemoryBytes", "gpuDurationMs"], missing: ["queue utilization", "VRAM", "command-buffer duration", "device identity"] },
  { key: "display", name: "Display", description: "Frame and present boundaries mark the final hand-off toward scan-out and the monitor.", owner: "Compositor / display server", Icon: Monitor, fields: ["refreshRateHz", "presentedFrameId", "vsyncTimestamp"], missing: ["VSync timestamp", "present result", "display latency", "monitor identity"] },
];

const explorerTabs: Array<[Explorer, string]> = [["processes", "Processes"], ["threads", "Threads"], ["memory", "Memory"], ["io", "I/O & network"], ["graphics", "Graphics"], ["signals", "Signal coverage"]];

export function SystemJourneyPanel() {
  const events = useTelemetryStore((state) => state.events);
  const status = useTelemetryStore((state) => state.status);
  const [explorer, setExplorer] = useState<Explorer>("processes");
  const model = useMemo(() => buildSystemModel(events), [events]);

  return <main className="system-journey">
    <header className="system-hero">
      <div><span>Stage 03 · Browser → operating system → hardware</span><h1>System Journey</h1><p>Trace the real ownership boundary from browser work to OS process counters, hardware execution and frame presentation. Measured counters, boundary observations and missing instrumentation are shown separately.</p></div>
      <div className="system-status"><i className={`system-status__dot system-status__dot--${status}`} /><span>{status}</span><strong>{model.systemEvents.length} system signals · {model.observedStages}/10 stages observed</strong></div>
    </header>

    <nav className="journey-chain" aria-label="Journey modules"><Link href="/internet-journey">Internet Journey</Link><b>→</b><Link href="/browser-journey">Browser Journey</Link><b>→</b><strong>System Journey</strong></nav>

    <section className="system-scope" aria-label="Observation scope">
      <div><Activity size={15}/><span><strong>Current telemetry buffer</strong><small>{model.sessionCount} session{model.sessionCount === 1 ? "" : "s"} · sequences {model.firstSequence ?? "—"}–{model.lastSequence ?? "—"}</small></span></div>
      <StatusLegend tone="measured" label="Measured" value={model.measuredCount} />
      <StatusLegend tone="boundary" label="Boundary only" value={model.boundaryCount} />
      <StatusLegend tone="missing" label="Not instrumented" value={10 - model.observedStages} />
      <StatusLegend tone="error" label="Errors" value={model.errorCount} />
    </section>

    <section className="system-metrics" aria-label="Live system metrics">
      <SystemMetric label="Processes" value={model.processes.length ? String(model.processes.length) : "Unavailable"} detail="Unique observed process identities" />
      <SystemMetric label="Threads" value={model.threads.length ? String(model.threads.length) : "Unavailable"} detail="Unique observed execution threads" />
      <SystemMetric label="CPU" value={numberValue(model.latest.cpuPercent, "%")} detail={model.latest.logicalCpuCount == null ? "Logical CPU topology unavailable" : `${model.latest.logicalCpuCount} logical CPUs · cumulative ${integerValue(model.latest.contextSwitches)} switches`} />
      <SystemMetric label="Resident RAM" value={formatBytes(model.latest.residentMemoryBytes)} detail={model.latest.physicalMemoryBytes == null ? "Host capacity unavailable" : `${formatBytes(model.latest.physicalMemoryBytes)} host physical memory`} />
      <SystemMetric label="Disk I/O" value={formatBytes((model.latest.diskReadBytes ?? 0) + (model.latest.diskWriteBytes ?? 0), model.hasDisk)} detail={`${formatBytes(model.latest.diskReadBytes)} read · ${formatBytes(model.latest.diskWriteBytes)} write`} />
      <SystemMetric label="Presented frames" value={model.frames.length ? String(model.frames.length) : "Unavailable"} detail={model.frames.length ? `Latest boundary ${formatDuration(model.frames.at(-1)?.duration)}` : "No frame/present boundary emitted"} />
    </section>

    <div className="system-layout">
      <section className="system-card system-card--journey">
        <header><div><span>OBSERVED EXECUTION PATH</span><h2>From browser process to monitor</h2></div><small>Expand a subsystem to inspect evidence and gaps</small></header>
        <div className="system-stage-list">{model.stageModels.map((stage, index) => <details className={`system-stage system-stage--${stage.state}`} key={stage.key} open={stage.state === "error"}>
          <summary><span className="system-stage__index">{String(index + 1).padStart(2, "0")}</span><stage.Icon size={17}/><span><strong>{stage.name}</strong><small>{stage.description}</small></span><span className={`system-stage__state system-stage__state--${stage.state}`}>{stage.label}</span><span className="system-stage__measure">{stage.measure}</span><b>＋</b></summary>
          <div className="system-stage__details">
            <p><strong>Ownership.</strong> {stage.owner}</p>
            <div className="system-stage__facts"><Fact label="Events" value={String(stage.events.length)} /><Fact label="Accumulated duration" value={stage.events.length ? formatDuration(stage.duration) : "Unavailable"} /><Fact label="Latest process" value={payloadText(stage.latest, "processName", "processId")} /><Fact label="Latest thread" value={payloadText(stage.latest, "threadName", "threadId")} /><Fact label="Measurement" value={stage.measurement} /><Fact label="Last observed" value={stage.latest ? formatClock(stage.latest.timestamp) : "Unavailable"} /></div>
            <div className="system-stage__evidence"><div><strong>Observed typed signals</strong>{stage.evidence.length ? <ul>{stage.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No typed signal has reached this subsystem.</p>}</div><div><strong>Core telemetry still needed</strong><ul>{stage.missing.map((item) => <li key={item}>{item}</li>)}</ul></div></div>
            {stage.events.length > 0 && <div className="system-stage__event-list">{stage.events.slice(-4).reverse().map((event) => <div key={event.id}><code>#{event.sequence}</code><span>{event.name}</span><small>{formatDuration(event.duration)} · {event.status} · {formatClock(event.timestamp)}</small></div>)}</div>}
          </div>
        </details>)}</div>
      </section>

      <aside className="system-side">
        <section className="system-card"><header><div><span>HARDWARE TOPOLOGY</span><h2>Observed execution hardware</h2></div></header><div className="hardware-path">{model.hardware.map((item, index) => <div key={item.name}><i>{index + 1}</i><span><strong>{item.name}</strong><small className={item.available ? "" : "unavailable-text"}>{item.value}</small></span>{index < model.hardware.length - 1 && <b>↓</b>}</div>)}</div></section>
        <section className="system-card"><header><div><span>RESOURCE COUNTERS</span><h2>Latest process sample</h2></div><small>Cumulative unless noted</small></header><div className="resource-summary"><SystemRow label="Resident memory" value={formatBytes(model.latest.residentMemoryBytes)} /><SystemRow label="CPU utilization" value={numberValue(model.latest.cpuPercent, "%")} /><SystemRow label="Context switches" value={integerValue(model.latest.contextSwitches)} /><SystemRow label="Disk read" value={formatBytes(model.latest.diskReadBytes)} /><SystemRow label="Disk write" value={formatBytes(model.latest.diskWriteBytes)} /><SystemRow label="Network received" value={model.networkReceived ? formatBytes(model.networkReceived) : "Unavailable"} /><SystemRow label="Connections" value={model.connections.size ? String(model.connections.size) : "Unavailable"} /></div></section>
      </aside>
    </div>

    <section className="system-card system-explorer">
      <header><div><span>DETAILED DIAGNOSTICS</span><h2>System explorers</h2></div><small>Evidence from the current telemetry buffer</small></header>
      <div className="system-explorer__tabs" role="tablist">{explorerTabs.map(([key, label]) => <button key={key} className={explorer === key ? "active" : ""} onClick={() => setExplorer(key)} role="tab" aria-selected={explorer === key}>{label}</button>)}</div>
      <div className="system-explorer__body">{explorer === "processes" && <EntityTable kind="process" rows={model.processes} />}{explorer === "threads" && <EntityTable kind="thread" rows={model.threads} />}{explorer === "memory" && <MemoryExplorer model={model} />}{explorer === "io" && <IoExplorer model={model} />}{explorer === "graphics" && <GraphicsExplorer model={model} />}{explorer === "signals" && <SignalCoverage models={model.stageModels} />}</div>
    </section>
  </main>;
}

function buildSystemModel(events: TelemetryEvent[]) {
  const systemEvents = events.filter((event) => typeof event.payload.systemStage === "string" || hasAny(event, ["processId", "threadId", "residentMemoryBytes", "cpuPercent", "contextSwitches", "diskReadBytes", "diskWriteBytes"]));
  const latest = latestNumbers(systemEvents, ["cpuPercent", "logicalCpuCount", "contextSwitches", "residentMemoryBytes", "physicalMemoryBytes", "diskReadBytes", "diskWriteBytes", "gpuPercent", "gpuMemoryBytes", "refreshRateHz"]);
  const stageModels = stages.map((stage) => observeStage(stage, events, systemEvents));
  const frames = events.filter((event) => ["frame", "present"].includes(String(event.payload.browserStage ?? event.name)) || event.payload.presentedFrameId != null);
  const connections = uniqueValues(events, ["connectionId", "primaryIp"]);
  return {
    systemEvents, latest, stageModels, frames, connections,
    hardware: [
      { name: "CPU", value: latest.logicalCpuCount == null ? "Topology unavailable" : `${latest.logicalCpuCount} logical CPUs`, available: latest.logicalCpuCount != null },
      { name: "Memory", value: formatBytes(latest.physicalMemoryBytes), available: latest.physicalMemoryBytes != null },
      { name: "Storage", value: latest.diskReadBytes == null && latest.diskWriteBytes == null ? "Device topology unavailable" : "Process block I/O observed", available: latest.diskReadBytes != null || latest.diskWriteBytes != null },
      { name: "Network adapter", value: connections.size ? `${connections.size} connection identities` : "NIC telemetry unavailable", available: connections.size > 0 },
      { name: "GPU", value: latest.gpuPercent == null ? "Driver telemetry unavailable" : `${latest.gpuPercent.toFixed(1)}% utilization`, available: latest.gpuPercent != null },
      { name: "Display controller", value: "Controller telemetry unavailable", available: false },
      { name: "Monitor", value: latest.refreshRateHz == null ? "Refresh rate unavailable" : `${latest.refreshRateHz} Hz`, available: latest.refreshRateHz != null },
    ],
    processes: aggregateEntities(systemEvents, "process"), threads: aggregateEntities(systemEvents, "thread"),
    observedStages: stageModels.filter((stage) => stage.state !== "missing").length,
    measuredCount: stageModels.filter((stage) => stage.state === "measured").length,
    boundaryCount: stageModels.filter((stage) => stage.state === "boundary").length,
    errorCount: systemEvents.filter((event) => event.status === "error").length,
    sessionCount: new Set(events.map((event) => event.sessionId)).size,
    firstSequence: events.at(0)?.sequence, lastSequence: events.at(-1)?.sequence,
    networkReceived: sumAliases(events, ["receivedBytes", "responseBodyBytes"]),
    networkSent: sumAliases(events, ["sentBytes", "requestBytes"]),
    hasDisk: latest.diskReadBytes != null || latest.diskWriteBytes != null,
    memorySamples: systemEvents.filter((event) => typeof event.payload.residentMemoryBytes === "number"),
  };
}

type SystemModel = ReturnType<typeof buildSystemModel>;
type StageModel = ReturnType<typeof observeStage>;

function observeStage(stage: (typeof stages)[number], events: TelemetryEvent[], systemEvents: TelemetryEvent[]) {
  const direct = systemEvents.filter((event) => event.payload.systemStage === stage.key);
  const evidenceEvents = events.filter((event) => stage.fields.some((field) => event.payload[field] != null));
  const stageEvents = direct.length ? direct : evidenceEvents;
  const evidence = stage.fields.flatMap((field) => {
    const event = [...stageEvents].reverse().find((candidate) => candidate.payload[field] != null);
    return event ? [`${field}: ${formatPayloadValue(event.payload[field])}`] : [];
  });
  const hasMeasuredField = evidenceEvents.length > 0;
  const latest = stageEvents.at(-1);
  const state = stageEvents.some((event) => event.status === "error") ? "error" : hasMeasuredField ? "measured" : direct.length ? "boundary" : "missing";
  const duration = direct.reduce((sum, event) => sum + event.duration, 0);
  return { ...stage, events: stageEvents, latest, evidence, state, duration, label: state === "measured" ? "MEASURED" : state === "boundary" ? "BOUNDARY" : state === "error" ? "ERROR" : "NOT INSTRUMENTED", measure: direct.length ? formatDuration(duration) : evidence.length ? `${evidence.length} counter${evidence.length === 1 ? "" : "s"}` : "Unavailable", measurement: latest ? String(latest.payload.measurementState ?? (hasMeasuredField ? "sampled" : "boundary")) : "Unavailable" };
}

function aggregateEntities(events: TelemetryEvent[], kind: "process" | "thread") {
  const rows = new Map<string, { id: string; name: string; events: number; first: number; last: number; duration: number; statuses: Set<string> }>();
  for (const event of events) {
    const id = event.payload[`${kind}Id`];
    const name = event.payload[`${kind}Name`] ?? event.payload[kind];
    if (id == null && name == null) continue;
    const key = String(id ?? name);
    const row = rows.get(key) ?? { id: key, name: String(name ?? "Unnamed"), events: 0, first: event.timestamp, last: event.timestamp, duration: 0, statuses: new Set<string>() };
    row.events += 1; row.last = event.timestamp; row.duration += event.duration; row.statuses.add(event.status); rows.set(key, row);
  }
  return [...rows.values()];
}

function EntityTable({ kind, rows }: { kind: "process" | "thread"; rows: SystemModel["processes"] }) {
  if (!rows.length) return <Empty title={`No ${kind} identity observed`} detail={`Core must emit ${kind}Id and ${kind}Name to populate this explorer.`} />;
  return <div className="system-table-wrap"><table className="system-table"><thead><tr><th>{kind === "process" ? "PID" : "TID"}</th><th>Name</th><th>Events</th><th>Observed duration</th><th>First seen</th><th>Last seen</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><code>{row.id}</code></td><td>{row.name}</td><td>{row.events}</td><td>{formatDuration(row.duration)}</td><td>{formatClock(row.first)}</td><td>{formatClock(row.last)}</td><td>{[...row.statuses].join(", ")}</td></tr>)}</tbody></table></div>;
}

function MemoryExplorer({ model }: { model: SystemModel }) {
  const samples = model.memorySamples.slice(-12);
  if (!samples.length) return <Empty title="No process memory sample" detail="Resident memory is intentionally not estimated from response-body bytes. Run a fresh inspection with the instrumented core to collect RSS." />;
  const max = Math.max(...samples.map((event) => Number(event.payload.residentMemoryBytes)), 1);
  return <div className="system-samples"><div className="system-samples__summary"><Fact label="Latest RSS" value={formatBytes(model.latest.residentMemoryBytes)} /><Fact label="Host physical" value={formatBytes(model.latest.physicalMemoryBytes)} /><Fact label="Samples shown" value={String(samples.length)} /></div><div className="system-sparkbars" aria-label="Recent resident memory samples">{samples.map((event) => <div key={event.id} style={{ height: `${Math.max(5, Number(event.payload.residentMemoryBytes) / max * 100)}%` }} title={`${formatClock(event.timestamp)} · ${formatBytes(Number(event.payload.residentMemoryBytes))}`} />)}</div><p>RSS is a process high-water/current value supplied by the platform sampler; it is not the JavaScript heap and it is not attributed to individual resources.</p></div>;
}

function IoExplorer({ model }: { model: SystemModel }) { return <div className="system-diagnostic-grid"><Fact label="Cumulative disk read" value={formatBytes(model.latest.diskReadBytes)} /><Fact label="Cumulative disk write" value={formatBytes(model.latest.diskWriteBytes)} /><Fact label="Response bytes observed" value={model.networkReceived ? formatBytes(model.networkReceived) : "Unavailable"} /><Fact label="Request bytes observed" value={model.networkSent ? formatBytes(model.networkSent) : "Unavailable"} /><Fact label="Connection identities" value={model.connections.size ? [...model.connections].slice(0, 5).join(", ") : "Unavailable"} /><Fact label="Missing for device view" value="Packets, retransmits, NIC, per-operation file data" /></div>; }
function GraphicsExplorer({ model }: { model: SystemModel }) { const graphics = model.stageModels.filter((stage) => ["graphics-pipeline", "gpu", "display"].includes(stage.key)); return <div className="system-graphics">{graphics.map((stage) => <article key={stage.key}><span className={`system-stage__state system-stage__state--${stage.state}`}>{stage.label}</span><strong>{stage.name}</strong><small>{stage.events.length} events · {stage.events.length ? formatDuration(stage.duration) : "no timing"}</small><p>{stage.evidence.join(" · ") || `Core still needs ${stage.missing.join(", ")}.`}</p></article>)}</div>; }
function SignalCoverage({ models }: { models: StageModel[] }) { return <div className="system-table-wrap"><table className="system-table"><thead><tr><th>Subsystem</th><th>Coverage</th><th>Available evidence</th><th>Required next signals</th></tr></thead><tbody>{models.map((stage) => <tr key={stage.key}><td>{stage.name}</td><td><span className={`system-stage__state system-stage__state--${stage.state}`}>{stage.label}</span></td><td>{stage.evidence.join(" · ") || "Boundary only / none"}</td><td>{stage.missing.join(", ")}</td></tr>)}</tbody></table></div>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="system-empty"><Activity size={20}/><strong>{title}</strong><span>{detail}</span></div>; }
function StatusLegend({ tone, label, value }: { tone: string; label: string; value: number }) { return <div className={`system-legend system-legend--${tone}`}><i/><span><strong>{value}</strong><small>{label}</small></span></div>; }
function SystemMetric({ label, value, detail }: { label: string; value: string; detail: string }) { return <article><span>{label}</span><strong className={value === "Unavailable" ? "unavailable" : ""}>{value}</strong><small>{detail}</small></article>; }
function SystemRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong className={value === "Unavailable" ? "unavailable" : ""}>{value}</strong></div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div className="system-fact"><small>{label}</small><strong>{value}</strong></div>; }

function latestNumbers(events: TelemetryEvent[], keys: string[]) { const result: Record<string, number | undefined> = {}; for (const key of keys) { for (let index = events.length - 1; index >= 0; index--) { const value = events[index].payload[key]; if (typeof value === "number" && Number.isFinite(value)) { result[key] = value; break; } } } return result; }
function hasAny(event: TelemetryEvent, keys: string[]) { return keys.some((key) => event.payload[key] != null); }
function uniqueValues(events: TelemetryEvent[], keys: string[]) { const values = new Set<string>(); for (const event of events) for (const key of keys) { const value = event.payload[key]; if (value != null && value !== "") values.add(String(value)); } return values; }
function sumAliases(events: TelemetryEvent[], keys: string[]) { return events.reduce((sum, event) => { for (const key of keys) { const value = event.payload[key]; if (typeof value === "number") return sum + value; } return sum; }, 0); }
function payloadText(event: TelemetryEvent | undefined, primary: string, fallback: string) { const value = event?.payload[primary] ?? event?.payload[fallback]; return value == null ? "Unavailable" : String(value); }
function formatBytes(value?: number, available = value != null) { if (!available || value == null) return "Unavailable"; if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`; if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`; if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`; return `${value.toFixed(0)} B`; }
function formatDuration(value?: number) { return value == null ? "Unavailable" : value < 1 ? `${value.toFixed(3)} ms` : `${value.toFixed(2)} ms`; }
function formatClock(value: number) { return new Date(value).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }); }
function integerValue(value?: number) { return value == null ? "Unavailable" : value.toLocaleString(); }
function numberValue(value?: number, suffix = "") { return value == null ? "Unavailable" : `${value.toFixed(1)}${suffix}`; }
function formatPayloadValue(value: unknown) { if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3); return String(value); }
