"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bookmark, CheckCircle2, CircleDot, Code2, GitBranch, PlayCircle, RotateCcw, Search, ShieldCheck, SlidersHorizontal, SquareArrowOutUpRight, XCircle } from "lucide-react";
import { useSelectionStore, useTelemetryStore } from "@/src/stores";
import { useExecutionStore } from "@/src/executions/store";
import { executionIdFor, type CheckpointRecord, type ExecutionCapability, type ReplayMode, type ReplayOverride } from "@/src/executions/types";
import type { TelemetryEvent } from "@/src/core/types";

const controlledCapabilities: ExecutionCapability[] = ["checkpoint-reconstruct", "network-replay", "branching"];
const replayPresentationMs = 2_800;

type ReplayPresentation = { phase: "preparing" | "running" | "completed" | "failed"; startedAt: number; executionId?: string };
type ReplayInput = { key: string; method: string; url: string; status: number; body: string; headers: string; resourceType: string; event: TelemetryEvent; occurrences: number };

function inputKey(event: TelemetryEvent) {
  const method = typeof event.payload.method === "string" ? event.payload.method : "GET";
  const url = typeof event.payload.url === "string" ? event.payload.url : "";
  return `${method}\n${url}`;
}

function parseHeaderText(value: string) {
  return value.replaceAll("\\n", "\n").split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [];
    const name = line.slice(0, separator).trim();
    return name ? [{ name, value: line.slice(separator + 1).trim() }] : [];
  });
}

function capturedInputs(events: TelemetryEvent[]): ReplayInput[] {
  const inputs = new Map<string, ReplayInput>();
  for (const event of events) {
    const payload = event.payload;
    if (payload.journeyStage !== "response" || payload.bodyCaptureState !== "captured" || payload.bodyTruncated === true || typeof payload.responseBody !== "string" || typeof payload.url !== "string") continue;
    const method = typeof payload.method === "string" ? payload.method : "GET";
    const key = inputKey(event);
    const existing = inputs.get(key);
    inputs.set(key, {
      key,
      method,
      url: payload.url,
      status: typeof payload.responseStatus === "number" && payload.responseStatus > 0 ? payload.responseStatus : 200,
      body: payload.responseBody,
      headers: typeof payload.responseHeaders === "string" ? payload.responseHeaders : "",
      resourceType: typeof payload.resourceType === "string" ? payload.resourceType : "other",
      event,
      occurrences: (existing?.occurrences ?? 0) + 1,
    });
  }
  return [...inputs.values()].sort((a, b) => a.event.sequence - b.event.sequence);
}

function ReplayReadiness({ checkpoint, inputs, mode, canReplay, pending, onReplay }: { checkpoint?: CheckpointRecord; inputs: ReplayInput[]; mode: ReplayMode; canReplay: boolean; pending: boolean; onReplay: () => void }) {
  const checks = [
    { ok: Boolean(checkpoint?.replayable), label: "Restorable checkpoint", detail: checkpoint?.replayable ? "Cookies and web storage can be restored by Core." : "Inspect the URL again with checkpoint capture enabled." },
    { ok: inputs.length > 0, label: "Captured response inputs", detail: inputs.length ? `${inputs.length} unique text responses are available for editing or replay.` : "No complete text response bodies were captured." },
    { ok: mode === "strict", label: "Network safety", detail: mode === "strict" ? "Uncaptured requests are blocked." : "Uncaptured requests may reach the network." },
  ];
  return <div className="replay-readiness"><div className="replay-readiness__checks">{checks.map((check) => <div key={check.label} className={`replay-readiness__item replay-readiness__item--${check.ok ? "ok" : "missing"}`}><span className="replay-readiness__icon">{check.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></div>)}</div><div className="replay-readiness__action"><button type="button" className={`replay-readiness__btn${canReplay ? " replay-readiness__btn--ready" : ""}`} disabled={!canReplay || pending} onClick={onReplay} title={canReplay ? "Run this replay plan" : "Complete the readiness checks first"}><PlayCircle size={14} />{pending ? "Starting replay…" : "Run replay plan"}</button>{!canReplay && <p className="replay-readiness__hint">A replayable checkpoint and at least one captured response are required.</p>}</div></div>;
}

function ReplayTransition({ presentation }: { presentation: ReplayPresentation }) {
  const copy = presentation.phase === "preparing" ? ["Preparing replay", "Restoring the selected checkpoint and validating the replay plan."] : presentation.phase === "running" ? ["Replaying controlled inputs", "Core is serving the selected and overridden responses."] : presentation.phase === "completed" ? ["Replay completed", `Execution ${presentation.executionId ?? "replay"} is ready to inspect.`] : ["Replay stopped", "Inspect the replay execution for the blocked request or breakpoint."];
  return <div className={`replay-transition replay-transition--${presentation.phase}`} role="status" aria-live="polite"><span className="replay-transition__pulse"><PlayCircle size={15} /></span><div><strong>{copy[0]}</strong><p>{copy[1]}</p><span className="replay-transition__track"><i /></span></div></div>;
}

function BranchExplanation({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return <div className="branch-explanation"><button type="button" className="branch-explanation__toggle" onClick={onToggle} aria-expanded={visible}>What is a branch? <span>{visible ? "▲" : "▼"}</span></button>{visible && <div className="branch-explanation__body"><p>A branch keeps a separate history reference from a checkpoint so the original recording stays immutable.</p><p>At present it is a view-only artifact. It does not start a second live browser process; use a replay plan for controlled execution.</p></div>}</div>;
}

export function ExecutionPanel() {
  const telemetry = useTelemetryStore((state) => state.events);
  const selectedEventId = useSelectionStore((state) => state.eventId);
  const selectEvent = useSelectionStore((state) => state.select);
  const executions = useExecutionStore((state) => state.executions);
  const checkpoints = useExecutionStore((state) => state.checkpoints);
  const branches = useExecutionStore((state) => state.branches);
  const activeExecutionId = useExecutionStore((state) => state.activeExecutionId);
  const hydrate = useExecutionStore((state) => state.hydrate);
  const selectExecution = useExecutionStore((state) => state.select);
  const bookmark = useExecutionStore((state) => state.bookmark);
  const createViewBranch = useExecutionStore((state) => state.createViewBranch);
  const [sourceExecutionId, setSourceExecutionId] = useState<string>();
  const [selectedInputKey, setSelectedInputKey] = useState<string>();
  const [search, setSearch] = useState("");
  const [resourceFilter, setResourceFilter] = useState("all");
  const [mode, setMode] = useState<ReplayMode>("strict");
  const [disabledKeys, setDisabledKeys] = useState<string[]>([]);
  const [breakpointKeys, setBreakpointKeys] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ReplayOverride>>({});
  const [replayPending, setReplayPending] = useState(false);
  const [replayPresentation, setReplayPresentation] = useState<ReplayPresentation>();
  const [branchExplanationVisible, setBranchExplanationVisible] = useState(false);
  const [planMessage, setPlanMessage] = useState<string>();
  const [newBranchKey, setNewBranchKey] = useState<string>();

  useEffect(() => { void hydrate(); }, [hydrate]);
  const active = executions.find((execution) => execution.id === activeExecutionId) ?? executions[0];
  useEffect(() => { if (!sourceExecutionId && active && !active.id.startsWith("replay-")) setSourceExecutionId(active.id); }, [active, sourceExecutionId]);
  const source = executions.find((execution) => execution.id === sourceExecutionId) ?? active;
  const sourceEvents = useMemo(() => source ? telemetry.filter((event) => executionIdFor(event) === source.id) : [], [source, telemetry]);
  const inputs = useMemo(() => capturedInputs(sourceEvents), [sourceEvents]);
  const inputKinds = useMemo(() => [...new Set(inputs.map((input) => input.resourceType))], [inputs]);
  const filteredInputs = useMemo(() => inputs.filter((input) => (!search || `${input.method} ${input.url}`.toLowerCase().includes(search.toLowerCase())) && (resourceFilter === "all" || input.resourceType === resourceFilter)), [inputs, resourceFilter, search]);
  useEffect(() => { if (!selectedInputKey || !inputs.some((input) => input.key === selectedInputKey)) setSelectedInputKey(inputs[0]?.key); }, [inputs, selectedInputKey]);
  const selectedInput = inputs.find((input) => input.key === selectedInputKey);
  const sourceCheckpoints = checkpoints.filter((checkpoint) => checkpoint.executionId === source?.id);
  const selectedCheckpoint = sourceCheckpoints.find((checkpoint) => checkpoint.kind === "reconstructible");
  const sourceBranches = branches.filter((branch) => branch.parentExecutionId === source?.id);
  const selectedEvent = sourceEvents.find((event) => event.id === selectedEventId);
  const replayError = active?.id.startsWith("replay-") ? telemetry.filter((event) => executionIdFor(event) === active.id).map((event) => event.payload.replayError).find((value): value is string => typeof value === "string") : undefined;
  const canReplay = Boolean(source && selectedCheckpoint?.replayable && inputs.length && !replayPending && !source.id.startsWith("replay-"));

  useEffect(() => {
    if (replayError) { setReplayPending(false); setReplayPresentation((current) => current ? { ...current, phase: "failed" } : current); setPlanMessage(replayError); return; }
    if (!active?.id.startsWith("replay-")) return;
    setReplayPending(false);
    const phase = active.status === "failed" ? "failed" : active.status === "completed" ? "completed" : "running";
    setReplayPresentation((current) => current ? { ...current, phase, executionId: active.id } : current);
  }, [active?.id, active?.status, replayError]);
  useEffect(() => { if (!replayPresentation || !["completed", "failed"].includes(replayPresentation.phase)) return; const remaining = Math.max(0, replayPresentationMs - (Date.now() - replayPresentation.startedAt)); const timeout = window.setTimeout(() => setReplayPresentation(undefined), remaining + 1_200); return () => window.clearTimeout(timeout); }, [replayPresentation]);

  const updateOverride = (key: string, patch: Partial<ReplayOverride>) => setOverrides((current) => ({ ...current, [key]: { ...current[key], ...patch, key } }));
  const resetOverride = (key: string) => setOverrides((current) => { const next = { ...current }; delete next[key]; return next; });
  const toggleKey = (key: string, collection: string[], setCollection: (value: string[]) => void) => setCollection(collection.includes(key) ? collection.filter((item) => item !== key) : [...collection, key]);
  const replay = () => {
    if (!source || !selectedCheckpoint || !canReplay) return;
    const plan = { mode, disabledKeys, overrides: Object.values(overrides), breakpoints: breakpointKeys.map((key) => ({ key, label: "network breakpoint" })) };
    setReplayPending(true); setPlanMessage(`Plan validated: ${inputs.length - disabledKeys.length} responses enabled, ${Object.keys(overrides).length} overrides, ${breakpointKeys.length} breakpoints.`); setReplayPresentation({ phase: "preparing", startedAt: Date.now() });
    window.dispatchEvent(new CustomEvent("koko:execution-replay", { detail: { executionId: source.id, checkpointId: selectedCheckpoint.id, replayPlan: plan } }));
  };
  const validatePlan = () => setPlanMessage(`${inputs.length} captured inputs · ${disabledKeys.length} disabled · ${Object.keys(overrides).length} edited · ${breakpointKeys.length} breakpoint${breakpointKeys.length === 1 ? "" : "s"}. ${mode === "strict" ? "No uncaptured network request will be allowed." : "Fallback mode can contact the network."}`);
  const handleBranch = () => { if (!source) return; createViewBranch(selectedCheckpoint?.id); const key = `branch:${source.id}:${Date.now()}`; setNewBranchKey(key); setTimeout(() => setNewBranchKey(undefined), 3_000); };

  return <main className="workspace">
    <header className="workspace-header"><div><span className="eyebrow">Controlled execution</span><h1>Replay Studio</h1><p>Inspect a recorded flow, edit its captured inputs, place network breakpoints, then run a safe replay from a Core checkpoint.</p></div><div className="workspace-header__actions"><span className={`checkpoint-badge checkpoint-badge--${badgeState}`}><ShieldCheck size={13} />{badgeState === "replayable" ? "Replayable" : "Capture required"}</span></div></header>
    <section className="global-timeline-summary"><article><span>Source execution</span><strong>{source ? source.id : "—"}</strong><small>{source?.status ?? "waiting for telemetry"}</small></article><article><span>Captured inputs</span><strong>{inputs.length}</strong><small>{inputs.reduce((sum, input) => sum + input.occurrences, 0)} response events</small></article><article><span>Plan changes</span><strong>{Object.keys(overrides).length + disabledKeys.length}</strong><small>{Object.keys(overrides).length} edited · {disabledKeys.length} disabled</small></article><article><span>Breakpoints</span><strong>{breakpointKeys.length}</strong><small>stop before response fulfillment</small></article></section>
    <section className="panel-card"><header className="card-header"><div><h2><CircleDot size={15} />1. Choose a recorded flow</h2><p>The source stays immutable. Replay always creates a new execution.</p></div></header><label><span className="eyebrow">Source execution</span><select className="select-control" value={source?.id ?? ""} onChange={(event) => { setSourceExecutionId(event.target.value || undefined); selectExecution(event.target.value || undefined); }}><option value="">Waiting for telemetry…</option>{executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.id} · {execution.status} · {execution.eventCount} events</option>)}</select></label>{source && <div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>URL</span><span>Fidelity</span><span>Capabilities</span><span>Latest</span><span>Status</span></div><div className="event-row" role="row"><span title={String(sourceEvents.find((event) => typeof event.payload.requestedUrl === "string")?.payload.requestedUrl ?? "")}>{String(sourceEvents.find((event) => typeof event.payload.requestedUrl === "string")?.payload.requestedUrl ?? "Unavailable")}</span><span>{source.fidelity}</span><span>{source.capabilities.filter((capability) => controlledCapabilities.includes(capability)).join(", ") || "recording only"}</span><span className="mono">#{source.latestSequence}</span><span className={`status-text status-text--${source.status === "failed" ? "error" : "ok"}`}>{source.status}</span></div></div>}</section>
    <section className="panel-card"><header className="card-header"><div><h2><SlidersHorizontal size={15} />2. Build the replay plan</h2><p>Every change below is applied to a new local policy file. The original telemetry and checkpoint are never modified.</p></div></header><div className="replay-plan-toolbar"><div><strong>Network mode</strong><p className="muted-copy">Strict is recommended for deterministic debugging.</p></div><label className="replay-mode-option"><input type="radio" name="replay-mode" checked={mode === "strict"} onChange={() => setMode("strict")} /><span><b>Strict</b><small>block uncaptured requests</small></span></label><label className="replay-mode-option replay-mode-option--warning"><input type="radio" name="replay-mode" checked={mode === "fallback"} onChange={() => setMode("fallback")} /><span><b>Fallback</b><small>allow real network misses</small></span></label><button type="button" onClick={validatePlan}><ShieldCheck size={14} />Validate plan</button></div>{mode === "fallback" && <div className="replay-warning"><AlertTriangle size={14} /><span>Fallback mode can create side effects and makes the result non-deterministic. Use it only for diagnosing a missing capture.</span></div>}<div className="replay-input-layout"><div className="replay-input-list"><div className="replay-input-list__toolbar"><label><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter URL or method…" /></label><select className="select-control" value={resourceFilter} onChange={(event) => setResourceFilter(event.target.value)}><option value="all">All resources</option>{inputKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></div><div className="replay-input-list__head"><span>Response inputs</span><span>{filteredInputs.length} shown</span></div>{filteredInputs.map((input) => <button type="button" key={input.key} className={`replay-input-row${input.key === selectedInputKey ? " replay-input-row--selected" : ""}`} onClick={() => { setSelectedInputKey(input.key); selectEvent(input.event.id); }}><span className="replay-input-row__toggle"><input type="checkbox" checked={!disabledKeys.includes(input.key)} onChange={(event) => { event.stopPropagation(); toggleKey(input.key, disabledKeys, setDisabledKeys); }} onClick={(event) => event.stopPropagation()} aria-label={`Enable ${input.url}`} /><i className={`event-dot event-dot--${input.event.status}`} /></span><span className="replay-input-row__main"><strong>{input.method} {input.url}</strong><small>{input.resourceType} · {input.occurrences} capture{input.occurrences === 1 ? "" : "s"} · {input.body.length.toLocaleString()} bytes</small></span><span className="replay-input-row__flags">{overrides[input.key] && <span title="Edited response"><Code2 size={13} /></span>}{breakpointKeys.includes(input.key) && <span title="Breakpoint"><CircleDot size={13} /></span>}</span></button>)}{!filteredInputs.length && <div className="empty-row">No complete response inputs match this filter.</div>}</div><div className="replay-input-editor">{selectedInput ? <><div className="replay-input-editor__header"><div><span className="eyebrow">Selected response</span><h3>{selectedInput.method} {selectedInput.url}</h3><p>{selectedInput.resourceType} · captured at event #{selectedInput.event.sequence}</p></div><button type="button" onClick={() => resetOverride(selectedInput.key)} disabled={!overrides[selectedInput.key]} title="Discard edits"><RotateCcw size={14} />Reset edits</button></div><div className="replay-editor-grid"><label><span>Response status</span><input type="number" min="100" max="599" value={overrides[selectedInput.key]?.status ?? selectedInput.status} onChange={(event) => updateOverride(selectedInput.key, { status: Number(event.target.value) })} /></label><label><span>Breakpoint</span><button type="button" className={breakpointKeys.includes(selectedInput.key) ? "toggle-button toggle-button--active" : "toggle-button"} onClick={() => toggleKey(selectedInput.key, breakpointKeys, setBreakpointKeys)}><CircleDot size={13} />{breakpointKeys.includes(selectedInput.key) ? "Stop before this response" : "Add network breakpoint"}</button></label></div><label className="replay-body-editor"><span>Response body override <small>JSON/text is sent exactly as entered</small></span><textarea value={overrides[selectedInput.key]?.body ?? selectedInput.body} onChange={(event) => updateOverride(selectedInput.key, { body: event.target.value })} spellCheck={false} /></label><label className="replay-body-editor replay-header-editor"><span>Response headers override <small>One `Name: value` pair per line</small></span><textarea value={overrides[selectedInput.key]?.headers?.map((header) => `${header.name}: ${header.value}`).join("\n") ?? selectedInput.headers} onChange={(event) => updateOverride(selectedInput.key, { headers: parseHeaderText(event.target.value) })} spellCheck={false} /></label><div className="replay-input-editor__contract"><ShieldCheck size={14} /><span>{disabledKeys.includes(selectedInput.key) ? "This response is disabled. Strict replay will fail if the page requests it." : breakpointKeys.includes(selectedInput.key) ? "Replay will stop before this response is fulfilled." : "This response will be fulfilled locally from the captured body."}</span></div></> : <div className="global-timeline-detail__empty"><strong>Select a captured response</strong><span>Use the list to edit a response or add a breakpoint.</span></div>}</div></div></section>
    <section className="panel-card"><header className="card-header"><div><h2><PlayCircle size={15} />3. Execute and inspect</h2><p>Run the plan from the selected checkpoint. A breakpoint stops before a matching network response; remove it and run again to continue deterministically from the checkpoint.</p></div></header><ReplayReadiness checkpoint={selectedCheckpoint} inputs={inputs} mode={mode} canReplay={canReplay} pending={replayPending} onReplay={replay} />{planMessage && <p className="execution-replay-summary">{planMessage}</p>}{replayPresentation && <ReplayTransition presentation={replayPresentation} />}{active?.id.startsWith("replay-") && <div className="replay-result-card"><div><span className="eyebrow">Latest replay execution</span><strong>{active.id}</strong><small>parent: {source?.id ?? "unknown"} · {active.eventCount} events · {active.status}</small></div><Link href={`/network?execution=${encodeURIComponent(active.id)}`} onClick={() => selectExecution(active.id)}><SquareArrowOutUpRight size={14} />View network</Link></div>}{replayError && <div className="replay-warning"><AlertTriangle size={14} /><span>{replayError}</span></div>}</section>
    <section className="panel-card"><header className="card-header"><div><h2><Code2 size={15} />Recorded flow timeline</h2><p>Select an event to inspect its full payload in Event Inspector. This is the exact sequence that produced the captured inputs.</p></div><span className="eyebrow">{sourceEvents.length} events</span></header><div className="event-table replay-flow-table" role="table"><div className="event-row event-row--header" role="row"><span>Event</span><span>Journey</span><span>Time</span><span>Duration</span><span>Status</span></div>{sourceEvents.slice(-160).reverse().map((event) => <button type="button" className={`event-row replay-flow-row${selectedEventId === event.id ? " replay-flow-row--selected" : ""}`} role="row" key={event.id} onClick={() => selectEvent(event.id)}><span><i className={`event-dot event-dot--${event.status}`} />{event.name}</span><span>{event.kind}{typeof event.payload.journeyStage === "string" ? ` · ${event.payload.journeyStage}` : ""}</span><span className="mono">#{event.sequence}</span><span className="mono">{event.duration.toFixed(2)} ms</span><span className={`status-text status-text--${event.status}`}>{event.status}</span></button>)}{!sourceEvents.length && <div className="empty-row">Inspect a URL to record a flow.</div>}</div>{selectedEvent && <details className="replay-event-details" open><summary>Selected event payload · #{selectedEvent.sequence}</summary><pre>{JSON.stringify(selectedEvent.payload, null, 2)}</pre></details>}</section>
    <section className="panel-card"><header className="card-header"><div><h2><Bookmark size={15} />Bookmarks and branches</h2><p>Bookmarks are timeline markers. Branches are currently view-only metadata; they do not start a browser process.</p></div></header><div className="global-timeline-filters"><button type="button" className="primary-button" onClick={() => bookmark(selectedEvent)} disabled={!source}>Create bookmark{selectedEvent ? ` at #${selectedEvent.sequence}` : " at latest event"}</button><button type="button" onClick={handleBranch} disabled={!source}><GitBranch size={14} />Create view branch</button><BranchExplanation visible={branchExplanationVisible} onToggle={() => setBranchExplanationVisible((value) => !value)} /></div>{sourceBranches.length > 0 && <div className="event-table execution-branch-list" role="table"><div className="event-row event-row--header" role="row"><span>Branch</span><span>Mode</span><span>Checkpoint</span><span>Overrides</span><span>Created</span></div>{sourceBranches.map((branch) => <div className={`event-row${newBranchKey && branch.id.startsWith(newBranchKey.split(":").slice(0, 2).join(":")) ? " execution-branch--new" : ""}`} role="row" key={branch.id}><span className="mono">{branch.id.split(":").at(-1)}</span><span>{branch.mode}</span><span className="mono">{branch.checkpointId?.split(":").at(-1) ?? "latest"}</span><span>{branch.overrides}</span><span>{new Date(branch.createdAt).toLocaleTimeString()}</span></div>)}</div>}</section>
    <section className="panel-card"><header className="card-header"><div><h2><ShieldCheck size={15} />Replay contract</h2><p>What this page guarantees and where the boundary is.</p></div></header><div className="replay-contract-grid"><article><strong>Restored</strong><span>Cookies and web storage from the Core checkpoint.</span></article><article><strong>Editable</strong><span>Captured response status, headers and body per URL/method.</span></article><article><strong>Breakpoints</strong><span>Network request boundaries before a captured response is fulfilled.</span></article><article><strong>Not restored</strong><span>V8 heap, timers, workers, Cache Storage and server-side sessions.</span></article></div></section>
  </main>;
}
