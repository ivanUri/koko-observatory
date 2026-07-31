"use client";

import dynamic from "next/dynamic";
import { Activity, ArrowDownRight, ArrowUpRight, CircleDot, Clock3, Cpu, Database, Gauge, Network, RefreshCw, Share2 } from "lucide-react";
import { RealtimeChart } from "@/src/components/realtime-chart";
import { useGraphStore, useNetworkStore, useReplayStore, useSelectionStore, useTelemetryStore } from "@/src/stores";

const ExecutionGraph = dynamic(
  () => import("@/src/components/execution-graph").then((module) => module.ExecutionGraph),
  { ssr: false, loading: () => <PanelLoader label="Building execution graph…" /> },
);

export function OverviewPanel() {
  const total = useTelemetryStore((state) => state.total);
  const p95 = useTelemetryStore((state) => state.p95);
  const events = useTelemetryStore((state) => state.events);
  const errors = events.filter((event) => event.status === "error").length;

  return (
    <PanelFrame
      eyebrow="Dashboards / Browser runtime"
      title="Velora runtime monitor"
      description="Live operational view across execution, resources, scheduling, and transport."
      actions={<DashboardControls />}
    >
      <div className="metric-grid">
        <Metric label="Events ingested" value={formatNumber(total)} delta="+18.4%" icon={Activity} />
        <Metric label="P95 latency" value={`${p95.toFixed(1)} ms`} delta="-6.2%" positive icon={Clock3} />
        <Metric label="Error signals" value={String(errors)} delta="0.07%" icon={CircleDot} />
        <Metric label="Worker load" value="38%" delta="healthy" positive icon={Cpu} />
      </div>
      <div className="monitor-grid">
        <section className="panel-card monitor-panel monitor-panel--throughput">
          <CardHeader title="Event throughput" subtitle="Incremental ring buffer · 60 second window" icon={Gauge} />
          <RealtimeChart />
        </section>
        <section className="panel-card monitor-panel monitor-panel--health">
          <CardHeader title="Runtime health" subtitle="Current execution profile" icon={Database} />
          <div className="health-stack">
            <HealthRow label="Main thread" value="12.8 ms" tone="primary" width="42%" />
            <HealthRow label="Scheduler queue" value="4 tasks" tone="blue" width="27%" />
            <HealthRow label="JS heap" value="84.2 MB" tone="mint" width="58%" />
            <HealthRow label="DOM nodes" value="12,481" tone="amber" width="36%" />
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Event status" subtitle="Last 10,000 signals" icon={CircleDot} />
          <div className="status-distribution">
            <div className="status-ring"><span><strong>99.3%</strong><small>healthy</small></span></div>
            <div className="status-legend">
              <span><i className="legend-dot legend-dot--ok" />Normal <strong>9,931</strong></span>
              <span><i className="legend-dot legend-dot--warn" />Warning <strong>54</strong></span>
              <span><i className="legend-dot legend-dot--error" />Error <strong>15</strong></span>
            </div>
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Subsystem latency" subtitle="P95 by pipeline stage" icon={Cpu} />
          <div className="subsystem-bars">
            <SubsystemBar label="Network" value="128 ms" width="78%" />
            <SubsystemBar label="JavaScript" value="42 ms" width="52%" />
            <SubsystemBar label="Render" value="28 ms" width="38%" />
            <SubsystemBar label="Scheduler" value="12 ms" width="22%" />
          </div>
        </section>
        <section className="panel-card monitor-panel">
          <CardHeader title="Resource pressure" subtitle="Current saturation" icon={Activity} />
          <div className="gauge-stack">
            <MiniGauge label="CPU" value="38%" tone="ok" />
            <MiniGauge label="Memory" value="61%" tone="warn" />
            <MiniGauge label="Queue" value="24%" tone="ok" />
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
  return (
    <PanelFrame eyebrow="Indexed timeline" title="Event timeline" description="Windowed, searchable event history with worker-built indexes.">
      <div className="timeline-shell">
        <div className="timeline-ruler">
          {["0 ms", "200 ms", "400 ms", "600 ms", "800 ms", "1.0 s"].map((tick) => <span key={tick}>{tick}</span>)}
        </div>
        <div className="timeline-lanes">
          {(["network", "javascript", "scheduler", "render", "dom"] as const).map((kind, lane) => (
            <div className="timeline-lane" key={kind}>
              <span className="timeline-label">{kind}</span>
              <div className="timeline-track">
                {events.filter((event) => event.kind === kind).slice(-28).map((event, index) => (
                  <button
                    type="button"
                    key={event.id}
                    onClick={() => select(event.id)}
                    title={`${event.name} · ${event.duration}ms`}
                    className={`timeline-span timeline-span--${event.status}`}
                    style={{ left: `${(index * 13 + lane * 7) % 92}%`, width: `${Math.max(1.8, Math.min(10, event.duration / 18))}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <section className="panel-card"><EventTable events={events.slice(-14).reverse()} /></section>
    </PanelFrame>
  );
}

export function GraphPanel() {
  const layout = useGraphStore((state) => state.layout);
  const setLayout = useGraphStore((state) => state.setLayout);
  return (
    <PanelFrame
      eyebrow="Execution correlation"
      title="Causal execution graph"
      description="Virtualized rendering with lazy graph windows, animated edges, minimap, and switchable layouts."
      actions={
        <select className="select-control" value={layout} onChange={(event) => setLayout(event.target.value as typeof layout)}>
          <option value="dagre">Dagre</option><option value="elk">ELK</option><option value="force">Force</option>
          <option value="tree">Tree</option><option value="radial">Radial</option>
        </select>
      }
    >
      <ExecutionGraph />
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
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={15} /></div><strong>{value}</strong><span className={positive ? "delta delta--positive" : "delta"}>{positive ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}{delta}</span></article>;
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

function PanelLoader({ label }: { label: string }) { return <div className="panel-loader"><span />{label}</div>; }
function LivePill() { return <span className="live-pill"><i />Live · 5.2k/s</span>; }
function formatNumber(value: number) { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
