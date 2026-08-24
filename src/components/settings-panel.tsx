"use client";

import { useEffect, useState } from "react";
import { Check, Database, PlugZap, RotateCcw, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { observatoryBus } from "@/src/core/event-bus";
import { clearStoredArtifacts } from "@/src/executions/artifact-store";
import { useAutomationStore } from "@/src/automation/store";
import { defaultObservatorySettings, useSettingsStore, useTelemetryStore, type InspectWaitUntil, type ObservatorySettings } from "@/src/stores";

type SettingsDraft = Pick<ObservatorySettings, "telemetryEndpoint" | "waitUntil" | "waitMs" | "observeMs" | "terminateMs" | "expandLazy" | "maxScrolls" | "scrollSettleMs" | "includeFrames" | "retention">;

const waitOptions: Array<{ value: InspectWaitUntil; label: string }> = [
  { value: "domcontentloaded", label: "DOMContentLoaded" },
  { value: "load", label: "Load" },
  { value: "domstable", label: "DOM stable" },
  { value: "networkidle", label: "Network idle" },
  { value: "done", label: "Done" },
];

const retentionOptions = [1_000, 5_000, 10_000];

function draftFromSettings(settings: ObservatorySettings): SettingsDraft {
  return {
    telemetryEndpoint: settings.telemetryEndpoint,
    waitUntil: settings.waitUntil,
    waitMs: settings.waitMs,
    observeMs: settings.observeMs,
    terminateMs: settings.terminateMs,
    expandLazy: settings.expandLazy,
    maxScrolls: settings.maxScrolls,
    scrollSettleMs: settings.scrollSettleMs,
    includeFrames: settings.includeFrames,
    retention: settings.retention,
  };
}

export function SettingsPanel() {
  const settings = useSettingsStore();
  const events = useTelemetryStore((state) => state.events);
  const transportStatus = useTelemetryStore((state) => state.status);
  const clearTelemetry = useTelemetryStore((state) => state.clear);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(settings));
  const [saved, setSaved] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");

  useEffect(() => observatoryBus.on("dataCleared", ({ removed }) => {
    setCleaning(false);
    setCleanupMessage(`${removed} site execution${removed === 1 ? "" : "s"} removed.`);
  }), []);

  useEffect(() => {
    setDraft(draftFromSettings(settings));
  }, [settings]);

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = () => {
    settings.update(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const reset = () => {
    settings.reset();
    setDraft(draftFromSettings(defaultObservatorySettings));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const clear = () => {
    if (!events.length || !window.confirm("Clear the telemetry currently shown in Observatory? Persisted execution artifacts will not be deleted.")) return;
    clearTelemetry();
  };

  const clearSiteData = async () => {
    if (!window.confirm("Delete all stored site data, execution history, checkpoints and browser profiles? This cannot be undone.")) return;
    setCleaning(true);
    setCleanupMessage("");
    clearTelemetry();
    useAutomationStore.getState().clear();
    await clearStoredArtifacts();
    if (transportStatus !== "live") {
      setCleaning(false);
      setCleanupMessage("Local data cleared. Start the telemetry bridge to clean its execution folder.");
      return;
    }
    window.dispatchEvent(new CustomEvent("koko:clear-execution-data"));
  };

  return (
    <main className="workspace settings-workspace">
      <header className="workspace-header settings-header">
        <div><span className="eyebrow">Workspace configuration</span><h1>Settings</h1><p>Control the Observatory connection, inspection defaults and local telemetry buffer.</p></div>
        <div className="settings-header__status"><i />{settings.hydrated ? "Saved locally" : "Loading settings"}</div>
      </header>

      <div className="settings-layout">
        <section className="panel-card settings-section">
          <header className="card-header"><div><h2><PlugZap size={15} />Telemetry connection</h2><p>The bridge is reconnected automatically when the endpoint changes.</p></div></header>
          <div className="settings-fields">
            <label className="settings-field settings-field--wide"><span>WebSocket endpoint</span><input value={draft.telemetryEndpoint} onChange={(event) => update("telemetryEndpoint", event.target.value)} placeholder="ws://127.0.0.1:9223/telemetry" spellCheck={false} /><small>Use the same WebSocket URL exposed by the Koko telemetry bridge.</small></label>
          </div>
        </section>

        <section className="panel-card settings-section">
          <header className="card-header"><div><h2><SlidersHorizontal size={15} />Inspect defaults</h2><p>These are the same shared values shown in Advanced and apply to the next Inspect URL run.</p></div></header>
          <div className="settings-fields">
            <label className="settings-field"><span>Wait until</span><select value={draft.waitUntil} onChange={(event) => update("waitUntil", event.target.value as InspectWaitUntil)}>{waitOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <NumberField label="Wait timeout (ms)" value={draft.waitMs} onChange={(value) => update("waitMs", value)} />
            <NumberField label="Background observation (ms)" value={draft.observeMs} onChange={(value) => update("observeMs", value)} />
            <NumberField label="Terminate deadline (ms)" value={draft.terminateMs} onChange={(value) => update("terminateMs", value)} hint="0 disables the hard deadline" />
            <NumberField label="Maximum lazy scrolls" value={draft.maxScrolls} onChange={(value) => update("maxScrolls", value)} />
            <NumberField label="Scroll settle (ms)" value={draft.scrollSettleMs} onChange={(value) => update("scrollSettleMs", value)} />
            <ToggleField label="Expand lazy content" detail="Bounded scrolling for infinite-scroll pages" checked={draft.expandLazy} onChange={(value) => update("expandLazy", value)} />
            <ToggleField label="Include iframe documents" checked={draft.includeFrames} onChange={(value) => update("includeFrames", value)} />
          </div>
        </section>

        <section className="panel-card settings-section">
          <header className="card-header"><div><h2><Database size={15} />Telemetry buffer</h2><p>Only the in-memory dashboard buffer is affected; execution files remain on disk.</p></div></header>
          <div className="settings-fields settings-fields--buffer">
            <label className="settings-field"><span>Maximum retained events</span><select value={draft.retention} onChange={(event) => update("retention", Number(event.target.value))}>{retentionOptions.map((value) => <option key={value} value={value}>{value.toLocaleString()} events</option>)}</select><small>Current buffer: {events.length.toLocaleString()} events</small></label>
            <div className="settings-danger"><div><strong>Clear current telemetry view</strong><span>Remove events from the dashboard until new telemetry arrives.</span></div><button type="button" onClick={clear} disabled={!events.length}><Trash2 size={14} />Clear buffer</button></div>
          </div>
        </section>

        <section className="panel-card settings-section settings-section--wide">
          <header className="card-header"><div><h2><Trash2 size={15} />Stored site data</h2><p>Delete saved HTML, Markdown, telemetry, checkpoints and per-site browser profiles from this Observatory workspace.</p></div></header>
          <div className="settings-fields settings-fields--buffer">
            <div className="settings-danger settings-danger--storage"><div><strong>Clean all site executions</strong><span>This removes all completed and failed site runs. An inspection already in progress is allowed to finish first.</span>{cleanupMessage && <small>{cleanupMessage}</small>}</div><button type="button" onClick={() => void clearSiteData()} disabled={cleaning}>{cleaning ? "Cleaning…" : <><Trash2 size={14} />Clean all data</>}</button></div>
          </div>
        </section>
      </div>

      <footer className="settings-actions"><button type="button" className="settings-reset" onClick={reset}><RotateCcw size={14} />Restore defaults</button><button type="button" className="settings-save" onClick={save}>{saved ? <Check size={14} /> : <Save size={14} />}{saved ? "Saved" : "Save changes"}</button></footer>
    </main>
  );
}

function NumberField({ label, value, onChange, hint }: { label: string; value: number; onChange: (value: number) => void; hint?: string }) {
  return <label className="settings-field"><span>{label}{hint && <small>{hint}</small>}</span><input type="number" min="0" step="1000" value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} /></label>;
}

function ToggleField({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-toggle"><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}
