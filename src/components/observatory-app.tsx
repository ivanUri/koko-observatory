"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Box, Clock3, Cpu, Globe2, Settings, Sparkles } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DemoTransport, WebSocketTransport } from "@/src/core/transport";
import { TelemetryPipeline } from "@/src/core/pipeline";
import { observatoryBus } from "@/src/core/event-bus";
import { getPlugin, plugins } from "@/src/plugins/registry";
import { useGraphStore, useTelemetryStore, useUIStore } from "@/src/stores";
import { useInternetJourneyStore } from "@/src/journeys/internet/store";
import { useBrowserJourneyStore } from "@/src/journeys/browser/store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

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
  const pipeline = useMemo(() => {
    const endpoint = process.env.NEXT_PUBLIC_VELORA_TELEMETRY_URL;
    return new TelemetryPipeline(endpoint ? new WebSocketTransport(endpoint) : new DemoTransport());
  }, []);
  useEffect(() => setActivePlugin(initialPlugin), [initialPlugin, setActivePlugin]);

  useEffect(() => {
    const unsubscribeStatus = observatoryBus.on("status", (status) => useTelemetryStore.getState().setStatus(status));
    const unsubscribe = observatoryBus.on("snapshot", (snapshot) => {
      useTelemetryStore.getState().append(snapshot.events, snapshot.rates, snapshot.p95);
      useGraphStore.getState().update(snapshot.graphNodes, snapshot.graphEdges);
      if (snapshot.events.length) useUIStore.getState().setInspecting(false);
    });
    const unsubscribeRaw = observatoryBus.on("raw", (events) => {
      useInternetJourneyStore.getState().ingest(events);
      useBrowserJourneyStore.getState().ingest(events);
    });
    void pipeline.start();
    const inspect = (event: Event) => pipeline.send(JSON.stringify({ type: "inspect-url", url: (event as CustomEvent<string>).detail }));
    window.addEventListener("velora:inspect-url", inspect);
    return () => {
      window.removeEventListener("velora:inspect-url", inspect);
      unsubscribe();
      unsubscribeStatus();
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
          {!collapsed && <div><strong>Velora Observatory</strong><small>Browser runtime monitor</small></div>}
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar">‹</button>
        </div>
        <nav className="nav-section" aria-label="Observatory plugins">
          {!collapsed && <span className="nav-label">Workspace</span>}
          {plugins.map(({ id, route, label, icon: Icon, badge }) => (
            <Link key={id} href={route} className={activePlugin === id ? "nav-item nav-item--active" : "nav-item"} title={label}>
              <Icon size={16} /><span>{label}</span>{badge && <em>{badge}</em>}
            </Link>
          ))}
        </nav>
        <nav className="nav-section nav-section--secondary">
          {!collapsed && <span className="nav-label">Runtime</span>}
          <button className="nav-item"><Cpu size={16} /><span>Performance</span></button>
          <button className="nav-item"><Box size={16} /><span>Compatibility</span></button>
          <button className="nav-item"><Sparkles size={16} /><span>AI insights</span><em>Beta</em></button>
        </nav>
        <div className="sidebar-footer">
          <button className="nav-item"><Settings size={16} /><span>Settings</span></button>
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
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || inspecting) return;
    useInternetJourneyStore.getState().setInputUrl(url);
    useUIStore.getState().setInspecting(true);
    window.dispatchEvent(new CustomEvent("velora:inspect-url", { detail: url }));
  };
  return <form className={inspecting ? "global-inspector global-inspector--loading" : "global-inspector"} onSubmit={submit} aria-label="Global URL inspector">
    <Globe2 size={14} />
    <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Global URL to inspect" placeholder="https://example.com" />
    <button type="submit" disabled={inspecting}>{inspecting ? "Inspecting…" : "Inspect URL"}</button>
  </form>;
}
