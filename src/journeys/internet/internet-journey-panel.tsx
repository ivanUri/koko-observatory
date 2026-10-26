"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, getStraightPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleHelp, Globe2, Pause, Play, Search } from "lucide-react";
import { internetJourneyEdges, internetJourneyNodes } from "./data";
import { absentStageLabel, assessInternetJourney, waterfallReading } from "./project";
import { useInternetJourneyStore } from "./store";
import { useSelectionStore } from "@/src/stores";
import type { JourneyNode } from "./types";
import styles from "./internet-journey-panel.module.css";

const typeIcons: Record<JourneyNode["type"], string> = {
  url: "URL", dns: "DNS", connection: "TCP", tls: "TLS", http: "HTTP",
  routing: "NET", server: "SRV", response: "RES", boundary: "END",
};
const nodeTypes = { journey: JourneyCard };
const edgeTypes = { journey: JourneyEdge };

export function journeyDurationLabel(model: JourneyNode): string {
  const absent = absentStageLabel(model);
  if (absent) return absent;
  if (model.status === "pending") return "—";
  if (model.status === "error") return "Failed";
  if (model.status === "skipped") return "Skipped";
  if (model.status === "unavailable" || model.metadata.measurement === "unavailable") return "Unavailable";
  if (model.metadata.measurement === "reused") return "Reused";
  if (["cached", "derived", "estimated", "not-applicable", "not-applicable-replay"].includes(String(model.metadata.measurement ?? ""))) return String(model.metadata.measurement);
  if (model.metadata.measurement === "not-timed") return "Not timed";
  if (model.metadata.measurement === "boundary") return "Boundary";
  return `${model.metadata.estimated ? "~" : ""}${model.duration.toFixed(3)} ms`;
}

function measurementHint(model: JourneyNode): string {
  const absent = absentStageLabel(model);
  if (absent === "No redirect") return "The response completed without an HTTP redirect.";
  if (absent === "No proxy") return "The request did not use an HTTP proxy or CONNECT tunnel.";
  if (model.metadata.measurement === "not-timed") return "The stage exists, but core does not attach a duration source yet.";
  if (model.metadata.measurement === "unavailable") return "The browser or network layer cannot observe this signal.";
  if (model.metadata.measurement === "reused") return "Connection reused, so the browser did not remeasure this phase.";
  if (model.metadata.measurement === "boundary") return "Lifecycle boundary, not a timed phase.";
  return model.status === "pending" ? "Awaiting telemetry." : "Measured from telemetry.";
}

function developerDetails(model: JourneyNode) {
  let rawEvent: unknown;
  try {
    rawEvent = model.metadata.raw ? JSON.parse(model.metadata.raw) : undefined;
  } catch {
    rawEvent = model.metadata.raw;
  }
  const fieldMap: Record<string, string[]> = {
    "url-input": ["url"], "url-parse": ["url"], queue: ["journeyStage", "measurement"],
    cache: ["cacheDecision", "responseStatus", "etag", "age", "responseHeaders"], dns: ["primaryIp", "measurement"],
    routing: ["primaryIp", "usedProxy"], proxy: ["usedProxy", "primaryIp"],
    tcp: ["primaryIp", "connectionId", "numConnects", "connectionReused"],
    tls: ["httpVersion", "connectionId", "connectionReused"],
    request: ["method", "url", "redirectCount", "httpVersion", "requestHeaders"], redirect: ["redirectCount", "url"],
    server: ["responseStatus", "server", "via", "httpVersion"],
    response: ["responseStatus", "responseBodyBytes", "compressedSizeBytes", "uncompressedSizeBytes", "contentType", "contentEncoding", "cacheControl", "server", "etag", "responseHeaders"],
    received: ["responseStatus", "responseBodyBytes", "responseMemoryBytes", "responseMemoryState"],
  };
  const event = rawEvent && typeof rawEvent === "object" && "event" in rawEvent ? (rawEvent as { event?: unknown }).event : undefined;
  const payload = event && typeof event === "object" && "payload" in event ? (event as { payload?: unknown }).payload : undefined;
  const relevantPayload = payload && typeof payload === "object"
    ? Object.fromEntries((fieldMap[model.id] ?? []).filter((key) => key in payload).map((key) => [key, (payload as Record<string, unknown>)[key]]))
    : undefined;
  const eventIdentity = event && typeof event === "object" ? Object.fromEntries(["id", "name", "status", "sequence", "sessionId"].filter((key) => key in event).map((key) => [key, (event as Record<string, unknown>)[key]])) : undefined;
  return JSON.stringify({
    stage: {
      id: model.id,
      type: model.type,
      status: model.status,
      owner: model.type === "dns" || model.type === "connection" || model.type === "tls" ? "network transport" : model.type === "server" || model.type === "response" ? "HTTP transaction" : "browser request lifecycle",
    },
    timing: {
      durationMs: model.duration,
      timestamp: model.timestamp ? new Date(model.timestamp).toISOString() : null,
      measurement: model.metadata.measurement,
      estimated: model.metadata.estimated ?? false,
    },
    diagnostics: Object.fromEntries(model.metadata.summary.map((item) => [item.label, item.value])),
    signal: eventIdentity ? { ...eventIdentity, payload: relevantPayload } : "No typed telemetry event has been received for this stage.",
  }, null, 2);
}

function JourneyCard({ data }: NodeProps) {
  const model = data as unknown as JourneyNode & { highlighted?: boolean };
  const expanded = useInternetJourneyStore((state) => state.expanded === model.id);
  const toggle = useInternetJourneyStore((state) => state.toggle);
  const mode = useInternetJourneyStore((state) => state.mode);
  return <article className={`journey-node journey-node--${model.status}${model.highlighted ? " journey-node--cursor" : ""}`}>
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
        {model.metadata.issues.length > 0 && <><h4>Not included</h4><p>{model.metadata.issues.join(" ")}</p></>}
        {model.metadata.practices.length > 0 && <><h4>Best practices</h4><p>{model.metadata.practices.join(" ")}</p></>}
        <span className="journey-reference">{model.metadata.reference}</span>
      </> : <>
        <h4>Stage diagnostics</h4>
        <pre>{developerDetails(model)}</pre>
      </>}
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
  const edgeState = (props.data as { state?: "connected" | "failed" | "skipped" | "pending" } | undefined)?.state ?? "pending";
  const active = edgeState === "connected" ? "#55d57d" : edgeState === "failed" ? "#ef6f78" : edgeState === "skipped" ? "#704149" : "#34404b";
  return (
    <BaseEdge
      path={path}
      markerEnd={props.markerEnd}
      style={{ stroke: active, strokeWidth: 1.5, strokeLinecap: "round", strokeDasharray: "6 7" }}
    />
  );
}

export function InternetJourneyPanel() {
  const { cursor, playing, speed, mode, query, phase, recording, recordedEvents, revealedCount, executionId, otherTransfers, nodes: liveNodes, play, seek, setSpeed, setMode, setQuery, toggleRecording, revealNext } = useInternetJourneyStore();
  const selectEvidence = useSelectionStore((state) => state.select);
  const transferCount = otherTransfers?.length ?? 0;
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
      id: node.id, type: "journey", data: { ...node, highlighted: playing && index === cursor },
      position: positions.current[node.id] ?? { x: index * 330, y: 30 },
    };
  }), [visible, journeyNodes, cursor, playing]);
  const edges = useMemo(() => {
    const visibleIds = new Set(visible.map((node) => node.id));
    return internetJourneyEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => {
      const source = journeyNodes.find((node) => node.id === edge.source);
      const target = journeyNodes.find((node) => node.id === edge.target);
      const failed = source?.status === "error" || target?.status === "error";
      const skipped = !failed && (source?.status === "skipped" || target?.status === "skipped");
      const traversed = (status?: JourneyNode["status"]) => status === "complete" || status === "unavailable";
      const connected = !failed && !skipped && traversed(source?.status) && traversed(target?.status);
      const state = failed ? "failed" : skipped ? "skipped" : connected ? "connected" : "pending";
      const color = state === "connected" ? "#55d57d" : state === "failed" ? "#ef6f78" : state === "skipped" ? "#704149" : "#34404b";
      return {
        ...edge, type: "journey", data: { state }, animated: connected, markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
  }, [visible, journeyNodes]);
  const durations = useMemo(() => [
    ["Queue", journeyNodes.find((node) => node.id === "queue")],
    ["DNS", journeyNodes.find((node) => node.id === "dns")],
    ["TCP", journeyNodes.find((node) => node.id === "tcp")],
    ["TLS", journeyNodes.find((node) => node.id === "tls")],
    ["Request", journeyNodes.find((node) => node.id === "request")],
    ["Server", journeyNodes.find((node) => node.id === "server")],
    ["Transfer", journeyNodes.find((node) => node.id === "response")],
  ] as const, [journeyNodes]);
  const totalDuration = durations.reduce((total, [, node]) => total + (node?.status === "complete" && node.metadata.measurement === "measured" ? node.duration : 0), 0);
  const reading = useMemo(() => waterfallReading(journeyNodes), [journeyNodes]);
  const assessment = useMemo(() => assessInternetJourney(journeyNodes), [journeyNodes]);
  const explained = useMemo(() => journeyNodes.slice(0, revealedCount).filter((node) => node.metadata.estimated === false && (
    !query || `${node.title} ${node.metadata.explanation} ${node.metadata.issues.join(" ")}`.toLowerCase().includes(query.toLowerCase())
  )), [journeyNodes, query, revealedCount]);
  const failedNode = journeyNodes.find((node) => node.status === "error");
  const onNodeDragStop = useCallback((_: unknown, node: { id: string; position: { x: number; y: number } }) => {
    positions.current[node.id] = node.position;
  }, []);

  return <main className={`internet-journey ${styles.internetPage}`}>
    <header className="journey-header">
      <div><span><Globe2 size={14} /> Protocol learning module</span><h1>Internet Journey</h1><p>From URL input to the moment the browser receives an HTTP response.</p></div>
      <div className="journey-mode"><button className={mode === "education" ? "active" : ""} onClick={() => setMode("education")}>Educational</button><button className={mode === "developer" ? "active" : ""} onClick={() => setMode("developer")}>Developer</button></div>
    </header>
    <div className="journey-legend"><span><i className="legend-dot legend-dot--ok" /> Measured</span><span><i className="legend-dot legend-dot--warn" /> Not timed / unavailable</span><span><i className="legend-dot legend-dot--error" /> Failed</span><span><i className="legend-dot legend-dot--skipped" /> Skipped / not reached</span></div>
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
    {phase === "idle" ? <section className="journey-empty"><Globe2 size={22} /><strong>Inspect an Internet journey</strong><span>Enter a URL above to launch Koko and reveal each measured network step.</span></section> : <>
    <section className={`journey-assessment journey-assessment--${assessment.state}`}>
      <div className="journey-assessment__icon">{assessment.state === "attention" ? <AlertTriangle size={16} /> : assessment.state === "healthy" ? <CheckCircle2 size={16} /> : <Search size={16} />}</div>
      <div className="journey-assessment__body"><span className="journey-assessment__eyebrow">Transport assessment</span><strong>{assessment.headline}</strong><p>{assessment.summary}</p>
        <div className="journey-assessment__actions">
          {assessment.evidenceId && <button type="button" onClick={() => selectEvidence(assessment.evidenceId)}>Inspect evidence <ArrowUpRight size={12} /></button>}
          {executionId && <Link href={`/network?execution=${encodeURIComponent(executionId)}`}>Open Network <ArrowUpRight size={12} /></Link>}
        </div>
      </div>
      {assessment.value && <code>{assessment.value}</code>}
    </section>
    {executionId ? <p className="journey-scope"><span>Top-level document only. {transferCount} other {transferCount === 1 ? "transfer" : "transfers"} in this inspection.</span><Link href={`/network?execution=${encodeURIComponent(executionId)}`}>Open Network</Link></p> : null}
    <section className={`journey-graph journey-graph--${phase}`}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeDragStop={onNodeDragStop} fitView minZoom={.3} maxZoom={1.3}><Background color="#23303b" gap={20} size={1} /><Controls /></ReactFlow>
    </section>
    <section className="journey-waterfall">
      <header><strong>Request waterfall</strong><span>Total <b>{totalDuration ? `${totalDuration.toFixed(3)} ms` : "Awaiting telemetry"}</b></span></header>
      {reading ? <p className="journey-waterfall__reading">{reading}</p> : null}
      <div>{durations.map(([label, node]) => { const measured = node?.status === "complete" && node.metadata.measurement === "measured"; const value = measured ? node.duration : 0; const result = node?.status === "error" ? "Failed" : node?.status === "skipped" ? "Skipped" : node?.status === "unavailable" || node?.metadata.measurement === "unavailable" ? "Unavailable" : measured ? `${value.toFixed(3)} ms` : node?.metadata.measurement === "boundary" ? "Boundary" : "—"; return <span key={label} className={`journey-waterfall__row journey-waterfall__row--${node?.status ?? "pending"}`}><small>{label}</small><i style={{ width: `${totalDuration && value ? Math.max(2, value / totalDuration * 100) : 2}%` }} /><b>{result}</b></span>; })}</div>
    </section>
    {explained.length > 0 && <section className="journey-reading"><header><strong>What the timings say</strong></header><div>{explained.map((node) => <p key={node.id}><strong>{node.title}</strong><span>{node.metadata.explanation}</span>{node.metadata.issues.length > 0 && <small>{node.metadata.issues.join(" ")}</small>}</p>)}</div></section>}
    {phase === "error" && <footer className="journey-boundary journey-boundary--error"><strong>Journey stopped at {failedNode?.title ?? "an unknown stage"}.</strong><span>{failedNode?.id === "url-input" ? "The URL is invalid, so the request was not sent." : `Previous stages completed, but ${failedNode?.title ?? "the network operation"} failed. Later stages were not reached.`} Open the failed node for diagnostics.</span></footer>}
    {phase === "received" && revealedCount >= journeyNodes.length && <footer className="journey-boundary"><strong>Response received.</strong><span>Internet Journey stops here — no HTML, CSS, JavaScript, DOM, rendering, Event Loop or GPU processing.</span><button onClick={() => { window.location.href = "/browser-journey"; }}>Continue → Browser Journey</button></footer>}
    </>}
  </main>;
}
