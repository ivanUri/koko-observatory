import type { TelemetryEvent } from "@/src/core/types";
import type { BrowserJourneyNode } from "./types";

const node = (id: string, type: BrowserJourneyNode["type"], title: string, description: string, process: string, thread: string): BrowserJourneyNode => ({
  id, type, title, description, process, thread, duration: 0, timestamp: 0, status: "pending", metadata: {},
});

export const browserJourneyNodes: BrowserJourneyNode[] = [
  node("response", "boundary", "Response received", "Network bytes cross into the browser processing pipeline.", "Browser", "Network"),
  node("html-parser", "parser", "HTML parser", "Tokenizer and tree builder progressively construct the document.", "Renderer", "Main"),
  node("dom", "dom", "DOM construction", "Tokens become nodes with parser-blocking boundaries preserved.", "Renderer", "Main"),
  node("javascript", "javascript", "JavaScript engine", "Compile and execute scripts at script-level granularity.", "Renderer", "Main"),
  node("event-loop", "scheduler", "Event loop", "Tasks, microtasks and animation callbacks run in defined order.", "Renderer", "Main"),
  node("layout", "render", "Layout", "Calculate box geometry and element coordinates.", "Renderer", "Main"),
  node("document-complete", "boundary", "Document complete", "Koko Core emitted the document completion lifecycle boundary. This does not measure frame presentation.", "Renderer", "Main"),
];

const browserNodeIds = new Set(browserJourneyNodes.map((item) => item.id));

/** Map only explicit Core browser signals to visible journey nodes. */
export function browserNodeIdForEvent(event: TelemetryEvent): string | undefined {
  const browserStage = typeof event.payload.browserStage === "string" ? event.payload.browserStage : undefined;
  if (browserStage === "frame") return "document-complete";
  if (browserStage && browserNodeIds.has(browserStage)) return browserStage;
  if (event.kind === "network" && ["response", "received"].includes(String(event.payload.journeyStage ?? ""))) return "response";
  return undefined;
}

/** Build edges from the first observed Core stage sequence, never from probe events. */
export function observedBrowserJourneyEdges(events: TelemetryEvent[]) {
  const ordered = [...events]
    .sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence)
    .map(browserNodeIdForEvent)
    .filter((id): id is string => Boolean(id));
  const firstSeen = [...new Set(ordered)];
  return firstSeen.slice(1).map((target, index) => ({
    id: `observed-browser-${index}`,
    source: firstSeen[index],
    target,
    label: "Observed Core order",
  }));
}
