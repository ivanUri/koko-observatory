"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleStop, Compass, GripVertical, ListRestart, MousePointer2, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { observatoryBus } from "@/src/core/event-bus";
import { useAutomationStore } from "@/src/automation/store";
import type { AutomationAction, AutomationEvent, AutomationLocator, AutomationStep, InteractiveElementModel } from "@/src/automation/types";

const actions: Array<{ value: AutomationAction; label: string }> = [
  { value: "navigate", label: "Navigate" },
  { value: "click", label: "Click" },
  { value: "fill", label: "Fill" },
  { value: "select", label: "Select option" },
  { value: "check", label: "Set checked" },
  { value: "press", label: "Press key" },
  { value: "hover", label: "Hover" },
  { value: "scroll", label: "Scroll" },
  { value: "wait", label: "Wait for selector" },
];

const locatorKinds: AutomationLocator["kind"][] = ["css", "role", "id", "name", "placeholder"];

export function AutomationPanel() {
  const workflows = useAutomationStore((state) => state.workflows);
  const activeWorkflowId = useAutomationStore((state) => state.activeWorkflowId);
  const session = useAutomationStore((state) => state.session);
  const hydrated = useAutomationStore((state) => state.hydrated);
  const hydrate = useAutomationStore((state) => state.hydrate);
  const createWorkflow = useAutomationStore((state) => state.createWorkflow);
  const updateWorkflow = useAutomationStore((state) => state.updateWorkflow);
  const deleteWorkflow = useAutomationStore((state) => state.deleteWorkflow);
  const selectWorkflow = useAutomationStore((state) => state.selectWorkflow);
  const addStep = useAutomationStore((state) => state.addStep);
  const updateStep = useAutomationStore((state) => state.updateStep);
  const removeStep = useAutomationStore((state) => state.removeStep);
  const moveStep = useAutomationStore((state) => state.moveStep);
  const markStep = useAutomationStore((state) => state.markStep);
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [selectedElement, setSelectedElement] = useState<InteractiveElementModel>();
  const [discoveryFilter, setDiscoveryFilter] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(true);

  const workflow = workflows.find((item) => item.id === activeWorkflowId);
  const selectedStep = workflow?.steps.find((step) => step.id === selectedStepId) ?? workflow?.steps[0];
  const filteredElements = useMemo(() => {
    const query = discoveryFilter.trim().toLowerCase();
    if (!query) return session.elements;
    return session.elements.filter((element) => [element.role, element.name, element.tagName, element.id, element.class, element.placeholder, element.elementName].some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [discoveryFilter, session.elements]);

  useEffect(() => { void hydrate(); }, [hydrate]);
  useEffect(() => {
    const unsubscribe = observatoryBus.on("automation", (event) => {
      applyAutomationEvent(event);
    });
    return () => { unsubscribe(); };
  }, [markStep, updateWorkflow]);

  if (!workflow) return <main className="workspace automation-workspace"><div className="automation-empty"><strong>{hydrated ? "No saved workflows" : "Loading automation workspace…"}</strong>{hydrated && <button type="button" className="automation-primary" onClick={() => createWorkflow("https://example.com")}><Plus size={13} />Create workflow</button>}</div></main>;

  const send = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent("koko:automation", { detail }));
  const start = () => {
    useAutomationStore.getState().setSession({ status: "starting", error: undefined });
    updateWorkflow({ startUrl: workflow.startUrl, lastRunStatus: "running", lastError: undefined });
    send({ type: "automation.start", url: workflow.startUrl });
  };
  const stop = () => send({ type: "automation.stop" });
  const discover = () => send({ type: "automation.discover" });
  const runStep = (step: AutomationStep, retry = false) => {
    if (session.status !== "ready" && session.status !== "running") return;
    send({ type: retry ? "automation.retry" : "automation.execute", step });
  };
  const runWorkflow = () => {
    if (!workflow.steps.length || (session.status !== "ready" && session.status !== "running")) return;
    updateWorkflow({ lastRunStatus: "running", lastError: undefined });
    send({ type: "automation.run", steps: workflow.steps });
  };
  const add = (action: AutomationAction) => {
    const step = defaultStep(action, workflow.startUrl);
    addStep(step);
    setSelectedStepId(step.id);
  };
  const useElement = () => {
    if (!selectedElement || !selectedStep || selectedStep.action === "navigate") return;
    updateStep(selectedStep.id, { locator: locatorFromElement(selectedElement) });
  };

  return (
    <main className="workspace automation-workspace">
      <header className="workspace-header automation-header">
        <div><span className="eyebrow">Live browser session</span><h1>Automation</h1><p>Build a reusable action recipe against a persistent Koko Core browser session.</p></div>
        <div className="automation-warning"><MousePointer2 size={14} /><span>Actions can create real side effects on the site.</span></div>
      </header>

      <section className="panel-card automation-session-bar">
        <div className="automation-session-url"><label>Session URL</label><input value={workflow.startUrl} onChange={(event) => updateWorkflow({ startUrl: event.target.value })} placeholder="https://example.com" spellCheck={false} /></div>
        <div className="automation-session-actions"><span className={`automation-status automation-status--${session.status}`}><i />{session.status}</span>{session.status === "starting" || session.status === "running" ? <button type="button" onClick={stop}><CircleStop size={14} />Stop</button> : <button type="button" className="automation-primary" onClick={start}><Play size={14} />Start session</button>}{session.status === "ready" && <button type="button" onClick={discover}><RefreshCw size={14} />Refresh</button>}</div>
        <div className="automation-session-meta"><strong>{session.title || "No document title"}</strong><span>{session.url || "Session has not navigated yet"}</span></div>
      </section>

      <div className="automation-layout">
        <section className="panel-card automation-workflows">
          <header className="card-header"><div><h2>Workflows</h2><p>Saved locally in IndexedDB</p></div><button type="button" className="icon-button" onClick={() => { const id = createWorkflow(workflow.startUrl); selectWorkflow(id); }} aria-label="New workflow"><Plus size={14} /></button></header>
          <div className="automation-workflow-list">{workflows.map((item) => <button type="button" key={item.id} className={item.id === workflow.id ? "active" : ""} onClick={() => { selectWorkflow(item.id); setSelectedStepId(item.steps[0]?.id); }}><span><strong>{item.name}</strong><small>{item.steps.length} steps · {item.lastRunStatus ?? "idle"}</small></span><ChevronRight size={13} /></button>)}</div>
          <div className="automation-workflow-settings"><label>Name<input value={workflow.name} onChange={(event) => updateWorkflow({ name: event.target.value })} /></label><button type="button" className="automation-danger-link" onClick={() => { if (window.confirm("Delete this saved workflow?")) deleteWorkflow(workflow.id); }}><Trash2 size={13} />Delete workflow</button></div>
        </section>

        <section className="panel-card automation-builder">
          <header className="card-header"><div><h2>Workflow builder</h2><p>Steps run in order and stop at the first failure.</p></div><div className="automation-builder-actions"><button type="button" onClick={runWorkflow} disabled={!workflow.steps.length || session.status !== "ready"}><Play size={13} />Run all</button>{selectedStep && <button type="button" onClick={() => runStep(selectedStep)} disabled={session.status !== "ready"}><Play size={13} />Run step</button>}</div></header>
          <div className="automation-add-actions">{actions.map((action) => <button type="button" key={action.value} onClick={() => add(action.value)}><Plus size={11} />{action.label}</button>)}</div>
          <div className="automation-step-list">{workflow.steps.length ? workflow.steps.map((step, index) => <div key={step.id} className={`automation-step-row ${selectedStep?.id === step.id ? "active" : ""}`}><button type="button" className="automation-step-main" onClick={() => setSelectedStepId(step.id)}><GripVertical size={13} /><span><strong>{index + 1}. {actionLabel(step.action)}</strong><small>{step.action === "navigate" ? step.value || "No URL" : locatorSummary(step.locator)}</small></span></button><span className={`automation-step-state automation-step-state--${step.status}`}>{step.status}</span><button type="button" className="icon-button" onClick={() => moveStep(step.id, -1)} disabled={index === 0} aria-label="Move step up"><ChevronLeft size={13} /></button><button type="button" className="icon-button" onClick={() => moveStep(step.id, 1)} disabled={index === workflow.steps.length - 1} aria-label="Move step down"><ChevronRight size={13} /></button><button type="button" className="icon-button" onClick={() => removeStep(step.id)} aria-label="Delete step"><Trash2 size={13} /></button></div>) : <div className="automation-empty automation-empty--steps"><Plus size={20} /><strong>Add your first action</strong><span>Choose an action above, then use Discovery to select an element.</span></div>}</div>
          {selectedStep && <StepEditor step={selectedStep} onChange={(patch) => updateStep(selectedStep.id, patch)} onRun={() => runStep(selectedStep)} onRetry={() => runStep(selectedStep, true)} canRun={session.status === "ready"} />}
        </section>

        <section className="panel-card automation-discovery">
          <header className="card-header"><div><h2><Compass size={15} />Discovery</h2><p>{session.elements.length} interactive elements on the current DOM</p></div><button type="button" className="icon-button" onClick={discover} disabled={session.status !== "ready"} aria-label="Refresh discovery"><RefreshCw size={14} /></button></header>
          <div className="automation-discovery-toolbar"><input value={discoveryFilter} onChange={(event) => setDiscoveryFilter(event.target.value)} placeholder="Filter role, name, id…" /><button type="button" onClick={useElement} disabled={!selectedElement || !selectedStep || selectedStep.action === "navigate"}><Check size={13} />Use in step</button></div>
          <div className="automation-element-list">{filteredElements.length ? filteredElements.map((element, index) => <button type="button" key={`${element.backendNodeId ?? "element"}-${index}`} className={selectedElement === element ? "active" : ""} onClick={() => setSelectedElement(element)}><span className="automation-element-role">{element.role || element.tagName}</span><span className="automation-element-name">{element.name || element.placeholder || element.id || element.elementName || "unnamed element"}</span><small>{element.tagName}{element.id ? `#${element.id}` : ""}{element.disabled ? " · disabled" : ""}</small></button>) : <div className="automation-empty">Start a session to discover elements.</div>}</div>
          <div className="automation-snapshot"><button type="button" onClick={() => setShowSnapshot((value) => !value)}><span>Semantic snapshot</span><ChevronDown size={13} className={showSnapshot ? "open" : ""} /></button>{showSnapshot && <pre>{session.snapshot || "No snapshot yet."}</pre>}</div>
        </section>
      </div>
    </main>
  );
}

function StepEditor({ step, onChange, onRun, onRetry, canRun }: { step: AutomationStep; onChange: (patch: Partial<AutomationStep>) => void; onRun: () => void; onRetry: () => void; canRun: boolean }) {
  const needsLocator = !["navigate", "scroll"].includes(step.action);
  return <div className="automation-editor"><div className="automation-editor-heading"><div><span>Selected action</span><strong>{actionLabel(step.action)}</strong></div><div>{step.status === "failed" && <button type="button" onClick={onRetry} disabled={!canRun}><ListRestart size={13} />Retry</button>}<button type="button" onClick={onRun} disabled={!canRun}><Play size={13} />Run</button></div></div><label className="automation-field"><span>Action</span><select value={step.action} onChange={(event) => onChange({ action: event.target.value as AutomationAction, locator: ["navigate", "scroll"].includes(event.target.value) ? undefined : step.locator ?? { kind: "css", value: "" } })}>{actions.map((action) => <option key={action.value} value={action.value}>{action.label}</option>)}</select></label>{step.action === "navigate" && <TextField label="URL" value={step.value ?? ""} onChange={(value) => onChange({ value })} placeholder="https://example.com" />}{needsLocator && <LocatorEditor locator={step.locator} onChange={(locator) => onChange({ locator })} />}{["fill", "select"].includes(step.action) && <TextField label={step.action === "fill" ? "Text value" : "Option value"} value={step.value ?? ""} onChange={(value) => onChange({ value })} placeholder={step.action === "fill" ? "Secret values are masked in events" : "option-value"} type={step.action === "fill" ? "text" : "text"} />}{step.action === "check" && <label className="automation-checkbox"><span>Checked</span><input type="checkbox" checked={step.checked === true} onChange={(event) => onChange({ checked: event.target.checked })} /></label>}{step.action === "press" && <TextField label="Key" value={step.key ?? "Enter"} onChange={(key) => onChange({ key })} placeholder="Enter" />}{step.action === "scroll" && <div className="automation-inline-fields"><TextField label="X" value={String(step.x ?? "")} onChange={(value) => onChange({ x: value ? Number(value) : undefined })} type="number" /><TextField label="Y" value={String(step.y ?? "")} onChange={(value) => onChange({ y: value ? Number(value) : undefined })} type="number" /></div>}{step.action === "wait" && <TextField label="Timeout (ms)" value={String(step.timeoutMs ?? 5000)} onChange={(value) => onChange({ timeoutMs: Math.max(0, Number(value) || 0) })} type="number" />}{step.error && <div className="automation-error">{step.error}</div>}{step.result && <small className="automation-result">{step.result}</small>}</div>;
}

function LocatorEditor({ locator, onChange }: { locator?: AutomationLocator; onChange: (locator: AutomationLocator) => void }) {
  const current = locator ?? { kind: "css" as const, value: "" };
  return <div className="automation-locator"><span>Locator</span><div className="automation-inline-fields"><select value={current.kind} onChange={(event) => onChange({ ...current, kind: event.target.value as AutomationLocator["kind"] })}>{locatorKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select><input value={current.value} onChange={(event) => onChange({ ...current, value: event.target.value })} placeholder={current.kind === "role" ? "button" : "selector or value"} spellCheck={false} /></div>{current.kind === "role" && <input value={current.name ?? ""} onChange={(event) => onChange({ ...current, name: event.target.value })} placeholder="Accessible name (optional)" />}</div>;
}

function TextField({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <label className="automation-field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} spellCheck={false} /></label>;
}

function defaultStep(action: AutomationAction, startUrl: string): AutomationStep {
  return { id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action, value: action === "navigate" ? startUrl : action === "press" ? "Enter" : undefined, locator: ["navigate", "scroll"].includes(action) ? undefined : { kind: "css", value: "" }, status: "idle" };
}

function actionLabel(action: AutomationAction) { return actions.find((item) => item.value === action)?.label ?? action; }
function locatorSummary(locator?: AutomationLocator) { return locator?.value ? `${locator.kind}: ${locator.name ? `${locator.name} / ` : ""}${locator.value}` : "Set a locator from Discovery"; }

function locatorFromElement(element: InteractiveElementModel): AutomationLocator {
  if (element.id) return { kind: "id", value: element.id };
  if (element.placeholder) return { kind: "placeholder", value: element.placeholder };
  if (element.role) return { kind: "role", value: element.role, name: element.name };
  if (element.elementName) return { kind: "name", value: element.elementName };
  return { kind: "css", value: element.tagName.toLowerCase() };
}

function applyAutomationEvent(event: AutomationEvent) {
  const payload = event.payload;
  const automation = useAutomationStore.getState();
  const statePatch = {
    ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(Array.isArray(payload.elements) ? { elements: payload.elements as InteractiveElementModel[] } : {}),
    ...(typeof payload.snapshot === "string" ? { snapshot: payload.snapshot } : {}),
  };
  if (Object.keys(statePatch).length) automation.setSession(statePatch);
  if (event.name === "automation-session-started") automation.setSession({ status: "ready", id: String(payload.sessionId ?? "") });
  if (event.name === "automation-session-stopped") automation.setSession({ status: "stopped", id: undefined, elements: [] });
  if (event.name === "automation-step-started" && typeof payload.stepId === "string") {
    const stepPayload = payload.step && typeof payload.step === "object" ? payload.step as { action?: unknown } : undefined;
    automation.setSession({ status: "running", lastAction: String(stepPayload?.action ?? "action") });
    automation.markStep(payload.stepId, { status: "running", error: undefined });
  }
  if (event.name === "automation-step-completed" && typeof payload.stepId === "string") {
    automation.setSession({ status: "ready" });
    automation.markStep(payload.stepId, { status: "completed", durationMs: Number(payload.durationMs ?? 0), result: "Completed", error: undefined });
  }
  if (event.name === "automation-step-failed" && typeof payload.stepId !== "string") {
    automation.setSession({ status: "error", error: String(payload.error ?? "Automation command failed") });
  }
  if (event.name === "automation-step-failed" && typeof payload.stepId === "string") {
    automation.setSession({ status: "ready", error: String(payload.error ?? "Action failed") });
    automation.markStep(payload.stepId, { status: "failed", durationMs: Number(payload.durationMs ?? 0), error: String(payload.error ?? "Action failed") });
    automation.updateWorkflow({ lastRunStatus: "failed", lastError: String(payload.error ?? "Action failed"), lastSessionUrl: typeof payload.url === "string" ? payload.url : undefined });
  }
  if (event.name === "automation-workflow-completed") automation.updateWorkflow({ lastRunStatus: "completed", lastError: undefined, lastSessionUrl: typeof payload.url === "string" ? payload.url : undefined });
}
