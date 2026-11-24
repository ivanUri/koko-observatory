"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { analyzeSecurity } from "@/src/core/security-evidence";
import { evidenceHref } from "@/src/core/evidence-links";
import type { TelemetryEvent } from "@/src/core/types";
import { observatoryDb } from "@/src/data/database";
import { executionIdFor } from "@/src/executions/types";
import { useExecutionStore } from "@/src/executions/store";
import { useSelectionStore, useTelemetryStore } from "@/src/stores";
import styles from "./security-evidence-panel.module.css";

export function SecurityEvidencePanel() {
  const live = useTelemetryStore((state) => state.events);
  const executions = useExecutionStore((state) => state.executions);
  const active = useExecutionStore((state) => state.activeExecutionId);
  const selectExecution = useExecutionStore((state) => state.select);
  const selectEvent = useSelectionStore((state) => state.select);
  const connection = useTelemetryStore((state) => state.status);
  const [stored, setStored] = useState<TelemetryEvent[]>([]);
  const [profile, setProfile] = useState("technologies");
  const [authorized, setAuthorized] = useState(false);
  const [captureEvidence, setCaptureEvidence] = useState(false);
  const [pendingScan, setPendingScan] = useState<string>();
  const selected = active ?? executions[0]?.id;
  useEffect(() => {
    let cancelled = false;
    setStored([]);
    if (selected) void observatoryDb.executionEvents.where("executionId").equals(selected).toArray().then((records) => {
      if (!cancelled) setStored(records.map((record) => record.event));
    }).catch(() => { if (!cancelled) setStored([]); });
    return () => { cancelled = true; };
  }, [selected]);
  const events = useMemo(() => [...new Map([...stored, ...live.filter((event) => executionIdFor(event) === selected)].map((event) => [event.id, event])).values()], [stored, live, selected]);
  const report = useMemo(() => analyzeSecurity(events), [events]);
  const eventMap = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const target = events.find((event) => event.kind === "network" && event.payload.journeyStage === "response" && event.payload.resourceType === "Document" && event.payload.topLevelNavigation === true && typeof event.payload.url === "string")?.payload.url as string | undefined;
  const scanEvents = useMemo(() => events.filter((event) => event.name.startsWith("nuclei-")).sort((a, b) => a.timestamp - b.timestamp), [events]);
  const scanId = pendingScan ?? (typeof scanEvents.at(-1)?.payload.scanId === "string" ? scanEvents.at(-1)?.payload.scanId as string : undefined);
  const currentScan = scanEvents.filter((event) => event.payload.scanId === scanId);
  const scanStatus = [...currentScan].reverse().find((event) => event.name !== "nuclei-finding");
  const running = pendingScan ? !scanStatus || scanStatus.payload.scanState === "started" : scanStatus?.payload.scanState === "started";
  const scanFindings = currentScan.filter((event) => event.name === "nuclei-finding");
  useEffect(() => { setPendingScan(undefined); setAuthorized(false); }, [selected]);
  const startScan = () => {
    if (!selected || !target || !authorized) return;
    const id = crypto.randomUUID();
    setPendingScan(id);
    window.dispatchEvent(new CustomEvent("koko:nuclei", { detail: { type: "nuclei.start", executionId: selected, scanId: id, target, profile, authorized: true, captureEvidence } }));
  };
  return <main className={`workspace ${styles.page}`}>
    <header className="workspace-header"><div><span className="eyebrow"><ShieldAlert size={13} /> Evidence-based security</span><h1>Technology & exposure</h1><p>Captured responses are correlated with a limited advisory pack. Open an evidence record to inspect its source.</p></div><label>Execution <select value={selected ?? ""} onChange={(event) => selectExecution(event.target.value)}><option value="" disabled>Select execution</option>{executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.id}</option>)}</select></label></header>
    <section className="panel-card"><h2>Nuclei active scan</h2><p>Runs community HTTP templates against the selected inspection target. This sends new requests; it does not reuse captured responses. Results are template matches, not automatic proof of exploitation.</p>
      <div className={styles.scanControls}><label>Target <code>{target ?? "Select an inspection with a captured document"}</code></label><label>Template profile <select value={profile} disabled={running} onChange={(event) => setProfile(event.target.value)}><option value="technologies">Technologies</option><option value="exposures">Exposures</option><option value="cves">CVEs</option></select></label></div>
      <p>HTTP templates only; redirects and Interactsh disabled. Some templates can still affect the target or contact other endpoints. CVE and exposure profiles can be intrusive. Limit: 5 requests/s, 2 concurrent, 120 seconds.</p>
      <label className={styles.confirm}><input type="checkbox" checked={authorized} disabled={running} onChange={(event) => setAuthorized(event.target.checked)} /> I am authorized to run the selected active checks against this target.</label>
      <label className={styles.confirm}><input type="checkbox" checked={captureEvidence} disabled={running} onChange={(event) => setCaptureEvidence(event.target.checked)} /> Retain request/response excerpts for matches. Bodies may contain sensitive data and are stored locally.</label>
      <div className={styles.scanActions}><button type="button" onClick={startScan} disabled={!selected || !target || !authorized || running || connection !== "live"}>Start active scan</button>{running && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("koko:nuclei", { detail: { type: "nuclei.stop", scanId } }))}>Stop</button>}<span>Bridge: {connection} · {scanStatus ? String(scanStatus.payload.scanState) : pendingScan ? "starting" : "not run"}</span></div>
      {scanStatus?.payload.error != null && <p className={styles.scanError}>{String(scanStatus.payload.error)}</p>}
      {scanStatus?.payload.message != null && <p>{String(scanStatus.payload.message)}</p>}
      <p>Nuclei and community templates must be installed on the machine running the bridge. Excerpts are limited to 16 KB each; common credential headers and request query strings are redacted. Other secrets may remain in bodies.</p>
      <div><strong>Findings: {scanFindings.length}</strong>{scanFindings.map((event) => {
        const finding = event.payload.finding as { templateId?: string; title?: string; severity?: string; matchedAt?: string; matcherName?: string; cves?: string[]; references?: string[]; request?: string; response?: string } | undefined;
        if (!finding) return null;
        return <article className={styles.finding} key={event.id}><div><strong>{finding.title} · {finding.templateId}</strong><span>{finding.severity} · TEMPLATE MATCH</span></div><p>Matched: {finding.matchedAt || "not supplied"}{finding.matcherName ? ` · matcher: ${finding.matcherName}` : ""}</p>{finding.cves?.length ? <p>{finding.cves.join(", ")}</p> : null}<div>{finding.references?.map((reference) => <a key={reference} href={reference} target="_blank" rel="noreferrer">Reference ↗ </a>)}</div>{finding.request && <details><summary>Request excerpt</summary><pre className={styles.httpEvidence}>{finding.request}</pre></details>}{finding.response && <details><summary>Response excerpt</summary><pre className={styles.httpEvidence}>{finding.response}</pre></details>}<Link href={evidenceHref(event, "inspector")} onClick={() => selectEvent(event.id)}>Inspect finding event ↗</Link></article>;
      })}</div>
    </section>
    <section className="panel-card"><h2>Advisory candidates <span>{report.findings.length}</span></h2>{report.findings.length ? report.findings.map(({ advisory, version, evidence, reason }) => <article className={styles.finding} key={`${advisory.id}:${version}`}><div><strong>{advisory.id} · {advisory.title}</strong><span>CRITICAL · EXPOSURE CANDIDATE · {advisory.related}</span></div><p>Next.js {version}. {reason}</p><p>{advisory.description}</p><a href={advisory.source} target="_blank" rel="noreferrer">Official advisory ↗</a><EvidenceList evidence={evidence} eventMap={eventMap} select={selectEvent} /></article>) : <p>{events.length ? "No matching advisory candidate in the current pack." : "Select an execution or inspect a URL to collect evidence."}</p>}</section>
    <section className="panel-card"><h2>Technology fingerprints <span>{report.fingerprints.length}</span></h2>{report.fingerprints.map((fingerprint, index) => <article className={styles.fingerprint} key={`${fingerprint.product}:${fingerprint.version ?? index}`}><strong>{fingerprint.product} {fingerprint.version ?? "version unknown"}</strong><span>{fingerprint.confidence === "observed" ? "Version observed in client bundle" : "Indicative signals"}</span><EvidenceList evidence={fingerprint.evidence} eventMap={eventMap} select={selectEvent} /></article>)}{events.length > 0 && !report.fingerprints.length && <p>No technology fingerprint matched the captured responses.</p>}</section>
    <section className="panel-card"><h2>Coverage and limitations</h2><ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul><p>Use <Link href="/automation">Automation</Link> or <Link href="/reverse">Reverse Inspector</Link> to capture interactions; this passive report does not execute verification requests.</p></section>
  </main>;
}

function EvidenceList({ evidence, eventMap, select }: { evidence: ReturnType<typeof analyzeSecurity>["evidence"]; eventMap: Map<string, TelemetryEvent>; select: (id?: string) => void }) {
  return <ul className={styles.evidence}>{evidence.map((item) => {
    const event = eventMap.get(item.eventId);
    return <li key={item.id}><div><strong>{item.kind}</strong> · <code>{item.value}</code>{item.truncated && <span> · body truncated</span>}<small>{item.url}</small><code>{item.snippet}</code></div>{event && <Link href={evidenceHref(event)} onClick={() => select(event.id)}>Inspect ↗</Link>}</li>;
  })}</ul>;
}
