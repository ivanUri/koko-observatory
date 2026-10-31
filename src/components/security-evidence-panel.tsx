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
  const [stored, setStored] = useState<TelemetryEvent[]>([]);
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
  return <main className={`workspace ${styles.page}`}>
    <header className="workspace-header"><div><span className="eyebrow"><ShieldAlert size={13} /> Evidence-based security</span><h1>Technology & exposure</h1><p>Captured responses are correlated with a limited advisory pack. Open an evidence record to inspect its source.</p></div><label>Execution <select value={selected ?? ""} onChange={(event) => selectExecution(event.target.value)}><option value="" disabled>Select execution</option>{executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.id}</option>)}</select></label></header>
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
