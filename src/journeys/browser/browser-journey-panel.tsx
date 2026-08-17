"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ChevronLeft, ChevronRight, CircleDot, Cpu, Pause, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { browserJourneyEdges, browserJourneyNodes } from "./data";
import { useBrowserJourneyStore } from "./store";
import type { BrowserJourneyNode } from "./types";
import { browserCalls } from "./trace-model";
import { layoutBrowserFlow, type BrowserFlowData } from "./layout";

function BrowserCard({ data }: NodeProps) {
  const item = data as unknown as BrowserFlowData;
  const expanded = item.expanded;
  const statusLabel = item.status === "complete" ? (item.duration > 0 ? "Measured" : "Complete") : item.status === "active" ? "Active" : item.status === "unavailable" ? "Unavailable" : "Awaiting";
  return <article className={`journey-node journey-node--${item.status}`}>
    {item.incomingHandles.map((id, index) => <Handle key={id} id={id} type="target" position={Position.Left} style={{ top: `${(index + 1) * 100 / (item.incomingHandles.length + 1)}%` }}/>) }
    <button className="journey-node__summary" onClick={(event) => { event.stopPropagation(); item.onToggle(item.id); }} aria-expanded={expanded}>
      <span className="journey-node__icon">{item.type.slice(0, 3).toUpperCase()}</span>
      <span><strong>{item.title}</strong><small>{item.description}</small><small>{item.process} · {item.thread} thread</small>{typeof item.metadata.scriptUrl === "string" && <small className="browser-script-source">{item.metadata.scriptKind} · {item.metadata.scriptUrl}</small>}</span>
      <span className="journey-node__duration" title={statusLabel}>{item.duration ? `${item.duration.toFixed(3)} ms` : statusLabel}</span>
      <ChevronRight size={14} className={expanded ? "rotate-90" : ""} />
    </button>
    {expanded && <div className="journey-node__details browser-node-details__inline">
      <div className="journey-kv">
        <span><small>Status</small><code>{statusLabel}</code></span>
        <span><small>Owner</small><code>{item.process} / {item.thread}</code></span>
        {Object.entries(item.metadata).map(([key, value]) => <span key={key}><small>{key}</small><code>{String(value)}</code></span>)}
      </div>
      <h4>What is this?</h4><p>{item.description}</p>
      {item.status === "unavailable" && <><h4>Why unavailable?</h4><p>Core has not emitted a typed signal for this browser stage yet.</p></>}
      {item.metadata.lastEvent && <pre>{JSON.stringify(item.metadata, null, 2)}</pre>}
    </div>}
    {item.outgoingHandles.map((id, index) => <Handle key={id} id={id} type="source" position={Position.Right} style={{ top: `${(index + 1) * 100 / (item.outgoingHandles.length + 1)}%` }}/>) }
  </article>;
}
function StageGroup({ data }: NodeProps) { const stage = data as { label: string; stage: string }; return <section className={`browser-stage browser-stage--${stage.stage}`}><span>{stage.label}</span></section>; }
const nodeTypes = { browser: BrowserCard, stageGroup: StageGroup };

export function BrowserJourneyPanel() {
  const pathname = usePathname();
  const view = pathname.split("/")[2] || "journey";
  const migratedView = ({ threads: "thread-explorer", memory: "memory-explorer", processes: "process-explorer" } as const)[view as "threads" | "memory" | "processes"];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const { nodes: live, trace, cursor, playing, speed, revealed, phase, blockedReason, play, seek, setSpeed, reveal } = useBrowserJourneyStore();
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const state = useBrowserJourneyStore.getState();
      if (state.cursor >= browserJourneyNodes.length - 1) state.play(false); else state.seek(state.cursor + 1);
    }, 850 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed]);
  useEffect(() => {
    if ((phase !== "running" && phase !== "complete") || revealed >= live.length) return;
    const timer = window.setTimeout(reveal, 320);
    return () => window.clearTimeout(timer);
  }, [phase, revealed, live.length, reveal]);
  useEffect(() => {
    if (phase === "blocked" || phase === "waiting" || phase === "idle") setSelectedId(null);
  }, [phase]);
  const toggleExpanded = useCallback((id: string) => setExpandedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const visibleItems = useMemo(() => live.slice(0, revealed).map((item, index) => ({ ...item, status: playing ? (index < cursor ? "complete" as const : index === cursor ? "active" as const : "pending" as const) : item.status })), [live, revealed, cursor, playing]);
  const styledEdges = useMemo<Edge[]>(() => browserJourneyEdges.map((edge) => { const sourceIndex = live.findIndex((item) => item.id === edge.source); const traversed = sourceIndex >= 0 && sourceIndex < cursor; return { ...edge, animated: playing && traversed, markerEnd: { type: MarkerType.ArrowClosed, color: traversed ? "#55d57d" : "#34404b" }, style: { stroke: traversed ? "#55d57d" : "#34404b" } }; }), [live, cursor, playing]);
  useEffect(() => {
    let cancelled = false;
    void layoutBrowserFlow(visibleItems, styledEdges, expandedIds, toggleExpanded).then((next) => { if (!cancelled) setFlow(next); });
    return () => { cancelled = true; };
  }, [visibleItems, styledEdges, expandedIds, toggleExpanded]);
  const total = live.reduce((sum, item) => sum + item.duration, 0);
  const views = ["journey", "timeline", "dependencies", "frames", "resources", "event-loop", "javascript"];
  const viewLabels: Record<string, string> = { journey: "Journey", timeline: "Browser timeline", dependencies: "Dependencies", frames: "Frames", resources: "Resources", "event-loop": "Event loop", javascript: "JavaScript" };
  return <main className="internet-journey browser-journey">
    <header className="journey-header"><div><span><Cpu size={14}/> Renderer pipeline</span><h1>Browser Journey</h1><p>From HTTP response bytes to the frame presented on screen.</p></div><Link href="/internet-journey">← Internet Journey</Link></header>
    <nav className="browser-view-tabs">{views.map((item) => <Link key={item} className={view === item ? "active" : ""} href={item === "journey" ? "/browser-journey" : `/browser-journey/${item}`}>{viewLabels[item]}</Link>)}<Link href="/system-journey">System Journey →</Link></nav>
    <div className="journey-toolbar"><div className="journey-stage-key">Network boundary → Parse → Execute → Render → Composite</div><div className="journey-playback">
      <button onClick={() => seek(cursor - 1)}><ChevronLeft size={14}/></button><button onClick={() => play(!playing)}>{playing ? <Pause size={14}/> : <Play size={14}/>} {playing ? "Pause" : "Play"}</button><button onClick={() => seek(cursor + 1)}><ChevronRight size={14}/></button>
      {([.5, 1, 2] as const).map((value) => <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>×{value}</button>)}
    </div></div>
    {view === "journey" && phase === "blocked" && <section className="journey-empty journey-empty--error"><Cpu size={22}/><strong>Browser Journey was not started</strong><span>{blockedReason}</span><Link href="/internet-journey">Inspect the network failure →</Link></section>}
    {view === "journey" && (phase === "idle" || phase === "waiting") && <section className="journey-empty"><Cpu size={22}/><strong>Awaiting an HTTP response</strong><span>Browser processing begins only after Internet Journey reaches “Browser receives response”.</span></section>}
    {view === "journey" && (phase === "running" || phase === "complete") && <section className="journey-graph browser-journey__graph"><ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => { if (node.type === "browser") setSelectedId(node.id); }} fitView fitViewOptions={{ padding: .12 }} minZoom={.2} maxZoom={1.4} nodesDraggable={false} elevateEdgesOnSelect><Background color="#23303b" gap={20}/><Controls/></ReactFlow></section>}
    {migratedView && <section className="journey-empty"><Cpu size={22}/><strong>This view belongs to System Journey</strong><span>Process, thread and memory telemetry describe runtime and operating-system ownership outside the response-to-frame browser pipeline.</span><Link href={`/system-journey#${migratedView}`}>Open {view} telemetry →</Link></section>}
    {view === "journey" && selectedId && <NodeDetails item={live.find((item) => item.id === selectedId)} onClose={() => setSelectedId(null)}/>} 
    {view === "timeline" && <TraceTimeline trace={trace}/>} {view === "dependencies" && <DependencyView trace={trace}/>} {view === "resources" && <ResourceView trace={trace}/>} {view === "frames" && <FrameView trace={trace}/>} {view === "event-loop" && <EventLoopView trace={trace}/>} {view === "javascript" && <CallGraphView trace={trace}/>}
    {view === "journey" && (phase === "running" || phase === "complete") && <section className="journey-waterfall"><header><strong>Browser processing waterfall</strong><span>Total measured <b>{total ? `${total.toFixed(3)} ms` : "Awaiting Koko events"}</b></span></header><div>{live.filter((item) => item.duration > 0).map((item) => <span key={item.id}><small>{item.title}</small><i style={{ width: `${Math.max(2, item.duration / Math.max(total, 1) * 100)}%` }}/><b>{item.duration.toFixed(2)} ms</b></span>)}</div></section>}
    {phase === "complete" && <footer className="journey-boundary"><strong>Frame presented.</strong><span>Browser Journey ends here. Every unavailable stage remains explicit until Koko Core emits supporting telemetry.</span><button>Open Rendering Explorer →</button></footer>}
  </main>;
}

type Trace = ReturnType<typeof useBrowserJourneyStore.getState>["trace"];
function Empty({ children }: { children: string }) { return <div className="trace-empty">{children}</div>; }
function NodeDetails({ item, onClose }: { item?: BrowserJourneyNode; onClose: () => void }) {
  if (!item) return null;
  const measured = item.status === "complete" || item.status === "active";
  const what = `This stage belongs to the ${item.process} process and ${item.thread} thread. Its duration is measured from Koko telemetry when available.`;
  const unavailableReason = item.status === "unavailable" ? "Core has not emitted a typed signal for this browser stage yet." : "No event has reached this stage in the current inspection.";
  return <aside className="trace-view browser-node-details">
    <header><div><small className="trace-kicker">BROWSER STAGE</small><strong>{item.title}</strong></div><button onClick={onClose}>Close</button></header>
    <p>{what}</p><p><strong>What is this?</strong> {item.description}</p>
    <div className="trace-cards">
      <article><span>Status</span><b>{item.status === "complete" ? (item.duration > 0 ? "Measured" : "Complete boundary") : item.status === "active" ? "Active" : item.status === "unavailable" ? "Unavailable" : "Awaiting"}</b></article>
      <article><span>Duration</span><b>{measured ? `${item.duration.toFixed(3)} ms` : "—"}</b></article>
      <article><span>Owner</span><b>{item.process} / {item.thread}</b></article>
    </div>
    {!measured && <p className="trace-empty browser-node-details__hint">{unavailableReason}</p>}
    <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
  </aside>;
}
function TraceTimeline({ trace }: { trace: Trace }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState("all");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [stage, setStage] = useState("all");
  const browserSpans = useMemo(() => trace.spans.filter(isBrowserTimelineSpan), [trace.spans]);
  const threads = useMemo(() => [...new Set(browserSpans.map((span) => span.thread))], [browserSpans]);
  const kinds = useMemo(() => [...new Set(browserSpans.map((span) => span.event.kind))], [browserSpans]);
  const stages = useMemo(() => [...new Set(browserSpans.map((span) => span.stage))], [browserSpans]);
  const filtered = useMemo(() => browserSpans.filter((span) => {
    const text = `${span.event.name} ${span.stage} ${span.thread} ${span.process} ${String(span.event.payload.url ?? "")}`.toLowerCase();
    return (thread === "all" || span.thread === thread) && (kind === "all" || span.event.kind === kind) && (status === "all" || span.event.status === status) && (stage === "all" || span.stage === stage) && (!query || text.includes(query.toLowerCase()));
  }), [browserSpans, kind, query, stage, status, thread]);
  const lanes = [...new Set(filtered.map((span) => span.thread))];
  const start = Math.min(...filtered.map((span) => span.start), Date.now());
  const end = Math.max(...filtered.map((span) => span.start + span.duration), start + 1);
  const range = Math.max(end - start, 1);
  const total = filtered.reduce((sum, span) => sum + span.duration, 0);
  const errors = filtered.filter((span) => span.event.status === "error").length;
  const warnings = filtered.filter((span) => span.event.status === "warning").length;
  const selected = browserSpans.find((span) => span.id === selectedId);
  const reset = () => { setQuery(""); setThread("all"); setKind("all"); setStatus("all"); setStage("all"); };
  return <section className="trace-view browser-global-timeline"><header><strong>Execution timeline</strong><span>{filtered.length} of {browserSpans.length} browser spans</span></header>
    <section className="global-timeline-summary">
      <article><span>Visible spans</span><strong>{filtered.length.toLocaleString()}</strong><small>of {browserSpans.length.toLocaleString()} in this browser trace</small></article>
      <article><span>Measured duration</span><strong>{formatTimelineDuration(total)}</strong><small>{formatTimelineDuration(range)} time range</small></article>
      <article><span>Errors</span><strong className={errors ? "status-text--error" : "status-text--ok"}>{errors}</strong><small>{warnings} warnings</small></article>
      <article><span>Threads</span><strong>{lanes.length}</strong><small>{kinds.length} browser subsystems</small></article>
    </section>
    <section className="global-timeline-filters" aria-label="Browser timeline filters">
      <label><span>Search</span><input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Event, URL, stage or owner…"/></label>
      <label><span>Thread</span><select className="select-control" value={thread} onChange={(event) => setThread(event.target.value)}><option value="all">All threads</option>{threads.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Kind</span><select className="select-control" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{kinds.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Status</span><select className="select-control" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="ok">OK</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
      <label><span>Stage</span><select className="select-control" value={stage} onChange={(event) => setStage(event.target.value)}><option value="all">All stages</option>{stages.map((value) => <option key={value}>{value}</option>)}</select></label>
      <button type="button" onClick={reset}>Reset</button>
    </section>
    <div className="timeline-shell browser-trace-shell">
      <div className="timeline-ruler">{[0, .2, .4, .6, .8, 1].map((ratio) => <span key={ratio}>{formatTimelineDuration(range * ratio)}</span>)}</div>
      <div className="timeline-lanes">{lanes.map((lane) => {
        const laneSpans = layoutBrowserTimelineLane(filtered.filter((span) => span.thread === lane), start, range);
        const rows = Math.max(...laneSpans.map((span) => span.row), 0) + 1;
        return <div className="timeline-lane browser-trace-lane" key={lane}><span className="timeline-label">{lane}<small>{laneSpans.length}</small></span><div className="timeline-track browser-trace-track" style={{ height: `${Math.max(38, 10 + rows * 20)}px` }}>{laneSpans.map((span) => <button type="button" key={span.id} onClick={() => setSelectedId(span.id)} title={`${span.event.name} · ${span.duration.toFixed(3)} ms · ${span.stage}`} aria-label={`${span.event.name}, ${span.duration.toFixed(3)} milliseconds, ${span.stage}`} aria-pressed={selectedId === span.id} className={`browser-trace-span browser-trace-span--${span.event.kind} browser-trace-span--${span.event.status} ${selectedId === span.id ? "browser-trace-span--selected" : ""}`} style={{ left: `${span.left}%`, top: `${5 + span.row * 20}px`, width: `${span.width}%` }}>{!span.compact && <span>{span.event.name}</span>}</button>)}</div></div>;
      })}{!filtered.length && <div className="empty-row">No browser spans match the current filters.</div>}</div>
    </div>
    <div className="global-timeline-layout">
      <section className="panel-card global-timeline-events"><header><strong>Chronological browser events</strong><span>{filtered.length} matching spans</span></header><div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Signal</span><span>Stage / kind</span><span>Time</span><span>Duration</span><span>Status</span></div>{filtered.length ? [...filtered].reverse().slice(0, 250).map((span) => <button type="button" className={`event-row global-event-row ${selectedId === span.id ? "global-event-row--selected" : ""}`} role="row" key={span.id} onClick={() => setSelectedId(span.id)}><span><i className={`event-dot event-dot--${span.event.status}`}/>{span.event.name}</span><span><b>{span.stage}</b><small>{span.event.kind} · {span.thread}</small></span><span className="mono">+{formatTimelineDuration(span.start - start)}</span><span className="mono">{span.duration.toFixed(3)} ms</span><span className={`status-text status-text--${span.event.status}`}>{span.event.status}</span></button>) : <div className="empty-row">No matching browser events.</div>}</div></section>
      <aside className="panel-card global-timeline-detail">{selected ? <BrowserTimelineDetails span={selected} onClose={() => setSelectedId(null)}/> : <div className="global-timeline-detail__empty"><CircleDot size={20}/><strong>Select an event</strong><span>Inspect timing, browser stage, process ownership and the complete typed payload.</span></div>}</aside>
    </div>
  </section>;
}

type BrowserTimelineSpan = Trace["spans"][number];
type PositionedBrowserTimelineSpan = BrowserTimelineSpan & { left: number; width: number; row: number; compact: boolean };

function isBrowserTimelineSpan(span: BrowserTimelineSpan) {
  const payload = span.event.payload;
  if (typeof payload.browserStage === "string") return true;
  if (["dom", "javascript", "scheduler", "render"].includes(span.event.kind)) return true;
  return span.event.kind === "network" && ["response", "received"].includes(String(payload.journeyStage ?? ""));
}

function layoutBrowserTimelineLane(spans: BrowserTimelineSpan[], start: number, range: number): PositionedBrowserTimelineSpan[] {
  const rowEnds: number[] = [];
  return [...spans].sort((a, b) => a.start - b.start || b.duration - a.duration).map((span) => {
    const left = Math.max(0, Math.min(99.6, (span.start - start) / range * 100));
    const width = Math.max(.45, Math.min(100 - left, span.duration / range * 100));
    let row = rowEnds.findIndex((end) => end + .15 <= left);
    if (row < 0) {
      if (rowEnds.length < 4) { row = rowEnds.length; rowEnds.push(0); }
      else row = rowEnds.reduce((best, end, index) => end < rowEnds[best] ? index : best, 0);
    }
    rowEnds[row] = Math.max(rowEnds[row], left + width);
    return { ...span, left, width, row, compact: width < 5.5 };
  });
}

function formatTimelineDuration(duration: number) {
  if (duration >= 60_000) return `${(duration / 60_000).toFixed(2)} min`;
  if (duration >= 1_000) return `${(duration / 1_000).toFixed(2)} s`;
  if (duration >= 1) return `${duration.toFixed(1)} ms`;
  return `${(duration * 1_000).toFixed(0)} µs`;
}

function BrowserTimelineDetails({ span, onClose }: { span: Trace["spans"][number]; onClose: () => void }) {
  const event = span.event;
  return <div className="timeline-event-detail"><header><div><small>browser · {event.kind}</small><strong>{event.name}</strong></div><button type="button" onClick={onClose}>Close</button></header><div className="timeline-event-detail__metrics"><span><small>Status</small><b className={`status-text--${event.status}`}>{event.status}</b></span><span><small>Duration</small><b>{span.duration.toFixed(3)} ms</b></span><span><small>Sequence</small><b>#{event.sequence}</b></span><span><small>Stage</small><b>{span.stage}</b></span></div><dl><div><dt>Event ID</dt><dd>{event.id}</dd></div><div><dt>Parent ID</dt><dd>{event.parentId ?? "Unavailable"}</dd></div><div><dt>Session</dt><dd>{event.sessionId}</dd></div><div><dt>Timestamp</dt><dd>{new Date(span.start).toISOString()}</dd></div><div><dt>Process</dt><dd>{span.process}</dd></div><div><dt>Thread</dt><dd>{span.thread}</dd></div><div><dt>URL</dt><dd>{String(event.payload.url ?? "Unavailable")}</dd></div></dl><h3>Typed payload</h3><pre>{JSON.stringify(event.payload, null, 2)}</pre></div>;
}
function ResourceView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Resource lifecycle</strong><span>{trace.resources.length} resources</span></header>{trace.resources.length ? <table className="trace-table"><thead><tr><th>URL</th><th>Type</th><th>Cache</th><th>Duration</th><th>Size</th></tr></thead><tbody>{trace.resources.map((item) => <tr key={item.id}><td>{item.url}</td><td>{item.type}</td><td>{item.cache}</td><td>{item.duration.toFixed(2)} ms</td><td>{item.size ?? "—"}</td></tr>)}</tbody></table> : <Empty>No resource events in this trace.</Empty>}</section>; }
function EventLoopView({ trace }: { trace: Trace }) {
  const [selected, setSelected] = useState<string | null>(null);
  const tasks = trace.spans.filter((s) => s.event.kind === "scheduler" || s.event.kind === "javascript" || s.stage === "event-loop");
  const maxDur = Math.max(...tasks.map((t) => t.duration), 1);
  const totalDur = tasks.reduce((sum, t) => sum + t.duration, 0);
  const selectedTask = tasks.find((t) => t.id === selected);

  const KIND_COLOR: Record<string, string> = {
    javascript: "#42c997", scheduler: "#3b8bd6", dom: "#a37bd3", render: "#d4a957",
  };

  if (!tasks.length) return <section className="trace-view"><header><strong>Event loop</strong><span>Task and microtask ordering</span></header><Empty>Awaiting scheduler and JavaScript queue events from Koko core.</Empty></section>;

  return (
    <section className="trace-view el-view">
      <header>
        <strong>Event loop</strong>
        <span>{tasks.length} tasks · {totalDur.toFixed(2)} ms total · {trace.spans.filter((s) => s.thread === "Main").length} main-thread events</span>
      </header>

      <div className="el-legend">
        {Object.entries(KIND_COLOR).map(([kind, color]) =>
          tasks.some((t) => t.event.kind === kind) && (
            <span key={kind}><i style={{ background: color }} />{kind}</span>
          )
        )}
        <span className="el-legend__total">{tasks.length} tasks queued</span>
      </div>

      <div className="el-track">
        {tasks.map((task) => {
          const color = KIND_COLOR[task.event.kind] ?? "#5a7a8a";
          const widthPct = Math.max(0.4, task.duration / maxDur * 100);
          const isSelected = selected === task.id;
          const scriptUrl = typeof task.event.payload.scriptUrl === "string" ? task.event.payload.scriptUrl : null;
          return (
            <button
              key={task.id}
              className={`el-bar${isSelected ? " el-bar--selected" : ""}`}
              style={{ "--color": color } as React.CSSProperties}
              onClick={() => setSelected(isSelected ? null : task.id)}
              title={`${task.event.name} · ${task.duration.toFixed(3)} ms`}
            >
              <span className="el-bar__fill" style={{ width: `${widthPct}%` }} />
              <span className="el-bar__kind">{task.event.kind}</span>
              <span className="el-bar__name">{scriptUrl ? new URL(scriptUrl).hostname : task.event.name}</span>
              <span className="el-bar__dur">{task.duration.toFixed(2)} ms</span>
              <span className="el-bar__share">{totalDur > 0 ? `${(task.duration / totalDur * 100).toFixed(1)}%` : "—"}</span>
            </button>
          );
        })}
      </div>

      {selectedTask && (
        <div className="el-detail">
          <header>
            <strong>{selectedTask.event.name}</strong>
            <span>{selectedTask.event.kind} · {selectedTask.stage}</span>
            <button onClick={() => setSelected(null)}>✕</button>
          </header>
          <div className="el-detail__grid">
            <span><small>Duration</small><code>{selectedTask.duration.toFixed(3)} ms</code></span>
            <span><small>Thread</small><code>{selectedTask.thread}</code></span>
            <span><small>Process</small><code>{selectedTask.process}</code></span>
            <span><small>Status</small><code>{selectedTask.event.status}</code></span>
            <span><small>Share</small><code>{totalDur > 0 ? `${(selectedTask.duration / totalDur * 100).toFixed(2)}%` : "—"}</code></span>
            <span><small>Sequence</small><code>#{selectedTask.event.sequence}</code></span>
            {typeof selectedTask.event.payload.scriptUrl === "string" && <span><small>Script</small><code>{selectedTask.event.payload.scriptUrl as string}</code></span>}
            {typeof selectedTask.event.payload.scriptKind === "string" && <span><small>Kind</small><code>{selectedTask.event.payload.scriptKind as string}</code></span>}
            {typeof selectedTask.event.payload.cpuPercent === "number" && <span><small>CPU %</small><code>{(selectedTask.event.payload.cpuPercent as number).toFixed(2)}%</code></span>}
          </div>
        </div>
      )}
    </section>
  );
}
function DependencyView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Stage dependencies</strong><span>{browserJourneyEdges.length} declared edges</span></header><table className="trace-table"><thead><tr><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead><tbody>{browserJourneyEdges.map((edge) => { const source = trace.spans.some((span) => span.stage === edge.source); const target = trace.spans.some((span) => span.stage === edge.target); return <tr key={edge.id}><td>{edge.source}</td><td>{edge.target}</td><td>{edge.label}</td><td>{source && target ? "observed" : "awaiting telemetry"}</td></tr>; })}</tbody></table></section>; }
function FrameView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Frame lifecycle</strong><span>{trace.frames.length} frame boundaries</span></header>{trace.frames.length ? <div className="event-queue">{trace.frames.map((frame) => <article key={frame.id}><b>{frame.presented ? "Frame presented" : "Composite frame"}</b><span>{frame.id}</span><strong>{frame.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core has not emitted frame timing for this navigation yet.</Empty>}</section>; }

function MiniLineChart({ values, color, label }: { values: number[]; color: string; label: string }) {
  const W = 320; const H = 52;
  if (values.length < 2) return <div className="jsd-chart jsd-chart--empty"><span>No data</span></div>;
  const min = Math.min(...values); const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <div className="jsd-chart">
      <span className="jsd-chart__label">{label}</span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H }}>
        <defs>
          <linearGradient id={`grad-${color.replace("#","")}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#grad-${color.replace("#","")})`} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div className="jsd-chart__range">
        <span>{label === "Memory" ? `${(min/1024/1024).toFixed(1)} MB` : `${min.toFixed(1)}`}</span>
        <span style={{ color }}>{label === "Memory" ? `${(max/1024/1024).toFixed(1)} MB` : `${max.toFixed(1)}`}</span>
      </div>
    </div>
  );
}

function JsdPending({ title, icon, reason }: { title: string; icon: string; reason: string }) {
  return (
    <div className="jsd-pending">
      <span className="jsd-pending__icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <span>{reason}</span>
      </div>
      <span className="jsd-pending__badge">Awaiting core telemetry</span>
    </div>
  );
}

function CallGraphView({ trace }: { trace: Trace }) {
  const [scriptExpanded, setScriptExpanded] = useState<Set<string>>(() => new Set());
  const calls = browserCalls(trace.events);

  // All JS events (including render/browserStage=javascript from current data)
  const jsEvents = trace.events.filter((e) =>
    e.kind === "javascript" ||
    (e.kind === "render" && typeof e.payload.browserStage === "string" && e.payload.browserStage === "javascript")
  );

  // ── Memory timeline ────────────────────────────────────────────────
  const memValues = jsEvents
    .filter((e) => typeof e.payload.residentMemoryBytes === "number")
    .map((e) => e.payload.residentMemoryBytes as number);

  // ── CPU timeline ───────────────────────────────────────────────────
  const cpuValues = jsEvents
    .filter((e) => typeof e.payload.cpuPercent === "number")
    .map((e) => e.payload.cpuPercent as number);

  // ── Context switch rate ────────────────────────────────────────────
  const ctxValues = jsEvents
    .filter((e) => typeof e.payload.contextSwitches === "number")
    .map((e) => e.payload.contextSwitches as number);
  const ctxDeltas = ctxValues.slice(1).map((v, i) => Math.max(0, v - ctxValues[i]));
  const totalCtx = ctxValues.length > 1 ? ctxValues[ctxValues.length - 1] - ctxValues[0] : 0;

  // ── Script waterfall ───────────────────────────────────────────────
  const byUrl = new Map<string, { url: string; totalDur: number; count: number; events: typeof jsEvents }>();
  for (const ev of jsEvents) {
    const url = typeof ev.payload.scriptUrl === "string" ? ev.payload.scriptUrl : "(inline)";
    const existing = byUrl.get(url) ?? { url, totalDur: 0, count: 0, events: [] };
    existing.totalDur += ev.duration;
    existing.count += 1;
    existing.events.push(ev);
    byUrl.set(url, existing);
  }
  const scripts = [...byUrl.values()].sort((a, b) => b.totalDur - a.totalDur);
  const maxScriptDur = Math.max(...scripts.map((s) => s.totalDur), 1);
  const totalScriptDur = scripts.reduce((sum, s) => sum + s.totalDur, 0);
  const toggleScript = (url: string) => setScriptExpanded((prev) => { const next = new Set(prev); if (next.has(url)) next.delete(url); else next.add(url); return next; });

  // ── System summary ─────────────────────────────────────────────────
  const lastEvent = jsEvents[jsEvents.length - 1];
  const physMem = typeof lastEvent?.payload.physicalMemoryBytes === "number" ? lastEvent.payload.physicalMemoryBytes as number : 0;
  const cpuCount = typeof lastEvent?.payload.logicalCpuCount === "number" ? lastEvent.payload.logicalCpuCount as number : 0;

  if (jsEvents.length === 0) return (
    <section className="trace-view">
      <header><strong>JavaScript runtime</strong><span>V8 engine telemetry</span></header>
      <Empty>Awaiting JavaScript events from Koko core.</Empty>
    </section>
  );

  return (
    <section className="trace-view jsd-view">
      <header>
        <strong>JavaScript runtime</strong>
        <span>{jsEvents.length} events · {scripts.length} scripts · {totalScriptDur.toFixed(1)} ms JS time{calls.length > 0 ? ` · ${calls.length} function calls` : ""}</span>
      </header>

      {/* System context */}
      {(physMem > 0 || cpuCount > 0) && (
        <div className="jsd-sys">
          {cpuCount > 0 && <span><small>CPUs</small><b>{cpuCount} logical</b></span>}
          {physMem > 0 && <span><small>Physical RAM</small><b>{(physMem / 1024 / 1024 / 1024).toFixed(1)} GB</b></span>}
          {totalCtx > 0 && <span><small>Context switches</small><b>{totalCtx}</b></span>}
          {ctxValues.length > 0 && <span><small>Final resident</small><b>{((ctxValues[ctxValues.length - 1] ?? 0) / 1024 / 1024).toFixed(0)} MB</b></span>}
        </div>
      )}

      {/* Charts row */}
      <div className="jsd-charts">
        {memValues.length > 1 && <MiniLineChart values={memValues} color="#42c997" label="Memory" />}
        {cpuValues.length > 1 && <MiniLineChart values={cpuValues} color="#d4a957" label="CPU %" />}
        {ctxDeltas.length > 1 && <MiniLineChart values={ctxDeltas} color="#3b8bd6" label="Ctx switches/event" />}
      </div>

      {/* Script waterfall */}
      <div className="jsd-section">
        <div className="jsd-section__header">
          <strong>Script execution waterfall</strong>
          <span>{scripts.length} scripts · {totalScriptDur.toFixed(2)} ms</span>
        </div>
        <div className="cg-waterfall">
          <div className="cg-waterfall__header">
            <span>Script origin</span><span>Runs</span><span>Total time</span><span>Share</span><span>Relative</span>
          </div>
          {scripts.map((script) => {
            const isOpen = scriptExpanded.has(script.url);
            const barW = Math.max(2, script.totalDur / maxScriptDur * 100);
            let host = script.url;
            try { host = new URL(script.url).hostname || script.url; } catch { /* inline */ }
            return (
              <div key={script.url} className={`cg-script${isOpen ? " cg-script--open" : ""}`}>
                <button className="cg-script__row" onClick={() => toggleScript(script.url)}>
                  <span className="cg-script__name" title={script.url}>
                    <i className="cg-script__toggle">{isOpen ? "▾" : "▸"}</i>{host}
                  </span>
                  <span className="cg-script__count">{script.count}×</span>
                  <span className="cg-script__dur">{script.totalDur.toFixed(2)} ms</span>
                  <span className="cg-script__share">{(script.totalDur / totalScriptDur * 100).toFixed(1)}%</span>
                  <span className="cg-script__bar"><span style={{ width: `${barW}%`, background: "#42c997" }} /></span>
                </button>
                {isOpen && (
                  <div className="cg-script__slots">
                    {script.events.map((ev, i) => (
                      <div key={ev.id} className="cg-slot">
                        <span className="cg-slot__seq">#{i + 1}</span>
                        <span className="cg-slot__name">{ev.name}</span>
                        <span className="cg-slot__kind">{typeof ev.payload.scriptKind === "string" ? ev.payload.scriptKind as string : ev.kind}</span>
                        <span className="cg-slot__dur">{ev.duration.toFixed(3)} ms</span>
                        {typeof ev.payload.cpuPercent === "number" && <span className="cg-slot__cpu">{(ev.payload.cpuPercent as number).toFixed(1)}% CPU</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Function call tree — shown when V8 profiler data is available */}
      {calls.length > 0 ? (
        <div className="jsd-section">
          <div className="jsd-section__header"><strong>Function call tree</strong><span>{calls.length} attributed calls</span></div>
          <div className="cg-calltree">
            {calls.map((call) => (
              <div key={call.id} className="cg-call" style={{ paddingLeft: `${Math.min(call.depth, 8) * 16 + 8}px` }}>
                <span className="cg-call__depth">L{call.depth}</span>
                <span className="cg-call__name">{call.name}</span>
                <span className="cg-call__kind">{call.kind}</span>
                <span className="cg-call__dur">{call.duration.toFixed(3)} ms</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <JsdPending
          title="Function-level call graph"
          icon="⛓"
          reason="Koko core emits script-level boundaries now. Function-to-function call edges will appear when V8 profiler events include functionName, callId and parentCallId."
        />
      )}

      {/* Pending sections — will light up when core adds telemetry */}
      <div className="jsd-section jsd-section--pending">
        <div className="jsd-section__header"><strong>Pending runtime features</strong><span>Activate when Koko core emits supporting events</span></div>
        <div className="jsd-pending-list">
          <JsdPending title="Garbage collection (GC)" icon="♻" reason="V8 GC callback (v8::GCCallback) — emit gc-start / gc-end events with kind (scavenge, mark-sweep, incremental) and duration." />
          <JsdPending title="Timers & task queue" icon="⏱" reason="setTimeout / setInterval / queueMicrotask instrumentation — emit timer-fire events with callerId, delay and kind (macro/micro/raf)." />
          <JsdPending title="Promise & async tracking" icon="⚡" reason="V8 Promise hooks (PromiseHook) — emit promise-created / promise-resolved / promise-rejected with parent promise chain IDs." />
          <JsdPending title="Web Workers" icon="👷" reason="Dedicated and shared worker lifecycle — emit worker-created / worker-message events with workerId, scriptUrl and origin thread." />
          <JsdPending title="Heap snapshot" icon="🧠" reason="V8 heap profiler (v8::HeapProfiler) — emit heap-snapshot events with alloc/freed bytes, live objects count and GC root types." />
          <JsdPending title="Wasm module execution" icon="⬡" reason="WebAssembly.compile / WebAssembly.instantiate hooks — emit wasm-compile / wasm-execute with module URL and tier (baseline/optimized)." />
        </div>
      </div>
    </section>
  );
}
