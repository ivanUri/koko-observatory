import type { TelemetryEvent } from "@/src/core/types";

/** Convert Koko's normalized events to Chrome trace-event JSON for Perfetto. */
export function telemetryToChromeTrace(events: TelemetryEvent[]) {
  return {
    traceEvents: events.map((event) => ({
      name: event.name,
      cat: event.kind,
      ph: event.duration > 0 ? "X" : "i",
      ts: event.timestamp * 1000,
      dur: event.duration > 0 ? event.duration * 1000 : undefined,
      pid: String(event.payload.processId ?? "koko-core"),
      tid: String(event.payload.threadId ?? event.payload.threadName ?? "main"),
      s: "t",
      args: { ...event.payload, kokoEventId: event.id, kokoSessionId: event.sessionId, status: event.status },
    })),
    displayTimeUnit: "ms",
  };
}

export function downloadChromeTrace(events: TelemetryEvent[], filename = "koko-trace.json") {
  const blob = new Blob([JSON.stringify(telemetryToChromeTrace(events), null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
