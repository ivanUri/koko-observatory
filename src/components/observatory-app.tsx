"use client";

import { useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { Box, Clock3, Cpu, Settings, Sparkles, TerminalSquare } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DemoTransport } from "@/src/core/transport";
import { TelemetryPipeline } from "@/src/core/pipeline";
import { observatoryBus } from "@/src/core/event-bus";
import { getPlugin, plugins } from "@/src/plugins/registry";
import { useGraphStore, useTelemetryStore, useUIStore } from "@/src/stores";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

export function ObservatoryApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ObservatoryRuntime />
    </QueryClientProvider>
  );
}

function ObservatoryRuntime() {
  const activePlugin = useUIStore((state) => state.activePlugin);
  const setActivePlugin = useUIStore((state) => state.setActivePlugin);
  const collapsed = useUIStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const plugin = getPlugin(activePlugin);
  const ActivePanel = plugin.component;
  const pipeline = useMemo(() => new TelemetryPipeline(new DemoTransport()), []);

  useEffect(() => {
    const unsubscribe = observatoryBus.on("snapshot", (snapshot) => {
      useTelemetryStore.getState().append(snapshot.events, snapshot.rates, snapshot.p95);
      useGraphStore.getState().update(snapshot.graphNodes, snapshot.graphEdges);
    });
    void pipeline.start();
    return () => {
      unsubscribe();
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
          {plugins.map(({ id, label, icon: Icon, badge }) => (
            <button key={id} className={activePlugin === id ? "nav-item nav-item--active" : "nav-item"} onClick={() => setActivePlugin(id)} title={label}>
              <Icon size={16} /><span>{label}</span>{badge && <em>{badge}</em>}
            </button>
          ))}
        </nav>
        <nav className="nav-section nav-section--secondary">
          {!collapsed && <span className="nav-label">Runtime</span>}
          <button className="nav-item" onClick={() => setActivePlugin("console")}><TerminalSquare size={16} /><span>Console</span></button>
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
        <motion.div key={activePlugin} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
          <ActivePanel />
        </motion.div>
      </section>
    </div>
  );
}
