"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bot, BrainCircuit, ChevronRight, Eye, EyeOff, Gauge, KeyRound, Lightbulb, LoaderCircle, MessageSquareText, Network, PlugZap, Save, Send, Settings2, ShieldCheck, Sparkles, WandSparkles, XCircle } from "lucide-react";
import { useSelectionStore, useTelemetryStore, useUIStore } from "@/src/stores";
import { executionIdFor } from "@/src/executions/types";
import type { TelemetryEvent, TelemetryKind } from "@/src/core/types";

type InsightSeverity = "critical" | "warning" | "opportunity";
type Insight = {
  id: string;
  severity: InsightSeverity;
  category: "Performance" | "Reliability" | "Network" | "Runtime";
  title: string;
  summary: string;
  recommendation: string;
  impact: string;
  confidence: number;
  evidence: TelemetryEvent[];
};

type ProviderMode = "responses" | "chat-completions";
type ProviderConfig = { endpoint: string; model: string; apiKey: string; mode: ProviderMode };
type RequestState = "idle" | "loading" | "success" | "error";

const providerStorageKey = "koko:ai-provider";
const providerApiKeyStorageKey = "koko:ai-provider-key";
const defaultProvider: ProviderConfig = { endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna", apiKey: "", mode: "responses" };

const severityOrder: Record<InsightSeverity, number> = { critical: 0, warning: 1, opportunity: 2 };

function buildInsights(events: TelemetryEvent[]): Insight[] {
  if (!events.length) return [];
  const byDuration = [...events].sort((a, b) => b.duration - a.duration);
  const errors = events.filter((event) => event.status === "error");
  const warnings = events.filter((event) => event.status === "warning");
  const slowRuntime = byDuration.filter((event) => ["javascript", "scheduler", "render"].includes(event.kind) && event.duration >= 50);
  const slowNetwork = byDuration.filter((event) => event.kind === "network" && event.duration >= 400);
  const repeated = new Map<string, TelemetryEvent[]>();
  for (const event of events) repeated.set(event.name, [...(repeated.get(event.name) ?? []), event]);
  const repeatedWarnings = [...repeated.entries()].filter(([, group]) => group.length >= 3 && group.some((event) => event.status !== "ok")).sort((a, b) => b[1].length - a[1].length)[0];
  const insights: Insight[] = [];

  if (errors.length) insights.push({
    id: "runtime-errors", severity: "critical", category: "Reliability", title: `${errors.length} runtime error${errors.length === 1 ? "" : "s"} need attention`,
    summary: `Errors are concentrated in ${new Set(errors.map((event) => event.kind)).size} subsystem${new Set(errors.map((event) => event.kind)).size === 1 ? "" : "s"}. The most recent failure is “${errors.at(-1)?.name}”.`,
    recommendation: "Open the latest failing event, verify its parent chain, then reproduce it from the closest checkpoint before changing captured inputs.",
    impact: "High reliability risk", confidence: 96, evidence: errors.slice(-5).reverse(),
  });
  if (slowRuntime.length) insights.push({
    id: "long-runtime-work", severity: slowRuntime.some((event) => event.duration >= 200) ? "critical" : "warning", category: "Performance", title: "Main-thread work may delay interactivity",
    summary: `${slowRuntime.length} runtime event${slowRuntime.length === 1 ? "" : "s"} exceeded the 50 ms responsiveness budget. The longest took ${slowRuntime[0].duration.toFixed(1)} ms.`,
    recommendation: "Split long JavaScript work into smaller tasks, defer non-critical work, and inspect the longest event's causal parents for the initiating code path.",
    impact: `Up to ${slowRuntime[0].duration.toFixed(0)} ms blocking`, confidence: 91, evidence: slowRuntime.slice(0, 5),
  });
  if (slowNetwork.length) insights.push({
    id: "slow-network", severity: slowNetwork.some((event) => event.duration >= 1_000) ? "critical" : "warning", category: "Network", title: "Slow responses extend the critical path",
    summary: `${slowNetwork.length} network event${slowNetwork.length === 1 ? "" : "s"} took more than 400 ms. The slowest observed request completed in ${slowNetwork[0].duration.toFixed(1)} ms.`,
    recommendation: "Prioritize the slowest critical-path response. Check server timing, cacheability, payload size and whether it can be preloaded or requested later.",
    impact: `${slowNetwork.length} slow network signal${slowNetwork.length === 1 ? "" : "s"}`, confidence: 88, evidence: slowNetwork.slice(0, 5),
  });
  if (repeatedWarnings) insights.push({
    id: "repeated-signal", severity: "warning", category: "Runtime", title: `Repeated “${repeatedWarnings[0]}” signals`,
    summary: `This signal appeared ${repeatedWarnings[1].length} times and included a non-healthy status, suggesting recurring work or a retry loop.`,
    recommendation: "Compare the payloads and parent IDs across occurrences. If inputs are identical, coalesce duplicate work or cap retries with backoff.",
    impact: `${repeatedWarnings[1].length} repeated events`, confidence: 82, evidence: repeatedWarnings[1].slice(-5).reverse(),
  });
  if (!errors.length && warnings.length) insights.push({
    id: "warnings", severity: "warning", category: "Reliability", title: `${warnings.length} warning signal${warnings.length === 1 ? "" : "s"} detected`,
    summary: `The run completed without a hard error, but ${new Set(warnings.map((event) => event.kind)).size} subsystem${new Set(warnings.map((event) => event.kind)).size === 1 ? "" : "s"} emitted degraded signals.`,
    recommendation: "Review warnings in sequence order and confirm whether they are expected capability boundaries or user-visible degradation.",
    impact: "Moderate reliability risk", confidence: 84, evidence: warnings.slice(-5).reverse(),
  });
  const largestKind = ([...new Set(events.map((event) => event.kind))] as TelemetryKind[]).map((kind) => ({ kind, duration: events.filter((event) => event.kind === kind).reduce((sum, event) => sum + event.duration, 0) })).sort((a, b) => b.duration - a.duration)[0];
  if (largestKind) insights.push({
    id: "dominant-work", severity: "opportunity", category: "Performance", title: `${largestKind.kind} dominates measured work`,
    summary: `${largestKind.kind} accounts for ${largestKind.duration.toFixed(1)} ms of accumulated event duration in the active telemetry buffer.`,
    recommendation: `Start optimization in the ${largestKind.kind} journey. Focus on its highest-duration events before making broad changes elsewhere.`,
    impact: "Optimization opportunity", confidence: 76, evidence: byDuration.filter((event) => event.kind === largestKind.kind).slice(0, 5),
  });
  return insights.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

function InsightIcon({ severity }: { severity: InsightSeverity }) {
  return severity === "critical" ? <XCircle size={15} /> : severity === "warning" ? <AlertTriangle size={15} /> : <Lightbulb size={15} />;
}

function normalizeAiAnswer(input: string) {
  return input
    .replace(/unuñaed\/unresponsive/gi, "unresponsive")
    .replace(/unc\s*gästen[- ]exception/gi, "uncaught-exception")
    .replace(/non-\s*चिल्ly/gi, "non-healthy")
    .replace(/Networketimes/gi, "Network latency")
    .replace(/De Shine Main-Thread Work/gi, "Define Main-Thread Work");
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|https?:\/\/[^\s)]+)/g);
  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^https?:\/\//.test(part)) return <a key={key} href={part} target="_blank" rel="noreferrer">{part}</a>;
    return <span key={key}>{part}</span>;
  });
}

function AiAnswerMarkdown({ answer }: { answer: string }) {
  const lines = normalizeAiAnswer(answer).replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(<p key={`paragraph-${blocks.length}`}>{renderInlineMarkdown(text, `paragraph-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(<Tag key={`list-${blocks.length}`}>{list.items.map((item, index) => <li key={`${list?.ordered ? "ordered" : "unordered"}-${index}`}>{renderInlineMarkdown(item, `list-${blocks.length}-${index}`)}</li>)}</Tag>);
    list = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (!trimmed) { flushParagraph(); flushList(); continue; }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flushParagraph(); flushList(); blocks.push(<hr key={`rule-${blocks.length}`} />); continue; }
    if (heading) { flushParagraph(); flushList(); const Tag = heading[1].length <= 3 ? "h3" : "h4"; blocks.push(<Tag key={`heading-${blocks.length}`}>{renderInlineMarkdown(heading[2], `heading-${blocks.length}`)}</Tag>); continue; }
    if (bullet || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) { flushList(); list = { ordered: orderedList, items: [] }; }
      list.items.push((bullet ?? ordered)?.[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return <div className="ai-answer__content">{blocks}</div>;
}

export function AIInsightsPanel() {
  const telemetry = useTelemetryStore((state) => state.events);
  const status = useTelemetryStore((state) => state.status);
  const inspectionStartedAt = useUIStore((state) => state.inspectionStartedAt);
  const selectEvent = useSelectionStore((state) => state.select);
  const scopeExecutionId = useMemo(() => {
    if (!inspectionStartedAt) return undefined;
    const current = [...telemetry].reverse().find((event) => event.timestamp >= inspectionStartedAt && (typeof event.payload.inspectionId === "string" || typeof event.payload.executionId === "string" || typeof event.payload.inspectionState === "string"));
    return current ? executionIdFor(current) : undefined;
  }, [inspectionStartedAt, telemetry]);
  const events = useMemo(() => scopeExecutionId && inspectionStartedAt ? telemetry.filter((event) => event.timestamp >= inspectionStartedAt && executionIdFor(event) === scopeExecutionId) : [], [inspectionStartedAt, scopeExecutionId, telemetry]);
  const p95 = useMemo(() => percentile95(events.map((event) => event.duration)), [events]);
  const baselineInsights = useMemo(() => buildInsights(events), [events]);
  const telemetryVersion = `${events.length}:${events.at(-1)?.id ?? "empty"}`;
  const [generatedFindings, setGeneratedFindings] = useState<{ version: string; items: Insight[] }>();
  const [filter, setFilter] = useState<"all" | InsightSeverity>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<string>();
  const [provider, setProvider] = useState<ProviderConfig>(defaultProvider);
  const [configOpen, setConfigOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [connectionState, setConnectionState] = useState<RequestState>("idle");
  const [connectionMessage, setConnectionMessage] = useState("Not tested");
  const [askState, setAskState] = useState<RequestState>("idle");
  const [askError, setAskError] = useState<string>();
  const [analysisState, setAnalysisState] = useState<RequestState>("idle");
  const [analysisError, setAnalysisError] = useState<string>();
  const insights = generatedFindings?.version === telemetryVersion ? generatedFindings.items : events.length ? baselineInsights : [];
  const findingsAreGenerated = generatedFindings?.version === telemetryVersion;
  const visible = insights.filter((insight) => filter === "all" || insight.severity === filter);
  const selected = insights.find((insight) => insight.id === selectedId) ?? visible[0];
  const healthy = events.filter((event) => event.status === "ok").length;
  const healthScore = events.length ? Math.max(0, Math.round(100 - events.filter((event) => event.status === "error").length / events.length * 100 - events.filter((event) => event.status === "warning").length / events.length * 35)) : 0;
  const configured = Boolean(provider.endpoint.trim() && provider.model.trim());

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(providerStorageKey) ?? "null") as Partial<ProviderConfig> | null;
      const apiKey = window.sessionStorage.getItem(providerApiKeyStorageKey) ?? "";
      if (saved) setProvider({ endpoint: typeof saved.endpoint === "string" ? saved.endpoint : defaultProvider.endpoint, model: typeof saved.model === "string" ? saved.model : defaultProvider.model, mode: saved.mode === "chat-completions" ? "chat-completions" : "responses", apiKey });
      if (!saved || (!apiKey && String(saved.endpoint ?? "").includes("api.openai.com"))) setConfigOpen(true);
    } catch { setConfigOpen(true); }
  }, []);

  const updateProvider = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => {
    setProvider((current) => ({ ...current, [key]: value }));
    setConnectionState("idle");
    setConnectionMessage("Configuration changed");
  };
  const saveProvider = () => {
    window.localStorage.setItem(providerStorageKey, JSON.stringify({ endpoint: provider.endpoint.trim(), model: provider.model.trim(), mode: provider.mode }));
    window.sessionStorage.setItem(providerApiKeyStorageKey, provider.apiKey.trim());
    setConnectionMessage("Configuration saved locally");
  };
  const testProvider = async () => {
    if (!configured || connectionState === "loading") return;
    setConnectionState("loading");
    setConnectionMessage("Contacting provider…");
    try {
      await callProvider(provider, "Reply with exactly: CONNECTION_OK", "This is a connection test. Follow the user's output instruction exactly.");
      setConnectionState("success");
      setConnectionMessage("Connection successful");
    } catch (error) {
      setConnectionState("error");
      setConnectionMessage(error instanceof Error ? error.message : "Connection failed");
    }
  };
  const analyzeFindings = async () => {
    if (!configured || analysisState === "loading") {
      if (!configured) { setConfigOpen(true); setAnalysisError("Configure an AI provider before generating findings."); }
      return;
    }
    if (!events.length) { setAnalysisError("Inspect a URL first so the model has telemetry to analyze."); return; }
    setAnalysisState("loading");
    setAnalysisError(undefined);
    try {
      const result = await callProvider(provider, buildFindingsPrompt(events), "You are a browser-runtime observability analyst. Return only valid JSON matching the requested schema, without Markdown fences. Use only supplied measurements. Do not invent evidence. Prioritize actionable performance, reliability, network and runtime findings.");
      const items = parseGeneratedFindings(result, events);
      if (!items.length) throw new Error("The model returned no valid findings.");
      setGeneratedFindings({ version: telemetryVersion, items });
      setSelectedId(items[0]?.id);
      setAnalysisState("success");
    } catch (error) {
      setAnalysisState("error");
      setAnalysisError(error instanceof Error ? error.message : "AI analysis failed.");
    }
  };
  const ask = async () => {
    if (!events.length) { setAskError("Inspect a URL in this session before asking about telemetry."); return; }
    if (!query.trim() || !configured || askState === "loading") {
      if (!configured) { setConfigOpen(true); setAskError("Configure an AI provider before asking a question."); }
      return;
    }
    setAskState("loading");
    setAskError(undefined);
    setAnswer(undefined);
    try {
      const result = await callProvider(provider, buildTelemetryPrompt(events, insights, query), "You are a browser-runtime performance analyst. Answer in the same language as the user's question. Use only the supplied telemetry summary, distinguish measured evidence from inference, and give concise prioritized actions. Never invent missing data.");
      setAnswer(result);
      setAskState("success");
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "The AI request failed.");
      setAskState("error");
    }
  };

  return <main className="workspace ai-insights-workspace">
    <section className="ai-insights-hero">
      <div className="ai-insights-hero__copy"><span className="eyebrow"><Sparkles size={12} /> AI analysis · Beta</span><h1>Turn runtime signals into clear next steps.</h1><p>AI Insights correlates performance, network and reliability telemetry from the active run, then ranks the issues most likely to improve the experience.</p><div className="ai-insights-hero__meta"><span><i className={`ai-live-dot ai-live-dot--${status}`} />{status}</span><span>{events.length.toLocaleString()} signals in scope</span><span title={scopeExecutionId}>Execution: {scopeExecutionId ? shortExecutionId(scopeExecutionId) : "none"}</span></div></div>
      <div className="ai-score"><div className="ai-score__ring" style={{ "--score": `${healthScore * 3.6}deg` } as React.CSSProperties}><span><strong>{events.length ? healthScore : "—"}</strong><small>Health score</small></span></div><div><strong>{events.length ? healthScore >= 85 ? "Looking healthy" : healthScore >= 60 ? "Needs attention" : "Action required" : "Awaiting a run"}</strong><p>{events.length ? `${healthy} of ${events.length} signals completed normally.` : "Inspect a URL to generate evidence-backed insights."}</p></div></div>
    </section>

    <section className="ai-summary-grid">
      <article><span><BrainCircuit size={14} />Insights found</span><strong>{insights.length}</strong><small>{insights.filter((item) => item.severity === "critical").length} critical · {insights.filter((item) => item.severity === "warning").length} warnings</small></article>
      <article><span><Gauge size={14} />P95 latency</span><strong>{p95 ? `${p95.toFixed(1)} ms` : "—"}</strong><small>Across normalized telemetry</small></article>
      <article><span><Network size={14} />Network signals</span><strong>{events.filter((event) => event.kind === "network").length}</strong><small>{events.filter((event) => event.kind === "network" && event.status !== "ok").length} degraded or failed</small></article>
      <article><span><ShieldCheck size={14} />Confidence</span><strong>{insights.length ? `${Math.round(insights.reduce((sum, item) => sum + item.confidence, 0) / insights.length)}%` : "—"}</strong><small>Based on available evidence</small></article>
    </section>

    <section className={`panel-card ai-provider${configOpen ? " ai-provider--open" : ""}`}>
      <header className="ai-provider__header"><div className="ai-provider__title"><span><Settings2 size={17} /></span><div><h2>AI provider</h2><p>Bring your own OpenAI or OpenAI-compatible API endpoint.</p></div></div><div className="ai-provider__actions"><span className={`ai-provider-status ai-provider-status--${connectionState}`}><i />{configured ? connectionMessage : "Not configured"}</span><button type="button" onClick={() => setConfigOpen((open) => !open)}>{configOpen ? "Close settings" : "Configure"}</button></div></header>
      {configOpen && <form className="ai-provider__form" onSubmit={(event) => { event.preventDefault(); saveProvider(); }}>
        <div className="ai-provider__fields">
          <label className="ai-provider__endpoint"><span>API endpoint</span><input type="url" value={provider.endpoint} onChange={(event) => updateProvider("endpoint", event.target.value)} placeholder="https://api.openai.com/v1/responses" required /><small>Enter the complete POST endpoint, not only the base URL.</small></label>
          <label><span>API type</span><select value={provider.mode} onChange={(event) => { const mode = event.target.value as ProviderMode; updateProvider("mode", mode); if (provider.endpoint === defaultProvider.endpoint || provider.endpoint === "https://api.openai.com/v1/chat/completions") updateProvider("endpoint", mode === "responses" ? defaultProvider.endpoint : "https://api.openai.com/v1/chat/completions"); }}><option value="responses">Responses API</option><option value="chat-completions">Chat Completions compatible</option></select></label>
          <label><span>Model</span><input value={provider.model} onChange={(event) => updateProvider("model", event.target.value)} placeholder="gpt-5.6-luna" required /></label>
          <label className="ai-provider__key"><span>API key <em>optional for local providers</em></span><div><KeyRound size={14} /><input type={keyVisible ? "text" : "password"} value={provider.apiKey} onChange={(event) => updateProvider("apiKey", event.target.value)} placeholder="sk-…" autoComplete="off" /><button type="button" onClick={() => setKeyVisible((visible) => !visible)} aria-label={keyVisible ? "Hide API key" : "Show API key"}>{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}</button></div><small>Stored only in this browser tab session; never written to telemetry.</small></label>
        </div>
        <div className="ai-provider__footer"><p><ShieldCheck size={13} />Questions and a reduced telemetry summary are sent to the configured endpoint. Raw payloads and storage values are excluded.</p><div><button type="button" className="ai-provider__test" onClick={() => void testProvider()} disabled={!configured || connectionState === "loading"}>{connectionState === "loading" ? <LoaderCircle className="ai-spin" size={14} /> : <PlugZap size={14} />}Test connection</button><button type="submit" className="ai-provider__save" disabled={!configured}><Save size={14} />Save configuration</button></div></div>
        {connectionState === "error" && <div className="ai-provider__error"><AlertTriangle size={14} /><span>{connectionMessage}</span></div>}
      </form>}
    </section>

    <section className="ai-insights-layout">
      <div className="panel-card ai-findings">
        <header className="card-header ai-findings__header"><div><h2><WandSparkles size={15} />Prioritized findings</h2><p>{findingsAreGenerated ? `Generated by ${provider.model} from the current execution.` : analysisState === "error" ? "AI failed · showing the local baseline for this execution." : events.length ? "Local baseline from the current execution · run AI analysis for deeper findings." : "Run Inspect URL to create a fresh execution scope."}</p></div><div className="ai-findings__actions"><span className={findingsAreGenerated ? "ai-source-badge ai-source-badge--generated" : "ai-source-badge"}>{findingsAreGenerated ? <Sparkles size={12} /> : <ShieldCheck size={12} />}{findingsAreGenerated ? "AI generated" : events.length ? "Local baseline" : "Not analyzed"}</span><button type="button" onClick={() => void analyzeFindings()} disabled={!events.length || analysisState === "loading"}>{analysisState === "loading" ? <LoaderCircle className="ai-spin" size={14} /> : <BrainCircuit size={14} />}{analysisState === "loading" ? "Analyzing…" : findingsAreGenerated ? "Analyze again" : "Analyze with AI"}</button></div></header>
        {analysisError && <div className="ai-findings__error"><AlertTriangle size={14} /><span>{analysisError}</span></div>}
        <nav className="ai-filter-tabs" aria-label="Filter insights">{(["all", "critical", "warning", "opportunity"] as const).map((value) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value}<span>{value === "all" ? insights.length : insights.filter((item) => item.severity === value).length}</span></button>)}</nav>
        <div className="ai-finding-list">{visible.map((insight) => <button type="button" key={insight.id} className={`ai-finding ai-finding--${insight.severity}${selected?.id === insight.id ? " ai-finding--selected" : ""}`} onClick={() => setSelectedId(insight.id)}><span className="ai-finding__icon"><InsightIcon severity={insight.severity} /></span><span className="ai-finding__body"><span><b>{insight.category}</b><em>{insight.severity}</em></span><strong>{insight.title}</strong><small>{insight.summary}</small><span className="ai-finding__facts"><i>{insight.impact}</i><i>{insight.confidence}% confidence</i><i>{insight.evidence.length} evidence</i></span></span><ChevronRight size={15} /></button>)}{!visible.length && <div className="ai-empty"><BrainCircuit size={22} /><strong>{events.length ? "No findings in this category" : "No current execution in scope"}</strong><span>{events.length ? "Try another filter or analyze this execution again." : "Older buffered telemetry is hidden. Run Inspect URL, then analyze the fresh execution."}</span></div>}</div>
      </div>

      <aside className="panel-card ai-detail">{selected ? <><header className={`ai-detail__header ai-detail__header--${selected.severity}`}><span><InsightIcon severity={selected.severity} />{selected.severity} · {selected.category}</span><h2>{selected.title}</h2><p>{selected.summary}</p></header><div className="ai-detail__section"><span className="eyebrow">Recommended next step</span><div className="ai-recommendation"><Lightbulb size={16} /><p>{selected.recommendation}</p></div></div><div className="ai-detail__section"><div className="ai-detail__section-title"><span className="eyebrow">Supporting evidence</span><small>{selected.evidence.length} signals</small></div><div className="ai-evidence-list">{selected.evidence.map((event) => <Link href="/inspector" key={event.id} onClick={() => selectEvent(event.id)}><i className={`event-dot event-dot--${event.status}`} /><span><strong>{event.name}</strong><small>{event.kind} · event #{event.sequence}</small></span><b>{event.duration.toFixed(1)} ms</b><ArrowRight size={13} /></Link>)}</div></div><footer className="ai-detail__footer"><span><ShieldCheck size={13} />Analysis confidence</span><strong>{selected.confidence}%</strong></footer></> : <div className="ai-empty ai-empty--detail"><Bot size={25} /><strong>{events.length ? "No analysis result yet" : "No telemetry to analyze yet"}</strong><span>{events.length ? "Run Analyze with AI and select a generated finding to inspect its evidence." : "Run Inspect URL and this view will turn the captured signals into prioritized findings."}</span></div>}</aside>
    </section>

    <section className="panel-card ai-ask"><div className="ai-ask__intro"><span><MessageSquareText size={17} /></span><div><h2>Ask about this run</h2><p>{!events.length ? "Inspect a URL in this session to create a fresh analysis scope." : configured ? `Using ${provider.model} via ${provider.mode === "responses" ? "Responses API" : "Chat Completions"}.` : "Configure an AI provider to analyze the current telemetry."}</p></div></div><div className="ai-ask__examples"><button type="button" onClick={() => setQuery("What should I fix first?")}>What should I fix first?</button><button type="button" onClick={() => setQuery("Why is this run slow?")}>Why is this run slow?</button><button type="button" onClick={() => setQuery("Summarize the reliability risks")}>Summarize reliability risks</button></div><form onSubmit={(event) => { event.preventDefault(); void ask(); }}><Sparkles size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={!events.length ? "Inspect a URL first…" : configured ? "Ask a question about performance, errors or network behavior…" : "Configure an AI provider above to begin…"} /><button type="submit" disabled={!events.length || !query.trim() || !configured || askState === "loading"}>{askState === "loading" ? <LoaderCircle className="ai-spin" size={14} /> : <Send size={14} />}{askState === "loading" ? "Analyzing…" : "Ask AI"}</button></form>{askError && <div className="ai-answer ai-answer--error"><span><AlertTriangle size={15} /></span><p>{askError}</p></div>}{answer && <div className="ai-answer"><span><Bot size={15} /></span><AiAnswerMarkdown answer={answer} /></div>}</section>
  </main>;
}

async function callProvider(provider: ProviderConfig, prompt: string, system: string) {
  const response = await fetch("/api/ai-insights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: provider.endpoint.trim(), apiKey: provider.apiKey.trim(), model: provider.model.trim(), mode: provider.mode, prompt, system }),
  });
  const result = await response.json() as { answer?: unknown; error?: unknown };
  if (!response.ok || typeof result.answer !== "string") throw new Error(typeof result.error === "string" ? result.error : `AI request failed with HTTP ${response.status}.`);
  return result.answer;
}

function buildTelemetryPrompt(events: TelemetryEvent[], insights: Insight[], question: string) {
  const statusCounts = { ok: 0, warning: 0, error: 0 };
  const kindCounts: Record<string, number> = {};
  for (const event of events) {
    statusCounts[event.status] += 1;
    kindCounts[event.kind] = (kindCounts[event.kind] ?? 0) + 1;
  }
  const topEvents = [...events].sort((left, right) => right.duration - left.duration).slice(0, 30).map((event) => ({ sequence: event.sequence, name: event.name, kind: event.kind, status: event.status, durationMs: Number(event.duration.toFixed(3)) }));
  const findingSummary = insights.map((insight) => ({ severity: insight.severity, category: insight.category, title: insight.title, summary: insight.summary, recommendation: insight.recommendation, confidence: insight.confidence, evidenceSequences: insight.evidence.map((event) => event.sequence) }));
  return `User question:\n${question.trim()}\n\nReduced telemetry context (raw payloads intentionally excluded):\n${JSON.stringify({ totalEvents: events.length, statusCounts, kindCounts, findings: findingSummary, longestEvents: topEvents }, null, 2)}`;
}

function buildFindingsPrompt(events: TelemetryEvent[]) {
  const statusCounts = { ok: 0, warning: 0, error: 0 };
  const kindStats: Record<string, { count: number; totalDurationMs: number; maxDurationMs: number }> = {};
  for (const event of events) {
    statusCounts[event.status] += 1;
    const stats = kindStats[event.kind] ?? { count: 0, totalDurationMs: 0, maxDurationMs: 0 };
    stats.count += 1;
    stats.totalDurationMs += event.duration;
    stats.maxDurationMs = Math.max(stats.maxDurationMs, event.duration);
    kindStats[event.kind] = stats;
  }
  const signals = [...events]
    .sort((left, right) => severityOrderForEvent(left) - severityOrderForEvent(right) || right.duration - left.duration)
    .slice(0, 100)
    .map((event) => ({ sequence: event.sequence, name: event.name, kind: event.kind, status: event.status, durationMs: Number(event.duration.toFixed(3)) }));
  return `Analyze this telemetry and return 1 to 6 prioritized findings.\n\nRequired JSON schema:\n{"findings":[{"severity":"critical|warning|opportunity","category":"Performance|Reliability|Network|Runtime","title":"string","summary":"string","recommendation":"string","impact":"string","confidence":0,"evidenceSequences":[1,2]}]}\n\nRules:\n- evidenceSequences must contain only sequence numbers present below.\n- confidence must be an integer from 0 to 100.\n- If evidence is insufficient, return fewer findings.\n- Do not repeat the same root cause.\n\nTelemetry:\n${JSON.stringify({ totalEvents: events.length, statusCounts, kindStats, signals }, null, 2)}`;
}

function severityOrderForEvent(event: TelemetryEvent) {
  return event.status === "error" ? 0 : event.status === "warning" ? 1 : 2;
}

function parseGeneratedFindings(value: string, events: TelemetryEvent[]): Insight[] {
  const unfenced = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return a JSON findings object.");
  let parsed: unknown;
  try { parsed = JSON.parse(unfenced.slice(start, end + 1)); } catch { throw new Error("The model returned invalid JSON. Run the analysis again."); }
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const rawFindings = Array.isArray(source.findings) ? source.findings : [];
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  return rawFindings.slice(0, 6).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const severity = item.severity === "critical" || item.severity === "warning" || item.severity === "opportunity" ? item.severity : undefined;
    const category = item.category === "Performance" || item.category === "Reliability" || item.category === "Network" || item.category === "Runtime" ? item.category : undefined;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const recommendation = typeof item.recommendation === "string" ? item.recommendation.trim() : "";
    const impact = typeof item.impact === "string" ? item.impact.trim() : "";
    if (!severity || !category || !title || !summary || !recommendation) return [];
    const sequences = Array.isArray(item.evidenceSequences) ? item.evidenceSequences.filter((entry): entry is number => typeof entry === "number") : [];
    const evidence = [...new Set(sequences)].flatMap((sequence) => bySequence.get(sequence) ? [bySequence.get(sequence)!] : []);
    const confidenceValue = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : 50;
    return [{ id: `ai:${telemetryVersionFor(events)}:${index}`, severity, category, title, summary, recommendation, impact: impact || "Model-identified impact", confidence: Math.min(100, Math.max(0, Math.round(confidenceValue))), evidence }];
  });
}

function telemetryVersionFor(events: TelemetryEvent[]) {
  return `${events.length}:${events.at(-1)?.id ?? "empty"}`;
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0;
}

function shortExecutionId(value: string) {
  return value.length > 24 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value;
}
