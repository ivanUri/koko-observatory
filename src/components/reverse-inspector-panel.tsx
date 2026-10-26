"use client";

import dynamic from "next/dynamic";
import { Download, GitBranch, Play, RotateCcw, Square, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { observatoryBus } from "@/src/core/event-bus";
import { useAutomationStore } from "@/src/automation/store";
import type { AutomationAction, AutomationLocator, AutomationStep, InteractiveElementModel } from "@/src/automation/types";
import { useTelemetryStore, useUIStore } from "@/src/stores";
import { buildReverseTrace } from "@/src/reverse/model";
import { downloadReverseTrace } from "@/src/reverse/export";

const SourceEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export function ReverseInspectorPanel() {
  const events = useTelemetryStore((state) => state.events);
  const url = useUIStore((state) => state.inspectorUrl);
  const session = useAutomationStore((state) => state.session);
  const setSession = useAutomationStore((state) => state.setSession);
  const [action, setAction] = useState<AutomationAction>("click");
  const [locatorKind, setLocatorKind] = useState<AutomationLocator["kind"]>("css");
  const [locatorValue, setLocatorValue] = useState("a");
  const [value, setValue] = useState("");
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const trace = useMemo(() => buildReverseTrace(events, session.id), [events, session.id]);
  const selectedEvidence = trace.evidence.find((item) => item.id === selectedEvidenceId) ?? trace.evidence.at(-1);

  useEffect(() => observatoryBus.on("automation", (event) => {
    const payload = event.payload;
    if (event.name === "automation-session-started") {
      setSession({ status: "starting", id: String(payload.sessionId ?? "") });
    } else if (event.name === "automation-discovery-ready") {
      setSession({
        status: "ready",
        id: String(payload.sessionId ?? ""),
        url: typeof payload.url === "string" ? payload.url : undefined,
        title: typeof payload.title === "string" ? payload.title : undefined,
        snapshot: typeof payload.snapshot === "string" ? payload.snapshot : undefined,
        elements: Array.isArray(payload.elements) ? payload.elements as InteractiveElementModel[] : [],
      });
    } else if (event.name === "automation-step-started") {
      setSession({ status: "running", lastAction: String((payload.step as { action?: unknown } | undefined)?.action ?? "action") });
    } else if (event.name === "automation-step-completed") {
      setSession({ status: "ready" });
    } else if (event.name === "automation-step-failed") {
      setSession({ status: "ready", error: String(payload.error ?? "Action failed") });
    } else if (event.name === "automation-session-stopped") {
      setSession({ status: "stopped", id: undefined, elements: [] });
    }
  }), [setSession]);

  const send = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent("koko:automation", { detail }));
  const start = () => {
    setSession({ status: "starting", error: undefined });
    send({ type: "automation.start", url, reverse: true });
  };
  const stop = () => send({ type: "automation.stop" });
  const run = () => {
    if (session.status !== "ready" && session.status !== "running") return;
    const step: AutomationStep = {
      id: `reverse-action-${Date.now()}`,
      action,
      locator: action === "navigate" ? undefined : { kind: locatorKind, value: locatorValue },
      value: action === "navigate" || action === "fill" ? value || url : undefined,
      key: action === "press" ? value || "Enter" : undefined,
      status: "idle",
    };
    send({ type: "automation.execute", step });
  };

  return <main className="workspace reverse-workspace">
    <header className="workspace-header reverse-header">
      <div><span className="eyebrow">Evidence-driven runtime tracing</span><h1>Reverse Inspector</h1><p>Run one targeted browser action using the URL from the global inspector above.</p></div>
      <div className="reverse-header-actions"><span className={`automation-status automation-status--${session.status}`}><i />{session.status}</span>{session.status === "starting" || session.status === "running" ? <button type="button" onClick={stop}><Square size={13} />Stop</button> : <button type="button" className="automation-primary" onClick={start}><Play size={13} />Start reverse session</button>}</div>
    </header>

    <section className="panel-card reverse-control-card">
      <div className="reverse-control-grid"><label>Action<select value={action} onChange={(event) => setAction(event.target.value as AutomationAction)}><option value="click">Click</option><option value="fill">Fill</option><option value="press">Press</option><option value="scroll">Scroll</option><option value="navigate">Navigate</option></select></label><label>Locator kind<select value={locatorKind} onChange={(event) => setLocatorKind(event.target.value as AutomationLocator["kind"])}><option value="css">CSS</option><option value="role">Role</option><option value="id">ID</option><option value="name">Name</option><option value="placeholder">Placeholder</option></select></label><label>Locator / value<input value={locatorValue} onChange={(event) => setLocatorValue(event.target.value)} spellCheck={false} /></label>{["fill", "navigate", "press"].includes(action) && <label>{action === "press" ? "Key" : action === "navigate" ? "Text / URL" : "Text"}<input value={value} onChange={(event) => setValue(event.target.value)} placeholder={action === "press" ? "Enter" : undefined} spellCheck={false} /></label>}<button type="button" className="primary-button" onClick={run} disabled={session.status !== "ready" && session.status !== "running"}><Target size={14} />Capture action</button></div>
      <div className="reverse-session-meta"><span>{session.title || "No document title"}</span><small>{session.url || "Start a reverse session to navigate"}</small></div>
    </section>

    <section className="global-timeline-summary reverse-summary"><article><span>Observed evidence</span><strong>{trace.evidence.length}</strong><small>raw probe records</small></article><article><span>Graph nodes</span><strong>{trace.nodes.length}</strong><small>deduplicated runtime entities</small></article><article><span>Explicit causal</span><strong>{trace.edges.filter((edge) => edge.evidenceClass === "OBSERVED").length}</strong><small>runtime IDs matched</small></article><article><span>Correlated</span><strong>{trace.edges.filter((edge) => edge.evidenceClass === "CORRELATED").length}</strong><small>not proof of causality</small></article></section>

    <div className="reverse-layout"><section className="panel-card reverse-evidence-card"><header className="card-header"><div><h2><Target size={15} />Evidence</h2><p>Only observed runtime records are presented as observed.</p></div><div className="reverse-export-actions"><button type="button" onClick={() => downloadReverseTrace(trace, "json")}><Download size={13} />JSON</button><button type="button" onClick={() => downloadReverseTrace(trace, "markdown")}><Download size={13} />Report</button></div></header><div className="reverse-evidence-list">{trace.evidence.length ? trace.evidence.map((item) => <button type="button" key={item.id} className={item.id === selectedEvidence?.id ? "active" : ""} onClick={() => setSelectedEvidenceId(item.id)}><span className={`reverse-class reverse-class--${item.evidenceClass.toLowerCase()}`}>{item.evidenceClass}</span><strong>{item.kind}</strong><small>{new Date(item.timestamp).toLocaleTimeString()} · {item.actionId}</small></button>) : <div className="automation-empty"><Target size={20} /><strong>No reverse evidence yet</strong><span>Start the session, then capture an action.</span></div>}</div></section>

      <section className="panel-card reverse-graph-card"><header className="card-header"><div><h2><GitBranch size={15} />Execution graph</h2><p>Edges retain their provenance and confidence.</p></div><span className="reverse-schema-badge">schema v{trace.schemaVersion}</span></header><div className="reverse-graph-list">{trace.edges.length ? trace.edges.map((edge) => <div className="reverse-edge" key={edge.id}><strong>{edge.relation}</strong><span>{edge.source} → {edge.target}</span><small>{edge.evidenceClass} · {Math.round((edge.confidence ?? 0) * 100)}% · {edge.verificationStatus}</small></div>) : <div className="automation-empty">No graph edges can be proven from the current session.</div>}</div></section>

      <section className="panel-card reverse-source-card"><header className="card-header"><div><h2>Source evidence</h2><p>Stack/source locations are shown as evidence, never guessed function names.</p></div><button type="button" onClick={() => setSelectedEvidenceId(undefined)}><RotateCcw size={13} />Latest</button></header>{selectedEvidence ? <><div className="reverse-source-location"><strong>{selectedEvidence.sourceLocation?.functionName || "Runtime probe record"}</strong><span>{selectedEvidence.sourceLocation?.url || selectedEvidence.sourceLocation?.raw || "No source location captured"}</span></div><SourceEditor height="220px" language="text" theme="vs-dark" value={JSON.stringify(selectedEvidence.data, null, 2)} options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "off", wordWrap: "on", padding: { top: 12 } }} /></> : <div className="automation-empty">Select evidence to inspect its redacted payload.</div>}</section></div>

    <section className="panel-card reverse-limitations"><header className="card-header"><div><h2>Accuracy boundaries</h2><p>These are intentional limits, not inferred results.</p></div></header><ul>{trace.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section>
  </main>;
}
