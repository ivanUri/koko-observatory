"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronDown, Clock3, Database, FileDown, Globe2, Settings, Sparkles, SlidersHorizontal } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebSocketTransport } from "@/src/core/transport";
import { TelemetryPipeline } from "@/src/core/pipeline";
import { observatoryBus } from "@/src/core/event-bus";
import { getPlugin, plugins } from "@/src/plugins/registry";
import { useExportStore, useGraphStore, useSettingsStore, useTelemetryStore, useUIStore } from "@/src/stores";
import { useInternetJourneyStore } from "@/src/journeys/internet/store";
import { useBrowserJourneyStore } from "@/src/journeys/browser/store";
import { useExecutionStore } from "@/src/executions/store";
import { loadRecentExecutionEvents } from "@/src/executions/artifact-store";
import { useAutomationStore } from "@/src/automation/store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "domstable" | "done";

interface InspectOptions {
  waitUntil: WaitUntil;
  waitMs: number;
  observeMs: number;
  terminateMs: number;
  expandLazy: boolean;
  maxScrolls: number;
  scrollSettleMs: number;
  waitSelector: string;
  waitScript: string;
  userAgent: string;
  extraHeaders: string;
  cookiePath: string;
  cookieJson: string;
  includeFrames: boolean;
}

const defaultInspectOptions: InspectOptions = {
  waitUntil: "domcontentloaded",
  waitMs: 30_000,
  observeMs: 10_000,
  terminateMs: 90_000,
  expandLazy: false,
  maxScrolls: 80,
  scrollSettleMs: 250,
  waitSelector: "",
  waitScript: "",
  userAgent: "",
  extraHeaders: "",
  cookiePath: "",
  cookieJson: "",
  includeFrames: false,
};

export function ObservatoryApp({ initialPlugin = "overview" }: { initialPlugin?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ObservatoryRuntime initialPlugin={initialPlugin} />
    </QueryClientProvider>
  );
}

function ObservatoryRuntime({ initialPlugin }: { initialPlugin: string }) {
  const activePlugin = useUIStore((state) => state.activePlugin);
  const setActivePlugin = useUIStore((state) => state.setActivePlugin);
  const collapsed = useUIStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const plugin = getPlugin(activePlugin);
  const ActivePanel = plugin.component;
  const telemetryEndpoint = useSettingsStore((state) => state.telemetryEndpoint);
  const telemetryRetention = useSettingsStore((state) => state.retention);
  const hydrateSettings = useSettingsStore((state) => state.hydrate);
  const setTelemetryRetention = useTelemetryStore((state) => state.setRetention);
  const pipeline = useMemo(() => new TelemetryPipeline(new WebSocketTransport(telemetryEndpoint)), [telemetryEndpoint]);
  useEffect(() => setActivePlugin(initialPlugin), [initialPlugin, setActivePlugin]);
  useEffect(() => hydrateSettings(), [hydrateSettings]);
  useEffect(() => setTelemetryRetention(telemetryRetention), [setTelemetryRetention, telemetryRetention]);

  useEffect(() => {
    let cancelled = false;
    void loadRecentExecutionEvents().then((events) => {
      if (!cancelled) useTelemetryStore.getState().hydrate(events);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const unsubscribeStatus = observatoryBus.on("status", (status) => useTelemetryStore.getState().setStatus(status));
    const unsubscribeExportProgress = observatoryBus.on("exportProgress", (event) => {
      useExportStore.getState().setProgress(event);
    });
    const unsubscribeDataCleared = observatoryBus.on("dataCleared", () => {
      useTelemetryStore.getState().clear();
      useExecutionStore.getState().clear();
      useAutomationStore.getState().clear();
    });
    const unsubscribe = observatoryBus.on("snapshot", (snapshot) => {
      useTelemetryStore.getState().append(snapshot.events, snapshot.rates, snapshot.p95);
      useGraphStore.getState().update(snapshot.graphNodes, snapshot.graphEdges);
      useExecutionStore.getState().ingest(snapshot.events);
      if (snapshot.events.some((event) => event.name === "inspection-started")) {
        useExportStore.getState().setProgress(undefined);
      }
      if (snapshot.events.some((event) => event.name === "site-export-ready")) {
        useExportStore.getState().setProgress(undefined);
      }
      const terminal = snapshot.events.find((event) => event.payload.inspectionState === "completed" || event.payload.inspectionState === "failed");
      if (terminal) useUIStore.getState().setInspecting(false);
    });
    const unsubscribeRaw = observatoryBus.on("raw", (events) => {
      useInternetJourneyStore.getState().ingest(events);
      useBrowserJourneyStore.getState().ingest(events);
    });
    void pipeline.start().catch(() => {
      useTelemetryStore.getState().setStatus("offline");
      useUIStore.getState().setInspecting(false);
    });
    const inspect = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; options?: InspectOptions } | string>).detail;
      const command = typeof detail === "string" ? { type: "inspect-url", url: detail } : { type: "inspect-url", url: detail.url, options: detail.options };
      pipeline.send(JSON.stringify(command));
    };
    const replay = (event: Event) => pipeline.send(JSON.stringify({ type: "execution.replay", ...(event as CustomEvent<Record<string, unknown>>).detail }));
    const clearExecutionData = () => pipeline.send(JSON.stringify({ type: "execution.clear-all" }));
    const automation = (event: Event) => pipeline.send(JSON.stringify((event as CustomEvent<Record<string, unknown>>).detail));
    window.addEventListener("koko:inspect-url", inspect);
    window.addEventListener("koko:execution-replay", replay);
    window.addEventListener("koko:clear-execution-data", clearExecutionData);
    window.addEventListener("koko:automation", automation);
    return () => {
      window.removeEventListener("koko:inspect-url", inspect);
      window.removeEventListener("koko:execution-replay", replay);
      window.removeEventListener("koko:clear-execution-data", clearExecutionData);
      window.removeEventListener("koko:automation", automation);
      unsubscribe();
      unsubscribeStatus();
      unsubscribeExportProgress();
      unsubscribeDataCleared();
      unsubscribeRaw();
      pipeline.stop();
    };
  }, [pipeline]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        useUIStore.getState().setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={collapsed ? "observatory observatory--collapsed" : "observatory"}>
      <aside className="sidebar">
        <div className="brand">
          {!collapsed && <div><strong>Koko Observatory</strong><small>Browser runtime monitor</small></div>}
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar">‹</button>
        </div>
        <nav className="nav-section" aria-label="Observatory plugins">
          {!collapsed && <span className="nav-label">Workspace</span>}
          {plugins.filter((item) => item.sidebar !== false).map(({ id, route, label, icon: Icon, badge }) => (
            <Link key={id} href={route} className={activePlugin === id ? "nav-item nav-item--active" : "nav-item"} title={label}>
              <Icon size={16} /><span>{label}</span>{badge && <em>{badge}</em>}
            </Link>
          ))}
        </nav>
        <nav className="nav-section nav-section--secondary">
          {!collapsed && <span className="nav-label">Runtime</span>}
          <Link href="/application" className={activePlugin === "application" ? "nav-item nav-item--active" : "nav-item"} title="Application"><Database size={16} /><span>Application</span></Link>
          <Link href="/export" className={activePlugin === "export" ? "nav-item nav-item--active" : "nav-item"} title="Export"><FileDown size={16} /><span>Export</span></Link>
          <Link href="/ai-insights" className={activePlugin === "ai-insights" ? "nav-item nav-item--active" : "nav-item"} title="AI insights"><Sparkles size={16} /><span>AI insights</span><em>Beta</em></Link>
        </nav>
        <div className="sidebar-footer">
          <Link href="/settings" className={activePlugin === "settings" ? "nav-item nav-item--active" : "nav-item"} title="Settings"><Settings size={16} /><span>Settings</span></Link>
          {!collapsed && <><div className="runtime-control"><span><i />Live</span><strong>1s⌄</strong></div><div className="runtime-control"><span><Clock3 size={14} />Last 15 minutes</span><strong>⌄</strong></div></>}
        </div>
      </aside>
      <section className="main-shell">
        <GlobalInspector />
        <motion.div key={activePlugin} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
          <ActivePanel />
        </motion.div>
      </section>
    </div>
  );
}

function GlobalInspector() {
  const url = useUIStore((state) => state.inspectorUrl);
  const inspecting = useUIStore((state) => state.inspecting);
  const setUrl = useUIStore((state) => state.setInspectorUrl);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const settings = useSettingsStore();
  const settingsDefaults = useMemo<InspectOptions>(() => ({
    ...defaultInspectOptions,
    waitUntil: settings.waitUntil,
    waitMs: settings.waitMs,
    observeMs: settings.observeMs,
    terminateMs: settings.terminateMs,
    expandLazy: settings.expandLazy,
    maxScrolls: settings.maxScrolls,
    scrollSettleMs: settings.scrollSettleMs,
    includeFrames: settings.includeFrames,
  }), [settings.expandLazy, settings.includeFrames, settings.maxScrolls, settings.observeMs, settings.scrollSettleMs, settings.terminateMs, settings.waitMs, settings.waitUntil]);
  const [options, setOptions] = useState<InspectOptions>(() => settingsDefaults);
  useEffect(() => {
    setOptions((current) => ({
      ...current,
      waitUntil: settingsDefaults.waitUntil,
      waitMs: settingsDefaults.waitMs,
      observeMs: settingsDefaults.observeMs,
      terminateMs: settingsDefaults.terminateMs,
      expandLazy: settingsDefaults.expandLazy,
      maxScrolls: settingsDefaults.maxScrolls,
      scrollSettleMs: settingsDefaults.scrollSettleMs,
      includeFrames: settingsDefaults.includeFrames,
    }));
  }, [settingsDefaults]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || inspecting) return;
    useBrowserJourneyStore.getState().reset();
    useInternetJourneyStore.getState().setInputUrl(url);
    if (useInternetJourneyStore.getState().phase === "error") {
      useBrowserJourneyStore.getState().block("Internet Journey rejected the URL before a request could be sent.");
      useUIStore.getState().setInspecting(false);
      return;
    }
    useUIStore.getState().beginInspection();
    useUIStore.getState().setInspecting(true);
    window.dispatchEvent(new CustomEvent("koko:inspect-url", { detail: { url, options } }));
  };
  const update = <K extends keyof InspectOptions>(key: K, value: InspectOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
    if (key === "waitUntil") settings.update({ waitUntil: value as WaitUntil });
    if (key === "waitMs") settings.update({ waitMs: value as number });
    if (key === "observeMs") settings.update({ observeMs: value as number });
    if (key === "terminateMs") settings.update({ terminateMs: value as number });
    if (key === "expandLazy") settings.update({ expandLazy: value as boolean });
    if (key === "maxScrolls") settings.update({ maxScrolls: value as number });
    if (key === "scrollSettleMs") settings.update({ scrollSettleMs: value as number });
    if (key === "includeFrames") settings.update({ includeFrames: value as boolean });
  };
  return <form className={inspecting ? "global-inspector global-inspector--loading" : "global-inspector"} onSubmit={submit} aria-label="Global URL inspector">
    <div className="global-inspector__bar">
      <Globe2 size={14} />
      <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Global URL to inspect" placeholder="https://example.com" />
      <button type="button" className="global-inspector__advanced-toggle" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}><SlidersHorizontal size={13} />Advanced<ChevronDown size={13} className={advancedOpen ? "global-inspector__chevron global-inspector__chevron--open" : "global-inspector__chevron"} /></button>
      <button type="submit" disabled={inspecting}>{inspecting ? "Inspecting…" : "Inspect URL"}</button>
    </div>
    {advancedOpen && <section className="global-inspector__advanced" aria-label="Advanced inspection options">
      <header><div><strong>Advanced run options</strong><span>Shared values stay in sync with Settings and apply to the next run.</span></div><button type="button" className="global-inspector__reset" onClick={() => setOptions((current) => ({ ...current, ...settingsDefaults }))}>Reset</button></header>
      <div className="global-inspector__fields">
        <label><span>Wait until</span><select value={options.waitUntil} onChange={(event) => update("waitUntil", event.target.value as WaitUntil)}><option value="domcontentloaded">DOMContentLoaded</option><option value="load">Load</option><option value="domstable">DOM stable</option><option value="networkidle">Network idle</option><option value="done">Done</option></select></label>
        <label><span>Wait timeout (ms)</span><input type="number" min="0" step="1000" value={options.waitMs} onChange={(event) => update("waitMs", Math.max(0, Number(event.target.value) || 0))} /></label>
        <label><span>Background observation (ms)</span><input type="number" min="0" step="1000" value={options.observeMs} onChange={(event) => update("observeMs", Math.max(0, Number(event.target.value) || 0))} /></label>
        <label><span>Terminate deadline (ms) <small>0 = disabled</small></span><input type="number" min="0" step="1000" value={options.terminateMs} onChange={(event) => update("terminateMs", Math.max(0, Number(event.target.value) || 0))} /></label>
        <label className="global-inspector__checkbox"><span>Expand lazy content <small>bounded scrolling</small></span><input type="checkbox" checked={options.expandLazy} onChange={(event) => update("expandLazy", event.target.checked)} /></label>
        <label><span>Maximum lazy scrolls</span><input type="number" min="0" max="10000" step="1" value={options.maxScrolls} onChange={(event) => update("maxScrolls", Math.max(0, Math.min(10000, Number(event.target.value) || 0)))} /></label>
        <label><span>Scroll settle (ms)</span><input type="number" min="0" step="50" value={options.scrollSettleMs} onChange={(event) => update("scrollSettleMs", Math.max(0, Number(event.target.value) || 0))} /></label>
        <label><span>User-Agent override</span><input value={options.userAgent} onChange={(event) => update("userAgent", event.target.value)} placeholder="Optional Koko-compatible UA" /></label>
        <label><span>Wait for selector</span><input value={options.waitSelector} onChange={(event) => update("waitSelector", event.target.value)} placeholder=".app-ready" /></label>
        <label><span>Cookie JSON path</span><input value={options.cookiePath} onChange={(event) => update("cookiePath", event.target.value)} placeholder="/path/to/cookies.json" /></label>
        <label><span>Import cookie JSON <small>optional file upload</small></span><input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void file.text().then((value) => { update("cookieJson", value); update("cookiePath", ""); }); }} /></label>
        <label className="global-inspector__checkbox"><span>Include iframe documents</span><input type="checkbox" checked={options.includeFrames} onChange={(event) => update("includeFrames", event.target.checked)} /></label>
        <label className="global-inspector__field--wide"><span>Wait script (optional expression)</span><input value={options.waitScript} onChange={(event) => update("waitScript", event.target.value)} placeholder="window.__APP_READY__ === true" /></label>
        <label className="global-inspector__field--wide global-inspector__headers-field">
          <span className="global-inspector__field-title"><strong>Fixed request headers</strong><small>Applied to navigation and subresources</small></span>
          <textarea aria-describedby="fixed-headers-help" value={options.extraHeaders} onChange={(event) => update("extraHeaders", event.target.value)} placeholder={"Authorization: Bearer …\nX-Trace-ID: observatory-run"} rows={5} spellCheck={false} />
          <small id="fixed-headers-help" className="global-inspector__field-help">Enter one <code>Name: value</code> pair per line. Leave blank if the page does not need custom headers.</small>
        </label>
      </div>
      <p className="global-inspector__hint">Koko reports lifecycle milestones as they happen, shows an early preview, and keeps servicing the page for the background observation window. Enable bounded lazy expansion for infinite-scroll pages.</p>
    </section>}
  </form>;
}
