"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CircleDot, Clock3, Cpu, Database, Filter, Gauge, GitBranch, Network, RefreshCw, Share2 } from "lucide-react";
import { RealtimeChart } from "@/src/components/realtime-chart";
import { useGraphStore, useNetworkStore, useReplayStore, useSelectionStore, useTelemetryStore } from "@/src/stores";
import type { ExecutionGraphMode } from "@/src/components/execution-graph";

const ExecutionGraph = dynamic(
  () => import("@/src/components/execution-graph").then((module) => module.ExecutionGraph),
  { ssr: false, loading: () => <PanelLoader label="Building execution graph…" /> },
);

export function OverviewPanel() {
  const p95 = useTelemetryStore((state) => state.p95);
  const events = useTelemetryStore((state) => state.events);
  const status = useTelemetryStore((state) => state.status);
  const errors = events.filter((event) => event.status === "error").length;
  const warnings = events.filter((event) => event.status === "warning").length;
  const sessions = new Set(events.map((event) => event.sessionId)).size;
  const recentCutoff = Date.now() - 60_000;
  const activeSessions = new Set(events.filter((event) => event.timestamp >= recentCutoff).map((event) => event.sessionId)).size;
  const heap = latestNumber(events, "heapUsedBytes", "jsHeapBytes");
  const domNodes = latestNumber(events, "domNodes");
  const cpu = latestNumber(events, "cpuPercent");
  const queue = latestNumber(events, "queueDepth");
  const stageP95 = (kind: typeof events[number]["kind"]) => formatDuration(percentile(events.filter((event) => event.kind === kind).map((event) => event.duration), .95));
  // Status counts are derived from the visible ring-buffer window. `total` is
  // cumulative and must not be used as the denominator for these windowed
  // counts once the buffer has rolled over.
  const statusTotal = Math.max(events.length, 1);
  const healthy = Math.max(0, events.length - errors - warnings);
  const hasTelemetry = events.length > 0;

  return (
    <PanelFrame
      eyebrow="Dashboards / Browser runtime"
      title="Velora runtime monitor"
      description="Live operational view across execution, resources, scheduling, and transport."
      actions={<DashboardControls />}
    >
      <div className="metric-grid">
        <Metric label="Sessions" value={hasTelemetry ? formatNumber(sessions) : "—"} delta={statusLabel(status)} icon={Activity} />
        <Metric label="Active sessions" value={hasTelemetry ? formatNumber(activeSessions) : "—"} delta="last 60s" icon={Activity} />
        <Metric label="Error rate" value={hasTelemetry ? `${(errors / statusTotal * 100).toFixed(2)}%` : "—"} delta={`${warnings} warnings`} icon={CircleDot} />
        <Metric label="P95 latency" value={hasTelemetry ? formatDuration(p95) : "—"} delta="observed window" icon={Clock3} />
        <Metric label="JS heap (latest)" value={heap == null ? "—" : formatBytes(heap)} delta={heap == null ? "Awaiting memory telemetry" : "latest sample"} icon={Cpu} />
        <Metric label="Crash rate" value="—" delta="No crash signal" icon={CircleDot} />
      </div>
      <div className="monitor-grid">
        <section className="panel-card monitor-panel monitor-panel--throughput">
          <CardHeader title="Event throughput" subtitle="Incremental ring buffer · 60 second window" icon={Gauge} />
          <RealtimeChart />
        </section>
        <section className="panel-card monitor-panel monitor-panel--health">
          <CardHeader title="Runtime health" subtitle="Current execution profile" icon={Database} />
          <div className="health-stack">
            <HealthRow label="Main thread" value={formatDuration(percentile(events.filter((event) => event.payload.thread === "Main" || event.kind === "javascript").map((event) => event.duration), .95))} tone="primary" width={barWidth(p95, events)} />
            <HealthRow label="Scheduler queue" value={queue == null ? "—" : `${formatNumber(queue)} tasks`} tone="blue" width={queue == null ? "0%" : `${Math.min(100, queue)}%`} />
            <HealthRow label="JS heap" value={heap == null ? "—" : formatBytes(heap)} tone="mint" width={heap == null ? "0%" : `${Math.min(100, heap / (512 * 1024 * 1024) * 100)}%`} />
            <HealthRow label="DOM nodes" value={domNodes == null ? "—" : formatNumber(domNodes)} tone="amber" width={domNodes == null ? "0%" : `${Math.min(100, domNodes / 50_000 * 100)}%`} />
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
          <CardHeader title="Resource pressure" subtitle="Current saturation" icon={Activity} />
          <div className="gauge-stack">
            <MiniGauge label="CPU" value={cpu == null ? "—" : `${Math.max(0, Math.min(100, cpu)).toFixed(0)}%`} tone={cpu != null && cpu > 80 ? "warn" : "ok"} />
            <MiniGauge label="Memory" value={heap == null ? "—" : `${Math.max(0, Math.min(100, heap / (512 * 1024 * 1024) * 100)).toFixed(0)}%`} tone="warn" />
            <MiniGauge label="Queue" value={queue == null ? "—" : `${Math.max(0, Math.min(100, queue)).toFixed(0)}%`} tone="ok" />
          </div>
        </section>
      </div>
      <section className="panel-card monitor-panel monitor-panel--events">
        <CardHeader title="Recent signals" subtitle="Normalized events from the telemetry pipeline" icon={Network} />
        <EventTable events={events.slice(-9).reverse()} />
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
  const network = events.filter((event) => event.kind === "network" && event.name.toLowerCase().includes(filter.toLowerCase())).slice(-120).reverse();
  return (
    <PanelFrame eyebrow="Network observability" title="Requests" description="Streaming request lifecycle, timings, payload metadata, and correlations.">
      <div className="toolbar">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter URL, type, status…" className="search-input" />
        <span>{network.length} visible</span>
      </div>
      <section className="panel-card"><EventTable events={network} network /></section>
    </PanelFrame>
  );
}

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
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={13} /></div><strong>{value}</strong><span className={positive ? "delta delta--positive" : "delta"}>{delta}</span><span className="metric-spark">{[2,4,3,7,5,9,8,12,10,14].map((height, index) => <i key={index} style={{height}} />)}</span></article>;
}

function CardHeader({ title, subtitle, icon: Icon }: { title: string; subtitle: string; icon: typeof Activity }) {
  return <header className="card-header"><div><h2><Icon size={15} />{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label={`More options for ${title}`}>•••</button></header>;
}

function HealthRow({ label, value, width, tone }: { label: string; value: string; width: string; tone: string }) {
  return <div className="health-row"><div><span>{label}</span><strong>{value}</strong></div><div className="health-bar"><span className={`health-bar__fill health-bar__fill--${tone}`} style={{ width }} /></div></div>;
}

function DashboardControls() {
  return <div className="dashboard-controls"><LivePill /><button className="toolbar-button"><Clock3 size={13} />Last 5 minutes</button><button className="toolbar-button" aria-label="Refresh dashboard"><RefreshCw size={13} />5s</button><button className="icon-button" aria-label="Share dashboard"><Share2 size={14} /></button></div>;
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
