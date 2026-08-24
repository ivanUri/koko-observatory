"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CircleDot, Clock3, Cpu, Database, Gauge, GitBranch, Grid3x3, List, Network, Share2, Waypoints, Wifi, X, Zap } from "lucide-react";
import { RealtimeChart } from "@/src/components/realtime-chart";
import { useGraphStore, useNetworkStore, useReplayStore, useSelectionStore, useTelemetryStore } from "@/src/stores";
import type { TelemetryEvent } from "@/src/core/types";
import { executionIdFor } from "@/src/executions/types";
import { bucketEventRate, eventsPerSecond, metricCategory, percentile, isMeasuredEvent } from "@/src/core/metrics";

const ExecutionGraph = dynamic(
  () => import("@/src/components/execution-graph").then((module) => module.ExecutionGraph),
  { ssr: false, loading: () => <PanelLoader label="Building execution graph…" /> },
);

export function OverviewPanel() {
  const events = useTelemetryStore((state) => state.events);
  const totalSignals = useTelemetryStore((state) => state.total);
  const status = useTelemetryStore((state) => state.status);
  const [range, setRange] = useState("5m");
  const [inspection, setInspection] = useState("latest");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const inspections = useMemo(() => [...new Map(events.flatMap((event) => {
    const id = stringPayload(event.payload, "inspectionId");
    return id ? [[id, stringPayload(event.payload, "requestedUrl") ?? id] as const] : [];
  })).entries()].reverse(), [events]);
  const latestInspection = inspections[0]?.[0];
  const scoped = useMemo(() => {
    const cutoff = range === "all" ? 0 : now - ({ "1m": 60_000, "5m": 300_000, "15m": 900_000 }[range] ?? 300_000);
    const selected = inspection === "latest" ? latestInspection : inspection === "all" ? undefined : inspection;
    return events.filter((event) => event.timestamp >= cutoff && (!selected || event.payload.inspectionId === selected));
  }, [events, inspection, latestInspection, now, range]);
  const lifecycle = [...scoped].reverse().find((event) => typeof event.payload.inspectionState === "string");
  const measured = scoped.filter(isMeasuredEvent);
  const errors = scoped.filter((event) => event.status === "error").length;
  const warnings = scoped.filter((event) => event.status === "warning").length;
  const cpu = latestNumber(scoped, "cpuPercent");
  const cpuCoresUsed = latestNumber(scoped, "cpuCoresUsed");
  const cpuWindowMs = latestNumber(scoped, "cpuSampleWindowMs");
  const memory = latestNumber(scoped, "residentMemoryBytes");
  const contextSwitches = latestNumber(scoped, "contextSwitches");
  const diskRead = latestNumber(scoped, "diskReadBytes");
  const diskWrite = latestNumber(scoped, "diskWriteBytes");
  const p95 = percentile(measured.map((event) => event.duration), .95);
  const statusTotal = Math.max(scoped.length, 1);
  const healthy = Math.max(0, scoped.length - errors - warnings);
  const hasTelemetry = scoped.length > 0;
  const rate = useMemo(() => bucketEventRate(scoped), [scoped]);
  const currentRate = eventsPerSecond(scoped, now);
  const stageP95 = (kind: "network" | "javascript" | "render" | "dom" | "scheduler" | "memory") => formatDuration(stageP95Raw(kind));
  const stageP95Raw = (kind: "network" | "javascript" | "render" | "dom" | "scheduler" | "memory") => percentile(measured.filter((event) => metricCategory(event) === kind).map((event) => event.duration), .95);

  const journeySummary = (["internet", "browser", "system"] as const).map((journey) => {
    const source = scoped.filter((event) => belongsToJourney(event, journey));
    const p95Val = percentile(source.filter(isMeasuredEvent).map((event) => event.duration), .95);
    const p50Val = percentile(source.filter(isMeasuredEvent).map((event) => event.duration), .50);
    return { journey, events: source.length, errors: source.filter((event) => event.status === "error").length, warnings: source.filter((event) => event.status === "warning").length, p95: p95Val, p50: p50Val };
  });

  // Pipeline coverage: which browser stages have seen at least one event
  const PIPELINE_STAGES = ["response", "decompression", "cache", "html-parser", "preload", "dom", "css-parser", "javascript", "event-loop", "mutations", "style", "layout", "paint", "layers", "raster", "composite", "frame"] as const;
  const observedStages = new Set(scoped.flatMap((e) => {
    const bs = String(e.payload.browserStage ?? ""); const ss = String(e.payload.systemStage ?? "");
    return [bs, ss, e.kind, e.name].filter(Boolean);
  }));
  const pipelineCoverage = PIPELINE_STAGES.map((stage) => ({ stage, observed: observedStages.has(stage) }));
  const coveredCount = pipelineCoverage.filter((s) => s.observed).length;

  // Top slowest stages
  const ALL_KINDS = ["network", "javascript", "render", "dom", "scheduler", "memory"] as const;
  const slowestStages = ALL_KINDS
    .map((kind) => ({ kind, p95: stageP95Raw(kind), count: measured.filter((event) => metricCategory(event) === kind).length }))
    .filter((s) => s.p95 > 0)
    .sort((a, b) => b.p95 - a.p95);
  const maxStageP95 = Math.max(...slowestStages.map((s) => s.p95), 1);

  // Top domain origins
  const domainCounts = new Map<string, number>();
  for (const ev of scoped) {
    const url = String(ev.payload.scriptUrl ?? ev.payload.url ?? "");
    if (!url.startsWith("http")) continue;
    try { const host = new URL(url).hostname; domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1); } catch { /* skip */ }
  }
  const topDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  // Browser lifecycle is the useful progress signal for the home page. The
  // bridge's transport states (queued/started/receiving) remain as early
  // phases, but once Core emits a milestone we show the actual page state.
  const hasInspectionState = (state: string) => scoped.some((event) => event.payload.inspectionState === state);
  const hasLifecycle = (stage: string) => scoped.some((event) => event.payload.lifecycleStage === stage);
  const hasResponse = scoped.some((event) => event.kind === "network" && event.payload.journeyStage === "response");
  // A warning/error signal is not the same as a failed inspection. Keep the
  // pipeline status on its ordered lifecycle steps until the run emits the
  // terminal failed state.
  const failed = hasInspectionState("failed");
  const completed = hasInspectionState("completed");
  const browserSteps = [
    "queued",
    "started",
    "receiving",
    "domcontentloaded",
    "load",
    "domstable",
    "networkidle",
    "background",
    "completed",
  ] as const;
  const reached = new Set<string>();
  if (hasTelemetry) reached.add("queued");
  if (hasInspectionState("started")) reached.add("started");
  if (hasResponse) reached.add("receiving");
  if (hasLifecycle("domcontentloaded")) reached.add("domcontentloaded");
  if (hasLifecycle("load")) reached.add("load");
  if (hasLifecycle("domstable")) reached.add("domstable");
  if (hasLifecycle("networkidle")) reached.add("networkidle");
  // Background observation begins after the browser lifecycle milestones. Do
  // not jump to it merely because the first DOM snapshot arrived: the active
  // label should move only when the next pipeline step is evidenced.
  if (hasLifecycle("networkidle") && !completed && !failed) reached.add("background");
  if (completed) reached.add("completed");
  const activeStepIndex = browserSteps.reduce((index, step, candidate) => reached.has(step) ? candidate : index, 0);
  const browserState = failed
    ? "failed"
    : completed
      ? "completed"
      : hasTelemetry
        ? browserSteps[activeStepIndex]
        : "waiting for inspection";

  return (
    <PanelFrame
      eyebrow="Dashboards / Browser runtime"
      title="Koko runtime monitor"
      description="Live operational view across execution, resources, scheduling, and transport."
    >
      {/* Status bar */}
      <section className="overview-context">
        <div>
          <LivePill />
          <strong>{browserState}</strong>
          <span>{String(lifecycle?.payload.requestedUrl ?? "Run Inspect URL to start an observed journey")}</span>
          {hasTelemetry && (
            <div className="inspection-steps">
              {browserSteps.map((step, i) => (
                <span key={step} className={`inspection-step${i < activeStepIndex || reached.has(step) ? " inspection-step--done" : ""}${i === activeStepIndex ? " inspection-step--active" : ""}`}>
                  {step}
                </span>
              ))}
            </div>
          )}
        </div>
        <DashboardControls range={range} inspection={inspection} inspections={inspections} onRange={setRange} onInspection={setInspection} />
      </section>

      {/* Key metrics */}
      <div className="metric-grid">
        <Metric label="Page lifecycle" value={hasTelemetry ? browserState : "—"} delta={statusLabel(status)} icon={Activity} />
        <Metric label="Signals received" value={totalSignals > 0 ? formatNumber(totalSignals) : "—"} delta={`${formatNumber(scoped.length)} in scope · ${events.length} retained · ${currentRate.toFixed(1)}/s`} icon={Activity} />
        <Metric label="Error rate" value={hasTelemetry ? `${(errors / statusTotal * 100).toFixed(2)}%` : "—"} delta={`${errors} errors · ${warnings} warnings`} icon={CircleDot} />
        <Metric label="Measured P95" value={formatDuration(p95)} delta="across all measured stages" icon={Clock3} />
        <Metric label="CPU capacity" value={cpu == null ? "—" : `${cpu.toFixed(1)}%`} delta={cpu == null ? "Signal unavailable" : cpuCoresUsed == null ? "CPU sample warming up" : `≈ ${cpuCoresUsed.toFixed(2)} cores · ${(cpuWindowMs ?? 0).toFixed(0)} ms window`} icon={Cpu} />
        <Metric label="Resident memory" value={memory == null ? "—" : formatBytes(memory)} delta={memory == null ? "Signal unavailable" : "core process sample"} icon={Database} />
        <Metric label="Disk read" value={diskRead == null ? "—" : formatBytes(diskRead)} delta={diskRead == null ? "Signal unavailable" : "cumulative bytes read"} icon={Database} />
        <Metric label="Disk write" value={diskWrite == null ? "—" : formatBytes(diskWrite)} delta={diskWrite == null ? "Signal unavailable" : "cumulative bytes written"} icon={Database} />
      </div>

      {/* Journey summary — enriched */}
      <div className="overview-journeys overview-journeys--rich">
        {journeySummary.map((item) => {
          const href = item.journey === "internet" ? "/internet-journey" : item.journey === "browser" ? "/browser-journey" : "/system-journey";
          const color = ({ internet: "#3b8bd6", browser: "#42c997", system: "#a37bd3" } as const)[item.journey];
          const p95pct = item.p95 > 0 ? Math.min(100, item.p95 / Math.max(...journeySummary.map((j) => j.p95), 1) * 100) : 0;
          return (
            <Link href={href} key={item.journey} className="journey-card">
              <div className="journey-card__rail" style={{ background: color }} />
              <div className="journey-card__body">
                <div className="journey-card__top">
                  <span className="journey-card__name">{item.journey} journey</span>
                  {item.errors > 0 && <span className="journey-card__err">{item.errors} error{item.errors !== 1 ? "s" : ""}</span>}
                  {item.warnings > 0 && !item.errors && <span className="journey-card__warn">{item.warnings} warn</span>}
                </div>
                <strong className="journey-card__count">{item.events || "—"} signals</strong>
                <div className="journey-card__bar">
                  <span style={{ width: `${p95pct}%`, background: color }} />
                </div>
                <small className="journey-card__meta">
                  {item.events ? `P50 ${formatDuration(item.p50)} · P95 ${formatDuration(item.p95)}` : "No observed evidence"}
                </small>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="monitor-grid">
        {/* Throughput */}
        <section className="panel-card monitor-panel monitor-panel--throughput">
          <CardHeader title="Event throughput" subtitle="Events per second from telemetry timestamps" icon={Gauge} />
          <RealtimeChart data={rate} />
        </section>

        {/* Runtime health */}
        <section className="panel-card monitor-panel monitor-panel--health">
          <CardHeader title="Runtime health" subtitle="Current execution profile" icon={Database} />
          <div className="health-stack">
            <HealthRow label="Measured latency P95" value={formatDuration(p95)} tone="primary" width={barWidth(p95, measured)} />
            <HealthRow label="Context switches" value={contextSwitches == null ? "—" : formatNumber(contextSwitches)} tone="blue" width={contextSwitches == null ? "0%" : "100%"} />
            <HealthRow label="Disk read" value={diskRead == null ? "—" : formatBytes(diskRead)} tone="mint" width={diskRead == null ? "0%" : "100%"} />
            <HealthRow label="Disk write" value={diskWrite == null ? "—" : formatBytes(diskWrite)} tone="amber" width={diskWrite == null ? "0%" : "100%"} />
          </div>
        </section>

        {/* Event status */}
        <section className="panel-card monitor-panel">
          <CardHeader title="Event status" subtitle="Latest buffered signals" icon={CircleDot} />
          <div className="status-distribution">
            <div className="status-ring"><span><strong>{hasTelemetry ? `${(healthy / statusTotal * 100).toFixed(1)}%` : "—"}</strong><small>healthy</small></span></div>
            <div className="status-legend">
              <span><i className="legend-dot legend-dot--ok" />Normal <strong>{healthy}</strong></span>
              <span><i className="legend-dot legend-dot--warn" />Warning <strong>{warnings}</strong></span>
              <span><i className="legend-dot legend-dot--error" />Error <strong>{errors}</strong></span>
            </div>
          </div>
        </section>

        {/* Stage latency */}
        <section className="panel-card monitor-panel">
          <CardHeader title="Stage latency" subtitle="P95 by pipeline kind" icon={Cpu} />
          <div className="subsystem-bars">
            {slowestStages.length > 0 ? slowestStages.map((s) => (
              <SubsystemBar key={s.kind} label={`${s.kind} (${s.count})`} value={formatDuration(s.p95)} width={`${Math.max(2, s.p95 / maxStageP95 * 100)}%`} />
            )) : (
              <>
                <SubsystemBar label="Network" value={stageP95("network")} width={barWidthFromValue(stageP95("network"))} />
                <SubsystemBar label="JavaScript" value={stageP95("javascript")} width={barWidthFromValue(stageP95("javascript"))} />
                <SubsystemBar label="Render" value={stageP95("render")} width={barWidthFromValue(stageP95("render"))} />
                <SubsystemBar label="Scheduler" value={stageP95("scheduler")} width={barWidthFromValue(stageP95("scheduler"))} />
              </>
            )}
          </div>
        </section>

        {/* Core process sample */}
        <section className="panel-card monitor-panel">
          <CardHeader title="Core process sample" subtitle="Latest system evidence; no assumed capacity" icon={Activity} />
          <div className="gauge-stack">
            <MiniGauge label="CPU" value={cpu == null ? "—" : `${Math.max(0, Math.min(100, cpu)).toFixed(0)}%`} tone={cpu != null && cpu > 80 ? "warn" : "ok"} />
            <MiniGauge label="Resident RAM" value={memory == null ? "—" : formatBytes(memory)} tone="ok" />
            <MiniGauge label="Context switches" value={contextSwitches == null ? "—" : formatNumber(contextSwitches)} tone="ok" />
          </div>
        </section>

        {/* Pipeline coverage */}
        <section className="panel-card monitor-panel monitor-panel--pipeline">
          <CardHeader title="Browser pipeline coverage" subtitle={`${coveredCount} of ${PIPELINE_STAGES.length} stages observed`} icon={GitBranch} />
          <div className="pipeline-coverage">
            {pipelineCoverage.map(({ stage, observed }) => (
              <span key={stage} className={`pipeline-stage${observed ? " pipeline-stage--observed" : ""}`} title={observed ? `${stage} — observed` : `${stage} — no telemetry`}>
                {stage}
              </span>
            ))}
          </div>
          <div className="pipeline-coverage__bar">
            <span style={{ width: `${(coveredCount / PIPELINE_STAGES.length) * 100}%` }} />
          </div>
        </section>

        {/* Top origins */}
        {topDomains.length > 0 && (
          <section className="panel-card monitor-panel monitor-panel--origins">
            <CardHeader title="Script origins" subtitle="Domains observed in telemetry" icon={Network} />
            <div className="origin-list">
              {topDomains.map(([host, count]) => (
                <div key={host} className="origin-row">
                  <span className="origin-row__host">{host}</span>
                  <span className="origin-row__count">{count} events</span>
                  <span className="origin-row__bar"><span style={{ width: `${Math.max(4, count / (topDomains[0]?.[1] ?? 1) * 100)}%` }} /></span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Recent signals */}
      <section className="panel-card monitor-panel monitor-panel--events">
        <CardHeader title="Recent signals" subtitle="Normalized events from the telemetry pipeline" icon={Network} />
        <EventTable events={scoped.slice(-12).reverse()} />
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
        <article><span>Total event duration</span><strong>{formatDuration(duration)}</strong><small>{formatTimelineOffset(range)} time range</small></article>
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

type GraphViewMode = "flame" | "tree" | "matrix" | "flow";

export function GraphPanel() {
  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const events = useTelemetryStore((state) => state.events);
  const selectedId = useSelectionStore((state) => state.eventId);
  const select = useSelectionStore((state) => state.select);
  const [viewMode, setViewMode] = useState<GraphViewMode>("tree");
  const [sessionFilter, setSessionFilter] = useState<string>();
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const selected = events.find((event) => event.id === selectedId);
  // Bridge lifecycle records have their own `inspection-*` session and are
  // emitted after the browser process finishes. They must not become the
  // default graph scope instead of the session that contains the actual work.
  const sessions = [...new Set(events
    .filter((event) => !(event.kind === "log" && typeof event.payload.inspectionState === "string"))
    .map((event) => event.sessionId))];
  const activeSession = sessionFilter ?? sessions.at(-1) ?? "all";
  const visibleNodes = useMemo(() => {
    const eventById = new Map(events.map((event) => [event.id, event]));
    return nodes.filter((node) => {
      const event = eventById.get(node.id);
    const text = `${node.label} ${node.kind} ${String(event?.payload.url ?? "")}`.toLowerCase();
    return (activeSession === "all" || event?.sessionId === activeSession) && (kindFilter === "all" || node.kind === kindFilter) && (statusFilter === "all" || node.status === statusFilter) && (!query || text.includes(query.toLowerCase()));
    }).slice(-300);
  }, [activeSession, events, kindFilter, nodes, query, statusFilter]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [edges, visibleIds]);
  const parentEdges = visibleEdges.filter((edge) => edge.relation !== "sequence").length;
  const errorNodes = visibleNodes.filter((n) => n.status === "error").length;
  const warningNodes = visibleNodes.filter((n) => n.status === "warning").length;
  const maxDepth = graphDepth(visibleNodes.map((n) => n.id), visibleEdges);
  const orphanNodes = visibleNodes.filter((n) => !visibleEdges.some((e) => e.source === n.id || e.target === n.id));

  const VIEW_TABS: { id: GraphViewMode; label: string; icon: typeof Zap }[] = [
    { id: "tree", label: "Causal Tree", icon: List },
    { id: "flame", label: "Causal Flame", icon: Zap },
    { id: "matrix", label: "Dependency Matrix", icon: Grid3x3 },
    { id: "flow", label: "Timeline by owner", icon: Waypoints },
  ];

  return (
    <PanelFrame
      eyebrow="Execution correlation"
      title="Causal execution graph"
      description="Only Core-emitted parent/child identities are shown as causal links. Chronology remains available in the Timeline."
      actions={<span className="graph-mode-note">Edges require explicit correlation IDs</span>}
    >
      <div className="graph-summary">
        <Metric label="Visible nodes" value={formatNumber(visibleNodes.length)} delta="last graph window" icon={GitBranch} />
        <Metric label="Causal links" value={formatNumber(parentEdges)} delta="explicit parent identities only" icon={Share2} />
        <Metric label="Max depth" value={visibleNodes.length ? String(maxDepth) : "—"} delta="derived from parent chain" icon={Activity} />
        <Metric label="Warnings" value={formatNumber(warningNodes)} delta={`${errorNodes} errors`} icon={AlertTriangle} />
      </div>

      <div className="graph-view-bar">
        <div className="graph-view-tabs">
          {VIEW_TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={viewMode === id ? "active" : ""} onClick={() => setViewMode(id)}>
              <Icon size={12} />{label}
            </button>
          ))}
        </div>
        <div className="graph-filters graph-filters--inline">
          <label><span>Search</span><input className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Event, URL or subsystem…" /></label>
          <label><span>Session</span><select className="select-control" value={activeSession} onChange={(e) => setSessionFilter(e.target.value)}><option value="all">All sessions</option>{sessions.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label><span>Kind</span><select className="select-control" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}><option value="all">All kinds</option>{[...new Set(nodes.map((n) => n.kind))].map((k) => <option key={k}>{k}</option>)}</select></label>
          <label><span>Status</span><select className="select-control" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="ok">OK</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
          <button onClick={() => { setQuery(""); setSessionFilter(undefined); setKindFilter("all"); setStatusFilter("all"); }}><X size={11} />Reset</button>
        </div>
      </div>

      <div className="graph-workspace">
        <div className="graph-workspace__main">
          <div className="graph-mode-context">
            {viewMode === "tree" && <><strong>Causal Tree</strong><span>Shows only explicit parent → child links emitted by Core. Events without a parent stay as independent roots.</span></>}
            {viewMode === "flame" && <><strong>Causal Flame</strong><span>Depth is derived from explicit parent links; horizontal position is chronological context, not a causal link.</span></>}
            {viewMode === "matrix" && <><strong>Dependency Matrix</strong><span>Counts explicit causal links between observed subsystems.</span></>}
            {viewMode === "flow" && <><strong>Timeline by owner</strong><span>Events are arranged by process/thread or network connection and time. No edges are inferred from their order.</span></>}
          </div>
          {viewMode === "flame" && (
            visibleNodes.length
              ? <FlameChart nodes={visibleNodes} edges={visibleEdges} events={events} selectedId={selectedId} onSelect={select} />
              : <GraphEmptyNew label="Causal Flame" description="Explicit parent/child links determine depth; timestamp provides context only. Run the inspector to capture telemetry." />
          )}
          {viewMode === "tree" && (
            visibleNodes.length
              ? <CausalTree nodes={visibleNodes} edges={visibleEdges} events={events} selectedId={selectedId} onSelect={select} />
              : <GraphEmptyNew label="Causal Tree" description="Parent/child relationships form a collapsible execution tree. Run the inspector to capture telemetry." />
          )}
          {viewMode === "matrix" && (
            visibleNodes.length
              ? <DependencyMatrix nodes={visibleNodes} edges={visibleEdges} events={events} />
              : <GraphEmptyNew label="Dependency Matrix" description="Subsystem interaction heatmap. Run the inspector to capture telemetry." />
          )}
          {viewMode === "flow" && (
            visibleNodes.length
              ? <ExecutionGraph mode="timeline" nodeIds={visibleIds} selectedId={selectedId} />
              : <GraphEmptyNew label="Timeline by owner" description="Chronological ownership view. It does not infer causal links. Run the inspector to capture telemetry." />
          )}
        </div>

        <aside className="graph-workspace__side">
          <section className="panel-card">
            <CardHeader title="Selected node" subtitle={selected ? `#${selected.sequence} · ${selected.kind}` : "Click any node"} icon={CircleDot} />
            {selected ? <GraphEventDetails event={selected} /> : <div className="empty-row">No node selected.</div>}
          </section>
          <section className="panel-card">
            <CardHeader title="Causal signal quality" subtitle="What the core currently emits" icon={Database} />
            <div className="graph-quality">
              <QualityRow label="Node identity" value={visibleNodes.length ? "Available" : "Waiting"} ok={visibleNodes.length > 0} />
              <QualityRow label="Parent links" value={parentEdges ? `${parentEdges} explicit` : "Unavailable"} ok={parentEdges > 0} />
              <QualityRow label="Chronology" value={visibleNodes.length > 1 ? "Available in Timeline" : "Waiting"} ok={visibleNodes.length > 1} />
              <QualityRow label="Cross-thread" value={events.some((e) => e.payload.threadId || e.payload.threadName) ? "Available" : "Unavailable"} ok={events.some((e) => e.payload.threadId || e.payload.threadName)} />
              <QualityRow label="Call edges" value={events.some((e) => e.payload.parentCallId) ? "Available" : "Unavailable"} ok={events.some((e) => e.payload.parentCallId)} />
            </div>
          </section>
          <section className="panel-card">
            <CardHeader title="Causal roots" subtitle={`${orphanNodes.length} unlinked nodes`} icon={Network} />
            <div className="graph-roots">
              {orphanNodes.slice(-8).reverse().map((node) => <span key={node.id}><b>{node.kind}</b>{node.label}<small>{node.duration.toFixed(1)} ms</small></span>)}
              {!orphanNodes.length && <div className="empty-row">All visible nodes are linked.</div>}
            </div>
          </section>
        </aside>
      </div>
    </PanelFrame>
  );
}

/* ─── Flame Chart ─────────────────────────────────────────────────────────── */

type GraphNode = ReturnType<typeof useGraphStore.getState>["nodes"][number];
type GraphEdge = ReturnType<typeof useGraphStore.getState>["edges"][number];

function computeDepths(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const edge of edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const depths = new Map<string, number>();
  const queue: string[] = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  queue.forEach((id) => depths.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    const d = depths.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      if (!depths.has(child) || depths.get(child)! < d + 1) {
        depths.set(child, d + 1);
        queue.push(child);
      }
    }
  }
  nodes.forEach((n) => { if (!depths.has(n.id)) depths.set(n.id, 0); });
  return depths;
}

const JOURNEY_COLORS: Record<string, string> = {
  internet: "#3b8bd6",
  browser: "#42c997",
  system: "#a37bd3",
  runtime: "#d4a957",
};

function nodeJourney(event?: TelemetryEvent): string {
  if (!event) return "runtime";
  if (typeof event.payload.systemStage === "string" || event.kind === "memory") return "system";
  if (typeof event.payload.browserStage === "string" || ["dom", "javascript", "render"].includes(event.kind)) return "browser";
  if (typeof event.payload.journeyStage === "string" || ["network", "navigation"].includes(event.kind)) return "internet";
  return "runtime";
}

function FlameChart({ nodes, edges, events, selectedId, onSelect }: {
  nodes: GraphNode[]; edges: GraphEdge[]; events: TelemetryEvent[]; selectedId?: string; onSelect: (id?: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const depths = useMemo(() => computeDepths(nodes, edges), [nodes, edges]);
  const maxDepth = useMemo(() => Math.max(0, ...[...depths.values()]), [depths]);

  const timeStart = useMemo(() => Math.min(...nodes.map((n) => eventById.get(n.id)?.timestamp ?? n.duration)), [nodes, eventById]);
  const timeEnd = useMemo(() => Math.max(...nodes.map((n) => (eventById.get(n.id)?.timestamp ?? 0) + n.duration + 1)), [nodes, eventById]);
  const timeRange = Math.max(1, timeEnd - timeStart);

  const ROW_H = 28;
  const totalRows = maxDepth + 1;

  return (
    <div className="flame-chart" ref={containerRef}>
      <div className="flame-chart__legend">
        {Object.entries(JOURNEY_COLORS).map(([journey, color]) => (
          <span key={journey}><i style={{ background: color }} />{journey}</span>
        ))}
        <span className="flame-chart__legend-sep" />
        <span><i style={{ background: "#ef6f78", opacity: 0.9 }} />error</span>
        <span><i style={{ background: "#d4a957", opacity: 0.9 }} />warning</span>
      </div>
      <div className="flame-chart__ruler">
        {[0, 0.25, 0.5, 0.75, 1].map((r) => (
          <span key={r} style={{ left: `${r * 100}%` }}>{(timeRange * r).toFixed(0)} ms</span>
        ))}
      </div>
      <div className="flame-chart__grid" style={{ minHeight: `${Math.max(totalRows * ROW_H, 120)}px` }}>
        {Array.from({ length: totalRows }, (_, depth) => (
          <div key={depth} className="flame-chart__row">
            <span className="flame-chart__depth-label">d{depth}</span>
            <div className="flame-chart__track">
              {nodes
                .filter((n) => (depths.get(n.id) ?? 0) === depth)
                .map((node) => {
                  const event = eventById.get(node.id);
                  const t0 = (event?.timestamp ?? timeStart) - timeStart;
                  const dur = Math.max(node.duration, 1);
                  const left = Math.max(0, (t0 / timeRange) * 100);
                  const width = Math.max(0.3, (dur / timeRange) * 100);
                  const journey = nodeJourney(event);
                  const base = JOURNEY_COLORS[journey] ?? "#42c997";
                  const isError = node.status === "error";
                  const isWarn = node.status === "warning";
                  const bg = isError ? "#7a2831" : isWarn ? "#6b4e1a" : undefined;
                  return (
                    <button
                      key={node.id}
                      className={`flame-bar${selectedId === node.id ? " flame-bar--selected" : ""}${isError ? " flame-bar--error" : isWarn ? " flame-bar--warn" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%`, borderColor: isError ? "#ef6f78" : isWarn ? "#d4a957" : base, background: bg }}
                      title={`${node.label} · ${node.kind} · ${node.duration.toFixed(2)} ms · ${journey} · ${node.status}`}
                      onClick={() => onSelect(selectedId === node.id ? undefined : node.id)}
                    >
                      <i style={{ background: isError ? "#ef6f78" : isWarn ? "#d4a957" : base }} />
                      <span>{node.label}</span>
                      <small>{node.duration.toFixed(1)} ms</small>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Causal Tree ─────────────────────────────────────────────────────────── */

type TreeNode = { node: GraphNode; event?: TelemetryEvent; children: TreeNode[] };

function buildTree(nodes: GraphNode[], edges: GraphEdge[], eventById: Map<string, TelemetryEvent>): TreeNode[] {
  const childMap = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (!nodes.find((n) => n.id === edge.source) || !nodes.find((n) => n.id === edge.target)) continue;
    childMap.set(edge.source, [...(childMap.get(edge.source) ?? []), edge.target]);
    hasParent.add(edge.target);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const makeTree = (id: string): TreeNode => ({
    node: nodeById.get(id)!,
    event: eventById.get(id),
    children: (childMap.get(id) ?? []).map(makeTree),
  });
  return nodes.filter((n) => !hasParent.has(n.id)).map((n) => makeTree(n.id));
}

function TreeRow({ item, depth, selectedId, onSelect, collapsed, onToggle }: {
  item: TreeNode; depth: number; selectedId?: string; onSelect: (id?: string) => void;
  collapsed: Set<string>; onToggle: (id: string) => void;
}) {
  const { node, event } = item;
  const journey = nodeJourney(event);
  const color = JOURNEY_COLORS[journey] ?? "#42c997";
  const hasChildren = item.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <>
      <div
        className={`ctree-row${selectedId === node.id ? " ctree-row--selected" : ""}${node.status === "error" ? " ctree-row--error" : node.status === "warning" ? " ctree-row--warn" : ""}`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        <button className="ctree-toggle" onClick={() => hasChildren && onToggle(node.id)} aria-label="toggle">
          {hasChildren ? (isCollapsed ? "▶" : "▼") : "·"}
        </button>
        <i style={{ background: color }} />
        <button className="ctree-label" onClick={() => onSelect(selectedId === node.id ? undefined : node.id)}>
          <b>{node.kind}</b>
          <span>{node.label}</span>
        </button>
        <span className="ctree-duration">{node.duration.toFixed(2)} ms</span>
        {node.status !== "ok" && <span className={`ctree-status ctree-status--${node.status}`}>{node.status}</span>}
        {hasChildren && <span className="ctree-children-count">{item.children.length}</span>}
      </div>
      {!isCollapsed && item.children.map((child) => (
        <TreeRow key={child.node.id} item={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} />
      ))}
    </>
  );
}

function CausalTree({ nodes, edges, events, selectedId, onSelect }: {
  nodes: GraphNode[]; edges: GraphEdge[]; events: TelemetryEvent[]; selectedId?: string; onSelect: (id?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const tree = useMemo(() => buildTree(nodes, edges, eventById), [nodes, edges, eventById]);
  const toggle = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const collapseAll = () => setCollapsed(new Set(nodes.map((n) => n.id)));
  const expandAll = () => setCollapsed(new Set());
  return (
    <div className="ctree">
      <div className="ctree-toolbar">
        <span><List size={11} />{nodes.length} nodes · {edges.length} edges · {tree.length} roots</span>
        <span>
          <button onClick={expandAll}>Expand all</button>
          <button onClick={collapseAll}>Collapse all</button>
        </span>
      </div>
      <div className="ctree-body">
        {tree.map((item) => (
          <TreeRow key={item.node.id} item={item} depth={0} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}

/* ─── Dependency Matrix ───────────────────────────────────────────────────── */

function DependencyMatrix({ nodes, edges, events }: {
  nodes: GraphNode[]; edges: GraphEdge[]; events: TelemetryEvent[];
}) {
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const subsystemKey = useCallback((id: string, fallback: string) => {
    const event = eventById.get(id);
    return String(event?.payload.processName ?? event?.payload.browserStage ?? event?.payload.systemStage ?? event?.payload.journeyStage ?? fallback);
  }, [eventById]);
  const nodeGroup = useMemo(() => new Map(nodes.map((n) => [n.id, subsystemKey(n.id, n.kind)])), [nodes, subsystemKey]);
  const systems = useMemo(() => [...new Set([...nodeGroup.values()])].sort(), [nodeGroup]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const edge of edges) {
      const src = nodeGroup.get(edge.source);
      const tgt = nodeGroup.get(edge.target);
      if (!src || !tgt) continue;
      const key = `${src}→${tgt}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [edges, nodeGroup]);

  const nodesBySystem = useMemo(() => {
    const m = new Map<string, GraphNode[]>();
    for (const [id, sys] of nodeGroup) {
      const node = nodes.find((n) => n.id === id);
      if (node) m.set(sys, [...(m.get(sys) ?? []), node]);
    }
    return m;
  }, [nodes, nodeGroup]);

  const maxCount = useMemo(() => Math.max(1, ...[...counts.values()]), [counts]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);

  return (
    <div className="dep-matrix">
      <div className="dep-matrix__container">
        <div className="dep-matrix__grid" style={{ gridTemplateColumns: `120px repeat(${systems.length}, 1fr)` }}>
          {/* header row */}
          <div className="dep-matrix__corner"><span>FROM \ TO</span></div>
          {systems.map((sys) => <div key={sys} className="dep-matrix__col-header" title={sys}><span>{sys}</span></div>)}
          {/* data rows */}
          {systems.map((rowSys) => (
            <>
              <div key={`row-${rowSys}`} className="dep-matrix__row-header" title={rowSys}>
                <span>{rowSys}</span>
                <small>{nodesBySystem.get(rowSys)?.length ?? 0} nodes</small>
              </div>
              {systems.map((colSys) => {
                const key = `${rowSys}→${colSys}`;
                const count = counts.get(key) ?? 0;
                const intensity = count / maxCount;
                const isSelf = rowSys === colSys;
                const isSelected = selectedCell === key;
                const isHovered = hovered === key;
                return (
                  <button
                    key={`${rowSys}-${colSys}`}
                    className={`dep-matrix__cell${isSelf ? " dep-matrix__cell--self" : ""}${count > 0 ? " dep-matrix__cell--active" : ""}${isSelected ? " dep-matrix__cell--selected" : ""}${isHovered ? " dep-matrix__cell--hovered" : ""}`}
                    style={count > 0 && !isSelf ? { background: `rgba(66,201,151,${0.06 + intensity * 0.55})`, borderColor: `rgba(66,201,151,${0.1 + intensity * 0.5})` } : undefined}
                    title={count > 0 ? `${rowSys} → ${colSys}: ${count} connection${count !== 1 ? "s" : ""}` : `${rowSys} → ${colSys}: no connections`}
                    onMouseEnter={() => setHovered(key)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => setSelectedCell(isSelected ? null : key)}
                  >
                    {count > 0 && <span>{count}</span>}
                  </button>
                );
              })}
            </>
          ))}
        </div>
      </div>
      <div className="dep-matrix__legend">
        <span>Cells show number of causal edges between subsystems. Intensity = relative connection density.</span>
        {selectedCell && (
          <span className="dep-matrix__selection">
            <strong>{selectedCell}</strong> · {counts.get(selectedCell) ?? 0} connections
          </span>
        )}
      </div>
    </div>
  );
}

function GraphEmptyNew({ label, description }: { label: string; description: string }) {
  return (
    <div className="graph-empty">
      <strong>Waiting for telemetry — {label}</strong>
      <span>{description}</span>
    </div>
  );
}

export function NetworkPanel() {
  const events = useTelemetryStore((state) => state.events);
  const filter = useNetworkStore((state) => state.filter);
  const setFilter = useNetworkStore((state) => state.setFilter);
  const [status, setStatus] = useState("all");
  const [execution, setExecution] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [detailTab, setDetailTab] = useState<"overview" | "timing" | "headers" | "payload" | "response" | "events">("overview");
  const networkEvents = useMemo(() => events.filter((event) => event.kind === "network"), [events]);
  const requests = useMemo(() => aggregateNetworkRequests(networkEvents), [networkEvents]);
  const executions = useMemo(() => [...new Set(requests.map((request) => request.executionId))], [requests]);
  useEffect(() => {
    const requestedExecution = new URLSearchParams(window.location.search).get("execution");
    if (requestedExecution) setExecution(requestedExecution);
  }, []);
  const visible = useMemo(() => requests.filter((request) => {
    const text = `${request.url} ${request.method} ${request.protocol} ${request.remoteIp} ${request.statusCode ?? ""} ${request.terminalStatus} ${request.executionId}`.toLowerCase();
    const typeMatch = typeFilter === "all" || (() => {
      const resourceType = (request.resourceType ?? "").toLowerCase();
      const ct = (request.contentType ?? "").toLowerCase();
      if (typeFilter === "xhr") return resourceType === "xhr" || resourceType === "fetch" || ct.includes("json") || ct.includes("xml") || request.method !== "GET";
      if (typeFilter === "script") return resourceType === "script" || resourceType === "worker" || ct.includes("javascript") || ct.includes("script") || request.url.endsWith(".js");
      if (typeFilter === "doc") return resourceType === "document" || ct.includes("html") || ct.includes("text/plain");
      if (typeFilter === "css") return resourceType === "stylesheet" || ct.includes("css");
      if (typeFilter === "media") return ["image", "media", "font"].includes(resourceType) || ct.includes("image") || ct.includes("video") || ct.includes("audio") || ct.includes("font");
      return true;
    })();
    return (!filter || text.includes(filter.toLowerCase())) && (status === "all" || request.terminalStatus === status) && (execution === "all" || request.executionId === execution) && typeMatch;
  }), [execution, filter, requests, status, typeFilter]);
  const selected = visible.find((request) => request.key === selectedKey) ?? visible[0];
  const errorCount = requests.filter((request) => request.terminalStatus === "error").length;
  const bytes = requests.reduce((sum, request) => sum + (request.responseBytes ?? 0), 0);
  const connections = new Set(requests.flatMap((request) => request.connectionId == null ? [] : [request.connectionId])).size;
  const protocols = [...new Set(requests.flatMap((request) => request.protocol === "Unavailable" ? [] : [request.protocol]))];
  const TYPE_TABS = [["all", "All"], ["xhr", "Fetch/XHR"], ["doc", "Doc"], ["script", "JS"], ["css", "CSS"], ["media", "Media"]] as const;
  return (
    <PanelFrame eyebrow="Network observability" title="Network Requests" description="Completed transfer lifecycles reconstructed from typed queue, DNS, transport, TLS, server and response events.">
      <section className="network-summary">
        <article><span>Transfers</span><strong>{requests.length.toLocaleString()}</strong><small>{visible.length} visible</small></article>
        <article><span>Failed</span><strong className={errorCount ? "status-text--error" : "status-text--ok"}>{errorCount}</strong><small>{requests.length ? `${(errorCount / requests.length * 100).toFixed(1)}% error rate` : "No transfers"}</small></article>
        <article><span>Response bytes</span><strong>{bytes ? formatBytes(bytes) : "Unavailable"}</strong><small>Observed body bytes</small></article>
        <article><span>Connections</span><strong>{connections || "Unavailable"}</strong><small>Unique connection IDs</small></article>
        <article><span>Protocols</span><strong>{protocols.join(", ") || "Unavailable"}</strong><small>Observed HTTP versions</small></article>
      </section>

      {/* Type filter bar — like Chrome DevTools */}
      <div className="network-type-bar">
        {TYPE_TABS.map(([val, label]) => (
          <button key={val} className={typeFilter === val ? "active" : ""} onClick={() => setTypeFilter(val)}>{label}</button>
        ))}
      </div>

      <section className="network-filters" aria-label="Network filters">
        <label><span>Search</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="URL, method, IP, protocol or status…" className="search-input" /></label>
        <label><span>Status</span><select className="select-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="ok">Successful</option><option value="error">Failed</option></select></label>
        <label><span>Execution</span><select className="select-control" value={execution} onChange={(event) => setExecution(event.target.value)}><option value="all">All executions</option>{executions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <button onClick={() => { setFilter(""); setStatus("all"); setExecution("all"); setTypeFilter("all"); }}><X size={13}/> Reset</button>
      </section>

      {networkEvents.length === 0 && (
        <div className="network-pending-notice">
          <Network size={16} />
          <div>
            <strong>No network events captured yet</strong>
            <span>Koko core must emit <code>kind: &quot;network&quot;</code> events with <code>journeyStage</code> (queue, dns, tcp, tls, request, server, response, received) to populate this panel. Inspect a URL to trigger a capture.</span>
          </div>
          <div className="network-pending-fields">
            <span>Required for request list</span>
            <code>url · method · httpVersion · primaryIp · connectionId · responseStatus · responseBodyBytes</code>
            <span>Required for Headers tab</span>
            <code>requestHeaders · responseHeaders · cacheControl · server · contentType</code>
            <span>Response body capture</span>
            <code>Text/JSON is captured automatically (up to 4 MiB); binary remains hidden</code>
          </div>
        </div>
      )}

      <div className="network-layout">
        <section className="network-request-list">
          <header><span>Name</span><span>Status</span><span>Protocol</span><span>Remote address</span><span>Size</span><span>Duration</span></header>
          <div>{visible.length ? visible.map((request) => <button key={request.key} className={selected?.key === request.key ? "active" : ""} onClick={() => setSelectedKey(request.key)}>
            <span><i className={`event-dot event-dot--${request.terminalStatus === "error" ? "error" : "ok"}`}/><b>{request.method} · {request.resourceType ?? "Other"}</b><strong>{requestDisplayName(request.url)}</strong><small>{request.url}</small></span>
            <span className={`status-text--${request.terminalStatus === "error" ? "error" : "ok"}`}>{request.statusCode ?? (request.terminalStatus === "error" ? "ERR" : "—")}</span>
            <code>{request.protocol}</code><code>{request.remoteIp}</code><code>{formatOptionalBytes(request.responseBytes)}</code><code>{formatDuration(request.duration)}</code>
          </button>) : <div className="network-empty"><Wifi size={20}/><strong>{requests.length ? "No transfers match the current filters" : "Waiting for network telemetry"}</strong><span>{requests.length ? "Reset filters or search for a different URL." : "Inspect a URL to capture its transfer lifecycle."}</span></div>}</div>
        </section>

        <aside className="network-detail">{selected ? <>
          <header>
            <div>
              <span>{selected.method} · {selected.resourceType ?? "Other"} · {selected.protocol}</span>
              <strong>{requestDisplayName(selected.url)}</strong>
              <small>{selected.url}</small>
            </div>
            <b className={`status-text--${selected.terminalStatus === "error" ? "error" : "ok"}`}>{selected.statusCode ?? selected.terminalStatus}</b>
          </header>
          <nav>{(["overview", "timing", "headers", "payload", "response", "events"] as const).map((tab) => <button key={tab} className={detailTab === tab ? "active" : ""} onClick={() => setDetailTab(tab)}>{tab}</button>)}</nav>
          {detailTab === "overview" && <NetworkOverview request={selected} />}
          {detailTab === "timing" && <NetworkTiming request={selected} />}
          {detailTab === "headers" && <NetworkHeaders request={selected} />}
          {detailTab === "payload" && <NetworkPayload request={selected} />}
          {detailTab === "response" && <NetworkResponse request={selected} />}
          {detailTab === "events" && <NetworkEvents request={selected} />}
        </> : <div className="network-empty"><Network size={20}/><strong>Select a transfer</strong><span>Click a request to inspect its headers, timing waterfall, payload and response.</span></div>}</aside>
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
    const execution = executionIdFor(event);
    const url = String(payload.url ?? payload.requestedUrl ?? "URL unavailable");
    const requestId = payload.requestId == null ? undefined : String(payload.requestId);
    const base = requestId ? `${execution}|request:${requestId}` : `${execution}|url:${url}`;
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
    return { key, events: ordered, sessionId: terminal.sessionId, executionId: executionIdFor(terminal), inspectionId: String(payload.inspectionId ?? "Unavailable"), url: String(payload.url ?? payload.requestedUrl ?? "Unavailable"), method: String(payload.method ?? "GET"), resourceType: payloadString(payload, "resourceType"), requestId: typeof payload.requestId === "number" ? payload.requestId : undefined, frameId: typeof payload.frameId === "number" ? payload.frameId : undefined, loaderId: typeof payload.loaderId === "number" ? payload.loaderId : undefined, protocol: String(payload.httpVersion ?? "Unavailable"), remoteIp: String(payload.primaryIp ?? "Unavailable"), connectionId: payload.connectionId == null ? undefined : String(payload.connectionId), statusCode: typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : undefined, responseBytes: latestPayloadNumber(ordered, "responseBodyBytes"), duration: ordered.reduce((sum, event) => sum + Math.max(0, event.duration), 0), terminalStatus: statusEvent || payload.terminalStatus === "error" ? "error" : "ok", connectionReused: payload.connectionReused === true, usedProxy: payload.usedProxy === true, redirectCount: typeof payload.redirectCount === "number" ? payload.redirectCount : undefined, contentType: payloadString(payload, "contentType"), contentEncoding: payloadString(payload, "contentEncoding"), cacheDecision: payloadString(payload, "cacheDecision"),
      requestHeaders: payloadString(payload, "requestHeaders"),
      responseHeaders: payloadString(payload, "responseHeaders"),
      requestBody: payloadString(payload, "requestBody") ?? payloadString(payload, "postData"),
      responseBody: payloadString(payload, "responseBody"),
      headers: { "Cache-Control": payloadString(payload, "cacheControl"), Server: payloadString(payload, "server"), Age: payloadString(payload, "age"), Via: payloadString(payload, "via"), ETag: payloadString(payload, "etag") }, failure: statusEvent ? String(statusEvent.payload.error ?? statusEvent.payload.errorMessage ?? statusEvent.payload.failureReason ?? "Network operation failed") : undefined };
  }).sort((a, b) => (b.events.at(-1)?.timestamp ?? 0) - (a.events.at(-1)?.timestamp ?? 0));
}

function NetworkOverview({ request }: { request: NetworkRequest }) { return <div className="network-detail-grid"><NetworkFact label="Request method" value={request.method}/><NetworkFact label="Response status" value={request.statusCode == null ? "Unavailable" : String(request.statusCode)}/><NetworkFact label="Remote address" value={request.remoteIp}/><NetworkFact label="Connection" value={request.connectionId ?? "Unavailable"}/><NetworkFact label="Connection reused" value={request.connectionReused ? "Yes" : "No / unavailable"}/><NetworkFact label="Proxy used" value={request.usedProxy ? "Yes" : "No"}/><NetworkFact label="Redirects" value={request.redirectCount == null ? "Unavailable" : String(request.redirectCount)}/><NetworkFact label="Cache decision" value={request.cacheDecision ?? "Unavailable"}/><NetworkFact label="Content type" value={request.contentType ?? "Unavailable"}/><NetworkFact label="Content encoding" value={request.contentEncoding ?? "Unavailable"}/><NetworkFact label="Response bytes" value={formatOptionalBytes(request.responseBytes)}/><NetworkFact label="Execution" value={request.executionId}/>{request.failure && <div className="network-failure"><AlertTriangle size={15}/><span><strong>Transfer failed</strong><small>{request.failure}</small></span></div>}</div>; }

function NetworkTiming({ request }: { request: NetworkRequest }) { const max = Math.max(...request.events.map((event) => event.duration), 1); return <div className="network-timing">{networkStageOrder.map((stage) => { const event = request.events.find((candidate) => String(candidate.payload.journeyStage ?? candidate.name) === stage); const measurement = String(event?.payload.measurement ?? "unavailable"); return <div key={stage} className={`network-timing__row network-timing__row--${event?.status ?? "missing"}`}><span>{stage}</span><div><i style={{ width: event && event.duration > 0 ? `${Math.max(2, event.duration / max * 100)}%` : "2%" }}/></div><strong>{!event ? "Not emitted" : measurement === "boundary" ? "Boundary" : measurement === "reused" ? "Reused" : event.duration > 0 ? `${event.duration.toFixed(3)} ms` : measurement}</strong></div>; })}<footer><span>Total measured stage duration</span><strong>{formatDuration(request.duration)}</strong></footer></div>; }

function NetworkHeaders({ request }: { request: NetworkRequest }) {
  const captured = Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const parseHeaderString = (raw: string) => raw.replaceAll("\\n", "\n").split("\n").map((line) => { const i = line.indexOf(":"); return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string] : null; }).filter(Boolean) as [string, string][];
  const reqHeaders = request.requestHeaders ? parseHeaderString(request.requestHeaders) : null;
  const resHeaders = request.responseHeaders ? parseHeaderString(request.responseHeaders) : null;
  return (
    <div className="network-headers">
      <section>
        <header>General</header>
        <div><code>Request URL</code><span>{request.url}</span></div>
        <div><code>Request Method</code><span>{request.method}</span></div>
        {request.statusCode && <div><code>Status Code</code><span>{request.statusCode}</span></div>}
        {request.remoteIp !== "Unavailable" && <div><code>Remote Address</code><span>{request.remoteIp}</span></div>}
      </section>
      <section>
        <header>Response Headers {!resHeaders && <small>(not captured — core needs to emit responseHeaders)</small>}</header>
        {resHeaders ? resHeaders.map(([name, value]) => <div key={name}><code>{name}</code><span>{value}</span></div>) :
          captured.length ? captured.map(([name, value]) => <div key={name}><code>{name}</code><span>{value}</span></div>) :
          <p>No response headers captured. Core must emit <code>responseHeaders</code> as a newline-separated string.</p>}
      </section>
      <section>
        <header>Request Headers {!reqHeaders && <small>(not captured — core needs to emit requestHeaders)</small>}</header>
        {reqHeaders ? reqHeaders.map(([name, value]) => <div key={name}><code>{name}</code><span>{value}</span></div>) :
          <p>No request headers captured. Core must emit <code>requestHeaders</code> as a newline-separated string.</p>}
      </section>
      <aside><strong>Capture boundary</strong><p>Only typed metadata emitted by Koko Core is shown. Koko does not reconstruct or invent header values not present in telemetry.</p></aside>
    </div>
  );
}

function NetworkPayload({ request }: { request: NetworkRequest }) {
  const body = request.requestBody;
  let isJson = false;
  if (body) { try { JSON.parse(body); isJson = true; } catch { /* not JSON */ } }
  return (
    <div className="network-payload">
      {body ? (
        <>
          <div className="network-payload__meta">
            <span>Request body · {new TextEncoder().encode(body).byteLength} bytes</span>
            {isJson && <span className="network-payload__type">JSON</span>}
          </div>
          <pre className="network-payload__body">{isJson ? JSON.stringify(JSON.parse(body), null, 2) : body}</pre>
        </>
      ) : (
        <div className="network-empty">
          <Database size={18} />
          <strong>No payload captured</strong>
          <span>For GET requests there is no body. For POST/PUT, core must emit <code>requestBody</code> or <code>postData</code> in the network event payload.</span>
        </div>
      )}
    </div>
  );
}

function NetworkResponse({ request }: { request: NetworkRequest }) {
  const body = request.responseBody;
  let isJson = false;
  if (body) { try { JSON.parse(body); isJson = true; } catch { /* not JSON */ } }
  const isText = body && (request.contentType?.includes("text") || request.contentType?.includes("json") || request.contentType?.includes("xml"));
  return (
    <div className="network-payload">
      {body ? (
        <>
          <div className="network-payload__meta">
            <span>Response body · {body.length} chars · {request.contentType ?? "unknown type"}</span>
            {isJson && <span className="network-payload__type">JSON</span>}
            {isText && !isJson && <span className="network-payload__type">text</span>}
          </div>
          <pre className="network-payload__body">{isJson ? JSON.stringify(JSON.parse(body), null, 2) : body}</pre>
        </>
      ) : (
        <div className="network-empty">
          <Database size={18} />
          <strong>No response body captured</strong>
          <span>This response has no displayable text body. Empty and binary responses remain hidden; text/JSON is captured automatically up to 4 MiB.</span>
        </div>
      )}
    </div>
  );
}

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
function formatDuration(value: number) { return value > 0 ? `${value.toFixed(1)} ms` : "—"; }
function formatTimelineOffset(value: number) { if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`; if (value >= 1000) return `${(value / 1000).toFixed(2)} s`; if (value >= 1) return `${value.toFixed(1)} ms`; return `${(value * 1000).toFixed(0)} µs`; }
function classifyJourney(event: ReturnType<typeof useTelemetryStore.getState>["events"][number]) {
  if (typeof event.payload.browserStage === "string" || ["dom", "javascript", "render"].includes(event.kind)) return "browser";
  if (typeof event.payload.journeyStage === "string" || event.kind === "network" || event.kind === "navigation") return "internet";
  if (typeof event.payload.systemStage === "string" || event.kind === "memory") return "system";
  return "runtime";
}
function belongsToJourney(event: TelemetryEvent, journey: "internet" | "browser" | "system") {
  if (journey === "browser") return typeof event.payload.browserStage === "string" || ["dom", "javascript", "render"].includes(event.kind);
  if (journey === "internet") return typeof event.payload.journeyStage === "string" || event.kind === "network" || event.kind === "navigation";
  return typeof event.payload.systemStage === "string" || event.kind === "memory";
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
