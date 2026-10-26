import { record } from "rrweb";
import axe from "axe-core";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { LongTaskInstrumentation } from "@opentelemetry/instrumentation-long-task";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";

type ProbeHost = (name: string, payload: string) => void;

declare global {
  interface Window {
    __kokoProbeEmit?: ProbeHost;
    __kokoProbeOptions?: { accessibilityAudit?: boolean };
    __kokoObservatoryProbeInstalled?: boolean;
  }
}

const host = (): ProbeHost | undefined => window.__kokoProbeEmit;
const emit = (name: string, payload: unknown) => {
  try {
    host()?.(name, JSON.stringify(payload));
  } catch {
    // Instrumentation must never break the inspected page.
  }
};

type AccessibilityNode = {
  html: string;
  target: unknown;
  impact?: string;
  failureSummary?: string;
};

const compactAccessibilityResults = (results: axe.AxeResults) => ({
  tool: "axe-core",
  version: axe.version,
  source: "injected-page-probe",
  documentState: document.readyState,
  url: location.href,
  counts: {
    violations: results.violations.length,
    incomplete: results.incomplete.length,
    passes: results.passes.length,
    inapplicable: results.inapplicable.length,
  },
  // Core keeps probe payloads bounded. Keep enough node evidence to diagnose
  // a rule while retaining the complete counts above.
  violations: results.violations.slice(0, 25).map((rule) => ({
    id: rule.id,
    impact: rule.impact,
    help: rule.help,
    helpUrl: rule.helpUrl,
    tags: rule.tags,
    nodes: rule.nodes.slice(0, 8).map((node): AccessibilityNode => ({
      html: node.html.slice(0, 500),
      target: node.target,
      impact: node.impact,
      failureSummary: node.failureSummary?.slice(0, 500),
    })),
  })),
  incomplete: results.incomplete.slice(0, 25).map((rule) => ({
    id: rule.id,
    impact: rule.impact,
    help: rule.help,
    helpUrl: rule.helpUrl,
    tags: rule.tags,
    nodes: rule.nodes.slice(0, 8).map((node): AccessibilityNode => ({
      html: node.html.slice(0, 500),
      target: node.target,
      impact: node.impact,
      failureSummary: node.failureSummary?.slice(0, 500),
    })),
  })),
});

const runAccessibilityAudit = async () => {
  const startedAt = performance.now();
  try {
    const results = await axe.run(document, {
      // Keep the full rule result groups: `incomplete` is evidence that needs
      // human review, not a passing result and not a failure.
      resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
      iframes: false,
      elementRef: false,
    });
    emit("accessibility-audit", {
      ...compactAccessibilityResults(results),
      duration: performance.now() - startedAt,
    });
  } catch (error) {
    emit("accessibility-audit-error", {
      tool: "axe-core",
      version: axe.version,
      message: error instanceof Error ? error.message : String(error),
      duration: performance.now() - startedAt,
    });
  }
};

class KokoSpanExporter {
  export(spans: Array<{ name: string; startTime: unknown; duration: unknown; attributes: Record<string, unknown> }>, done: (result: { code: ExportResultCode }) => void) {
    for (const span of spans) {
      emit("otel-span", {
        name: span.name,
        startTime: span.startTime,
        duration: span.duration,
        attributes: span.attributes,
      });
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

if (!window.__kokoObservatoryProbeInstalled) {
  window.__kokoObservatoryProbeInstalled = true;
  emit("probe-ready", { url: location.href, startedAt: performance.now() });

  const reportVital = (metric: { name: string; value: number; rating?: string; id: string; navigationType?: string }) => {
    emit("web-vital", {
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
      navigationType: metric.navigationType,
    });
  };
  onCLS(reportVital, { reportAllChanges: true });
  onFCP(reportVital);
  // A bounded inspection has no visibilitychange to hidden. Publish the
  // first trusted interaction as soon as its Event Timing entry is available.
  onINP(reportVital, { reportAllChanges: true });
  // Observatory sessions end without a browser visibility transition or a
  // user input. Ask web-vitals to publish the buffered LCP candidate as soon
  // as Core emits it, while still allowing later candidates to update it.
  onLCP(reportVital, { reportAllChanges: true });
  onTTFB(reportVital);

  // Koko intentionally supports lightweight, non-Chromium execution where
  // some paint observers are unavailable. Preserve the standards-based
  // Web-Vitals callbacks above, but expose navigation timing as a clearly
  // labelled fallback so a run still has useful timing evidence.
  const reportNavigationFallback = () => {
    try {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const legacy = performance.timing;
      const ttfb = navigation?.responseStart ?? (legacy && legacy.responseStart > 0 && legacy.navigationStart > 0 ? legacy.responseStart - legacy.navigationStart : undefined);
      if (typeof ttfb === "number" && ttfb >= 0) emit("web-vital", { name: "TTFB", value: ttfb, source: "navigation-timing-fallback" });
    } catch {
      // Performance timing is optional in older/partial runtimes.
    }
  };
  if (document.readyState === "complete") window.setTimeout(reportNavigationFallback, 0);
  else window.addEventListener("load", reportNavigationFallback, { once: true });

  try {
    const provider = new WebTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new KokoSpanExporter())],
    });
    provider.register();
    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new LongTaskInstrumentation(),
      ],
    });
    // Koko Core already emits the canonical fetch/XHR network lifecycle. The
    // browser Fetch/XHR OTel wrappers assume native browser invocation
    // semantics and can reject on lightweight runtimes, so they are kept out
    // of the page probe to guarantee instrumentation is side-effect free.
    emit("otel-ready", { instrumentations: ["document-load", "long-task"], networkSource: "koko-core" });
  } catch (error) {
    emit("otel-error", { message: error instanceof Error ? error.message : String(error) });
  }

  try {
    record({
      emit: (event) => emit("rrweb-event", event),
      checkoutEveryNms: 30_000,
      sampling: {
        mousemove: false,
        mouseInteraction: true,
        input: "last",
        scroll: 100,
      },
    });
    emit("rrweb-ready", { version: "rrweb", startedAt: performance.now() });
  } catch (error) {
    emit("rrweb-error", { message: error instanceof Error ? error.message : String(error) });
  }

  if (window.__kokoProbeOptions?.accessibilityAudit !== false) {
    let auditScheduled = false;
    const scheduleAudit = () => {
      if (auditScheduled) return;
      auditScheduled = true;
      // Give hydration and the first layout a small settling window. The
      // result is explicitly labelled as an axe audit and never mixed into
      // the runtime performance metrics.
      window.setTimeout(() => void runAccessibilityAudit(), 1_000);
    };
    if (document.readyState === "complete") scheduleAudit();
    else {
      window.addEventListener("load", scheduleAudit, { once: true });
      window.addEventListener("DOMContentLoaded", () => window.setTimeout(scheduleAudit, 1_500), { once: true });
    }
  }
}

export {};
