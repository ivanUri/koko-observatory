"use client";

import { useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import { ChevronLeft, ChevronRight, Cpu, Pause, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { browserJourneyEdges, browserJourneyNodes } from "./data";
import { useBrowserJourneyStore } from "./store";
import type { BrowserJourneyNode } from "./types";
import { browserCalls } from "./trace-model";

function BrowserCard({ data }: NodeProps) {
  const item = data as unknown as BrowserJourneyNode;
  return <article className={`journey-node journey-node--${item.status}`}>
    <Handle type="target" position={Position.Left} />
    <div className="journey-node__summary">
      <span className="journey-node__icon">{item.type.slice(0, 3).toUpperCase()}</span>
      <span><strong>{item.title}</strong><small>{item.description}</small><small>{item.process} · {item.thread} thread</small>{typeof item.metadata.scriptUrl === "string" && <small className="browser-script-source">{item.metadata.scriptKind} · {item.metadata.scriptUrl}</small>}</span>
      <span className="journey-node__duration">{item.duration ? `${item.duration.toFixed(3)} ms` : item.status === "complete" ? "Complete" : item.status === "unavailable" ? "Unavailable" : "Awaiting"}</span>
    </div>
    <Handle type="source" position={Position.Right} />
  </article>;
}
const nodeTypes = { browser: BrowserCard };

export function BrowserJourneyPanel() {
  const pathname = usePathname();
  const view = pathname.split("/")[2] || "journey";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { nodes: live, trace, cursor, playing, speed, play, seek, setSpeed } = useBrowserJourneyStore();
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const state = useBrowserJourneyStore.getState();
      if (state.cursor >= browserJourneyNodes.length - 1) state.play(false); else state.seek(state.cursor + 1);
    }, 850 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed]);
  const nodes = useMemo(() => live.map((item, index) => ({
    id: item.id, type: "browser", position: { x: index * 330, y: index % 2 ? 155 : 25 },
    data: { ...item, status: playing ? (index < cursor ? "complete" : index === cursor ? "active" : "pending") : item.status },
  })), [live, cursor, playing]);
  const edges = useMemo(() => browserJourneyEdges.map((edge, index) => ({ ...edge, animated: playing && index < cursor, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: index < cursor ? "#55d57d" : "#34404b" } })), [cursor, playing]);
  const total = live.reduce((sum, item) => sum + item.duration, 0);
  const views = ["journey", "timeline", "dependencies", "threads", "frames", "resources", "event-loop", "call-graph", "memory", "processes"];
  return <main className="internet-journey browser-journey">
    <header className="journey-header"><div><span><Cpu size={14}/> Renderer pipeline</span><h1>Browser Journey</h1><p>From HTTP response bytes to the frame presented on screen.</p></div><Link href="/internet-journey">← Internet Journey</Link></header>
    <nav className="browser-view-tabs">{views.map((item) => <a key={item} className={view === item ? "active" : ""} href={item === "journey" ? "/browser-journey" : `/browser-journey/${item}`}>{item.replace("-", " ")}</a>)}</nav>
    <div className="journey-toolbar"><div className="journey-stage-key">Network boundary → Parse → Execute → Render → Composite</div><div className="journey-playback">
      <button onClick={() => seek(cursor - 1)}><ChevronLeft size={14}/></button><button onClick={() => play(!playing)}>{playing ? <Pause size={14}/> : <Play size={14}/>} {playing ? "Pause" : "Play"}</button><button onClick={() => seek(cursor + 1)}><ChevronRight size={14}/></button>
      {([.5, 1, 2] as const).map((value) => <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>×{value}</button>)}
    </div></div>
    {view === "journey" && <section className="journey-graph browser-journey__graph"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => setSelectedId(node.id)} fitView minZoom={.25} maxZoom={1.4}><Background color="#23303b" gap={20}/><Controls/></ReactFlow></section>}
    {view === "journey" && selectedId && <NodeDetails item={live.find((item) => item.id === selectedId)} onClose={() => setSelectedId(null)}/>} 
    {view === "timeline" && <TraceTimeline trace={trace}/>} {view === "dependencies" && <DependencyView trace={trace}/>} {view === "threads" && <ThreadView trace={trace}/>} {view === "resources" && <ResourceView trace={trace}/>} {view === "frames" && <FrameView trace={trace}/>} {view === "event-loop" && <EventLoopView trace={trace}/>} {view === "call-graph" && <CallGraphView trace={trace}/>} {view === "memory" && <MemoryView trace={trace}/>} {view === "processes" && <ProcessView trace={trace}/>} 
    {view === "journey" && <section className="journey-waterfall"><header><strong>Browser processing waterfall</strong><span>Total measured <b>{total ? `${total.toFixed(3)} ms` : "Awaiting Velora events"}</b></span></header><div>{live.filter((item) => item.duration > 0).map((item) => <span key={item.id}><small>{item.title}</small><i style={{ width: `${Math.max(2, item.duration / Math.max(total, 1) * 100)}%` }}/><b>{item.duration.toFixed(2)} ms</b></span>)}</div></section>}
    <footer className="journey-boundary"><strong>Frame presented.</strong><span>Browser Journey ends here. Every unavailable stage remains explicit until Velora Core emits supporting telemetry.</span><button>Open Rendering Explorer →</button></footer>
  </main>;
}

type Trace = ReturnType<typeof useBrowserJourneyStore.getState>["trace"];
function Empty({ children }: { children: string }) { return <div className="trace-empty">{children}</div>; }
function NodeDetails({ item, onClose }: { item?: BrowserJourneyNode; onClose: () => void }) { if (!item) return null; const what = `This stage belongs to the ${item.process} process and ${item.thread} thread. Its duration is measured from Velora telemetry when available.`; return <aside className="trace-view browser-node-details"><header><strong>{item.title}</strong><button onClick={onClose}>Close</button></header><p>{what}</p><p><strong>What is this?</strong> {item.description}</p><div className="trace-cards"><article><span>Status</span><b>{item.status}</b></article><article><span>Duration</span><b>{item.duration.toFixed(3)} ms</b></article><article><span>Owner</span><b>{item.process} / {item.thread}</b></article></div><pre>{JSON.stringify(item.metadata, null, 2)}</pre></aside>; }
function TraceTimeline({ trace }: { trace: Trace }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const min = Math.min(...trace.spans.map((span) => span.start), Date.now());
  const maxDuration = Math.max(...trace.spans.map((span) => span.duration), 1);
  const total = trace.spans.reduce((sum, span) => sum + span.duration, 0);
  const grouped = ["Main", "Network", "Compositor", "Worker"].map((thread) => ({ thread, spans: trace.spans.filter((span) => span.thread === thread) }));
  return <section className="trace-view"><header><strong>Execution timeline</strong><span>{trace.spans.length} spans · {total.toFixed(3)} ms total measured</span></header>{trace.spans.length ? <>
    <div className="trace-lanes">{grouped.map(({ thread, spans }) => <div key={thread} className="trace-lane-group"><div className="trace-lane-heading"><b>{thread}</b><small>{spans.reduce((sum, span) => sum + span.duration, 0).toFixed(3)} ms · {spans.length} events</small></div><span className="trace-lane-track">{spans.map((span) => <button className={`trace-span ${expanded === span.id ? "trace-span--selected" : ""}`} key={span.id} title={`${span.event.name} · ${span.duration.toFixed(3)} ms`} onClick={() => setExpanded(expanded === span.id ? null : span.id)} style={{ marginLeft: `${Math.min(80, Math.max(0, (span.start-min)/20))}px`, width: `${Math.max(5, span.duration / maxDuration * 100)}px` }}>{span.event.name}</button>)}</span></div>)}</div>
    {expanded && (() => { const span = trace.spans.find((item) => item.id === expanded); if (!span) return null; const payload = span.event.payload; return <article className="timeline-details"><header><strong>{span.stage} · {span.event.name}</strong><button onClick={() => setExpanded(null)}>Close</button></header><div className="timeline-metrics"><span><small>Duration</small><b>{span.duration.toFixed(3)} ms</b></span><span><small>Process</small><b>{span.process}</b></span><span><small>Thread</small><b>{span.thread}</b></span><span><small>Status</small><b>{span.event.status}</b></span><span><small>Timestamp</small><b>{new Date(span.start).toISOString()}</b></span><span><small>Share</small><b>{total ? `${(span.duration / total * 100).toFixed(2)}%` : "0%"}</b></span></div><p className="timeline-load-summary">Loaded stage: <strong>{typeof payload.url === "string" ? payload.url : span.event.name}</strong>{typeof payload.responseBodyBytes === "number" ? ` · ${payload.responseBodyBytes} bytes` : ""}</p><pre>{JSON.stringify(payload, null, 2)}</pre></article>; })()}
  </> : <Empty>No browser spans received yet.</Empty>}</section>;
}
function ThreadView({ trace }: { trace: Trace }) { const groups = Map.groupBy(trace.spans, (span) => span.thread); return <section className="trace-view"><header><strong>Thread activity</strong><span>Measured concurrency</span></header>{groups.size ? <div className="trace-cards">{[...groups].map(([thread, spans]) => <article key={thread}><strong>{thread}</strong><b>{spans.length} tasks</b><span>{spans.reduce((sum, item) => sum+item.duration,0).toFixed(2)} ms active</span></article>)}</div> : <Empty>Awaiting thread-attributed events.</Empty>}</section>; }
function ResourceView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Resource lifecycle</strong><span>{trace.resources.length} resources</span></header>{trace.resources.length ? <table className="trace-table"><thead><tr><th>URL</th><th>Type</th><th>Cache</th><th>Duration</th><th>Size</th></tr></thead><tbody>{trace.resources.map((item) => <tr key={item.id}><td>{item.url}</td><td>{item.type}</td><td>{item.cache}</td><td>{item.duration.toFixed(2)} ms</td><td>{item.size ?? "—"}</td></tr>)}</tbody></table> : <Empty>No resource events in this trace.</Empty>}</section>; }
function EventLoopView({ trace }: { trace: Trace }) { const tasks = trace.spans.filter((span) => span.event.kind === "scheduler" || span.event.kind === "javascript"); return <section className="trace-view"><header><strong>Event loop</strong><span>Task and microtask ordering</span></header>{tasks.length ? <div className="event-queue">{tasks.map((task) => <article key={task.id}><b>{task.event.name}</b><span>{task.thread}</span><strong>{task.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Awaiting scheduler and JavaScript queue events.</Empty>}</section>; }
function DependencyView({ trace }: { trace: Trace }) { return <section className="trace-view"><header><strong>Stage dependencies</strong><span>{browserJourneyEdges.length} declared edges</span></header><table className="trace-table"><thead><tr><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead><tbody>{browserJourneyEdges.map((edge) => { const source = trace.spans.some((span) => span.stage === edge.source); const target = trace.spans.some((span) => span.stage === edge.target); return <tr key={edge.id}><td>{edge.source}</td><td>{edge.target}</td><td>{edge.label}</td><td>{source && target ? "observed" : "awaiting telemetry"}</td></tr>; })}</tbody></table></section>; }
function FrameView({ trace }: { trace: Trace }) { const frames = trace.events.filter((event) => event.kind === "render" && event.payload.browserStage === "frame"); return <section className="trace-view"><header><strong>Frame lifecycle</strong><span>{frames.length} frame boundaries</span></header>{frames.length ? <div className="event-queue">{frames.map((event) => <article key={event.id}><b>{event.name}</b><span>{String(event.payload.frameId ?? "frame")}</span><strong>{event.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core has not emitted frame timing for this navigation yet.</Empty>}</section>; }
function MemoryView({ trace }: { trace: Trace }) { const samples = trace.events.filter((event) => event.kind === "memory"); return <section className="trace-view"><header><strong>Memory samples</strong><span>{samples.length} measurements</span></header>{samples.length ? <div className="event-queue">{samples.map((event) => <article key={event.id}><b>{event.name}</b><span>{JSON.stringify(event.payload)}</span><strong>{event.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core has not emitted typed memory samples for this navigation yet.</Empty>}</section>; }
function CallGraphView({ trace }: { trace: Trace }) { const calls = browserCalls(trace.events); return <section className="trace-view"><header><strong>JavaScript call graph</strong><span>{calls.length ? `${calls.length} attributed calls` : "Script-level instrumentation"}</span></header>{calls.length ? <div className="event-queue">{calls.map((call) => <article key={call.id} style={{ marginLeft: `${Math.min(call.depth, 8) * 18}px` }}><b>{call.name}</b><span>{call.kind}{call.url ? ` · ${call.url}` : ""}{call.parentId ? ` · parent ${call.parentId}` : ""}</span><strong>{call.duration.toFixed(3)} ms</strong></article>)}</div> : <Empty>Core emits script URL, kind and duration now. Function-to-function edges will appear when V8 profiler events provide functionName, callId and parentCallId; no synthetic edges are shown.</Empty>}</section>; }
function ProcessView({ trace }: { trace: Trace }) { const groups = Map.groupBy(trace.spans, (span) => span.process); return <section className="trace-view"><header><strong>Logical processes</strong><span>Velora subsystem ownership</span></header><div className="trace-cards">{["Browser", "Renderer", "GPU"].map((process) => <article key={process}><strong>{process}</strong><b>{groups.get(process)?.length ?? 0} spans</b><span>{groups.has(process) ? "Measured activity" : "Unavailable / not isolated"}</span></article>)}</div></section>; }
