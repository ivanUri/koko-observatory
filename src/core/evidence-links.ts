import type { TelemetryEvent } from "./types.ts";

export type EvidenceSurface = "auto" | "network" | "inspector" | "timeline";

export function evidenceHref(event: Pick<TelemetryEvent, "id" | "kind">, surface: EvidenceSurface = "auto") {
  const resolved = surface === "auto" ? (event.kind === "network" ? "network" : "inspector") : surface;
  return `/${resolved}?event=${encodeURIComponent(event.id)}`;
}

export function eventIdFromSearch(search: string) {
  const value = new URLSearchParams(search).get("event")?.trim();
  return value || undefined;
}
