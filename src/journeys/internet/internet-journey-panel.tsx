"use client";

import { useEffect } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Globe2, Pause, Play, Search } from "lucide-react";
import { internetJourneyEdges, internetJourneyNodes } from "./data";
import { useInternetJourneyStore } from "./store";
import type { JourneyNode } from "./types";

const durations = [["DNS", 4], ["TCP", 18], ["TLS", 41], ["Server", 95], ["Transfer", 12]] as const;
const typeIcons: Record<JourneyNode["type"], string> = {
  url: "URL", dns: "DNS", connection: "TCP", tls: "TLS", http: "HTTP",
  routing: "NET", server: "SRV", response: "RES", boundary: "END",
};

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
      <span className="journey-node__duration">{model.metadata.estimated && "~"}{model.duration} ms</span>
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

export function InternetJourneyPanel() {
  const { cursor, playing, speed, mode, query, nodes: liveNodes, play, seek, setSpeed, setMode, setQuery } = useInternetJourneyStore();
  const journeyNodes = liveNodes.length ? liveNodes : internetJourneyNodes;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const current = useInternetJourneyStore.getState().cursor;
      if (current >= journeyNodes.length - 1) useInternetJourneyStore.getState().play(false);
      else useInternetJourneyStore.getState().seek(current + 1);
    }, 1000 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, journeyNodes.length]);

  const visible = journeyNodes.filter((node) =>
    !query || `${node.title} ${node.description} ${node.metadata.raw ?? ""} ${node.metadata.summary.map((item) => `${item.label} ${item.value}`).join(" ")}`
      .toLowerCase().includes(query.toLowerCase()));
  const nodes = visible.map((node) => ({
    id: node.id, type: "journey", data: { ...node, status: internetJourneyNodes.indexOf(node) < cursor ? "complete" : internetJourneyNodes.indexOf(node) === cursor ? "active" : "pending" },
    position: { x: journeyNodes.indexOf(node) * 330, y: 30 },
  }));
  const visibleIds = new Set(visible.map((node) => node.id));
  const edges = internetJourneyEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge, index) => ({
    ...edge, animated: index < cursor, markerEnd: { type: MarkerType.ArrowClosed, color: "#55d57d" },
    style: { stroke: index < cursor ? "#55d57d" : "#34404b", strokeWidth: 1.5 },
  }));

  return <main className="internet-journey">
    <header className="journey-header">
      <div><span><Globe2 size={14} /> Protocol learning module</span><h1>Internet Journey</h1><p>From URL input to the moment the browser receives an HTTP response.</p></div>
      <div className="journey-mode"><button className={mode === "education" ? "active" : ""} onClick={() => setMode("education")}>Educational</button><button className={mode === "developer" ? "active" : ""} onClick={() => setMode("developer")}>Developer</button></div>
    </header>
    <div className="journey-toolbar">
      <label><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, headers, DNS records, status…" /></label>
      <div className="journey-playback">
        <button onClick={() => seek(cursor - 1)} aria-label="Previous"><ChevronLeft size={14} /></button>
        <button onClick={() => play(!playing)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause" : "Play"}</button>
        <button onClick={() => seek(cursor + 1)} aria-label="Next"><ChevronRight size={14} /></button>
        {[.5, 1, 2].map((value) => <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value as .5 | 1 | 2)}>×{value}</button>)}
      </div>
    </div>
    <section className="journey-graph"><ReactFlow nodes={nodes} edges={edges} nodeTypes={{ journey: JourneyCard }} fitView minZoom={.3} maxZoom={1.3}><Background color="#23303b" gap={20} size={1} /><Controls /></ReactFlow></section>
    <section className="journey-waterfall">
      <header><strong>Request waterfall</strong><span>Total <b>170 ms</b></span></header>
      <div>{durations.map(([label, value]) => <span key={label}><small>{label}</small><i style={{ width: `${Math.max(4, value / 1.7)}%` }} /><b>{value} ms</b></span>)}</div>
    </section>
    <footer className="journey-boundary"><strong>Response received.</strong><span>Internet Journey stops here — no HTML, CSS, JavaScript, DOM, rendering, Event Loop or GPU processing.</span><button>Continue → Browser Journey</button></footer>
  </main>;
}
