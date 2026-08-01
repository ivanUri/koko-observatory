"use client";

import Link from "next/link";
import { Cpu, Database, Files, Gauge, MemoryStick, Monitor, Network, Route, Server, Waypoints } from "lucide-react";
import { useTelemetryStore } from "@/src/stores";

const stages = [
  ["Browser processes", "Browser, Renderer, GPU, Network and utility process lifetime", Server],
  ["Thread scheduler", "Running, waiting, blocked and sleeping browser threads", Waypoints],
  ["CPU", "Core topology, utilization, context switches and thread migration", Cpu],
  ["Memory", "Virtual, physical, JS, native, shared and GPU memory", MemoryStick],
  ["File system", "Executables, fonts, cache, certificates and browser storage", Files],
  ["Socket layer", "DNS, TCP, TLS, HTTP streams, WebSocket and connection pools", Network],
  ["IPC", "Messages and queues between Browser, Renderer, GPU and utilities", Route],
  ["Graphics pipeline", "Paint commands through driver, command buffer and swap", Gauge],
  ["GPU", "Graphics queues, VRAM, render targets and execution time", Database],
  ["Display", "VSync, frame queue, presentation and monitor latency", Monitor],
] as const;

export function SystemJourneyPanel() {
  const events = useTelemetryStore((state) => state.events);
  const status = useTelemetryStore((state) => state.status);
  const latest = (key: string) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const value = events[index].payload[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const metric = (key: string, suffix = "") => {
    const value = latest(key);
    return value == null ? "Unavailable" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
  };
  const systemEvents = events.filter((event) => typeof event.payload.systemStage === "string" || ["memory", "scheduler", "render"].includes(event.kind));
  const processCount = uniquePayloadValues(systemEvents, "processId", "processName");
  const threadCount = uniquePayloadValues(systemEvents, "threadId", "threadName");
  const renderEvents = events.filter((event) => event.kind === "render");
  const frameEvents = renderEvents.filter((event) => ["frame", "present", "composite"].includes(String(event.payload.browserStage ?? event.name)));
  const networkBytes = sumPayload(events, "responseBodyBytes");
  const socketCount = uniquePayloadValues(events.filter((event) => event.kind === "network"), "connectionId", "primaryIp");
  const observedMemory = latest("residentMemoryBytes") ?? latest("jsHeapBytes") ?? latest("responseMemoryBytes") ?? latest("responseBodyBytes");
  const observedFrameTime = renderEvents.at(-1)?.duration;
  const diskRead = latest("diskReadBytes");
  const diskWrite = latest("diskWriteBytes");
  const contextSwitches = latest("contextSwitches");
  const cpuPercent = latest("cpuPercent");
  const physicalMemory = latest("physicalMemoryBytes");

  return <main className="system-journey">
    <header className="system-hero">
      <div><span>Stage 03 · Browser → operating system → hardware</span><h1>System Journey</h1><p>See how browser work becomes operating-system operations, hardware execution, and finally a frame on the monitor.</p></div>
      <div className="system-status"><i className={`system-status__dot system-status__dot--${status}`} /><span>{status}</span><strong>{systemEvents.length} system signals</strong></div>
    </header>

    <nav className="journey-chain" aria-label="Journey modules"><Link href="/internet-journey">Internet Journey</Link><b>→</b><Link href="/browser-journey">Browser Journey</Link><b>→</b><strong>System Journey</strong></nav>

    <section className="system-metrics" aria-label="Live system metrics">
      <SystemMetric label="Processes" value={processCount ? String(processCount) : "Unavailable"} detail="Observed process owners" />
      <SystemMetric label="Threads" value={threadCount ? String(threadCount) : "Unavailable"} detail="Observed execution threads" />
      <SystemMetric label="CPU" value={cpuPercent == null ? "Unavailable" : `${cpuPercent.toFixed(1)}%`} detail={contextSwitches == null ? "Context switches unavailable" : `${contextSwitches.toLocaleString()} context switches`} />
      <SystemMetric label="RAM" value={formatBytes(observedMemory)} detail={physicalMemory == null ? `Observed payload memory ${formatBytes(latest("responseMemoryBytes") ?? latest("responseBodyBytes"))}` : `Host memory ${formatBytes(physicalMemory)}`} />
      <SystemMetric label="GPU" value={metric("gpuPercent", "%")} detail={`VRAM ${formatBytes(latest("gpuMemoryBytes"))}`} />
      <SystemMetric label="Presented frames" value={frameEvents.length ? String(frameEvents.length) : "Unavailable"} detail="Frame/present events observed" />
    </section>

    <div className="system-layout">
      <section className="system-card system-card--journey">
        <header><div><span>MAIN EXECUTION PATH</span><h2>From browser process to monitor</h2></div><small>Expand any subsystem for diagnostics</small></header>
        <div className="system-stage-list">{stages.map(([name, description, Icon], index) => {
          const stage = stageObservation(name, events, systemEvents);
          return <details className="system-stage" key={name}>
            <summary><span className="system-stage__index">{String(index + 1).padStart(2, "0")}</span><Icon size={17}/><span><strong>{name}</strong><small>{description}</small></span><span className="system-stage__measure">{stage.measure}</span><b>＋</b></summary>
            <div className="system-stage__details"><p><strong>What is this?</strong> {description}. This stage is shown only from typed Velora Core telemetry; missing operating-system signals are never synthesized.</p><dl><div><dt>Events</dt><dd>{stage.events}</dd></div><div><dt>Signal</dt><dd>{stage.detail}</dd></div><div><dt>Process</dt><dd>{String(stage.latest?.payload.processName ?? "Unavailable")}</dd></div><div><dt>Thread</dt><dd>{String(stage.latest?.payload.threadName ?? "Unavailable")}</dd></div></dl></div>
          </details>;
        })}</div>
      </section>

      <aside className="system-side">
        <section className="system-card"><header><div><span>HARDWARE TOPOLOGY</span><h2>Execution hardware</h2></div></header><div className="hardware-path">{["CPU", "Memory", "PCIe", "GPU", "Display controller", "Monitor"].map((item, index) => <div key={item}><i>{index + 1}</i><span><strong>{item}</strong><small>{hardwareValue(item, latest)}</small></span>{index < 5 && <b>↓</b>}</div>)}</div></section>
        <section className="system-card"><header><div><span>RESOURCE ACTIVITY</span><h2>Kernel boundaries</h2></div></header><div className="resource-summary"><SystemRow label="Disk read" value={formatBytes(diskRead)} /><SystemRow label="Disk write" value={formatBytes(diskWrite)} /><SystemRow label="Network I/O" value={networkBytes ? formatBytes(networkBytes) : "Unavailable"} /><SystemRow label="Sockets" value={socketCount ? String(socketCount) : "Unavailable"} /><SystemRow label="Context switches" value={contextSwitches == null ? "Unavailable" : contextSwitches.toLocaleString()} /><SystemRow label="Frame time" value={observedFrameTime == null ? "Unavailable" : `${observedFrameTime.toFixed(2)} ms`} /></div></section>
      </aside>
    </div>

    <section className="system-card system-explorers"><header><div><span>DEBUG & EDUCATION</span><h2>System explorers</h2></div><small>Every view links execution back to Browser Journey</small></header><div>{["Process Explorer", "Thread Explorer", "Memory Explorer", "GPU Explorer", "File Explorer", "Network Device"].map((name) => <article key={name}><strong>{name}</strong><span>{explorerDescription(name)}</span><small>{explorerStatus(name, { events, processCount, threadCount, observedMemory, socketCount })}</small></article>)}</div></section>
  </main>;
}

function SystemMetric({ label, value, detail }: { label: string; value: string; detail: string }) { return <article><span>{label}</span><strong className={value === "Unavailable" ? "unavailable" : ""}>{value}</strong><small>{detail}</small></article>; }
function SystemRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong className={value === "Unavailable" ? "unavailable" : ""}>{value}</strong></div>; }
function formatBytes(value?: number) { if (value == null) return "Unavailable"; if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`; if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`; if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`; return `${value.toFixed(0)} B`; }
function hardwareValue(item: string, latest: (key: string) => number | undefined) { const keys: Record<string, string> = { CPU: "logicalCpuCount", Memory: "physicalMemoryBytes", GPU: "gpuPercent", Monitor: "refreshRateHz" }; const value = keys[item] ? latest(keys[item]) : undefined; if (value == null) return item === "PCIe" || item === "Display controller" ? "Path inferred from graphics pipeline" : "Topology unavailable"; if (item === "CPU") return `${value.toLocaleString()} logical CPUs`; if (item === "Memory") return formatBytes(value); return `${value.toLocaleString()}${item === "GPU" ? "% utilization" : item === "Monitor" ? " Hz" : ""}`; }
function explorerDescription(name: string) { const values: Record<string, string> = { "Process Explorer": "PID, CPU, memory, children, handles and sockets", "Thread Explorer": "State, affinity, synchronization and migration", "Memory Explorer": "Maps, allocations, fragmentation and snapshots", "GPU Explorer": "Graphics, compute and transfer command queues", "File Explorer": "Fonts, cache, certificates, storage and files", "Network Device": "Kernel, NIC, packets, errors and retransmissions" }; return values[name]; }
function uniquePayloadValues(events: ReturnType<typeof useTelemetryStore.getState>["events"], primary: string, fallback: string) { const values = new Set<string>(); for (const event of events) { const value = event.payload[primary] ?? event.payload[fallback]; if (typeof value === "string" || typeof value === "number") values.add(String(value)); } return values.size; }
function sumPayload(events: ReturnType<typeof useTelemetryStore.getState>["events"], key: string) { return events.reduce((sum, event) => sum + (typeof event.payload[key] === "number" && Number.isFinite(event.payload[key]) ? event.payload[key] as number : 0), 0); }
function explorerStatus(name: string, data: { events: ReturnType<typeof useTelemetryStore.getState>["events"]; processCount: number; threadCount: number; observedMemory?: number; socketCount: number }) { if (name === "Process Explorer") return data.processCount ? `${data.processCount} process owner observed` : "Core process lifecycle unavailable"; if (name === "Thread Explorer") return data.threadCount ? `${data.threadCount} thread owner observed` : "Core thread lifecycle unavailable"; if (name === "Memory Explorer") return data.observedMemory != null ? "Resident/process memory observed" : "Core memory sampler unavailable"; if (name === "File Explorer") return data.events.some((event) => typeof event.payload.diskReadBytes === "number" || typeof event.payload.diskWriteBytes === "number") ? "Process disk I/O observed" : "Core disk sampler unavailable"; if (name === "Network Device") return data.socketCount ? `${data.socketCount} socket identity observed` : "Core socket sampler unavailable"; return "GPU/driver telemetry unavailable"; }
function stageObservation(name: string, events: ReturnType<typeof useTelemetryStore.getState>["events"], systemEvents: ReturnType<typeof useTelemetryStore.getState>["events"]) {
  const key = name.split(" ")[0].toLowerCase();
  const byStage = systemEvents.filter((event) => String(event.payload.systemStage ?? "").toLowerCase().includes(key));
  const latest = byStage.at(-1);
  const duration = byStage.reduce((sum, event) => sum + event.duration, 0);
  if (byStage.length) return { events: byStage.length, measure: `${duration.toFixed(2)} ms`, detail: `${duration.toFixed(3)} ms observed`, latest };
  if (name === "CPU") return numericStage(events, ["cpuPercent", "contextSwitches"], (event) => typeof event.payload.cpuPercent === "number" ? `${(event.payload.cpuPercent as number).toFixed(1)}% CPU` : `${event.payload.contextSwitches} context switches`);
  if (name === "Memory") return numericStage(events, ["residentMemoryBytes", "physicalMemoryBytes"], (event) => formatBytes((event.payload.residentMemoryBytes ?? event.payload.physicalMemoryBytes) as number));
  if (name === "File system") return numericStage(events, ["diskReadBytes", "diskWriteBytes"], (event) => `${formatBytes(event.payload.diskReadBytes as number | undefined)} read / ${formatBytes(event.payload.diskWriteBytes as number | undefined)} write`);
  if (name === "Socket layer") return numericStage(events, ["connectionId", "primaryIp", "responseBodyBytes"], (event) => String(event.payload.primaryIp ?? event.payload.connectionId ?? formatBytes(event.payload.responseBodyBytes as number | undefined)));
  return { events: 0, measure: "Unavailable", detail: "Unavailable", latest: undefined };
}
function numericStage(events: ReturnType<typeof useTelemetryStore.getState>["events"], keys: string[], format: (event: ReturnType<typeof useTelemetryStore.getState>["events"][number]) => string) {
  const matching = events.filter((event) => keys.some((key) => typeof event.payload[key] === "number" || typeof event.payload[key] === "string"));
  const latest = matching.at(-1);
  return latest ? { events: matching.length, measure: format(latest), detail: format(latest), latest } : { events: 0, measure: "Unavailable", detail: "Unavailable", latest: undefined };
}
