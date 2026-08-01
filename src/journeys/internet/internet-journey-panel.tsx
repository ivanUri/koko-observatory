"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, getStraightPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronDown, ChevronLeft, ChevronRight, Circle, CircleHelp, Globe2, Pause, Play, Search } from "lucide-react";
import { internetJourneyEdges, internetJourneyNodes } from "./data";
import { useInternetJourneyStore } from "./store";
import type { JourneyNode } from "./types";

const typeIcons: Record<JourneyNode["type"], string> = {
  url: "URL", dns: "DNS", connection: "TCP", tls: "TLS", http: "HTTP",
  routing: "NET", server: "SRV", response: "RES", boundary: "END",
};
const nodeTypes = { journey: JourneyCard };
const edgeTypes = { journey: JourneyEdge };

export function journeyDurationLabel(model: JourneyNode): string {
  if (model.status === "pending") return "—";
  if (model.status === "error") return "Failed";
  if (model.status === "skipped" || model.metadata.measurement === "unavailable") return "Unavailable";
  if (model.metadata.measurement === "reused") return "Reused";
  if (model.metadata.measurement === "not-timed") return "Not timed";
  if (model.metadata.measurement === "boundary") return "Boundary";
  return `${model.metadata.estimated ? "~" : ""}${model.duration.toFixed(3)} ms`;
}

function measurementHint(model: JourneyNode): string {
  if (model.metadata.measurement === "not-timed") return "The stage exists, but core does not attach a duration source yet.";
  if (model.metadata.measurement === "unavailable") return "The browser or network layer cannot observe this signal.";
  if (model.metadata.measurement === "reused") return "Connection reused, so the browser did not remeasure this phase.";
  if (model.metadata.measurement === "boundary") return "Lifecycle boundary, not a timed phase.";
  return model.status === "pending" ? "Awaiting telemetry." : "Measured from telemetry.";
}

function JourneyCard({ data }: NodeProps) {
  const model = data as unknown as JourneyNode;
  const expanded = useInternetJourneyStore((state) => state.expanded === model.id);
  const toggle = useInternetJourneyStore((state) => state.toggle);
  const mode = useInternetJourneyStore((state) => state.mode);
  return <article className={`journey-node journey-node--${model.status}`}>
    <Handle type="target" position={Position.Left} />
    <button className="journey-node__summary" onClick={() => toggle(model.id)}>
      <span className="journey-node__icon">{typeIcons[model.type]}</span>
      <span><strong>{model.title}</strong><small>{model.description}</small></span>
      <span className="journey-node__duration" title={measurementHint(model)}>{journeyDurationLabel(model)}</span>
      <ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
    </button>
    {expanded && <div className="journey-node__details">
      <div className="journey-kv">{model.metadata.summary.map((item) => <span key={item.label}><small>{item.label}</small><code>{item.value}</code></span>)}</div>
      {mode === "education" ? <>
        <h4><CircleHelp size={12} /> What is this?</h4><p>{model.metadata.explanation}</p>
        <h4>Common issues</h4><p>{model.metadata.issues.join(" ")}</p>
        <h4>Best practices</h4><p>{model.metadata.practices.join(" ")}</p>
        <a>{model.metadata.reference}</a>
      </> : <pre>{model.metadata.raw ?? model.metadata.summary.map((item) => `${item.label}: ${item.value}`).join("\n")}</pre>}
    </div>}
    <Handle type="source" position={Position.Right} />
  </article>;
}

function JourneyEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const inset = 7;
  const adjusted = {
    sourceX: sourceX + dx / length * inset,
    sourceY: sourceY + dy / length * inset,
    targetX: targetX - dx / length * inset,
    targetY: targetY - dy / length * inset,
  };
  const [path] = getStraightPath(adjusted);
  const edgeState = (props.data as { state?: "connected" | "failed" | "pending" } | undefined)?.state ?? "pending";
  const active = edgeState === "connected" ? "#55d57d" : edgeState === "failed" ? "#ef6f78" : "#34404b";
  return (
    <BaseEdge
      path={path}
      markerEnd={props.markerEnd}
      style={{ stroke: active, strokeWidth: 1.5, strokeLinecap: "round", strokeDasharray: "6 7" }}
    />
  );
}

export function InternetJourneyPanel() {
  const { cursor, playing, speed, mode, query, phase, recording, recordedEvents, revealedCount, nodes: liveNodes, play, seek, setSpeed, setMode, setQuery, toggleRecording, revealNext } = useInternetJourneyStore();
  const journeyNodes = liveNodes.length ? liveNodes : internetJourneyNodes;
  const positions = useRef<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const current = useInternetJourneyStore.getState().cursor;
      if (current >= journeyNodes.length - 1) useInternetJourneyStore.getState().play(false);
      else useInternetJourneyStore.getState().seek(current + 1);
    }, 1000 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, journeyNodes.length]);
  useEffect(() => {
    if (phase === "idle" || revealedCount >= journeyNodes.length) return;
    const timer = window.setTimeout(revealNext, 320);
    return () => window.clearTimeout(timer);
  }, [phase, revealedCount, journeyNodes.length, revealNext]);

  const visible = useMemo(() => journeyNodes.slice(0, revealedCount).filter((node) =>
    !query || `${node.title} ${node.description} ${node.metadata.raw ?? ""} ${node.metadata.summary.map((item) => `${item.label} ${item.value}`).join(" ")}`
      .toLowerCase().includes(query.toLowerCase())), [journeyNodes, query, revealedCount]);
  const nodes = useMemo(() => visible.map((node) => {
    const index = journeyNodes.findIndex((candidate) => candidate.id === node.id);
    return {
      id: node.id, type: "journey", data: { ...node, status: playing ? (index < cursor ? "complete" : index === cursor ? "active" : "pending") : node.status },
      position: positions.current[node.id] ?? { x: index * 330, y: 30 },
    };
  }), [visible, journeyNodes, cursor, playing]);
  const edges = useMemo(() => {
    const visibleIds = new Set(visible.map((node) => node.id));
    return internetJourneyEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge, index) => {
      const source = journeyNodes.find((node) => node.id === edge.source);
      const target = journeyNodes.find((node) => node.id === edge.target);
      const failed = source?.status === "error" || source?.status === "skipped" || target?.status === "error" || target?.status === "skipped";
      const connected = !failed && (index < cursor || (source?.status === "complete" && target?.status === "complete"));
      const state = failed ? "failed" : connected ? "connected" : "pending";
      const color = state === "connected" ? "#55d57d" : state === "failed" ? "#ef6f78" : "#34404b";
      return {
        ...edge, type: "journey", data: { state }, animated: connected, markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
  }, [visible, journeyNodes, cursor]);
  const durations = useMemo(() => [
    ["Queue", journeyNodes.find((node) => node.id === "queue")?.duration ?? 0],
    ["DNS", journeyNodes.find((node) => node.id === "dns")?.duration ?? 0],
    ["TCP", journeyNodes.find((node) => node.id === "tcp")?.duration ?? 0],
    ["TLS", journeyNodes.find((node) => node.id === "tls")?.duration ?? 0],
    ["Server", journeyNodes.find((node) => node.id === "server")?.duration ?? 0],
    ["Transfer", journeyNodes.find((node) => node.id === "response")?.duration ?? 0],
  ] as const, [journeyNodes]);
  const totalDuration = durations.reduce((total, [, duration]) => total + duration, 0);
  const onNodeDragStop = useCallback((_: unknown, node: { id: string; position: { x: number; y: number } }) => {
    positions.current[node.id] = node.position;
  }, []);

  return <main className="internet-journey">
    <header className="journey-header">
      <div><span><Globe2 size={14} /> Protocol learning module</span><h1>Internet Journey</h1><p>From URL input to the moment the browser receives an HTTP response.</p></div>
      <div className="journey-mode"><button className={mode === "education" ? "active" : ""} onClick={() => setMode("education")}>Educational</button><button className={mode === "developer" ? "active" : ""} onClick={() => setMode("developer")}>Developer</button></div>
    </header>
    <div className="journey-legend"><span><i className="legend-dot legend-dot--ok" /> Measured</span><span><i className="legend-dot legend-dot--warn" /> Not timed means the stage exists but core does not attach a duration source yet</span><span><i className="legend-dot legend-dot--error" /> Unavailable means the browser layer cannot observe that signal</span></div>
    <div className="journey-toolbar">
      <label><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, headers, DNS records, status…" /></label>
      <div className="journey-playback">
        <button className={recording ? "recording" : ""} onClick={toggleRecording}><Circle size={10} fill={recording ? "currentColor" : "none"} />{recording ? `Recording ${recordedEvents.length}` : "Record"}</button>
        <button onClick={() => seek(cursor - 1)} aria-label="Previous"><ChevronLeft size={14} /></button>
        <button disabled={phase === "idle"} onClick={() => { if (cursor >= journeyNodes.length - 1) seek(0); play(!playing); }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause" : "Play"}</button>
        <button onClick={() => seek(cursor + 1)} aria-label="Next"><ChevronRight size={14} /></button>
        {[.5, 1, 2].map((value) => <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value as .5 | 1 | 2)}>×{value}</button>)}
      </div>
    </div>
    {phase === "idle" ? <section className="journey-empty"><Globe2 size={22} /><strong>Inspect an Internet journey</strong><span>Enter a URL above to launch Velora and reveal each measured network step.</span></section> : <>
    <section className={`journey-graph journey-graph--${phase}`}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeDragStop={onNodeDragStop} fitView minZoom={.3} maxZoom={1.3}><Background color="#23303b" gap={20} size={1} /><Controls /></ReactFlow>
    </section>
    <section className="journey-waterfall">
      <header><strong>Request waterfall</strong><span>Total <b>{totalDuration ? `${totalDuration.toFixed(3)} ms` : "Awaiting telemetry"}</b></span></header>
      <div>{durations.map(([label, value]) => <span key={label}><small>{label}</small><i style={{ width: `${totalDuration ? Math.max(2, value / totalDuration * 100) : 2}%` }} /><b>{value ? `${value.toFixed(3)} ms` : "—"}</b></span>)}</div>
    </section>
    {phase === "error" && <footer className="journey-boundary journey-boundary--error"><strong>Journey stopped at URL validation.</strong><span>The request was not sent. Open the failed URL input node to inspect the validation error; all later stages are marked skipped.</span></footer>}
    {phase === "received" && revealedCount >= journeyNodes.length && <footer className="journey-boundary"><strong>Response received.</strong><span>Internet Journey stops here — no HTML, CSS, JavaScript, DOM, rendering, Event Loop or GPU processing.</span><button onClick={() => { window.location.href = "/browser-journey"; }}>Continue → Browser Journey</button></footer>}
    </>}
  </main>;
}
