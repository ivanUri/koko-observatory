"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CircleDot, Clock3, Cpu, Database, Filter, Gauge, GitBranch, Network, Wifi, X } from "lucide-react";
import { RealtimeChart } from "@/src/components/realtime-chart";
import { useGraphStore, useNetworkStore, useReplayStore, useSelectionStore, useTelemetryStore } from "@/src/stores";
import type { ExecutionGraphMode } from "@/src/components/execution-graph";
import type { TelemetryEvent } from "@/src/core/types";

const ExecutionGraph = dynamic(
  () => import("@/src/components/execution-graph").then((module) => module.ExecutionGraph),
  { ssr: false, loading: () => <PanelLoader label="Building execution graph…" /> },
);

export function OverviewPanel() {
  const events = useTelemetryStore((state) => state.events);
  const status = useTelemetryStore((state) => state.status);
  const [range, setRange] = useState("5m");
  const [inspection, setInspection] = useState("latest");
  const inspections = useMemo(() => [...new Map(events.flatMap((event) => {
    const id = stringPayload(event.payload, "inspectionId");
    return id ? [[id, stringPayload(event.payload, "requestedUrl") ?? id] as const] : [];
  })).entries()].reverse(), [events]);
  const latestInspection = inspections[0]?.[0];
  const scoped = useMemo(() => {
    const now = events.at(-1)?.timestamp ?? Date.now();
    const cutoff = range === "all" ? 0 : now - ({ "1m": 60_000, "5m": 300_000, "15m": 900_000 }[range] ?? 300_000);
    const selected = inspection === "latest" ? latestInspection : inspection === "all" ? undefined : inspection;
    return events.filter((event) => event.timestamp >= cutoff && (!selected || event.payload.inspectionId === selected));
  }, [events, inspection, latestInspection, range]);
  const lifecycle = [...scoped].reverse().find((event) => typeof event.payload.inspectionState === "string");
  const measured = scoped.filter(isMeasuredEvent);
  const errors = scoped.filter((event) => event.status === "error").length;
  const warnings = scoped.filter((event) => event.status === "warning").length;
  const cpu = latestNumber(scoped, "cpuPercent");
  const memory = latestNumber(scoped, "residentMemoryBytes", "physicalMemoryBytes");
  const contextSwitches = latestNumber(scoped, "contextSwitches");
  const diskRead = latestNumber(scoped, "diskReadBytes");
  const diskWrite = latestNumber(scoped, "diskWriteBytes");
  const p95 = percentile(measured.map((event) => event.duration), .95);
  const statusTotal = Math.max(scoped.length, 1);
  const healthy = Math.max(0, scoped.length - errors - warnings);
  const hasTelemetry = scoped.length > 0;
  const rate = useMemo(() => eventRate(scoped), [scoped]);
  const stageP95 = (kind: typeof events[number]["kind"]) => formatDuration(percentile(measured.filter((event) => event.kind === kind).map((event) => event.duration), .95));
  const journeySummary = (["internet", "browser", "system"] as const).map((journey) => {
    const source = scoped.filter((event) => classifyJourney(event) === journey);
    return { journey, events: source.length, errors: source.filter((event) => event.status === "error").length, p95: percentile(source.filter(isMeasuredEvent).map((event) => event.duration), .95) };
  });

  return (
    <PanelFrame
      eyebrow="Dashboards / Browser runtime"
      title="Velora runtime monitor"
      description="Live operational view across execution, resources, scheduling, and transport."
    >
      <section className="overview-context">
        <div><LivePill /><strong>{String(lifecycle?.payload.inspectionState ?? (hasTelemetry ? "receiving telemetry" : "waiting for inspection"))}</strong><span>{String(lifecycle?.payload.requestedUrl ?? "Run Inspect URL to start an observed journey")}</span></div>
        <DashboardControls range={range} inspection={inspection} inspections={inspections} onRange={setRange} onInspection={setInspection} />
      </section>
      <div className="metric-grid">
        <Metric label="Inspection" value={lifecycle ? String(lifecycle.payload.inspectionState) : "—"} delta={statusLabel(status)} icon={Activity} />
        <Metric label="Signals" value={hasTelemetry ? formatNumber(scoped.length) : "—"} delta={`${measured.length} timed`} icon={Activity} />
        <Metric label="Error rate" value={hasTelemetry ? `${(errors / statusTotal * 100).toFixed(2)}%` : "—"} delta={`${warnings} warnings`} icon={CircleDot} />
        <Metric label="Measured P95" value={formatDuration(p95)} delta="excludes unavailable boundaries" icon={Clock3} />
        <Metric label="CPU (latest)" value={cpu == null ? "—" : `${cpu.toFixed(1)}%`} delta={cpu == null ? "Signal unavailable" : "core process sample"} icon={Cpu} />
        <Metric label="Resident memory" value={memory == null ? "—" : formatBytes(memory)} delta={memory == null ? "Signal unavailable" : "core process sample"} icon={Database} />
      </div>
      <div className="overview-journeys">
        {journeySummary.map((item) => <Link href={item.journey === "internet" ? "/internet-journey" : item.journey === "browser" ? "/browser-journey" : "/system-journey"} key={item.journey}><span>{item.journey} journey</span><strong>{item.events || "—"} signals</strong><small>{item.events ? `${item.errors} errors · ${formatDuration(item.p95)} P95` : "No observed evidence"}</small></Link>)}
      </div>
      <div className="monitor-grid">
        <section className="panel-card monitor-panel monitor-panel--throughput">
          <CardHeader title="Event throughput" subtitle="Events per second from telemetry timestamps" icon={Gauge} />
          <RealtimeChart data={rate} />
        </section>
        <section className="panel-card monitor-panel monitor-panel--health">
          <CardHeader title="Runtime health" subtitle="Current execution profile" icon={Database} />
          <div className="health-stack">
            <HealthRow label="Measured latency P95" value={formatDuration(p95)} tone="primary" width={barWidth(p95, measured)} />
            <HealthRow label="Context switches" value={contextSwitches == null ? "—" : formatNumber(contextSwitches)} tone="blue" width={contextSwitches == null ? "0%" : "100%"} />
            <HealthRow label="Disk read" value={diskRead == null ? "—" : formatBytes(diskRead)} tone="mint" width={diskRead == null ? "0%" : "100%"} />
            <HealthRow label="Disk write" value={diskWrite == null ? "—" : formatBytes(diskWrite)} tone="amber" width={diskWrite == null ? "0%" : "100%"} />
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Event status" subtitle="Last 10,000 signals" icon={CircleDot} />
          <div className="status-distribution">
            <div className="status-ring"><span><strong>{hasTelemetry ? `${(healthy / statusTotal * 100).toFixed(1)}%` : "—"}</strong><small>healthy</small></span></div>
            <div className="status-legend">
              <span><i className="legend-dot legend-dot--ok" />Normal <strong>{healthy}</strong></span>
              <span><i className="legend-dot legend-dot--warn" />Warning <strong>{warnings}</strong></span>
              <span><i className="legend-dot legend-dot--error" />Error <strong>{errors}</strong></span>
            </div>
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Subsystem latency" subtitle="P95 by pipeline stage" icon={Cpu} />
          <div className="subsystem-bars">
            <SubsystemBar label="Network" value={stageP95("network")} width={barWidthFromValue(stageP95("network"))} />
            <SubsystemBar label="JavaScript" value={stageP95("javascript")} width={barWidthFromValue(stageP95("javascript"))} />
            <SubsystemBar label="Render" value={stageP95("render")} width={barWidthFromValue(stageP95("render"))} />
            <SubsystemBar label="Scheduler" value={stageP95("scheduler")} width={barWidthFromValue(stageP95("scheduler"))} />
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Core process sample" subtitle="Latest system evidence; no assumed capacity" icon={Activity} />
          <div className="gauge-stack">
            <MiniGauge label="CPU" value={cpu == null ? "—" : `${Math.max(0, Math.min(100, cpu)).toFixed(0)}%`} tone={cpu != null && cpu > 80 ? "warn" : "ok"} />
            <MiniGauge label="Resident RAM" value={memory == null ? "—" : formatBytes(memory)} tone="ok" />
            <MiniGauge label="Context switches" value={contextSwitches == null ? "—" : formatNumber(contextSwitches)} tone="ok" />
          </div>
        </section>
      </div>
      <section className="panel-card monitor-panel monitor-panel--events">
        <CardHeader title="Recent signals" subtitle="Normalized events from the telemetry pipeline" icon={Network} />
        <EventTable events={scoped.slice(-9).reverse()} />
      </section>
    </PanelFrame>
  );
}

export function TimelinePanel() {
  const events = useTelemetryStore((state) => state.events);
  const select = useSelectionStore((state) => state.select);
  const selectedId = useSelectionStore((state) => state.eventId);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [journey, setJourney] = useState("all");
  const [session, setSession] = useState("all");
  const sessions = useMemo(() => [...new Set(events.map((event) => event.sessionId))], [events]);
  const filtered = useMemo(() => events.filter((event) => {
    const eventJourney = classifyJourney(event);
    const text = `${event.name} ${event.kind} ${event.sessionId} ${String(event.payload.url ?? "")} ${String(event.payload.browserStage ?? event.payload.systemStage ?? event.payload.journeyStage ?? "")}`.toLowerCase();
    return (kind === "all" || event.kind === kind) && (status === "all" || event.status === status) && (journey === "all" || eventJourney === journey) && (session === "all" || event.sessionId === session) && (!query || text.includes(query.toLowerCase()));
  }), [events, journey, kind, query, session, status]);
  const lanes = useMemo(() => [...new Set(filtered.map((event) => event.kind))], [filtered]);
  const start = Math.min(...filtered.map((event) => event.timestamp), Date.now());
  const end = Math.max(...filtered.map((event) => event.timestamp + event.duration), start + 1);
  const range = Math.max(1, end - start);
  const selected = filtered.find((event) => event.id === selectedId) ?? events.find((event) => event.id === selectedId);
  const errors = filtered.filter((event) => event.status === "error").length;
  const warnings = filtered.filter((event) => event.status === "warning").length;
  const duration = filtered.reduce((sum, event) => sum + event.duration, 0);
  const tick = (ratio: number) => formatTimelineOffset(range * ratio);
  return (
    <PanelFrame eyebrow="Observatory / All telemetry" title="Global Telemetry Timeline" description="Chronological signals across Internet, Browser, System and runtime diagnostics.">
      <section className="global-timeline-summary">
        <article><span>Visible events</span><strong>{filtered.length.toLocaleString()}</strong><small>of {events.length.toLocaleString()} buffered</small></article>
        <article><span>Measured duration</span><strong>{formatDuration(duration)}</strong><small>{formatTimelineOffset(range)} time range</small></article>
        <article><span>Errors</span><strong className={errors ? "status-text--error" : "status-text--ok"}>{errors}</strong><small>{warnings} warnings</small></article>
        <article><span>Sessions</span><strong>{new Set(filtered.map((event) => event.sessionId)).size}</strong><small>{lanes.length} active subsystems</small></article>
      </section>
      <section className="global-timeline-filters" aria-label="Timeline filters">
        <label><span>Search</span><input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Event, URL, stage or session…"/></label>
        <label><span>Journey</span><select className="select-control" value={journey} onChange={(event) => setJourney(event.target.value)}><option value="all">All journeys</option><option value="internet">Internet</option><option value="browser">Browser</option><option value="system">System</option><option value="runtime">Runtime</option></select></label>
        <label><span>Kind</span><select className="select-control" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{[...new Set(events.map((event) => event.kind))].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Status</span><select className="select-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="ok">OK</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
        <label><span>Session</span><select className="select-control" value={session} onChange={(event) => setSession(event.target.value)}><option value="all">All sessions</option>{sessions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <button type="button" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); setJourney("all"); setSession("all"); }}>Reset</button>
      </section>
      <div className="timeline-shell">
        <div className="timeline-ruler">
          {[0, .2, .4, .6, .8, 1].map((ratio) => <span key={ratio}>{tick(ratio)}</span>)}
        </div>
        <div className="timeline-lanes">
          {lanes.map((laneKind) => (
            <div className="timeline-lane" key={laneKind}>
              <span className="timeline-label">{laneKind}<small>{filtered.filter((event) => event.kind === laneKind).length}</small></span>
              <div className="timeline-track">
                {filtered.filter((event) => event.kind === laneKind).map((event) => (
                  <button
                    type="button"
                    key={event.id}
                    onClick={() => select(event.id)}
                    title={`${event.name} · ${event.duration.toFixed(3)} ms · ${classifyJourney(event)}`}
                    className={`timeline-span timeline-span--${event.status} ${selectedId === event.id ? "timeline-span--selected" : ""}`}
                    style={{ left: `${Math.max(0, (event.timestamp - start) / range * 100)}%`, width: `${Math.max(.25, Math.min(100, event.duration / range * 100))}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
          {!filtered.length && <div className="empty-row">No telemetry matches the current filters.</div>}
        </div>
      </div>
      <div className="global-timeline-layout">
        <section className="panel-card global-timeline-events"><header><strong>Chronological events</strong><span>{filtered.length} matching signals</span></header><div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Signal</span><span>Journey / kind</span><span>Time</span><span>Duration</span><span>Status</span></div>{filtered.length ? [...filtered].reverse().slice(0, 250).map((event) => <button type="button" className={`event-row global-event-row ${selectedId === event.id ? "global-event-row--selected" : ""}`} role="row" key={event.id} onClick={() => select(event.id)}><span><i className={`event-dot event-dot--${event.status}`}/>{event.name}</span><span><b>{classifyJourney(event)}</b><small>{event.kind}</small></span><span className="mono">+{formatTimelineOffset(event.timestamp-start)}</span><span className="mono">{event.duration.toFixed(3)} ms</span><span className={`status-text status-text--${event.status}`}>{event.status}</span></button>) : <div className="empty-row">No matching events.</div>}</div></section>
        <aside className="panel-card global-timeline-detail">{selected ? <TimelineEventDetails event={selected} onClose={() => select(undefined)}/> : <div className="global-timeline-detail__empty"><CircleDot size={20}/><strong>Select an event</strong><span>Inspect timing, ownership, journey classification, relationships and the complete typed payload.</span></div>}</aside>
      </div>
    </PanelFrame>
  );
}

export function GraphPanel() {
  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const events = useTelemetryStore((state) => state.events);
  const selectedId = useSelectionStore((state) => state.eventId);
  const [mode, setMode] = useState<ExecutionGraphMode>("causal");
  const [sessionFilter, setSessionFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const selected = events.find((event) => event.id === selectedId);
  const sessions = [...new Set(events.map((event) => event.sessionId))];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const visibleNodes = nodes.filter((node) => {
    const event = eventById.get(node.id);
    const text = `${node.label} ${node.kind} ${String(event?.payload.url ?? "")}`.toLowerCase();
    return (sessionFilter === "all" || event?.sessionId === sessionFilter) && (kindFilter === "all" || node.kind === kindFilter) && (statusFilter === "all" || node.status === statusFilter) && (!query || text.includes(query.toLowerCase()));
  }).slice(-300);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const orphanNodes = visibleNodes.filter((node) => !visibleEdges.some((edge) => edge.source === node.id || edge.target === node.id));
  const errorNodes = visibleNodes.filter((node) => node.status === "error").length;
  const warningNodes = visibleNodes.filter((node) => node.status === "warning").length;
  const maxDepth = graphDepth(visibleNodes.map((node) => node.id), visibleEdges);
  const parentEdges = visibleEdges.filter((edge) => edge.relation !== "sequence").length;
  const sequenceEdges = visibleEdges.filter((edge) => edge.relation === "sequence").length;
  return (
    <PanelFrame
      eyebrow="Execution correlation"
      title="Causal execution graph"
      description="Parent/child telemetry relationships, stage ownership, failures, and unavailable causal signals."
      actions={<span className="graph-mode-note">Edges require explicit correlation IDs</span>}
    >
      <div className="graph-summary">
        <Metric label="Visible nodes" value={formatNumber(visibleNodes.length)} delta="last graph window" icon={GitBranch} />
        <Metric label="Connections" value={formatNumber(visibleEdges.length)} delta={`${parentEdges} causal · ${sequenceEdges} observed`} icon={Share2} />
        <Metric label="Max depth" value={visibleNodes.length ? String(maxDepth) : "—"} delta="derived from parent chain" icon={Activity} />
        <Metric label="Warnings" value={formatNumber(warningNodes)} delta={`${errorNodes} errors`} icon={AlertTriangle} />
      </div>
      <div className="graph-mode-tabs">{(["causal", "session", "subsystems", "neighborhood"] as ExecutionGraphMode[]).map((value) => <button key={value} className={mode === value ? "active" : ""} onClick={() => setMode(value)}>{value === "session" ? "Session Tree" : value}</button>)}</div>
      <div className="graph-filters"><label><span>Search</span><input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Event, URL or subsystem…"/></label><label><span>Session</span><select className="select-control" value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}><option value="all">All sessions</option>{sessions.map((session) => <option key={session}>{session}</option>)}</select></label><label><span>Kind</span><select className="select-control" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="all">All kinds</option>{[...new Set(nodes.map((node) => node.kind))].map((kind) => <option key={kind}>{kind}</option>)}</select></label><label><span>Status</span><select className="select-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="ok">OK</option><option value="warning">Warning</option><option value="error">Error</option></select></label><button onClick={() => { setQuery(""); setSessionFilter("all"); setKindFilter("all"); setStatusFilter("all"); }}>Reset</button></div>
      <div className="graph-toolbar"><span><Filter size={13}/>{mode === "causal" ? "Expandable Dagre causal flow · click +/− nodes" : mode === "session" ? "Expandable Dagre session hierarchy · click +/− nodes" : mode === "subsystems" ? "Aggregated correlated subsystem links" : selectedId ? "Two-hop parent/child neighborhood" : "Select a node to focus its neighborhood"}</span><span>{orphanNodes.length ? `${orphanNodes.length} orphan nodes without visible parent/child` : "All visible nodes are linked"}</span></div>
      <div className="graph-layout">
        <section className="graph-main">
          {visibleNodes.length ? <ExecutionGraph mode={mode} nodeIds={visibleIds} selectedId={selectedId}/> : <GraphEmpty />}
        </section>
        <aside className="graph-side">
          <section className="panel-card graph-detail">
            <CardHeader title="Selected node" subtitle={selected ? `#${selected.sequence} · ${selected.kind}` : "Click a graph node"} icon={CircleDot} />
            {selected ? <GraphEventDetails event={selected} /> : <div className="empty-row">No node selected.</div>}
          </section>
          <section className="panel-card graph-detail">
            <CardHeader title="Causal signal quality" subtitle="What the core currently emits" icon={Database} />
            <div className="graph-quality">
              <QualityRow label="Node identity" value={visibleNodes.length ? "Available" : "Waiting"} ok={visibleNodes.length > 0} />
              <QualityRow label="Parent links" value={parentEdges ? `${parentEdges} explicit` : "Unavailable"} ok={parentEdges > 0} />
              <QualityRow label="Session sequence" value={sequenceEdges ? `${sequenceEdges} observed` : "Unavailable"} ok={sequenceEdges > 0} />
              <QualityRow label="Cross-thread ownership" value={events.some((event) => event.payload.threadId || event.payload.threadName) ? "Available" : "Unavailable"} ok={events.some((event) => event.payload.threadId || event.payload.threadName)} />
              <QualityRow label="Function call edges" value={events.some((event) => event.payload.parentCallId) ? "Available" : "Unavailable"} ok={events.some((event) => event.payload.parentCallId)} />
            </div>
          </section>
          <section className="panel-card graph-detail">
            <CardHeader title="Recent causal roots" subtitle="Nodes without visible parent" icon={Network} />
            <div className="graph-roots">
              {orphanNodes.slice(-8).reverse().map((node) => <span key={node.id}><b>{node.kind}</b>{node.label}<small>{node.duration.toFixed(1)} ms</small></span>)}
              {!orphanNodes.length && <div className="empty-row">No orphan nodes in the visible window.</div>}
            </div>
          </section>
        </aside>
      </div>
    </PanelFrame>
  );
}

export function NetworkPanel() {
  const events = useTelemetryStore((state) => state.events);
  const filter = useNetworkStore((state) => state.filter);
  const setFilter = useNetworkStore((state) => state.setFilter);
  const [status, setStatus] = useState("all");
  const [session, setSession] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [detailTab, setDetailTab] = useState<"overview" | "timing" | "headers" | "events">("overview");
  const networkEvents = useMemo(() => events.filter((event) => event.kind === "network"), [events]);
  const requests = useMemo(() => aggregateNetworkRequests(networkEvents), [networkEvents]);
  const sessions = useMemo(() => [...new Set(requests.map((request) => request.sessionId))], [requests]);
  const visible = useMemo(() => requests.filter((request) => {
    const text = `${request.url} ${request.method} ${request.protocol} ${request.remoteIp} ${request.statusCode ?? ""} ${request.terminalStatus}`.toLowerCase();
    return (!filter || text.includes(filter.toLowerCase())) && (status === "all" || request.terminalStatus === status) && (session === "all" || request.sessionId === session);
  }), [filter, requests, session, status]);
  const selected = visible.find((request) => request.key === selectedKey) ?? visible[0];
  const errorCount = requests.filter((request) => request.terminalStatus === "error").length;
  const bytes = requests.reduce((sum, request) => sum + (request.responseBytes ?? 0), 0);
  const connections = new Set(requests.flatMap((request) => request.connectionId == null ? [] : [request.connectionId])).size;
  const protocols = [...new Set(requests.flatMap((request) => request.protocol === "Unavailable" ? [] : [request.protocol]))];
  return (
    <PanelFrame eyebrow="Network observability" title="Network Requests" description="Completed transfer lifecycles reconstructed from typed queue, DNS, transport, TLS, server and response events.">
      <section className="network-summary">
        <article><span>Transfers</span><strong>{requests.length.toLocaleString()}</strong><small>{visible.length} visible</small></article>
        <article><span>Failed</span><strong className={errorCount ? "status-text--error" : "status-text--ok"}>{errorCount}</strong><small>{requests.length ? `${(errorCount / requests.length * 100).toFixed(1)}% error rate` : "No transfers"}</small></article>
        <article><span>Response bytes</span><strong>{bytes ? formatBytes(bytes) : "Unavailable"}</strong><small>Observed body bytes</small></article>
        <article><span>Connections</span><strong>{connections || "Unavailable"}</strong><small>Unique connection IDs</small></article>
        <article><span>Protocols</span><strong>{protocols.join(", ") || "Unavailable"}</strong><small>Observed HTTP versions</small></article>
      </section>

      <section className="network-filters" aria-label="Network filters">
        <label><span>Search</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="URL, method, IP, protocol or status…" className="search-input" /></label>
        <label><span>Status</span><select className="select-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="ok">Successful</option><option value="error">Failed</option></select></label>
        <label><span>Session</span><select className="select-control" value={session} onChange={(event) => setSession(event.target.value)}><option value="all">All sessions</option>{sessions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <button onClick={() => { setFilter(""); setStatus("all"); setSession("all"); }}><X size={13}/> Reset</button>
      </section>

      <div className="network-layout">
        <section className="network-request-list">
          <header><span>Name</span><span>Status</span><span>Protocol</span><span>Remote address</span><span>Size</span><span>Duration</span></header>
          <div>{visible.length ? visible.map((request) => <button key={request.key} className={selected?.key === request.key ? "active" : ""} onClick={() => setSelectedKey(request.key)}>
            <span><i className={`event-dot event-dot--${request.terminalStatus === "error" ? "error" : "ok"}`}/><b>{request.method}</b><strong>{requestDisplayName(request.url)}</strong><small>{request.url}</small></span>
            <span className={`status-text--${request.terminalStatus === "error" ? "error" : "ok"}`}>{request.statusCode ?? (request.terminalStatus === "error" ? "ERR" : "—")}</span>
            <code>{request.protocol}</code><code>{request.remoteIp}</code><code>{formatOptionalBytes(request.responseBytes)}</code><code>{formatDuration(request.duration)}</code>
          </button>) : <div className="network-empty"><Wifi size={20}/><strong>{requests.length ? "No transfers match the current filters" : "Waiting for network telemetry"}</strong><span>{requests.length ? "Reset filters or search for a different URL." : "Inspect a URL to capture its transfer lifecycle."}</span></div>}</div>
        </section>

        <aside className="network-detail">{selected ? <>
          <header><div><span>{selected.method} · {selected.protocol}</span><strong>{requestDisplayName(selected.url)}</strong><small>{selected.url}</small></div><b className={`status-text--${selected.terminalStatus === "error" ? "error" : "ok"}`}>{selected.statusCode ?? selected.terminalStatus}</b></header>
          <nav>{(["overview", "timing", "headers", "events"] as const).map((tab) => <button key={tab} className={detailTab === tab ? "active" : ""} onClick={() => setDetailTab(tab)}>{tab}</button>)}</nav>
          {detailTab === "overview" && <NetworkOverview request={selected} />}
          {detailTab === "timing" && <NetworkTiming request={selected} />}
          {detailTab === "headers" && <NetworkHeaders request={selected} />}
          {detailTab === "events" && <NetworkEvents request={selected} />}
        </> : <div className="network-empty"><Network size={20}/><strong>Select a transfer</strong></div>}</aside>
      </div>
    </PanelFrame>
  );
}

const networkStageOrder = ["queue", "cache", "dns", "routing", "proxy", "tcp", "tls", "request", "redirect", "server", "response", "received"];
type NetworkRequest = ReturnType<typeof aggregateNetworkRequests>[number];

function aggregateNetworkRequests(events: TelemetryEvent[]) {
  const groups = new Map<string, TelemetryEvent[]>();
  const active = new Map<string, { key: string; seen: Set<string>; index: number }>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const payload = event.payload;
    const inspection = String(payload.inspectionId ?? event.sessionId);
    const url = String(payload.url ?? payload.requestedUrl ?? "URL unavailable");
    const base = `${inspection}|${url}`;
    const stage = String(payload.journeyStage ?? event.name);
    const current = active.get(base);
    const startsTransfer = stage === "queue" || !current || current.seen.has(stage) || current.seen.has("received");
    const group = startsTransfer ? { key: `${base}|${(current?.index ?? -1) + 1}`, seen: new Set<string>(), index: (current?.index ?? -1) + 1 } : current;
    active.set(base, group);
    group.seen.add(stage);
    const key = group.key;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups].map(([key, grouped]) => {
    const ordered = [...grouped].sort((a, b) => networkStageOrder.indexOf(String(a.payload.journeyStage ?? a.name)) - networkStageOrder.indexOf(String(b.payload.journeyStage ?? b.name)));
    const terminal = [...ordered].reverse().find((event) => event.payload.terminalStatus != null || event.payload.responseStatus != null) ?? ordered.at(-1)!;
    const payload = terminal.payload;
    const statusEvent = ordered.find((event) => event.status === "error");
    return { key, events: ordered, sessionId: terminal.sessionId, inspectionId: String(payload.inspectionId ?? "Unavailable"), url: String(payload.url ?? payload.requestedUrl ?? "Unavailable"), method: String(payload.method ?? "GET"), protocol: String(payload.httpVersion ?? "Unavailable"), remoteIp: String(payload.primaryIp ?? "Unavailable"), connectionId: payload.connectionId == null ? undefined : String(payload.connectionId), statusCode: typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : undefined, responseBytes: latestPayloadNumber(ordered, "responseBodyBytes"), duration: ordered.reduce((sum, event) => sum + Math.max(0, event.duration), 0), terminalStatus: statusEvent || payload.terminalStatus === "error" ? "error" : "ok", connectionReused: payload.connectionReused === true, usedProxy: payload.usedProxy === true, redirectCount: typeof payload.redirectCount === "number" ? payload.redirectCount : undefined, contentType: payloadString(payload, "contentType"), contentEncoding: payloadString(payload, "contentEncoding"), cacheDecision: payloadString(payload, "cacheDecision"), headers: { "Cache-Control": payloadString(payload, "cacheControl"), Server: payloadString(payload, "server"), Age: payloadString(payload, "age"), Via: payloadString(payload, "via"), ETag: payloadString(payload, "etag") }, failure: statusEvent ? String(statusEvent.payload.error ?? statusEvent.payload.errorMessage ?? statusEvent.payload.failureReason ?? "Network operation failed") : undefined };
  }).sort((a, b) => (b.events.at(-1)?.timestamp ?? 0) - (a.events.at(-1)?.timestamp ?? 0));
}

function NetworkOverview({ request }: { request: NetworkRequest }) { return <div className="network-detail-grid"><NetworkFact label="Request method" value={request.method}/><NetworkFact label="Response status" value={request.statusCode == null ? "Unavailable" : String(request.statusCode)}/><NetworkFact label="Remote address" value={request.remoteIp}/><NetworkFact label="Connection" value={request.connectionId ?? "Unavailable"}/><NetworkFact label="Connection reused" value={request.connectionReused ? "Yes" : "No / unavailable"}/><NetworkFact label="Proxy used" value={request.usedProxy ? "Yes" : "No"}/><NetworkFact label="Redirects" value={request.redirectCount == null ? "Unavailable" : String(request.redirectCount)}/><NetworkFact label="Cache decision" value={request.cacheDecision ?? "Unavailable"}/><NetworkFact label="Content type" value={request.contentType ?? "Unavailable"}/><NetworkFact label="Content encoding" value={request.contentEncoding ?? "Unavailable"}/><NetworkFact label="Response bytes" value={formatOptionalBytes(request.responseBytes)}/><NetworkFact label="Inspection" value={request.inspectionId}/>{request.failure && <div className="network-failure"><AlertTriangle size={15}/><span><strong>Transfer failed</strong><small>{request.failure}</small></span></div>}</div>; }
function NetworkTiming({ request }: { request: NetworkRequest }) { const max = Math.max(...request.events.map((event) => event.duration), 1); return <div className="network-timing">{networkStageOrder.map((stage) => { const event = request.events.find((candidate) => String(candidate.payload.journeyStage ?? candidate.name) === stage); const measurement = String(event?.payload.measurement ?? "unavailable"); return <div key={stage} className={`network-timing__row network-timing__row--${event?.status ?? "missing"}`}><span>{stage}</span><div><i style={{ width: event && event.duration > 0 ? `${Math.max(2, event.duration / max * 100)}%` : "2%" }}/></div><strong>{!event ? "Not emitted" : measurement === "boundary" ? "Boundary" : measurement === "reused" ? "Reused" : event.duration > 0 ? `${event.duration.toFixed(3)} ms` : measurement}</strong></div>; })}<footer><span>Total measured stage duration</span><strong>{formatDuration(request.duration)}</strong></footer></div>; }
function NetworkHeaders({ request }: { request: NetworkRequest }) { const captured = Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"); return <div className="network-headers"><section><header>Response metadata captured by core</header>{captured.length ? captured.map(([name, value]) => <div key={name}><code>{name}</code><span>{value}</span></div>) : <p>No response header values were captured for this transfer.</p>}</section><aside><strong>Capture boundary</strong><p>Only typed response metadata emitted by Velora Core is displayed. Complete request headers, response headers, cookies and body content are not reconstructed or invented.</p></aside></div>; }
function NetworkEvents({ request }: { request: NetworkRequest }) { return <div className="network-raw-events">{request.events.map((event) => <details key={event.id}><summary><span className={`status-text--${event.status}`}>{event.status}</span><strong>{event.name}</strong><code>#{event.sequence}</code><small>{event.duration.toFixed(3)} ms</small></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div>; }
function NetworkFact({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function latestPayloadNumber(events: TelemetryEvent[], key: string) { for (let index = events.length - 1; index >= 0; index--) { const value = events[index].payload[key]; if (typeof value === "number" && Number.isFinite(value)) return value; } return undefined; }
function payloadString(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "string" && value.length ? value : undefined; }
function requestDisplayName(url: string) { try { const parsed = new URL(url); return `${parsed.hostname}${parsed.pathname}`; } catch { return url; } }
function formatOptionalBytes(value?: number) { return value == null ? "Unavailable" : formatBytes(value); }

export function ReplayPanel() {
  const status = useReplayStore((state) => state.status);
  const setStatus = useReplayStore((state) => state.setStatus);
  const events = useTelemetryStore((state) => state.events);
  return (
    <PanelFrame eyebrow="Deterministic replay" title="Session replay" description="Model-free playback from versioned Action Journal artifacts.">
      <section className="replay-hero">
        <div>
          <span className="replay-kicker">Workflow v1</span>
          <h3>checkout-observation.json</h3>
          <p>24 replayable steps · 3 observations · no ephemeral node references</p>
        </div>
        <button className="primary-button" onClick={() => setStatus(status === "replaying" ? "idle" : "replaying")}>
          {status === "replaying" ? "Pause replay" : "Replay session"}
        </button>
      </section>
      <div className="replay-track">
        <span className={status === "replaying" ? "replay-progress replay-progress--active" : "replay-progress"} />
      </div>
      <section className="panel-card">
        <CardHeader title="Action journal" subtitle="Durable locators and structured extraction only" icon={Activity} />
        <EventTable events={events.filter((event) => ["navigation", "dom", "javascript"].includes(event.kind)).slice(-10).reverse()} />
      </section>
    </PanelFrame>
  );
}

function PanelFrame({ eyebrow, title, description, actions, children }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <main className="workspace"><header className="workspace-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions}</header>{children}</main>;
}

function Metric({ label, value, delta, positive, icon: Icon }: { label: string; value: string; delta: string; positive?: boolean; icon: typeof Activity }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={13} /></div><strong>{value}</strong><span className={positive ? "delta delta--positive" : "delta"}>{delta}</span></article>;
}

function CardHeader({ title, subtitle, icon: Icon }: { title: string; subtitle: string; icon: typeof Activity }) {
  return <header className="card-header"><div><h2><Icon size={15} />{title}</h2><p>{subtitle}</p></div></header>;
}

function HealthRow({ label, value, width, tone }: { label: string; value: string; width: string; tone: string }) {
  return <div className="health-row"><div><span>{label}</span><strong>{value}</strong></div><div className="health-bar"><span className={`health-bar__fill health-bar__fill--${tone}`} style={{ width }} /></div></div>;
}

function DashboardControls({ range, inspection, inspections, onRange, onInspection }: { range: string; inspection: string; inspections: Array<[string, string]>; onRange: (value: string) => void; onInspection: (value: string) => void }) {
  return <div className="dashboard-controls"><LivePill /><label><span>Inspection</span><select value={inspection} onChange={(event) => onInspection(event.target.value)}><option value="latest">Latest inspection</option><option value="all">All inspections</option>{inspections.map(([id, url]) => <option value={id} key={id}>{url}</option>)}</select></label><label><Clock3 size={13} /><select aria-label="Overview time range" value={range} onChange={(event) => onRange(event.target.value)}><option value="1m">Last 1 minute</option><option value="5m">Last 5 minutes</option><option value="15m">Last 15 minutes</option><option value="all">Full buffer</option></select></label></div>;
}

function SubsystemBar({ label, value, width }: { label: string; value: string; width: string }) {
  return <div className="subsystem-row"><div><span>{label}</span><strong>{value}</strong></div><div><span style={{ width }} /></div></div>;
}

function MiniGauge({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" }) {
  return <div className={`mini-gauge mini-gauge--${tone}`}><span>{label}</span><strong>{value}</strong><div><i style={{ width: value }} /></div></div>;
}

function EventTable({ events, network }: { events: ReturnType<typeof useTelemetryStore.getState>["events"]; network?: boolean }) {
  return <div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Signal</span><span>Subsystem</span><span>{network ? "Endpoint" : "Sequence"}</span><span>Duration</span><span>Status</span></div>{events.length === 0 ? <div className="empty-row">Waiting for telemetry…</div> : events.map((event) => <div className="event-row" role="row" key={event.id}><span><i className={`event-dot event-dot--${event.status}`} />{event.name}</span><span className="tag">{event.kind}</span><span className="mono">{network ? String(event.payload.url ?? "—") : `#${event.sequence}`}</span><span className="mono">{event.duration.toFixed(1)} ms</span><span className={`status-text status-text--${event.status}`}>{event.status}</span></div>)}</div>;
}

function GraphEmpty() {
  return <div className="graph-empty"><strong>Waiting for execution graph telemetry</strong><span>Run the global URL inspector. Nodes appear when normalized events arrive; edges require parentId or call-parent signals from core.</span></div>;
}

function GraphEventDetails({ event }: { event: ReturnType<typeof useTelemetryStore.getState>["events"][number] }) {
  const payload = event.payload;
  const rows = [
    ["Event id", event.id],
    ["Parent id", event.parentId ?? "Unavailable"],
    ["Session", event.sessionId],
    ["Timestamp", new Date(event.timestamp).toISOString()],
    ["Duration", `${event.duration.toFixed(3)} ms`],
    ["Status", event.status],
    ["URL", stringPayload(payload, "url") ?? "Unavailable"],
    ["Process", stringPayload(payload, "processName") ?? numberPayload(payload, "processId") ?? "Unavailable"],
    ["Thread", stringPayload(payload, "threadName") ?? numberPayload(payload, "threadId") ?? "Unavailable"],
    ["System stage", stringPayload(payload, "systemStage") ?? "Unavailable"],
  ];
  return (
    <div className="graph-event-detail">
      <h3>{event.name}</h3>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}

function TimelineEventDetails({ event, onClose }: { event: ReturnType<typeof useTelemetryStore.getState>["events"][number]; onClose: () => void }) {
  const stage = event.payload.browserStage ?? event.payload.systemStage ?? event.payload.journeyStage ?? "Not attributed";
  const owner = event.payload.processName ?? event.payload.processId ?? "Unavailable";
  const thread = event.payload.threadName ?? event.payload.thread ?? event.payload.threadId ?? "Unavailable";
  return <div className="timeline-event-detail">
    <header><div><small>{classifyJourney(event)} · {event.kind}</small><strong>{event.name}</strong></div><button type="button" onClick={onClose}>Close</button></header>
    <div className="timeline-event-detail__metrics">
      <span><small>Status</small><b className={`status-text--${event.status}`}>{event.status}</b></span>
      <span><small>Duration</small><b>{event.duration.toFixed(3)} ms</b></span>
      <span><small>Sequence</small><b>#{event.sequence}</b></span>
      <span><small>Stage</small><b>{String(stage)}</b></span>
    </div>
    <dl>
      <div><dt>Event ID</dt><dd>{event.id}</dd></div>
      <div><dt>Parent ID</dt><dd>{event.parentId ?? "Unavailable"}</dd></div>
      <div><dt>Session</dt><dd>{event.sessionId}</dd></div>
      <div><dt>Timestamp</dt><dd>{new Date(event.timestamp).toISOString()}</dd></div>
      <div><dt>Process</dt><dd>{String(owner)}</dd></div>
      <div><dt>Thread</dt><dd>{String(thread)}</dd></div>
      <div><dt>URL</dt><dd>{String(event.payload.url ?? "Unavailable")}</dd></div>
    </dl>
    <h3>Typed payload</h3><pre>{JSON.stringify(event.payload, null, 2)}</pre>
  </div>;
}

function QualityRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <span><i className={ok ? "legend-dot legend-dot--ok" : "legend-dot legend-dot--warn"} />{label}<strong className={ok ? "status-text--ok" : "status-text--warning"}>{value}</strong></span>;
}

function PanelLoader({ label }: { label: string }) { return <div className="panel-loader"><span />{label}</div>; }
function LivePill() { const status = useTelemetryStore((state) => state.status); return <span className={`live-pill live-pill--${status}`}><i />{status}</span>; }
function formatNumber(value: number) { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function percentile(values: number[], rank: number) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank))]; }
function formatDuration(value: number) { return value > 0 ? `${value.toFixed(1)} ms` : "—"; }
function formatTimelineOffset(value: number) { if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`; if (value >= 1000) return `${(value / 1000).toFixed(2)} s`; if (value >= 1) return `${value.toFixed(1)} ms`; return `${(value * 1000).toFixed(0)} µs`; }
function classifyJourney(event: ReturnType<typeof useTelemetryStore.getState>["events"][number]) {
  if (typeof event.payload.systemStage === "string" || event.kind === "memory") return "system";
  if (typeof event.payload.browserStage === "string" || ["dom", "javascript", "render"].includes(event.kind)) return "browser";
  if (typeof event.payload.journeyStage === "string" || event.kind === "network" || event.kind === "navigation") return "internet";
  return "runtime";
}
function formatBytes(value: number) { if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`; if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`; return `${value.toFixed(0)} B`; }
function latestNumber(events: ReturnType<typeof useTelemetryStore.getState>["events"], ...keys: string[]) { for (let index = events.length - 1; index >= 0; index -= 1) { for (const key of keys) { const value = events[index].payload[key]; if (typeof value === "number" && Number.isFinite(value)) return value; } } return undefined; }
function isMeasuredEvent(event: TelemetryEvent) { const state = String(event.payload.measurementState ?? event.payload.measurement ?? "").toLowerCase(); return event.duration > 0 && Number.isFinite(event.duration) && !["unavailable", "not-timed", "not timed", "boundary", "awaiting"].includes(state); }
function eventRate(events: TelemetryEvent[]) { const buckets = new Map<number, number>(); events.forEach((event) => { const second = Math.floor(event.timestamp / 1000) * 1000; buckets.set(second, (buckets.get(second) ?? 0) + 1); }); return [...buckets.entries()].sort((a, b) => a[0] - b[0]); }
function statusLabel(status: ReturnType<typeof useTelemetryStore.getState>["status"]) { return status === "live" ? "streaming" : status; }
function barWidth(value: number, events: ReturnType<typeof useTelemetryStore.getState>["events"]) { const max = Math.max(1, percentile(events.map((event) => event.duration), .99)); return `${Math.min(100, value / max * 100)}%`; }
function barWidthFromValue(value: string) { const number = Number.parseFloat(value); return Number.isFinite(number) ? `${Math.min(100, number / 200 * 100)}%` : "0%"; }
function stringPayload(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "string" && value.length ? value : undefined; }
function numberPayload(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function graphDepth(nodeIds: string[], edges: Array<{ source: string; target: string }>) {
  const children = new Map<string, string[]>();
  const targets = new Set<string>();
  edges.forEach((edge) => {
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]);
    targets.add(edge.target);
  });
  const roots = nodeIds.filter((id) => !targets.has(id));
  const visit = (id: string, depth: number, seen: Set<string>): number => {
    if (seen.has(id)) return depth;
    const nextSeen = new Set(seen).add(id);
    const next = children.get(id) ?? [];
    if (!next.length) return depth;
    return Math.max(...next.map((child) => visit(child, depth + 1, nextSeen)));
  };
  return roots.length ? Math.max(...roots.map((id) => visit(id, 1, new Set()))) : 0;
}
