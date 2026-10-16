import type { TelemetryEvent } from "./types";
import { isMeasuredEvent } from "./metrics.ts";

export const networkStageOrder = ["queue", "cache", "dns", "routing", "proxy", "tcp", "tls", "request", "redirect", "server", "response", "received"] as const;

export interface NetworkTransfer {
  key: string;
  events: TelemetryEvent[];
  duration: number;
  url: string;
  executionId: string;
  sessionId: string;
  requestId?: string;
}

export function groupNetworkTransfers(events: TelemetryEvent[]): NetworkTransfer[] {
  const groups = new Map<string, TelemetryEvent[]>();
  const active = new Map<string, { key: string; seen: Set<string>; index: number }>();
  for (const event of [...events].filter((candidate) => candidate.kind === "network").sort((a, b) => a.sequence - b.sequence)) {
    const payload = event.payload;
    const execution = event.payload.executionId == null ? event.sessionId : String(event.payload.executionId);
    const url = String(payload.url ?? payload.requestedUrl ?? "URL unavailable");
    const requestId = payload.requestId == null ? undefined : String(payload.requestId);
    const base = requestId ? `${execution}|request:${requestId}` : `${execution}|url:${url}`;
    const stage = String(payload.journeyStage ?? event.name);
    const current = active.get(base);
    const startsTransfer = stage === "queue" || !current || current.seen.has(stage) || current.seen.has("received");
    const group = startsTransfer ? { key: `${base}|${(current?.index ?? -1) + 1}`, seen: new Set<string>(), index: (current?.index ?? -1) + 1 } : current;
    active.set(base, group);
    group.seen.add(stage);
    groups.set(group.key, [...(groups.get(group.key) ?? []), event]);
  }
  return [...groups].map(([key, grouped]) => {
    const ordered = [...grouped].sort((a, b) => {
      const left = networkStageOrder.indexOf(String(a.payload.journeyStage ?? a.name) as typeof networkStageOrder[number]);
      const right = networkStageOrder.indexOf(String(b.payload.journeyStage ?? b.name) as typeof networkStageOrder[number]);
      return left - right || a.sequence - b.sequence;
    });
    const terminal = ordered.at(-1)!;
    return {
      key,
      events: ordered,
      duration: ordered.reduce((sum, event) => sum + (isMeasuredEvent(event) ? event.duration : 0), 0),
      url: String(terminal.payload.url ?? terminal.payload.requestedUrl ?? "Unavailable"),
      executionId: terminal.payload.executionId == null ? terminal.sessionId : String(terminal.payload.executionId),
      sessionId: terminal.sessionId,
      requestId: terminal.payload.requestId == null ? undefined : String(terminal.payload.requestId),
    };
  });
}
