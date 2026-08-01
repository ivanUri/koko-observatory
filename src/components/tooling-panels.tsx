"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, CirclePause, CirclePlay, Copy, Download, Search, Trash2 } from "lucide-react";
import type { TelemetryEvent, TelemetryKind } from "@/src/core/types";
import { useSelectionStore, useTelemetryStore } from "@/src/stores";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="tooling-loader">Loading editor…</div>,
});

export function InspectorPanel() {
  const events = useTelemetryStore((state) => state.events);
  const selectedId = useSelectionStore((state) => state.eventId);
  const select = useSelectionStore((state) => state.select);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | TelemetryKind>("all");
  const [view, setView] = useState<"overview" | "payload" | "raw">("overview");
  const [copied, setCopied] = useState(false);
  const selected = events.find((event) => event.id === selectedId) ?? events.at(-1);
  const filtered = useMemo(() => events.filter((event) => {
    if (kind !== "all" && event.kind !== kind) return false;
    if (!query.trim()) return true;
    return `${event.name} ${event.id} ${event.sessionId} ${event.sequence} ${compactPayload(event.payload)}`.toLowerCase().includes(query.toLowerCase());
  }).slice(-500).reverse(), [events, kind, query]);
  const sourceIndex = selected ? events.findIndex((event) => event.id === selected.id) : -1;
  const parent = selected?.parentId ? events.find((event) => event.id === selected.parentId) : undefined;
  const children = selected ? events.filter((event) => event.parentId === selected.id) : [];
  const copy = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(view === "payload" ? selected.payload : selected, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <main className="workspace inspector-workspace">
      <header className="workspace-header"><div><span className="eyebrow">Structured telemetry</span><h1>Event Inspector</h1><p>Inspect identity, timing, ownership, relationships and the complete typed payload of any normalized signal.</p></div><div className="inspector-nav"><button disabled={sourceIndex <= 0} onClick={() => select(events[sourceIndex - 1]?.id)}><ChevronLeft size={14}/> Previous</button><span>{sourceIndex < 0 ? "No selection" : `${sourceIndex + 1} / ${events.length}`}</span><button disabled={sourceIndex < 0 || sourceIndex >= events.length - 1} onClick={() => select(events[sourceIndex + 1]?.id)}>Next <ChevronRight size={14}/></button></div></header>
      <div className="inspector-layout">
        <aside className="inspector-events">
          <header><strong>Telemetry events</strong><small>Latest 500 matching signals</small></header>
          <label><Search size={13}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events…" aria-label="Search inspector events" /></label>
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} aria-label="Filter inspector subsystem"><option value="all">All subsystems</option>{(["navigation", "network", "dom", "javascript", "scheduler", "render", "memory", "log"] satisfies TelemetryKind[]).map((value) => <option key={value} value={value}>{value}</option>)}</select>
          <div className="inspector-event-list">{filtered.length ? filtered.map((event) => <button key={event.id} className={selected?.id === event.id ? "active" : ""} onClick={() => select(event.id)}><i className={`event-dot event-dot--${event.status}`}/><span><strong>{event.name}</strong><small>{event.kind} · #{event.sequence}</small></span><time>{shortTime(event.timestamp)}</time></button>) : <div className="inspector-list-empty">No matching events</div>}</div>
        </aside>

        <section className="inspector-detail">{selected ? <>
          <header className="inspector-detail__header"><div><span>{selected.kind} · {journeyForEvent(selected)}</span><h2>{selected.name}</h2><small>{selected.id}</small></div><div><b className={`status-text--${selected.status}`}>{selected.status}</b><button onClick={copy}><Copy size={13}/>{copied ? "Copied" : "Copy JSON"}</button></div></header>
          <div className="inspector-metrics"><InspectorFact label="Duration" value={formatConsoleDuration(selected.duration)} /><InspectorFact label="Sequence" value={`#${selected.sequence}`} /><InspectorFact label="Timestamp" value={new Date(selected.timestamp).toISOString()} /><InspectorFact label="Session" value={selected.sessionId} /></div>
          <nav className="inspector-tabs" role="tablist">{(["overview", "payload", "raw"] as const).map((tab) => <button key={tab} className={view === tab ? "active" : ""} onClick={() => setView(tab)} role="tab" aria-selected={view === tab}>{tab === "raw" ? "Raw event" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
          {view === "overview" ? <InspectorOverview event={selected} parent={parent} childEvents={children} onSelect={select} /> : <div className="inspector-editor"><Monaco height="560px" language="json" theme="vs-dark" value={JSON.stringify(view === "payload" ? selected.payload : selected, null, 2)} options={{ readOnly: true, minimap: { enabled: true }, fontSize: 12, lineNumbersMinChars: 3, padding: { top: 14 }, wordWrap: "on", folding: true }} /></div>}
        </> : <div className="inspector-empty"><strong>Waiting for telemetry</strong><span>Inspect a URL or connect the telemetry bridge, then select an event.</span></div>}</section>
      </div>
    </main>
  );
}

function InspectorOverview({ event, parent, childEvents, onSelect }: { event: TelemetryEvent; parent?: TelemetryEvent; childEvents: TelemetryEvent[]; onSelect: (id?: string) => void }) {
  const payload = event.payload;
  const facts = [
    ["Journey stage", payload.journeyStage ?? payload.browserStage ?? payload.systemStage ?? "Not attributed"],
    ["Process", payload.processName ?? payload.process ?? payload.processId ?? "Unavailable"],
    ["Thread", payload.threadName ?? payload.thread ?? payload.threadId ?? "Unavailable"],
    ["Frame", payload.frameId ?? "Unavailable"],
    ["Loader", payload.loaderId ?? "Unavailable"],
    ["URL", payload.url ?? payload.scriptUrl ?? "Unavailable"],
    ["Measurement", payload.measurementState ?? payload.measurement ?? "Unavailable"],
    ["Terminal status", payload.terminalStatus ?? event.status],
  ];
  const entries = Object.entries(payload);
  return <div className="inspector-overview">
    <section><header><strong>Ownership & attribution</strong><small>Normalized fields</small></header><dl>{facts.map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{String(value)}</dd></div>)}</dl></section>
    <section><header><strong>Causal relationships</strong><small>{childEvents.length} direct children</small></header><div className="inspector-relations"><div><span>Parent</span>{parent ? <button onClick={() => onSelect(parent.id)}><strong>{parent.name}</strong><small>{parent.id} · #{parent.sequence}</small></button> : <em>{event.parentId ? `Parent ${event.parentId} is outside the retained buffer` : "Root event — no parentId"}</em>}</div><div><span>Children</span>{childEvents.length ? childEvents.slice(0, 12).map((child) => <button key={child.id} onClick={() => onSelect(child.id)}><strong>{child.name}</strong><small>{child.kind} · #{child.sequence}</small></button>) : <em>No direct child event observed</em>}</div></div></section>
    <section className="inspector-field-section"><header><strong>Typed payload fields</strong><small>{entries.length} fields · values are not synthesized</small></header>{entries.length ? <div className="inspector-field-table">{entries.map(([key, value]) => <div key={key}><code>{key}</code><span>{payloadType(value)}</span><strong>{formatInspectorValue(value)}</strong></div>)}</div> : <div className="inspector-list-empty">This event has an empty payload.</div>}</section>
  </div>;
}

function InspectorFact({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function journeyForEvent(event: TelemetryEvent) { if (typeof event.payload.systemStage === "string" || event.kind === "memory") return "System Journey"; if (typeof event.payload.browserStage === "string" || ["dom", "javascript", "render"].includes(event.kind)) return "Browser Journey"; if (typeof event.payload.journeyStage === "string" || ["network", "navigation"].includes(event.kind)) return "Internet Journey"; return "Runtime"; }
function payloadType(value: unknown) { if (value === null) return "null"; if (Array.isArray(value)) return "array"; return typeof value; }
function formatInspectorValue(value: unknown) { if (value == null) return String(value); if (typeof value === "object") return JSON.stringify(value); return String(value); }
function shortTime(value: number) { return new Date(value).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

export function ConsolePanel() {
  const events = useTelemetryStore((state) => state.events);
  const transportStatus = useTelemetryStore((state) => state.status);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | TelemetryEvent["status"]>("all");
  const [kind, setKind] = useState<"all" | TelemetryKind>("all");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearedThrough, setClearedThrough] = useState(0);
  const [pausedEvents, setPausedEvents] = useState<TelemetryEvent[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const source = paused ? pausedEvents : events;
  const visible = useMemo(() => source.filter((event) => {
    if (event.sequence <= clearedThrough) return false;
    if (level !== "all" && event.status !== level) return false;
    if (kind !== "all" && event.kind !== kind) return false;
    if (!query.trim()) return true;
    const needle = query.toLowerCase();
    return `${event.name} ${event.kind} ${event.status} ${event.sessionId} ${event.sequence} ${compactPayload(event.payload)}`.toLowerCase().includes(needle);
  }).slice(-1_000), [clearedThrough, kind, level, query, source]);
  const counts = useMemo(() => source.reduce((result, event) => { result[event.status] += 1; return result; }, { ok: 0, warning: 0, error: 0 }), [source]);

  useEffect(() => {
    if (!paused && autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [autoScroll, paused, visible.length]);

  const togglePause = () => {
    if (!paused) setPausedEvents([...events]);
    setPaused((value) => !value);
  };
  const clear = () => {
    setClearedThrough(source.at(-1)?.sequence ?? clearedThrough);
    setExpanded(undefined);
  };
  const exportVisible = () => {
    const body = visible.map((event) => JSON.stringify(event)).join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `velora-console-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="workspace console-workspace">
      <header className="workspace-header"><div><span className="eyebrow">Runtime diagnostics</span><h1>Console</h1><p>Search normalized browser, worker, network and core diagnostics from the active telemetry buffer.</p></div><div className={`console-connection console-connection--${transportStatus}`}><i />{transportStatus}<strong>{events.length.toLocaleString()} buffered</strong></div></header>

      <section className="console-summary" aria-label="Console status summary">
        <ConsoleCount label="Visible" value={visible.length} tone="visible" />
        <ConsoleCount label="Normal" value={counts.ok} tone="ok" />
        <ConsoleCount label="Warnings" value={counts.warning} tone="warning" />
        <ConsoleCount label="Errors" value={counts.error} tone="error" />
      </section>

      <section className="console-shell">
        <div className="console-toolbar">
          <label className="console-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search message, payload, session or sequence…" aria-label="Search console" />{query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}</label>
          <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)} aria-label="Filter by status"><option value="all">All statuses</option><option value="ok">Normal</option><option value="warning">Warnings</option><option value="error">Errors</option></select>
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} aria-label="Filter by subsystem"><option value="all">All subsystems</option>{(["navigation", "network", "dom", "javascript", "scheduler", "render", "memory", "log"] satisfies TelemetryKind[]).map((value) => <option value={value} key={value}>{value}</option>)}</select>
          <button className={paused ? "console-action active" : "console-action"} onClick={togglePause}>{paused ? <CirclePlay size={14}/> : <CirclePause size={14}/>} {paused ? "Resume" : "Pause"}</button>
          <button className={autoScroll ? "console-action active" : "console-action"} onClick={() => setAutoScroll((value) => !value)}><ArrowDown size={14}/> Follow</button>
          <button className="console-action" onClick={clear}><Trash2 size={14}/> Clear view</button>
          <button className="console-action" onClick={exportVisible} disabled={!visible.length}><Download size={14}/> Export JSONL</button>
        </div>

        <div className="console-columns" aria-hidden="true"><span>Time</span><span>Level</span><span>Subsystem</span><span>Message</span><span>Duration</span><span>Sequence</span></div>
        <div className="console-stream" ref={scrollRef} role="log" aria-live={paused ? "off" : "polite"}>
          {!visible.length && <div className="console-empty"><strong>{events.length ? "No events match this view" : "Waiting for telemetry"}</strong><span>{events.length ? "Change filters or clear the search query." : "Inspect a URL or connect the core telemetry bridge to populate the console."}</span></div>}
          {visible.map((event) => <ConsoleEntry key={event.id} event={event} open={expanded === event.id} onToggle={() => setExpanded((value) => value === event.id ? undefined : event.id)} />)}
        </div>
        <footer className="console-footer"><span>{paused ? `Paused at ${pausedEvents.at(-1)?.sequence ?? "—"}` : "Live view"}</span><span>Showing {visible.length.toLocaleString()} of {Math.max(0, source.filter((event) => event.sequence > clearedThrough).length).toLocaleString()} events · capped at 1,000 rendered rows</span></footer>
      </section>
    </main>
  );
}

function ConsoleEntry({ event, open, onToggle }: { event: TelemetryEvent; open: boolean; onToggle: () => void }) {
  const select = useSelectionStore((state) => state.select);
  return <article className={`console-entry console-entry--${event.status}`}>
    <button className="console-entry__line" onClick={onToggle} aria-expanded={open}>
      <time>{formatConsoleTime(event.timestamp)}</time><span className="console-level">{event.status === "ok" ? "INFO" : event.status.toUpperCase()}</span><span className="console-kind">{event.kind}</span><strong>{event.name}</strong><span>{formatConsoleDuration(event.duration)}</span><code>#{event.sequence}</code>
    </button>
    {open && <div className="console-entry__detail"><div><span>Session</span><code>{event.sessionId}</code></div><div><span>Event ID</span><code>{event.id}</code></div><div><span>Parent</span><code>{event.parentId ?? "None"}</code></div><pre>{JSON.stringify(event.payload, null, 2)}</pre><Link href="/inspector" onClick={() => select(event.id)}>Open in Event Inspector →</Link></div>}
  </article>;
}

function ConsoleCount({ label, value, tone }: { label: string; value: number; tone: string }) { return <article className={`console-count console-count--${tone}`}><span>{label}</span><strong>{value.toLocaleString()}</strong></article>; }
function compactPayload(payload: Record<string, unknown>) { try { return JSON.stringify(payload); } catch { return "[unserializable payload]"; } }
function formatConsoleTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }); }
function formatConsoleDuration(duration: number) { return duration < 1 ? `${duration.toFixed(3)} ms` : `${duration.toFixed(2)} ms`; }
