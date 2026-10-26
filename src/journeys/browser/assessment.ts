import type { TelemetryEvent } from "../../core/types.ts";
import { isMeasuredEvent } from "../../core/metrics.ts";
import { diagnoseRuntime, type RuntimeFinding } from "../../core/forensics.ts";
import type { InternetJourneyAssessment } from "../internet/project.ts";

export interface BrowserRuntimeAssessment {
  state: "incomplete" | "healthy" | "attention";
  headline: string;
  summary: string;
  value?: string;
  evidenceId?: string;
  finding?: RuntimeFinding;
  measuredCount: number;
}

export interface PageLoadAssessment {
  state: "incomplete" | "healthy" | "attention";
  headline: string;
  summary: string;
  primary: "transport" | "browser" | "none";
  evidenceId?: string;
}

/**
 * Keep the Browser Journey assessment tied to explicit browser/runtime signals.
 * Network findings stay in Internet Journey so the same HTTP request is not
 * reported twice as both a transport and a browser bottleneck.
 */
export function assessBrowserRuntime(events: TelemetryEvent[]): BrowserRuntimeAssessment {
  if (!events.length) {
    return {
      state: "incomplete",
      headline: "Waiting for browser runtime evidence",
      summary: "Browser Journey has not received a Core trace for this inspection.",
      measuredCount: 0,
    };
  }

  const browserEvents = events.filter(isBrowserEvidence);
  const report = diagnoseRuntime(events);
  const browserFindings = report.findings.filter((finding) => finding.category !== "network");
  const primary = browserFindings[0];
  if (primary) {
    return {
      state: "attention",
      headline: primary.title,
      summary: primary.summary,
      value: primary.value,
      evidenceId: primary.evidenceIds[0],
      finding: primary,
      measuredCount: browserEvents.filter(isMeasuredEvent).length,
    };
  }

  if (!browserEvents.length) {
    return {
      state: "incomplete",
      headline: "Browser runtime evidence is incomplete",
      summary: "The network trace is present, but Core has not emitted a typed browser stage for this inspection.",
      measuredCount: 0,
    };
  }

  const measuredCount = browserEvents.filter(isMeasuredEvent).length;
  if (!measuredCount) {
    return {
      state: "incomplete",
      headline: "Browser stages were not timed",
      summary: "Core emitted browser lifecycle metadata, but no measured browser duration is available.",
      measuredCount: 0,
    };
  }

  return {
    state: "healthy",
    headline: "No browser runtime finding detected",
    summary: "The retained Core browser trace contains measured stages without runtime errors or covered threshold breaches.",
    value: `${measuredCount} measured signal${measuredCount === 1 ? "" : "s"}`,
    measuredCount,
  };
}

export function combinePageLoadAssessments(
  transport: InternetJourneyAssessment,
  browser: BrowserRuntimeAssessment,
): PageLoadAssessment {
  const transportAttention = transport.state === "attention";
  const browserAttention = browser.state === "attention";
  const transportIncomplete = transport.state === "incomplete";
  const browserIncomplete = browser.state === "incomplete";

  if (transportAttention && browserAttention) {
    return {
      state: "attention",
      headline: "Transport and browser evidence need attention",
      summary: `Transport: ${transport.headline}. Browser: ${browser.headline}.`,
      primary: browser.evidenceId ? "browser" : "transport",
      evidenceId: browser.evidenceId ?? transport.evidenceId,
    };
  }
  if (browserAttention) {
    return {
      state: "attention",
      headline: browser.headline,
      summary: `Browser Journey found a runtime signal after transport completed. ${browser.summary}`,
      primary: "browser",
      evidenceId: browser.evidenceId,
    };
  }
  if (transportAttention) {
    return {
      state: "attention",
      headline: transport.headline,
      summary: `Internet Journey found the transport bottleneck. Browser evidence does not replace that network measurement. ${transport.summary}`,
      primary: "transport",
      evidenceId: transport.evidenceId,
    };
  }
  if (transportIncomplete || browserIncomplete) {
    return {
      state: "incomplete",
      headline: "Page-load evidence is incomplete",
      summary: `Transport: ${transport.headline}. Browser: ${browser.headline}.`,
      primary: "none",
    };
  }
  return {
    state: "healthy",
    headline: "No covered transport or browser bottleneck detected",
    summary: `Transport: ${transport.headline}. Browser: ${browser.headline}.`,
    primary: "none",
  };
}

function isBrowserEvidence(event: TelemetryEvent) {
  if (event.payload.probe === true) return event.name === "web-vital";
  if (typeof event.payload.browserStage === "string") return true;
  return ["dom", "javascript", "scheduler", "render"].includes(event.kind);
}
