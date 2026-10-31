"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDot, Search } from "lucide-react";
import type { ForensicEvidenceDestination, RuntimeForensicsReport } from "@/src/core/forensics";
import type { TelemetryEvent } from "@/src/core/types";
import { evidenceHref } from "@/src/core/evidence-links";
import { useSelectionStore } from "@/src/stores";

export function RuntimeForensicsPanel({ report, events }: { report: RuntimeForensicsReport; events: TelemetryEvent[] }) {
  const select = useSelectionStore((state) => state.select);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const destinationByEventId = new Map(report.findings.flatMap((finding) => finding.evidence.map((item) => [item.eventId, item.destination] as const)));
  const primaryEvent = report.bottleneck.evidenceIds.map((id) => eventById.get(id)).find((event): event is TelemetryEvent => Boolean(event));
  const icon = report.state === "attention" ? AlertTriangle : report.state === "healthy" ? CheckCircle2 : Search;
  const Icon = icon;
  return <section className={`panel-card forensics-panel forensics-panel--${report.state}`}>
    <header className="card-header">
      <div><h2><Icon size={15} />Runtime Forensics</h2><p>Measured findings from the current Core trace. No causal claim is made without direct evidence.</p></div>
      <span className="forensics-badge">{report.state === "waiting" ? "WAITING" : report.state === "attention" ? "ATTENTION" : "NO BREACH"}</span>
    </header>
    <div className="forensics-hero"><div><span className="forensics-kicker">Primary result</span><strong>{report.headline}</strong><p>{report.summary}</p></div><div className="forensics-count"><strong>{report.evidenceCount}</strong><span>evidence<br/>records</span></div></div>
    <section className={`forensics-bottleneck forensics-bottleneck--${report.bottleneck.state}`}>
      <header><div><span className="forensics-kicker">Evidence-backed bottleneck report</span><strong>{report.bottleneck.headline}</strong></div><span className="forensics-confidence">{report.bottleneck.confidence}</span></header>
      <p>{report.bottleneck.summary}</p>
      {report.bottleneck.chain.length > 0 && <div className="forensics-chain">{report.bottleneck.chain.map((step, index) => {
        const event = step.evidenceIds.map((id) => eventById.get(id)).find((candidate): candidate is TelemetryEvent => Boolean(candidate));
        return <div className="forensics-chain__step" key={`${step.label}-${index}`}><span className="forensics-chain__index">{index + 1}</span><div><small>{step.label}</small><strong>{step.value}</strong>{event && <EvidenceMeta event={event} />}</div>{event ? <EvidenceLink event={event} select={select} destination={destinationByEventId.get(event.id)} compact /> : step.evidenceIds[0] && <button type="button" onClick={() => select(step.evidenceIds[0])}>Inspect <ArrowUpRight size={11} /></button>}</div>;
      })}</div>}
      <footer><span>Next action: {report.bottleneck.nextAction}</span>{report.bottleneck.layer === "network" && <Link href={primaryEvent ? evidenceHref(primaryEvent, "network") : "/network"} onClick={() => primaryEvent && select(primaryEvent.id)}>Open Network <ArrowUpRight size={12} /></Link>}{(report.bottleneck.layer === "runtime" || report.bottleneck.layer === "experience") && primaryEvent && <EvidenceLink event={primaryEvent} select={select} />}{report.bottleneck.layer === "reliability" && <Link href={primaryEvent ? evidenceHref(primaryEvent, "timeline") : "/timeline"} onClick={() => primaryEvent && select(primaryEvent.id)}>Open Timeline <ArrowUpRight size={12} /></Link>}</footer>
    </section>
    {report.findings.length ? <div className="forensics-findings">{report.findings.map((finding) => {
      const evidence = finding.evidence.flatMap((item) => {
        const event = eventById.get(item.eventId);
        return event ? [{ event, destination: item.destination }] : [];
      });
      return <article key={finding.id} className={`forensics-finding forensics-finding--${finding.severity}`}>
        <div className="forensics-finding__icon"><CircleDot size={13}/></div><div className="forensics-finding__body"><div className="forensics-finding__top"><strong>{finding.title}</strong><span className="forensics-confidence">{finding.confidence}</span>{finding.value && <code>{finding.value}</code>}</div><p>{finding.summary}</p>
          <div className="forensics-evidence"><span className="forensics-evidence__label">{finding.confidence === "measured" ? "Measured evidence" : "Direct evidence"}</span>{evidence.slice(0, 3).map(({ event, destination }) => <div className="forensics-evidence__item" key={event.id}><div><EvidenceMeta event={event} /><code>{event.id}</code></div><EvidenceLink event={event} destination={destination} select={select} /></div>)}</div>
          <div className="forensics-finding__actions">{evidence[0] ? <EvidenceLink event={evidence[0].event} destination={evidence[0].destination} select={select} /> : <button type="button" onClick={() => select(finding.evidenceIds[0])}>Inspect evidence <ArrowUpRight size={12}/></button>}{evidence[0] && <Link href={evidenceHref(evidence[0].event, "timeline")} onClick={() => select(evidence[0].event.id)}>Open Timeline <ArrowUpRight size={12}/></Link>}</div>
        </div>
      </article>;
    })}</div> : <div className="forensics-empty"><CheckCircle2 size={18}/><div><strong>{report.state === "waiting" ? "No inspection loaded" : "No covered threshold was breached"}</strong><span>{report.state === "waiting" ? "Run Inspect URL from the global bar to begin." : "This is not a guarantee that the page is perfect; it means this report found no direct evidence in its rule set."}</span></div></div>}
    <footer className="forensics-footer"><span>{report.measuredCount.toLocaleString()} measured signals · {report.scope.mode === "top-level-loader" ? "top-level document scope" : "full inspection scope"} · Core/probe evidence only</span><Link href="/browser-journey">Open Browser Journey <ArrowUpRight size={12}/></Link></footer>
  </section>;
}

function EvidenceMeta({ event }: { event: TelemetryEvent }) {
  const payload = event.payload;
  const stage = String(payload.journeyStage ?? payload.browserStage ?? event.name);
  const context = event.kind === "network"
    ? String(payload.url ?? "request unavailable")
    : String(payload.scriptUrl ?? payload.functionName ?? payload.url ?? event.name);
  return <span className="forensics-evidence__meta"><strong>{event.kind === "network" ? "Network" : event.kind === "javascript" ? "JavaScript" : event.kind}</strong><span>{stage} · {context}</span></span>;
}

function EvidenceLink({ event, select, destination, compact = false }: { event: TelemetryEvent; select: (id?: string) => void; destination?: ForensicEvidenceDestination; compact?: boolean }) {
  const network = event.kind === "network";
  const href = evidenceHref(event, destination ?? "auto");
  const label = compact ? "Open" : destination === "timeline" ? "Open Timeline" : network ? "Open Network" : event.kind === "javascript" ? "Open JS event" : "Open event";
  return <Link href={href} onClick={() => select(event.id)}>{label} <ArrowUpRight size={compact ? 11 : 12} /></Link>;
}
