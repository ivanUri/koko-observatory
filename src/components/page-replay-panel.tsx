"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Play, RotateCcw, Square } from "lucide-react";
import { Replayer } from "rrweb";
import { useTelemetryStore } from "@/src/stores";
import type { TelemetryEvent } from "@/src/core/types";

type ReplayEvent = Parameters<ConstructorParameters<typeof Replayer>[0]["push"]>[0];

const inspectionIdFor = (event: TelemetryEvent) => {
  const value = event.payload.inspectionId ?? event.payload.executionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const isReplayEvent = (value: unknown): value is ReplayEvent => {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.timestamp === "number"
    && Number.isFinite(event.timestamp)
    && typeof event.type === "number"
    && Boolean(event.data && typeof event.data === "object");
};

function latestInspectionId(events: TelemetryEvent[]) {
  const latest = (candidates: TelemetryEvent[]) => candidates
    .sort((left, right) => right.timestamp - left.timestamp || right.sequence - left.sequence)[0];
  const marker = latest(events.filter((event) => event.name === "inspection-started" && inspectionIdFor(event)));
  if (marker) return inspectionIdFor(marker);
  const replayEvent = latest(events.filter((event) => event.name === "rrweb-event" && inspectionIdFor(event)));
  return replayEvent ? inspectionIdFor(replayEvent) : undefined;
}

function pageReplayEvents(events: TelemetryEvent[]): ReplayEvent[] {
  const inspectionId = latestInspectionId(events);
  return events
    .filter((event) => event.name === "rrweb-event" && typeof event.payload.probeJson === "string")
    .filter((event) => !inspectionId || inspectionIdFor(event) === inspectionId)
    .flatMap((event) => {
      try {
        const value = JSON.parse(event.payload.probeJson as string);
        return isReplayEvent(value) ? [value] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.timestamp - right.timestamp);
}

function capturedHtmlFor(events: TelemetryEvent[]) {
  const inspectionId = latestInspectionId(events);
  const ready = [...events]
    .reverse()
    .find((event) => event.name === "site-export-ready" && (!inspectionId || inspectionIdFor(event) === inspectionId));
  const raw = ready?.payload.siteExport;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const html = (raw as Record<string, unknown>).html;
  return typeof html === "string" && html.trim().length > 0 ? html : undefined;
}

export function PageReplayPanel() {
  const events = useTelemetryStore((state) => state.events);
  const target = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const replayEvents = useMemo(() => pageReplayEvents(events), [events]);
  const capturedHtml = useMemo(() => capturedHtmlFor(events), [events]);
  const replayHasSnapshot = replayEvents.some((event) => event.type === 2);
  const [replayError, setReplayError] = useState<string>();
  const canReplay = replayEvents.length >= 2 && replayHasSnapshot && !replayError;

  useEffect(() => {
    const mount = target.current;
    if (!mount) return;

    let disposed = false;
    const onStart = () => { if (!disposed) setPlaying(true); };
    const onPause = () => { if (!disposed) setPlaying(false); };
    const onFinish = () => { if (!disposed) setPlaying(false); };
    const dispose = () => {
      disposed = true;
      replayer.current?.off("start", onStart).off("pause", onPause).off("finish", onFinish);
      replayer.current?.pause();
      replayer.current?.destroy();
      replayer.current = null;
      mount.replaceChildren();
    };

    // Remove the previous URL immediately. Otherwise a new inspection with
    // only one rrweb event leaves the old iframe visible while the new stream
    // is still being collected.
    dispose();
    setPlaying(false);
    setReplayError(undefined);

    // rrweb 2.x throws for incomplete streams. A new inspection commonly
    // starts with one meta/full-snapshot event, so wait until the stream has a
    // full snapshot and at least two valid events before constructing it.
    if (replayEvents.length < 2 || !replayHasSnapshot) {
      return dispose;
    }

    try {
      // rrweb calls this mount point `root`. Passing `target` is silently
      // ignored by rrweb 2.x and appends the replay wrapper to document.body.
      const instance = new Replayer(replayEvents as never[], { root: mount, UNSAFE_replayCanvas: true });
      instance.on("start", onStart).on("pause", onPause).on("finish", onFinish);
      replayer.current = instance;
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : String(error));
    }

    return dispose;
  }, [replayEvents, replayHasSnapshot]);

  const play = () => {
    replayer.current?.play();
    setPlaying(true);
  };
  const pause = () => {
    replayer.current?.pause();
    setPlaying(false);
  };

  return (
    <main className="workspace">
      <header className="workspace-header"><div><span className="eyebrow">Page instrumentation / rrweb</span><h1>Page Replay</h1><p>DOM snapshots, mutations and captured interactions from the inspected page.</p></div></header>
      <section className="global-timeline-summary"><article><span>Replay events</span><strong>{replayEvents.length || "—"}</strong><small>latest inspection only</small></article><article><span>Source</span><strong>{canReplay ? "Ready" : capturedHtml ? "Static snapshot" : "Waiting"}</strong><small>{replayError ?? (canReplay ? "rrweb stream ready" : capturedHtml ? "rrweb unavailable; captured HTML shown" : "Waiting for a complete DOM snapshot")}</small></article></section>
      <section className="panel-card">
        <header className="card-header"><div><h2><Activity size={15} />DOM replay</h2><p>The player is isolated from Observatory and can be replayed repeatedly.</p></div><div className="export-actions"><button type="button" onClick={play} disabled={!canReplay || playing}><Play size={14} />Play</button><button type="button" onClick={pause} disabled={!playing}><Square size={14} />Pause</button><button type="button" onClick={() => { replayer.current?.play(0); setPlaying(true); }} disabled={!canReplay}><RotateCcw size={14} />Restart</button></div></header>
        <div ref={target} className="page-replay-stage" style={{ minHeight: canReplay ? 480 : 0, background: "#111820", overflow: "hidden", borderRadius: 12 }} />
        {!canReplay && capturedHtml && <iframe className="page-replay-static" title="Captured DOM snapshot" sandbox="allow-same-origin" srcDoc={capturedHtml} />}
        {!canReplay && <div className="global-timeline-detail__empty"><strong>{replayError ?? (capturedHtml ? "rrweb replay unavailable" : replayEvents.length ? "Replay is still being recorded" : "No rrweb events yet")}</strong><span>{capturedHtml ? "This inspection has a complete captured HTML snapshot, but no usable rrweb timeline. Play, Pause and Restart are disabled." : replayEvents.length < 2 ? "The current inspection has not produced enough rrweb events yet." : !replayHasSnapshot ? "The current inspection has no complete DOM snapshot to replay." : "Run Inspect URL from the top bar to record a page."}</span></div>}
      </section>
    </main>
  );
}
