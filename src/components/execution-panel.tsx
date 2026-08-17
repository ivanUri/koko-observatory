"use client";

import { useEffect, useMemo, useState } from "react";
import { Bookmark, CircleDot, GitBranch, PauseCircle, PlayCircle, ShieldCheck } from "lucide-react";
import { useSelectionStore, useTelemetryStore } from "@/src/stores";
import { useExecutionStore } from "@/src/executions/store";
import { executionIdFor, type ExecutionCapability } from "@/src/executions/types";

const controlledCapabilities: ExecutionCapability[] = ["checkpoint-live", "checkpoint-reconstruct", "network-replay", "branching"];
const replayPresentationMs = 2_800;

type ReplayPresentation = {
  phase: "preparing" | "running" | "completed" | "failed";
  startedAt: number;
  executionId?: string;
};

export function ExecutionPanel() {
  const telemetry = useTelemetryStore((state) => state.events);
  const selectedEventId = useSelectionStore((state) => state.eventId);
  const executions = useExecutionStore((state) => state.executions);
  const checkpoints = useExecutionStore((state) => state.checkpoints);
  const branches = useExecutionStore((state) => state.branches);
  const activeExecutionId = useExecutionStore((state) => state.activeExecutionId);
  const hydrate = useExecutionStore((state) => state.hydrate);
  const select = useExecutionStore((state) => state.select);
  const bookmark = useExecutionStore((state) => state.bookmark);
  const createViewBranch = useExecutionStore((state) => state.createViewBranch);
  const [replayPending, setReplayPending] = useState(false);
  const [replayPresentation, setReplayPresentation] = useState<ReplayPresentation>();
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>();

  useEffect(() => { void hydrate(); }, [hydrate]);

  const active = executions.find((execution) => execution.id === activeExecutionId) ?? executions[0];
  const selected = telemetry.find((event) => event.id === selectedEventId);
  const activeEvents = useMemo(() => active ? telemetry.filter((event) => executionIdFor(event) === active.id) : [], [active, telemetry]);
  const activeCheckpoints = checkpoints.filter((checkpoint) => checkpoint.executionId === active?.id);
  const activeBranches = branches.filter((branch) => branch.parentExecutionId === active?.id);
  const coreCanCheckpoint = Boolean(active?.capabilities.includes("checkpoint-reconstruct"));
  const replayInputs = activeEvents.filter((event) => event.payload.journeyStage === "response" && event.payload.bodyCaptureState === "captured" && event.payload.bodyTruncated !== true && typeof event.payload.responseBody === "string");
  const selectedCheckpoint = activeCheckpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId) ?? activeCheckpoints.find((checkpoint) => checkpoint.kind === "reconstructible");
  const canReplay = Boolean(active && selectedCheckpoint?.replayable && replayInputs.length);
  const replayError = activeEvents.map((event) => event.payload.replayError).find((value): value is string => typeof value === "string");

  useEffect(() => {
    if (replayError) {
      setReplayPending(false);
      setReplayPresentation((current) => current ? { ...current, phase: "failed" } : current);
      return;
    }
    if (!active?.id.startsWith("replay-")) return;

    setReplayPending(false);
    const phase = active.status === "failed" ? "failed" : active.status === "completed" ? "completed" : "running";
    setReplayPresentation((current) => {
      if (!current || (current.phase === phase && current.executionId === active.id)) return current;
      return { ...current, phase, executionId: active.id };
    });
  }, [active?.id, active?.status, replayError]);

  useEffect(() => {
    if (!replayPresentation || (replayPresentation.phase !== "completed" && replayPresentation.phase !== "failed")) return;
    const minimumRemaining = Math.max(0, replayPresentationMs - (Date.now() - replayPresentation.startedAt));
    const timeout = window.setTimeout(() => setReplayPresentation(undefined), minimumRemaining + 1_200);
    return () => window.clearTimeout(timeout);
  }, [replayPresentation]);

  const replay = () => {
    if (!active || !selectedCheckpoint) return;
    setReplayPending(true);
    setReplayPresentation({ phase: "preparing", startedAt: Date.now() });
    window.dispatchEvent(new CustomEvent("koko:execution-replay", { detail: { executionId: active.id, checkpointId: selectedCheckpoint.id } }));
  };

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">Controlled execution</span>
          <h1>Execution artifacts</h1>
          <p>Durable recordings, explicit causal evidence, and checkpoint fidelity. Controls stay disabled until Koko Core advertises the corresponding capability.</p>
        </div>
      </header>

      <section className="global-timeline-summary">
        <article><span>Executions</span><strong>{executions.length}</strong><small>stored locally in this browser</small></article>
        <article><span>Events</span><strong>{active?.eventCount ?? 0}</strong><small>{active ? active.status : "waiting for telemetry"}</small></article>
        <article><span>Checkpoints</span><strong>{activeCheckpoints.length}</strong><small>{activeCheckpoints.some((item) => item.replayable) ? "replayable state available" : "bookmarks only"}</small></article>
        <article><span>Branches</span><strong>{activeBranches.length}</strong><small>{active?.capabilities.includes("branching") ? "Core-controlled branching" : "view-only branch metadata"}</small></article>
      </section>

      <section className="panel-card">
        <header className="card-header"><div><h2><CircleDot size={15} />Execution</h2><p>Select one recorded execution; live telemetry continues to append to its artifact.</p></div></header>
        <label><span className="eyebrow">Current execution</span><select className="select-control" value={active?.id ?? ""} onChange={(event) => select(event.target.value || undefined)}>
          {!executions.length && <option value="">Waiting for telemetry…</option>}
          {executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.id} · {execution.status} · {execution.eventCount} events</option>)}
        </select></label>
        {active && <div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Fidelity</span><span>Capabilities</span><span>Latest event</span><span>Safety</span><span>Status</span></div><div className="event-row" role="row"><span><b>{active.fidelity}</b></span><span>{active.capabilities.join(", ")}</span><span className="mono">#{active.latestSequence}</span><span>side effects blocked by default</span><span className={`status-text status-text--${active.status === "failed" ? "error" : "ok"}`}>{active.status}</span></div></div>}
        {!active && <p className="execution-replay-summary">Start the live bridge, then Inspect URL. This page receives executions only while the bridge is connected.</p>}
      </section>

      <section className="panel-card">
        <header className="card-header"><div><h2><Bookmark size={15} />Checkpoint rail</h2><p>A bookmark preserves the selected cursor and telemetry evidence only. It is not presented as restorable browser state.</p></div></header>
        <div className="global-timeline-filters">
          <button type="button" className="primary-button" onClick={() => bookmark(selected)} disabled={!active}>Create bookmark{selected ? ` at #${selected.sequence}` : ""}</button>
          <span className="checkpoint-state" title={coreCanCheckpoint ? "A checkpoint was created by this inspection." : "A checkpoint is created automatically after Inspect URL finishes."}><PauseCircle size={14} />{coreCanCheckpoint ? "Checkpoint captured" : "Checkpoint pending"}</span>
          <button type="button" onClick={replay} disabled={!canReplay || replayPending} title={canReplay ? "Replay this checkpoint with the exact recorded response inputs." : "This replay point has no complete recorded response inputs yet."}><PlayCircle size={14} />{replayPending ? "Starting replay…" : "Replay selected checkpoint"}</button>
          <button type="button" onClick={() => createViewBranch(activeCheckpoints[0]?.id)} disabled={!active}><GitBranch size={14} />Create view branch</button>
        </div>
        <p className="execution-replay-summary">{replayInputs.length} complete text response{replayInputs.length === 1 ? "" : "s"} captured for strict replay. Requests without a captured input will be blocked.</p>
        {active && !replayInputs.length && <p className="execution-replay-summary">Replay is unavailable for this recording. Inspect the URL again after starting the updated bridge; it now uses an isolated cache to capture replay inputs.</p>}
        {replayError && <p className="execution-replay-summary">Replay could not start: {replayError}</p>}
        {replayPresentation && <ReplayTransition presentation={replayPresentation} />}
        <div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Replay point</span><span>Cursor</span><span>Coverage</span><span>Replay</span><span>Created</span></div>
          {activeCheckpoints.map((checkpoint) => <label className="event-row execution-checkpoint-option" role="row" key={checkpoint.id}><span><input type="radio" name="replay-checkpoint" checked={(selectedCheckpoint?.id ?? "") === checkpoint.id} onChange={() => setSelectedCheckpointId(checkpoint.id)} disabled={!checkpoint.replayable} /> {checkpoint.kind}</span><span className="mono">#{checkpoint.eventCursor}</span><span>{checkpoint.stateCoverage.join(", ")}</span><span>{checkpoint.replayable ? "ready" : "view only"}</span><span>{new Date(checkpoint.createdAt).toLocaleTimeString()}</span></label>)}
          {!activeCheckpoints.length && <div className="empty-row">No checkpoints for this execution.</div>}
        </div>
        {activeBranches.length > 0 && <div className="event-table execution-branch-list" role="table"><div className="event-row event-row--header" role="row"><span>View branches</span><span>Mode</span><span>Checkpoint</span><span>Overrides</span><span>Created</span></div>
          {activeBranches.map((branch) => <div className="event-row" role="row" key={branch.id}><span className="mono">{branch.id.split(":").at(-1)}</span><span>{branch.mode}</span><span className="mono">{branch.checkpointId?.split(":").at(-1) ?? "latest"}</span><span>{branch.overrides}</span><span>{new Date(branch.createdAt).toLocaleTimeString()}</span></div>)}
        </div>}
      </section>

      <section className="panel-card">
        <header className="card-header"><div><h2><ShieldCheck size={15} />Replay safety contract</h2><p>Replay uses the selected Core checkpoint and its captured response inputs. Strict mode blocks every request that was not captured.</p></div></header>
        <div className="event-table" role="table"><div className="event-row event-row--header" role="row"><span>Capability</span><span>State</span><span>What it means</span><span>Required Core signal</span><span>Events in scope</span></div>
          {controlledCapabilities.map((capability) => <div className="event-row" role="row" key={capability}><span>{capability}</span><span>{active?.capabilities.includes(capability) ? "available" : "not advertised"}</span><span>{description(capability)}</span><span><code>executionCapabilities</code></span><span>{activeEvents.length}</span></div>)}
        </div>
      </section>
    </main>
  );
}

function ReplayTransition({ presentation }: { presentation: ReplayPresentation }) {
  const copy = presentation.phase === "preparing"
    ? ["Preparing replay", "Restoring the selected browser checkpoint and validating captured inputs."]
    : presentation.phase === "running"
      ? ["Replaying recorded inputs", "Koko Core is serving the captured responses into a new replay execution."]
      : presentation.phase === "completed"
        ? ["Replay completed", `Execution ${presentation.executionId ?? "replay"} is ready to inspect.`]
        : ["Replay could not start", "The recording or its captured inputs are no longer available to the live bridge."];
  return (
    <div className={`replay-transition replay-transition--${presentation.phase}`} role="status" aria-live="polite">
      <span className="replay-transition__pulse" aria-hidden="true"><PlayCircle size={15} /></span>
      <div><strong>{copy[0]}</strong><p>{copy[1]}</p><span className="replay-transition__track" aria-hidden="true"><i /></span></div>
    </div>
  );
}

function description(capability: ExecutionCapability) {
  switch (capability) {
    case "checkpoint-live": return "Pause/resume a still-live Core process at a safe point.";
    case "checkpoint-reconstruct": return "Restore a Core-produced browser-state manifest into a new execution.";
    case "network-replay": return "Inject recorded or overridden external inputs under an explicit safety policy.";
    case "branching": return "Fork immutable execution history using a Core checkpoint and override set.";
    default: return "Recorded execution capability.";
  }
}
