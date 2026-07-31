"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { useTelemetryStore } from "@/src/stores";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="tooling-loader">Loading editor…</div>,
});

export function InspectorPanel() {
  const latest = useTelemetryStore((state) => state.events.at(-1));
  return (
    <main className="workspace">
      <header className="workspace-header"><div><span className="eyebrow">Structured payloads</span><h1>Event inspector</h1><p>JSON, scripts, requests, responses, and configuration without blocking the UI.</p></div></header>
      <section className="editor-shell">
        <div className="editor-tabs"><span className="editor-tab editor-tab--active">event.json</span><span className="editor-tab">request.json</span><span className="editor-tab">runtime.config</span></div>
        <Monaco
          height="560px"
          language="json"
          theme="vs-dark"
          value={JSON.stringify(latest ?? { status: "waiting-for-telemetry" }, null, 2)}
          options={{ readOnly: true, minimap: { enabled: true }, fontSize: 12, lineNumbersMinChars: 3, padding: { top: 14 } }}
        />
      </section>
    </main>
  );
}

export function ConsolePanel() {
  const ref = useRef<HTMLDivElement>(null);
  const events = useTelemetryStore((state) => state.events);

  useEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    void import("@xterm/xterm").then(({ Terminal }) => {
      if (disposed || !ref.current) return;
      terminal = new Terminal({
        theme: { background: "#090b0e", foreground: "#bac2ce", cursor: "#8f7cff", green: "#56d0a2", red: "#e07c83" },
        fontFamily: "var(--font-geist-mono)",
        fontSize: 12,
        convertEol: true,
      });
      terminal.open(ref.current);
      terminal.writeln("\u001b[38;5;141mVelora Observatory runtime console\u001b[0m");
      terminal.writeln("\u001b[38;5;243mtransport websocket://127.0.0.1:9223/telemetry · JSON mode\u001b[0m");
      terminal.writeln("");
    });
    return () => {
      disposed = true;
      terminal?.dispose();
    };
  }, []);

  useEffect(() => {
    // Runtime logs are routed through a dedicated terminal adapter in production.
  }, [events]);

  return (
    <main className="workspace">
      <header className="workspace-header"><div><span className="eyebrow">Runtime diagnostics</span><h1>Console</h1><p>Browser logs, remote commands, and worker diagnostics.</p></div></header>
      <section className="terminal-shell"><div className="terminal-title"><i /><i /><i /><span>velora-runtime — zsh</span></div><div ref={ref} className="terminal-surface" /></section>
    </main>
  );
}
