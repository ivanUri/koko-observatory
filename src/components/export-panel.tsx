"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clipboard, Download, Eye, FileCode2, FileJson, FileText, Globe2, Package } from "lucide-react";
import { useExportStore, useTelemetryStore } from "@/src/stores";
import type { TelemetryEvent } from "@/src/core/types";
import { executionIdFor } from "@/src/executions/types";

type ExportFormat = "html" | "markdown" | "json";

interface SiteExport {
  url: string;
  status: number | null;
  contentType: string;
  html: string;
  body: string;
  markdown: string;
  htmlBytes: number;
  bodyBytes: number;
  markdownBytes: number;
  htmlCaptured: boolean;
  bodyCaptured: boolean;
  markdownCaptured: boolean;
  bodyTruncated: boolean;
  complete: boolean;
  sourceEventId: string | null;
  sourceEventName: string;
}

interface SiteExportSnapshot {
  schemaVersion: 1;
  exportedAt: string;
  source: "koko-core";
  url: string;
  status: number | null;
  contentType: string;
  bodyTruncated: boolean;
  complete: boolean;
  html: string;
  body: string;
  markdown: string;
  metadata: { htmlBytes: number; bodyBytes: number; markdownBytes: number; sourceEventId: string | null };
}

const formatOptions: Array<{ id: ExportFormat; label: string; description: string; extension: string; icon: typeof FileJson }> = [
  { id: "html", label: "Site HTML", description: "The final hydrated document after the configured wait", extension: "html", icon: FileCode2 },
  { id: "markdown", label: "Site Markdown", description: "Koko Core's content extraction of the site", extension: "md", icon: FileText },
  { id: "json", label: "Site JSON", description: "URL, response metadata, HTML and Markdown", extension: "json", icon: FileJson },
];

const lifecycleStages = ["domcontentloaded", "load", "domstable", "networkidle"] as const;

function lifecycleProgress(events: TelemetryEvent[]) {
  const started = [...events].reverse().find((event) => event.name === "inspection-started");
  const executionId = started ? executionIdFor(started) : undefined;
  const relevant = executionId ? events.filter((event) => executionIdFor(event) === executionId) : events;
  const seen = new Map<string, TelemetryEvent>();
  for (const event of relevant) {
    const stage = typeof event.payload.lifecycleStage === "string" ? event.payload.lifecycleStage : event.name;
    if (lifecycleStages.includes(stage as typeof lifecycleStages[number])) seen.set(stage, event);
  }
  const terminal = [...relevant].reverse().find((event) => event.name === "inspection-completed" || event.name === "inspection-failed");
  return { stages: lifecycleStages.map((stage) => ({ stage, event: seen.get(stage) })), terminal };
}

export function ExportPanel() {
  const events = useTelemetryStore((state) => state.events);
  const progress = useExportStore((state) => state.progress);
  const [format, setFormat] = useState<ExportFormat>("html");
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const autoPreviewedSource = useRef<string | null>(null);
  const site = useMemo(() => latestSiteExport(events, progress), [events, progress]);
  const lifecycle = useMemo(() => lifecycleProgress(events), [events]);
  const snapshot = useMemo(() => site ? toSnapshot(site) : undefined, [site]);
  const responseIsJson = Boolean(site && isJsonResponse(site.contentType, site.body));
  const contents = useMemo(() => snapshot ? ({ html: snapshot.html, markdown: snapshot.markdown, json: responseIsJson ? snapshot.body : JSON.stringify(snapshot, null, 2) }) : ({ html: "", markdown: "", json: "" }), [responseIsJson, snapshot]);
  const selected = formatOptions.find((item) => item.id === format) ?? formatOptions[0];
  const selectedLabel = responseIsJson && format === "json" ? "Response JSON" : selected.label;
  const content = contents[format];
  const previewable = format === "html" || format === "markdown";
  const available = Boolean(site && ((format === "html" && site.htmlCaptured && !site.bodyTruncated) || (format === "markdown" && site.markdownCaptured) || format === "json"));
  const filename = `${filenameStem(site?.url)}.${selected.extension}`;

  useEffect(() => {
    if (!responseIsJson) return;
    setFormat("json");
    setPreviewOpen(false);
    setCopied(false);
  }, [responseIsJson, site]);

  useEffect(() => {
    if (!site || responseIsJson || site.complete || !site.htmlCaptured) return;
    if (autoPreviewedSource.current === site.sourceEventId) return;
    autoPreviewedSource.current = site.sourceEventId;
    setFormat("html");
    setPreviewOpen(true);
  }, [responseIsJson, site]);

  const download = () => {
    if (!available) return;
    const mime = format === "html" ? "text/html;charset=utf-8" : format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8";
    const href = URL.createObjectURL(new Blob([content], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const copy = async () => {
    if (!available) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="workspace export-workspace">
      <header className="workspace-header"><div><span className="eyebrow">Observatory / Site export</span><h1>Export inspected site</h1><p>Download the actual site content captured by Koko Core as HTML, Markdown, or JSON.</p></div></header>
      <section className="global-timeline-summary export-summary">
        <article><span>Site</span><strong title={site?.url}>{site ? hostname(site.url) : "—"}</strong><small>{site?.url ?? "Inspect a URL first"}</small></article>
        <article><span>HTTP status</span><strong>{site?.status ?? "—"}</strong><small>{site?.contentType ?? "No site response captured"}</small></article>
        <article><span>{responseIsJson ? "Response body" : "HTML"}</span><strong>{site ? formatBytes(responseIsJson ? site.bodyBytes : site.htmlBytes) : "—"}</strong><small>{responseIsJson ? "raw JSON response" : site?.htmlCaptured ? site.complete ? "final document" : "streaming partial" : "not available"}</small></article>
        <article><span>Markdown</span><strong>{site ? formatBytes(site.markdownBytes) : "—"}</strong><small>{site?.markdownCaptured ? "content captured" : "not available"}</small></article>
      </section>
      {!site && <section className="panel-card export-empty"><Globe2 size={20} /><strong>No site export yet</strong><span>Use Inspect URL. The preview appears as soon as the first document response arrives; the final hydrated document replaces it later.</span></section>}
      <section className="panel-card export-lifecycle" aria-live="polite"><header className="card-header"><div><h2><Globe2 size={15} />Live page lifecycle</h2><p>Milestones arrive independently while Koko continues background work.</p></div><span className={`export-lifecycle__state${lifecycle.terminal ? " export-lifecycle__state--terminal" : ""}`}>{lifecycle.terminal ? lifecycle.terminal.name === "inspection-failed" ? "failed" : "snapshot ready" : lifecycle.stages.some(({ event }) => event) || site ? "background loading" : "waiting"}</span></header><div className="export-lifecycle__steps">{lifecycle.stages.map(({ stage, event }) => <div className={`export-lifecycle__step${event ? " export-lifecycle__step--done" : ""}`} key={stage}><span>{event ? "✓" : "○"}</span><strong>{stage}</strong><small>{event ? new Date(event.timestamp).toLocaleTimeString() : "pending"}</small></div>)}</div></section>
      {site && !site.complete && <div className="export-streaming"><span className="export-streaming__dot" />{responseIsJson ? "Capturing API response · updates while the inspection is running" : "Streaming document preview · updates while the inspection is running"}</div>}
      {site?.bodyTruncated && <div className="export-warning"><AlertTriangle size={15} /><span>The HTML response was truncated by the Core capture limit. JSON and Markdown remain available, but HTML is not a complete document.</span></div>}
      <section className="panel-card export-card">
        <header className="card-header"><div><h2><Package size={15} />Choose site format</h2><p>These files contain the inspected site, not Observatory benchmark telemetry.</p></div><span className="export-card__size">{available ? formatBytes(byteLength(content)) : "Unavailable"}</span></header>
        <div className="export-format-grid">
          {formatOptions.map((option) => {
            const Icon = option.icon;
            const active = option.id === format;
            const optionAvailable = Boolean(site && ((option.id === "html" && site.htmlCaptured && !site.bodyTruncated) || (option.id === "markdown" && site.markdownCaptured) || option.id === "json"));
            const optionLabel = responseIsJson && option.id === "json" ? "Response JSON" : option.label;
            const optionDescription = responseIsJson
              ? option.id === "json" ? "The original JSON body returned by the inspected URL" : `Not generated for an ${site?.contentType ?? "application/json"} response`
              : option.description;
            return <button type="button" key={option.id} className={`export-format${active ? " export-format--active" : ""}${!optionAvailable ? " export-format--disabled" : ""}`} onClick={() => { setFormat(option.id); setPreviewOpen(false); setCopied(false); }} aria-pressed={active} disabled={!optionAvailable}>
              <Icon size={18} /><strong>{optionLabel}</strong><span>{optionDescription}</span><small>.{option.extension} · {optionAvailable ? "ready" : "not captured"}</small>{active && <Check size={14} className="export-format__check" />}
            </button>;
          })}
        </div>
        <div className="export-actions"><button type="button" className="primary-button" onClick={download} disabled={!available}><Download size={15} />Download {selectedLabel}</button>{previewable ? <button type="button" onClick={() => setPreviewOpen((open) => !open)} disabled={!available}><Eye size={15} />{previewOpen ? "Hide preview" : "Preview"}</button> : <button type="button" onClick={copy} disabled={!available}><Clipboard size={15} />{copied ? "Copied" : "Copy content"}</button>}<span className="export-filename mono">{filename}</span></div>
      </section>
      <section className="panel-card export-preview-card">
        <header className="card-header"><div><h2>{previewOpen && previewable ? "Rendered preview" : `${selectedLabel} source`}</h2><p>{format === "html" ? site?.complete ? "Final DOM after hydration, rendered in an isolated frame; scripts are disabled." : "Partial document snapshot; it will update as Core receives and hydrates the page." : format === "markdown" ? "Markdown rendered as a readable site preview." : responseIsJson ? "Original JSON response body, preserved without an HTML wrapper." : "Machine-readable site snapshot containing both captured representations."}</p></div><span className="export-preview-card__format">{selected.extension}</span></header>
        {previewOpen && previewable && available ? <LivePreviewFrame key={format} complete={site?.complete === true} documentHtml={format === "html" ? htmlPreviewDocument(content, site?.url) : markdownPreviewDocument(content, site?.url)} title={`${selected.label} rendered preview`} /> : <pre className="export-preview"><code>{available ? content : "No content available. Inspect a site first."}</code></pre>}
      </section>
    </main>
  );
}

function LivePreviewFrame({ documentHtml, complete, title }: { documentHtml: string; complete: boolean; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const initialDocument = useRef(documentHtml);
  const pendingDocument = useRef(documentHtml);
  const updateTimer = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);

  const sendUpdate = () => {
    frameRef.current?.contentWindow?.postMessage({ type: "koko-preview-update", html: pendingDocument.current }, "*");
  };

  useEffect(() => {
    pendingDocument.current = documentHtml;
    if (updateTimer.current) window.clearTimeout(updateTimer.current);
    if (complete) {
      sendUpdate();
    } else {
      updateTimer.current = window.setTimeout(sendUpdate, 350);
    }
    return () => {
      if (updateTimer.current) window.clearTimeout(updateTimer.current);
    };
  }, [complete, documentHtml]);

  useEffect(() => {
    const onPreviewReady = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== "koko-preview-ready") return;
      sendUpdate();
    };
    window.addEventListener("message", onPreviewReady);
    return () => window.removeEventListener("message", onPreviewReady);
  }, []);

  // Keep captured scripts stripped, but preserve the srcdoc origin so the
  // page's stylesheet and font URLs can load like they do in a browser.
  return <iframe ref={frameRef} className="export-live-preview" srcDoc={initialDocument.current} sandbox="allow-scripts allow-same-origin" onLoad={sendUpdate} title={title} />;
}

function latestSiteExport(events: TelemetryEvent[], progress?: TelemetryEvent): SiteExport | undefined {
  const started = [...events].reverse().find((event) => event.name === "inspection-started");
  const currentExecutionId = started ? executionIdFor(started) : progress ? executionIdFor(progress) : undefined;
  const ready = [...events].reverse().find((event) => event.name === "site-export-ready" && (!currentExecutionId || executionIdFor(event) === currentExecutionId));
  // Scope all candidates to the current run so an older completed page never
  // wins while the new run is loading. Once the terminal snapshot arrives, it
  // wins even if the progress store is cleared one render later.
  if (ready) {
    const raw = ready.payload.siteExport;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return normalizeSiteExport(raw as Record<string, unknown>, ready);
  }
  if (progress && (!currentExecutionId || executionIdFor(progress) === currentExecutionId)) {
    const raw = progress.payload.siteExport;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return normalizeSiteExport(raw as Record<string, unknown>, progress);
  }
  // Keep compatibility with transports that still include progress snapshots
  // in their regular event stream.
  for (const event of [...events].reverse()) {
    if (event.name !== "site-export-progress") continue;
    if (currentExecutionId && executionIdFor(event) !== currentExecutionId) continue;
    const raw = event.payload.siteExport;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return normalizeSiteExport(raw as Record<string, unknown>, event);
  }
  const response = [...events].reverse().find((event) => event.kind === "network" && event.payload.journeyStage === "response" && typeof event.payload.responseBody === "string" && (!currentExecutionId || executionIdFor(event) === currentExecutionId));
  if (!response) return undefined;
  const contentType = typeof response.payload.contentType === "string" ? response.payload.contentType : "";
  const responseBody = String(response.payload.responseBody);
  return normalizeSiteExport({ url: response.payload.url, status: response.payload.responseStatus, contentType, ...(isJsonResponse(contentType, responseBody) ? { body: responseBody } : { html: responseBody }), bodyTruncated: response.payload.bodyTruncated, complete: false }, response);
}

function normalizeSiteExport(raw: Record<string, unknown>, event: TelemetryEvent): SiteExport {
  const contentType = typeof raw.contentType === "string" ? raw.contentType : typeof event.payload.contentType === "string" ? event.payload.contentType : "text/html";
  const rawHtml = typeof raw.html === "string" ? raw.html : "";
  const explicitBody = typeof raw.body === "string" ? raw.body : "";
  const body = explicitBody || (isJsonResponse(contentType, rawHtml) ? rawHtml : "");
  const html = body ? "" : rawHtml;
  const markdown = typeof raw.markdown === "string" ? raw.markdown : "";
  return {
    url: typeof raw.url === "string" ? raw.url : String(event.payload.requestedUrl ?? ""),
    status: typeof raw.status === "number" ? raw.status : null,
    contentType,
    html, body, markdown,
    htmlBytes: typeof raw.htmlBytes === "number" ? raw.htmlBytes : new TextEncoder().encode(html).byteLength,
    bodyBytes: typeof raw.bodyBytes === "number" ? raw.bodyBytes : new TextEncoder().encode(body).byteLength,
    markdownBytes: typeof raw.markdownBytes === "number" ? raw.markdownBytes : new TextEncoder().encode(markdown).byteLength,
    htmlCaptured: raw.htmlCaptured === true || Boolean(html),
    bodyCaptured: raw.bodyCaptured === true || Boolean(body),
    markdownCaptured: raw.markdownCaptured === true || Boolean(markdown),
    bodyTruncated: raw.bodyTruncated === true,
    complete: raw.complete === true || event.name === "site-export-ready",
    sourceEventId: typeof raw.sourceEventId === "string" ? raw.sourceEventId : event.id,
    sourceEventName: event.name,
  };
}

function toSnapshot(site: SiteExport): SiteExportSnapshot {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), source: "koko-core", url: site.url, status: site.status, contentType: site.contentType, bodyTruncated: site.bodyTruncated, complete: site.complete, html: site.html, body: site.body, markdown: site.markdown, metadata: { htmlBytes: site.htmlBytes, bodyBytes: site.bodyBytes, markdownBytes: site.markdownBytes, sourceEventId: site.sourceEventId } };
}

function isJsonResponse(contentType: string, body: string) {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("application/json") || normalized.includes("+json")) return true;
  const trimmed = body.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function hostname(url?: string) {
  if (!url) return "—";
  try { return new URL(url).hostname; } catch { return url; }
}

function filenameStem(url?: string) {
  const value = hostname(url);
  return value === "—" ? "koko-site" : value.replace(/[^a-z0-9.-]/gi, "-");
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function htmlPreviewDocument(html: string, baseUrl?: string) {
  const safeHtml = stripPreviewScripts(html);
  const base = baseUrl ? `<base href="${escapeAttribute(baseUrl)}">` : "";
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${base}`;
  const bridge = previewUpdateBridge();
  if (/<head\b/i.test(safeHtml)) return safeHtml.replace(/<head\b[^>]*>/i, (match) => `${match}${head}${bridge}`);
  if (/<html\b/i.test(safeHtml)) return safeHtml.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${head}${bridge}</head>`);
  return `<!doctype html><html><head>${head}${bridge}</head><body>${safeHtml}</body></html>`;
}

function markdownPreviewDocument(markdown: string, baseUrl?: string) {
  const lines = markdown.split(/\r?\n/);
  const rendered: string[] = [];
  let inCode = false;
  let inList: "ul" | "ol" | undefined;

  const closeList = () => {
    if (inList) rendered.push(`</${inList}>`);
    inList = undefined;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```(?:[^\s]*)?\s*$/);
    if (fence) {
      if (inCode) {
        rendered.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        rendered.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      rendered.push(escapeMarkup(line));
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      rendered.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      rendered.push("<hr>");
      continue;
    }
    const listItem = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const kind = /^\d/.test(listItem[1]) ? "ol" : "ul";
      if (inList && inList !== kind) closeList();
      if (!inList) {
        inList = kind;
        rendered.push(`<${kind}>`);
      }
      rendered.push(`<li>${inlineMarkdown(listItem[2])}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      rendered.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    closeList();
    rendered.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) rendered.push("</code></pre>");
  closeList();

  const base = baseUrl ? `<base href="${escapeAttribute(baseUrl)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${base}<style>${markdownPreviewStyles}</style>${previewUpdateBridge()}</head><body>${rendered.join("\n")}</body></html>`;
}

function stripPreviewScripts(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src|action)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "");
}

function previewUpdateBridge() {
  return `<script>(function(){var syncAttributes=function(from,to){Array.from(to.attributes).forEach(function(attribute){if(!from.hasAttribute(attribute.name))to.removeAttribute(attribute.name)});Array.from(from.attributes).forEach(function(attribute){to.setAttribute(attribute.name,attribute.value)})};var clean=function(value){var parsed=new DOMParser().parseFromString(value,"text/html");parsed.querySelectorAll("script").forEach(function(node){node.remove()});parsed.querySelectorAll("*").forEach(function(node){Array.from(node.attributes).forEach(function(attribute){if(/^on/i.test(attribute.name))node.removeAttribute(attribute.name)})});var x=window.scrollX,y=window.scrollY;syncAttributes(parsed.documentElement,document.documentElement);syncAttributes(parsed.body,document.body);var body=Array.from(parsed.body.childNodes).map(function(node){return document.importNode(node,true)});document.body.replaceChildren.apply(document.body,body);window.requestAnimationFrame(function(){window.scrollTo(x,y)})};window.addEventListener("message",function(event){if(event.source!==window.parent||!event.data||event.data.type!=="koko-preview-update")return;clean(String(event.data.html||""))});window.parent.postMessage({type:"koko-preview-ready"},"*")})()</script>`;
}

function inlineMarkdown(value: string) {
  let result = escapeMarkup(value);
  result = result.replace(/!\[([^\]]*)\]\(((?:https?:\/\/|data:image\/)[^)\s]+)\)/g, '<img alt="$1" src="$2">');
  result = result.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  result = result.replace(/_([^_]+)_/g, "<em>$1</em>");
  return result;
}

function escapeMarkup(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function escapeAttribute(value: string) {
  return escapeMarkup(value);
}

const markdownPreviewStyles = `
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { max-width: 900px; margin: 0 auto; padding: 32px 40px 56px; color: #1f2937; background: #fff; line-height: 1.65; }
  h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.25; margin: 1.4em 0 .55em; }
  h1 { font-size: 2em; } h2 { font-size: 1.55em; } h3 { font-size: 1.25em; }
  p { margin: .75em 0; } a { color: #0969da; } img { max-width: 100%; height: auto; }
  ul, ol { padding-left: 1.6em; } blockquote { margin: 1em 0; padding: .2em 1em; border-left: 4px solid #d0d7de; color: #57606a; background: #f6f8fa; }
  hr { border: 0; border-top: 1px solid #d8dee4; margin: 2em 0; }
  pre { overflow: auto; padding: 14px 16px; border-radius: 6px; background: #f6f8fa; color: #24292f; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { padding: .15em .35em; border-radius: 4px; background: #eff1f3; font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre code { padding: 0; background: transparent; }
`;
