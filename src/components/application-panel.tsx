"use client";

import { useMemo, useState } from "react";
import { Box, Database, Globe2, HardDrive, KeyRound, LockKeyhole, Search, ShieldAlert } from "lucide-react";
import type { TelemetryEvent } from "@/src/core/types";
import { useTelemetryStore, useUIStore } from "@/src/stores";

type StorageKind = "cookies" | "local-storage" | "session-storage" | "indexed-db" | "cache-storage";
type StorageRow = { event: TelemetryEvent; kind: StorageKind; details: Record<string, unknown>; identity: string };

const storageTabs: Array<{ id: StorageKind; label: string; icon: typeof Database; description: string }> = [
  { id: "cookies", label: "Cookies", icon: KeyRound, description: "Cookies visible to this host" },
  { id: "local-storage", label: "Local Storage", icon: HardDrive, description: "Persistent key/value data for this origin" },
  { id: "session-storage", label: "Session Storage", icon: Database, description: "Browsing-context key/value data for this origin" },
  { id: "indexed-db", label: "IndexedDB", icon: Database, description: "Database metadata and record counts for this origin" },
  { id: "cache-storage", label: "Cache Storage", icon: Box, description: "Cache API backing-store coverage" },
];

export function ApplicationPanel() {
  const events = useTelemetryStore((state) => state.events);
  const inspectedUrl = useUIStore((state) => state.inspectorUrl);
  const [active, setActive] = useState<StorageKind>("cookies");
  const [query, setQuery] = useState("");
  const [sessionChoice, setSessionChoice] = useState<string>();
  const [selectedIdentity, setSelectedIdentity] = useState<string>();
  const origin = useMemo(() => inspectedOrigin(inspectedUrl), [inspectedUrl]);
  const applicationEvents = useMemo(() => events.filter((event) => event.kind === "log" && (storageKind(event.payload) !== undefined || event.payload.storageType === "snapshot") && belongsToInspectedOrigin(event, origin)), [events, origin]);
  const originEvents = useMemo(() => applicationEvents.filter((event) => storageKind(event.payload) !== undefined), [applicationEvents]);
  const sessions = useMemo(() => [...new Set(applicationEvents.map((event) => event.sessionId))], [applicationEvents]);
  const sessionId = sessionChoice ?? sessions.at(-1);
  const snapshotEvents = useMemo(() => originEvents.filter((event) => !sessionId || event.sessionId === sessionId), [originEvents, sessionId]);
  const snapshotSummary = useMemo(() => [...applicationEvents].reverse().find((event) => event.sessionId === sessionId && event.payload.storageType === "snapshot"), [applicationEvents, sessionId]);
  const rows = useMemo(() => latestRows(snapshotEvents), [snapshotEvents]);
  const selected = storageTabs.find((tab) => tab.id === active)!;
  const visibleRows = useMemo(() => rows
    .filter((row) => row.kind === active)
    .filter((row) => matches(row, query))
    .sort((left, right) => right.event.sequence - left.event.sequence), [active, query, rows]);
  const selectedRow = visibleRows.find((row) => row.identity === selectedIdentity) ?? visibleRows[0];
  const metrics = useMemo(() => buildMetrics(rows), [rows]);
  const Icon = selected.icon;
  const cacheSupported = false;

  return <main className="workspace application-workspace">
    <header className="journey-header">
      <div><span><Database size={12}/>Browser storage</span><h1>Application</h1><p>Origin-scoped browser state from the latest Koko Core snapshot. Captured values are stored only in this local telemetry file.</p></div>
      <div className="application-header-controls"><div className="application-origin"><Globe2 size={14}/><span>{origin}</span></div>{sessions.length > 1 && <label className="application-session"><span>Snapshot</span><select value={sessionId} onChange={(event) => { setSessionChoice(event.target.value || undefined); setSelectedIdentity(undefined); }}><option value="">Latest</option>{sessions.map((id) => <option key={id} value={id}>{shortSession(id)}</option>)}</select></label>}</div>
    </header>

    <section className="metric-grid application-metrics">
      <Metric tab={storageTabs[0]} value={metrics.cookies} detail={`${metrics.secureCookies} Secure · ${metrics.httpOnlyCookies} HttpOnly`} active={active} onClick={setActive}/>
      <Metric tab={storageTabs[1]} value={metrics.localStorage} detail={formatBytes(metrics.localBytes)} active={active} onClick={setActive}/>
      <Metric tab={storageTabs[2]} value={metrics.sessionStorage} detail={formatBytes(metrics.sessionBytes)} active={active} onClick={setActive}/>
      <Metric tab={storageTabs[3]} value={metrics.indexedDb} detail={`${metrics.idbRecords} records observed`} active={active} onClick={setActive}/>
      <Metric tab={storageTabs[4]} value={cacheSupported ? "—" : "N/A"} detail={cacheSupported ? "Cache API snapshot" : "Core exporter unavailable"} active={active} onClick={setActive}/>
    </section>

    <section className="panel-card application-card">
      <header className="card-header"><div><h2><Icon size={15}/>{selected.label}</h2><p>{selected.description} · {origin}</p></div><span className="application-source">{snapshotSummary ? snapshotLabel(snapshotSummary) : sessionId ? "snapshot signal missing" : "awaiting snapshot"}</span></header>
      <div className="application-toolbar"><label className="application-search"><Search size={13}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${selected.label.toLowerCase()}…`} aria-label={`Search ${selected.label}`} /></label></div>
      {active === "cache-storage" ? <UnsupportedCacheStorage /> : visibleRows.length ? <div className="application-split"><StorageTable rows={visibleRows} selectedIdentity={selectedRow?.identity} onSelect={setSelectedIdentity}/><StorageDetails row={selectedRow}/></div> : <EmptyStorage kind={selected.label} icon={Icon} hasSnapshot={Boolean(sessionId)} />}
    </section>

    {active === "cookies" && metrics.cookies > 0 && <section className="application-security"><ShieldAlert size={15}/><div><strong>Cookie posture</strong><span>{metrics.insecureCookies ? `${metrics.insecureCookies} cookie${metrics.insecureCookies === 1 ? "" : "s"} not marked Secure.` : "All observed cookies are marked Secure."} {metrics.nonHttpOnlyCookies ? `${metrics.nonHttpOnlyCookies} readable by page JavaScript.` : "All observed cookies are HttpOnly."}</span></div><LockKeyhole size={15}/></section>}
  </main>;
}

function Metric({ tab, value, detail, active, onClick }: { tab: (typeof storageTabs)[number]; value: number | string; detail: string; active: StorageKind; onClick: (value: StorageKind) => void }) { const Icon = tab.icon; return <button className={active === tab.id ? "metric-card application-metric application-metric--active" : "metric-card application-metric"} onClick={() => onClick(tab.id)}><div className="metric-top"><span>{tab.label}</span><Icon size={13}/></div><strong>{typeof value === "number" ? value.toLocaleString() : value}</strong><span className="delta">{detail}</span></button>; }

function StorageTable({ rows, selectedIdentity, onSelect }: { rows: StorageRow[]; selectedIdentity?: string; onSelect: (identity: string) => void }) {
  const kind = rows[0]?.kind;
  return <div className="event-table application-table" role="table">
    <div className="event-row event-row--header" role="row">{kind === "cookies" ? <><span>Name</span><span>Value</span><span>Domain / path</span><span>Expires</span><span>Flags</span></> : kind === "indexed-db" ? <><span>Database</span><span>Version</span><span>Object stores</span><span>Records</span><span>Coverage</span></> : <><span>Key</span><span>Value</span><span>Bytes</span><span>Origin</span><span>Snapshot</span></>}</div>
    {rows.map((row) => <StorageRowView key={row.identity} row={row} selected={row.identity === selectedIdentity} onSelect={onSelect}/>)}</div>;
}

function StorageRowView({ row, selected, onSelect }: { row: StorageRow; selected: boolean; onSelect: (identity: string) => void }) {
  const { event, kind, details } = row;
  const key = String(event.payload.key ?? "—");
  if (kind === "cookies") return <button type="button" className={selected ? "event-row application-row active" : "event-row application-row"} role="row" onClick={() => onSelect(row.identity)}><span><i className={`event-dot event-dot--${event.status}`} />{key}</span><span className="mono application-value">{storageValue(event)}</span><span><b>{String(details.domain ?? event.payload.origin ?? "—")}</b><small>{String(details.path ?? "/")}</small></span><span className="mono">{formatExpiry(details.expires)}</span><span className="application-flags">{details.secure && <b>Secure</b>}{details.httpOnly && <b>HttpOnly</b>}{details.sameSite && <b>{String(details.sameSite)}</b>}{details.partitioned && <b>Partitioned</b>}</span></button>;
  if (kind === "indexed-db") return <button type="button" className={selected ? "event-row application-row active" : "event-row application-row"} role="row" onClick={() => onSelect(row.identity)}><span><i className={`event-dot event-dot--${event.status}`} />{key}</span><span className="mono">{String(details.version ?? "—")}</span><span className="mono">{String(details.objectStoreCount ?? 0)}</span><span className="mono">{String(details.recordCount ?? 0)}</span><span className="application-state">metadata only</span></button>;
  return <button type="button" className={selected ? "event-row application-row active" : "event-row application-row"} role="row" onClick={() => onSelect(row.identity)}><span><i className={`event-dot event-dot--${event.status}`} />{key}</span><span className="mono application-value">{storageValue(event)}</span><span className="mono">{formatBytes(number(event.payload.valueBytes))}</span><span className="mono">{String(event.payload.origin ?? "—")}</span><span className="mono">#{event.sequence}</span></button>;
}

function StorageDetails({ row }: { row?: StorageRow }) {
  if (!row) return null;
  const payload = row.event.payload;
  const details = row.details;
  const fields: Array<[string, string]> = row.kind === "cookies" ? [["Name", String(payload.key ?? "—")], ["Value", storageValue(row.event)], ["Domain", String(details.domain ?? "—")], ["Path", String(details.path ?? "/")], ["Expiry", formatExpiry(details.expires)], ["SameSite", String(details.sameSite ?? "—")], ["Secure", yesNo(details.secure)], ["HttpOnly", yesNo(details.httpOnly)], ["Partitioned", yesNo(details.partitioned)]] : row.kind === "indexed-db" ? [["Database", String(payload.key ?? "—")], ["Version", String(details.version ?? "—")], ["Object stores", String(details.objectStoreCount ?? 0)], ["Records", String(details.recordCount ?? 0)], ["Value coverage", "Metadata only"]] : [["Key", String(payload.key ?? "—")], ["Value", storageValue(row.event)], ["Size", formatBytes(number(payload.valueBytes))], ["Origin", String(payload.origin ?? "—")], ["Snapshot sequence", `#${row.event.sequence}`]];
  return <aside className="application-details"><header><span>Selected entry</span><strong>{String(payload.key ?? "—")}</strong><small>{payload.valueState === "captured" ? "Value is visible and stored in this local telemetry file." : "Value capture is disabled for this snapshot."}</small></header><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label === "Value" ? "application-details__value" : ""} title={value}>{value}</dd></div>)}</dl></aside>;
}

function EmptyStorage({ kind, icon: Icon, hasSnapshot }: { kind: string; icon: typeof Database; hasSnapshot: boolean }) { return <div className="application-empty"><Icon size={22}/><strong>{hasSnapshot ? `No ${kind} entries` : `No ${kind} snapshot yet`}</strong><span>{hasSnapshot ? "Koko Core captured this origin and did not report an entry of this type." : "Inspect a URL and wait for the Core snapshot emitted after page processing settles."}</span><small>Captured values are written to the local JSONL telemetry file for this inspection.</small></div>; }
function UnsupportedCacheStorage() { return <div className="application-empty application-empty--capability"><Box size={22}/><strong>Cache Storage exporter is not available</strong><span>Koko Core exposes the Cache API surface, but its current backing store does not retain cache names or entries for an inspection snapshot.</span><small>This state means “not instrumented”, not that the origin has no Cache Storage entries.</small></div>; }

function latestRows(events: TelemetryEvent[]): StorageRow[] { const latest = new Map<string, StorageRow>(); for (const event of events) { const kind = storageKind(event.payload); if (!kind) continue; const details = record(event.payload.details); const identity = `${kind}:${String(event.payload.origin ?? "")}:${String(details.domain ?? "")}:${String(details.path ?? "")}:${String(event.payload.key ?? "")}`; const current = latest.get(identity); if (!current || current.event.sequence < event.sequence) latest.set(identity, { event, kind, details, identity }); } return [...latest.values()]; }
function buildMetrics(rows: StorageRow[]) { const cookies = rows.filter((row) => row.kind === "cookies"); const local = rows.filter((row) => row.kind === "local-storage"); const session = rows.filter((row) => row.kind === "session-storage"); const idb = rows.filter((row) => row.kind === "indexed-db"); return { cookies: cookies.length, secureCookies: cookies.filter((row) => row.details.secure === true).length, httpOnlyCookies: cookies.filter((row) => row.details.httpOnly === true).length, insecureCookies: cookies.filter((row) => row.details.secure !== true).length, nonHttpOnlyCookies: cookies.filter((row) => row.details.httpOnly !== true).length, localStorage: local.length, localBytes: local.reduce((sum, row) => sum + (number(row.event.payload.valueBytes) ?? 0), 0), sessionStorage: session.length, sessionBytes: session.reduce((sum, row) => sum + (number(row.event.payload.valueBytes) ?? 0), 0), indexedDb: idb.length, idbRecords: idb.reduce((sum, row) => sum + (number(row.details.recordCount) ?? 0), 0) }; }
function matches(row: StorageRow, query: string) { return !query.trim() || `${row.event.payload.key ?? ""} ${row.event.payload.origin ?? ""} ${JSON.stringify(row.details)}`.toLowerCase().includes(query.toLowerCase()); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function formatBytes(value?: number) { if (value == null) return "—"; if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`; if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`; return `${value} B`; }
function formatExpiry(value: unknown) { return typeof value === "number" ? new Date(value * 1_000).toLocaleString() : "Session"; }
function yesNo(value: unknown) { return value === true ? "Yes" : "No"; }
function shortSession(value: string) { return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function storageValue(event: TelemetryEvent) { return typeof event.payload.value === "string" ? event.payload.value : "redacted"; }
function snapshotLabel(event: TelemetryEvent) { const details = record(event.payload.details); const count = number(details.emittedEntries) ?? 0; return count ? `${count} entries captured` : "snapshot captured · no entries"; }
function inspectedOrigin(url: string) { try { return new URL(url).origin; } catch { return url || "No inspected origin"; } }
function storageKind(payload: Record<string, unknown>): StorageKind | undefined { const value = payload.storageType ?? payload.storageKind ?? payload.applicationStorage; if (value === "cookies" || value === "cookie") return "cookies"; if (value === "local-storage" || value === "localStorage") return "local-storage"; if (value === "session-storage" || value === "sessionStorage") return "session-storage"; if (value === "indexed-db" || value === "indexedDB") return "indexed-db"; if (value === "cache-storage" || value === "cacheStorage") return "cache-storage"; return undefined; }
function belongsToInspectedOrigin(event: TelemetryEvent, origin: string) { try { const target = new URL(origin); const kind = storageKind(event.payload); if (kind === "cookies") { const domain = String(record(event.payload.details).domain ?? event.payload.origin ?? "").replace(/^\./, "").toLowerCase(); const host = target.hostname.toLowerCase(); return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`)); } return String(event.payload.origin ?? "") === target.origin; } catch { return false; } }
