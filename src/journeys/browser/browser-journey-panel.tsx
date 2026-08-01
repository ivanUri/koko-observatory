"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ChevronLeft, ChevronRight, Cpu, Pause, Play } from "lucide-react";
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
    {view === "journey" && (phase === "running" || phase === "complete") && <section className="journey-waterfall"><header><strong>Browser processing waterfall</strong><span>Total measured <b>{total ? `${total.toFixed(3)} ms` : "Awaiting Velora events"}</b></span></header><div>{live.filter((item) => item.duration > 0).map((item) => <span key={item.id}><small>{item.title}</small><i style={{ width: `${Math.max(2, item.duration / Math.max(total, 1) * 100)}%` }}/><b>{item.duration.toFixed(2)} ms</b></span>)}</div></section>}
    {phase === "complete" && <footer className="journey-boundary"><strong>Frame presented.</strong><span>Browser Journey ends here. Every unavailable stage remains explicit until Velora Core emits supporting telemetry.</span><button>Open Rendering Explorer →</button></footer>}
  </main>;
}

type Trace = ReturnType<typeof useBrowserJourneyStore.getState>["trace"];
function Empty({ children }: { children: string }) { return <div className="trace-empty">{children}</div>; }
function NodeDetails({ item, onClose }: { item?: BrowserJourneyNode; onClose: () => void }) {
  if (!item) return null;
  const measured = item.status === "complete" || item.status === "active";
  const what = `This stage belongs to the ${item.process} process and ${item.thread} thread. Its duration is measured from Velora telemetry when available.`;
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const min = Math.min(...trace.spans.map((span) => span.start), Date.now());
  const maxDuration = Math.max(...trace.spans.map((span) => span.duration), 1);
  const total = trace.spans.reduce((sum, span) => sum + span.duration, 0);
  const grouped = [...Map.groupBy(trace.spans, (span) => span.thread)].map(([thread, spans]) => ({ thread, spans }));
  return <section className="trace-view"><header><strong>Execution timeline</strong><span>{trace.spans.length} spans · {total.toFixed(3)} ms total measured</span></header>{trace.spans.length ? <>
    <div className="trace-lanes">{grouped.map(({ thread, spans }) => <div key={thread} className="trace-lane-group"><div className="trace-lane-heading"><b>{thread}</b><small>{spans.reduce((sum, span) => sum + span.duration, 0).toFixed(3)} ms · {spans.length} events</small></div><span className="trace-lane-track">{spans.map((span) => <button className={`trace-span ${expanded === span.id ? "trace-span--selected" : ""}`} key={span.id} title={`${span.event.name} · ${span.duration.toFixed(3)} ms`} onClick={() => setExpanded(expanded === span.id ? null : span.id)} style={{ marginLeft: `${Math.min(80, Math.max(0, (span.start-min)/20))}px`, width: `${Math.max(5, span.duration / maxDuration * 100)}px` }}>{span.event.name}</button>)}</span></div>)}</div>
    {expanded && (() => { const span = trace.spans.find((item) => item.id === expanded); if (!span) return null; const payload = span.event.payload; return <article className="timeline-details"><header><strong>{span.stage} · {span.event.name}</strong><button onClick={() => setExpanded(null)}>Close</button></header><div className="timeline-metrics"><span><small>Duration</small><b>{span.duration.toFixed(3)} ms</b></span><span><small>Process</small><b>{span.process}</b></span><span><small>Thread</small><b>{span.thread}</b></span><span><small>Status</small><b>{span.event.status}</b></span><span><small>Timestamp</small><b>{new Date(span.start).toISOString()}</b></span><span><small>Share</small><b>{total ? `${(span.duration / total * 100).toFixed(2)}%` : "0%"}</b></span></div><p className="timeline-load-summary">Loaded stage: <strong>{typeof payload.url === "string" ? payload.url : span.event.name}</strong>{typeof payload.responseBodyBytes === "number" ? ` · ${payload.responseBodyBytes} bytes` : ""}</p><pre>{JSON.stringify(payload, null, 2)}</pre></article>; })()}
  </> : <Empty>No browser spans received yet.</Empty>}</section>;
}
function ResourceView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Resource lifecycle</strong><span>{trace.resources.length} resources</span></header>{trace.resources.length ? <table className="trace-table"><thead><tr><th>URL</th><th>Type</th><th>Cache</th><th>Duration</th><th>Size</th></tr></thead><tbody>{trace.resources.map((item) => <tr key={item.id}><td>{item.url}</td><td>{item.type}</td><td>{item.cache}</td><td>{item.duration.toFixed(2)} ms</td><td>{item.size ?? "—"}</td></tr>)}</tbody></table> : <Empty>No resource events in this trace.</Empty>}</section>; }
function EventLoopView({ trace }: { trace: Trace }) { const tasks = trace.spans.filter((span) => span.event.kind === "scheduler" || span.event.kind === "javascript"); return <section className="trace-view"><header><strong>Event loop</strong><span>Task and microtask ordering</span></header>{tasks.length ? <div className="event-queue">{tasks.map((task) => <article key={task.id}><b>{task.event.name}</b><span>{task.thread}</span><strong>{task.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Awaiting scheduler and JavaScript queue events.</Empty>}</section>; }
function DependencyView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Stage dependencies</strong><span>{browserJourneyEdges.length} declared edges</span></header><table className="trace-table"><thead><tr><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead><tbody>{browserJourneyEdges.map((edge) => { const source = trace.spans.some((span) => span.stage === edge.source); const target = trace.spans.some((span) => span.stage === edge.target); return <tr key={edge.id}><td>{edge.source}</td><td>{edge.target}</td><td>{edge.label}</td><td>{source && target ? "observed" : "awaiting telemetry"}</td></tr>; })}</tbody></table></section>; }
function FrameView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Frame lifecycle</strong><span>{trace.frames.length} frame boundaries</span></header>{trace.frames.length ? <div className="event-queue">{trace.frames.map((frame) => <article key={frame.id}><b>{frame.presented ? "Frame presented" : "Composite frame"}</b><span>{frame.id}</span><strong>{frame.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core has not emitted frame timing for this navigation yet.</Empty>}</section>; }
function CallGraphView({ trace }: { trace: Trace }) { const calls = browserCalls(trace.events); return <section className="trace-view"><header><strong>JavaScript call graph</strong><span>{calls.length ? `${calls.length} attributed calls` : "Script-level instrumentation"}</span></header>{calls.length ? <div className="event-queue">{calls.map((call) => <article key={call.id} style={{ marginLeft: `${Math.min(call.depth, 8) * 18}px` }}><b>{call.name}</b><span>{call.kind}{call.url ? ` · ${call.url}` : ""}{call.parentId ? ` · parent ${call.parentId}` : ""}</span><strong>{call.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core emits script URL, kind and duration now. Function-to-function edges will appear when V8 profiler events provide functionName, callId and parentCallId; no synthetic edges are shown.</Empty>}</section>; }
