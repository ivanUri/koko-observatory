import type { TelemetryEvent } from "./types.ts";

export type Evidence = { id: string; kind: string; value: string; eventId: string; url: string; snippet: string; truncated: boolean };
export type Fingerprint = { product: string; version?: string; evidence: Evidence[]; confidence: "observed" | "indicative" };
export type Advisory = { id: string; related: string; title: string; severity: "critical"; product: string; source: string; description: string; affected: Record<string, number> };
export type SecurityReport = { evidence: Evidence[]; fingerprints: Fingerprint[]; findings: Array<{ advisory: Advisory; version: string; evidence: Evidence[]; state: "exposure-candidate"; reason: string }>; limitations: string[] };

// An adapter maps an individual captured response to evidence. Additional
// adapters and advisory packs can be added without changing the correlation engine.
type Adapter = (event: TelemetryEvent) => Evidence[];
const nextAdapter: Adapter = (event) => {
  const p = event.payload;
  if (event.kind !== "network" || p.journeyStage !== "response" || typeof p.url !== "string") return [];
  const body = typeof p.responseBody === "string" ? p.responseBody : "";
  const headers = typeof p.responseHeaders === "string" ? p.responseHeaders : "";
  const evidence: Evidence[] = [];
  const add = (kind: string, value: string, snippet: string) => evidence.push({ id: `${event.id}:${kind}:${value}`, kind, value, eventId: event.id, url: p.url as string, snippet, truncated: p.bodyTruncated === true });
  if (/^x-powered-by:\s*next\.js\s*$/im.test(headers)) add("framework-header", "Next.js", "X-Powered-By: Next.js");
  if (/\/_next\/static\//.test(p.url)) add("framework-path", "Next.js", "/_next/static/");
  if (p.resourceType === "Script" || /javascript/i.test(String(p.contentType ?? ""))) {
    const match = /\b(?:window|self)\.next\s*=\s*\{\s*version\s*:\s*["'](\d+\.\d+\.\d+(?:-[\w.-]+)?)["']\s*,\s*appDir\s*:\s*(!0|!1|true|false)/.exec(body);
    if (match) {
      add("framework-version", match[1], match[0]);
      if (match[2] === "!0" || match[2] === "true") add("app-router", "present", match[0]);
    }
  }
  if (p.resourceType === "Document" || /text\/html/i.test(String(p.contentType ?? ""))) {
    const action = /\$ACTION_ID_[a-f\d]{40,}/i.exec(body);
    if (action) add("server-action-marker", "present", "$ACTION_ID_[redacted]");
    if (/self\.__next_f\s*=|self\.__next_f\.push/.test(body)) add("rsc-flight-marker", "present", "self.__next_f");
  }
  return evidence;
};

export const defaultAdapters: Adapter[] = [nextAdapter];
export const advisoryPack: Advisory[] = [{
  id: "CVE-2025-66478", related: "CVE-2025-55182", title: "Next.js App Router RSC deserialization", severity: "critical", product: "Next.js",
  source: "https://nextjs.org/blog/CVE-2025-66478",
  description: "An affected App Router version may expose the React Server Components deserialization vulnerability. Version and App Router evidence do not prove exploitability or server-side package identity.",
  affected: { "15.0": 5, "15.1": 9, "15.2": 6, "15.3": 6, "15.4": 8, "15.5": 7, "16.0": 7 },
}];

export function analyzeSecurity(events: TelemetryEvent[], adapters: Adapter[] = defaultAdapters, advisories: Advisory[] = advisoryPack): SecurityReport {
  const document = events.find((event) => event.kind === "network" && event.payload.journeyStage === "response" && event.payload.resourceType === "Document" && event.payload.topLevelNavigation === true && typeof event.payload.url === "string");
  let origin: string | undefined;
  try { if (document) origin = new URL(String(document.payload.url)).origin; } catch { /* origin unavailable */ }
  // Never attribute a third-party bundle's version to the inspected application.
  const evidence = events.flatMap((event) => adapters.flatMap((adapter) => adapter(event))).filter((item) => {
    try { return !!origin && new URL(item.url).origin === origin; } catch { return false; }
  });
  const unique = [...new Map(evidence.map((item) => [`${item.kind}:${item.value}:${item.eventId}`, item])).values()];
  const versions = [...new Set(unique.filter((item) => item.kind === "framework-version").map((item) => item.value))];
  const nextEvidence = unique.filter((item) => ["framework-header", "framework-path", "framework-version", "app-router", "rsc-flight-marker", "server-action-marker"].includes(item.kind));
  const fingerprints: Fingerprint[] = versions.length ? versions.map((version) => ({ product: "Next.js", version, confidence: "observed", evidence: nextEvidence.filter((item) => item.kind !== "framework-version" || item.value === version) })) : nextEvidence.some((item) => item.kind === "framework-header" || item.kind === "framework-path") ? [{ product: "Next.js", confidence: "indicative", evidence: nextEvidence }] : [];
  const findings: SecurityReport["findings"] = [];
  for (const fingerprint of fingerprints) for (const advisory of advisories) {
    if (fingerprint.product !== advisory.product || !fingerprint.version) continue;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(fingerprint.version);
    if (!match) continue; // prerelease ordering requires explicit advisory data
    const fixedPatch = advisory.affected[`${match[1]}.${match[2]}`];
    if (fixedPatch === undefined || Number(match[3]) >= fixedPatch || !fingerprint.evidence.some((item) => item.kind === "app-router")) continue;
    findings.push({ advisory, version: fingerprint.version, evidence: fingerprint.evidence.filter((item) => item.kind === "framework-version" || item.kind === "app-router" || item.kind === "server-action-marker" || item.kind === "rsc-flight-marker"), state: "exposure-candidate", reason: "The client bundle reports an affected Next.js version and App Router. Server version, deployment mitigations, and runtime exploitation remain unverified." });
  }
  const limitations = ["Client-side evidence does not establish the deployed server package version or prove exploitation.", "Advisory pack coverage is limited; no finding does not mean the application is secure."];
  if (!origin) limitations.push("Top-level document origin is unavailable; technology attribution is disabled.");
  if (events.some((event) => event.kind === "network" && event.payload.bodyTruncated === true)) limitations.push("Some response bodies were truncated; evidence may be incomplete.");
  if (versions.length > 1) limitations.push("Multiple Next.js versions were observed; they may belong to separate bundles or deployments.");
  return { evidence: unique, fingerprints, findings, limitations };
}
