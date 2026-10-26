import { record } from "rrweb";
import axe from "axe-core";
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

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

  // Core already emits the canonical network and browser-stage measurements.
  // The browser-side OTel document-load/long-task instrumentations assume
  // Chromium semantics that are not available in every Koko realm and can
  // crash JS-heavy pages, so do not install them in the injected probe.
  emit("otel-ready", {
    instrumentations: [],
    networkSource: "koko-core",
    mode: "core-native",
  });

  const DOM_COMPLEXITY_LIMIT = 600;
  const startReplayRecording = () => {
    const nodeCount = document.querySelectorAll("*").length;
    // rrweb's full DOM serializer is reliable for ordinary pages, but very
    // large hydrated trees can exceed the lightweight Core DOM wrapper
    // lifecycle during teardown. Keep the captured HTML fallback instead of
    // producing an incomplete or unsafe replay stream.
    if (nodeCount > DOM_COMPLEXITY_LIMIT) {
      emit("rrweb-skipped", { reason: "dom-too-large", nodeCount, limit: DOM_COMPLEXITY_LIMIT });
      return;
    }
    try {
      const stopRecording = record({
        emit: (event) => emit("rrweb-event", event),
        inlineStylesheet: false,
        collectFonts: false,
        recordCanvas: false,
        checkoutEveryNms: 30_000,
        sampling: {
          mousemove: false,
          mouseInteraction: true,
          input: "last",
          scroll: 100,
        },
      });
      emit("rrweb-ready", { version: "rrweb", startedAt: performance.now() });
      // Keep the full snapshot and the first hydration mutations, then stop
      // before Core tears down the realm. This prevents rrweb's observer graph
      // from retaining DOM wrappers into native teardown while preserving a
      // useful, replayable inspection stream.
      window.setTimeout(() => {
        try { stopRecording?.(); } catch { /* best-effort cleanup */ }
      }, 1_500);
    } catch (error) {
      emit("rrweb-error", { message: error instanceof Error ? error.message : String(error) });
    }
  };
  // Starting rrweb before the parser/hydration settles makes its mutation
  // observer observe Core's document-construction work and can retain DOM
  // wrappers across a detached realm. A load-time full snapshot preserves
  // replay fidelity while keeping instrumentation outside that lifecycle.
  // Keep this below the shortest supported observation window so a caller
  // using a bounded 2s capture still receives either rrweb-ready or the
  // explicit large-DOM skip result.
  const scheduleReplayRecording = () => window.setTimeout(startReplayRecording, 1_000);
  if (document.readyState === "loading") window.addEventListener("load", scheduleReplayRecording, { once: true });
  else scheduleReplayRecording();

  if (window.__kokoProbeOptions?.accessibilityAudit !== false) {
    let auditScheduled = false;
    const scheduleAudit = () => {
      if (auditScheduled) return;
      auditScheduled = true;
      // Give hydration and the first layout a small settling window. The
      // result is explicitly labelled as an axe audit and never mixed into
      // the runtime performance metrics.
      window.setTimeout(() => {
        const auditNodeCount = document.querySelectorAll("*").length;
        if (auditNodeCount > DOM_COMPLEXITY_LIMIT) {
          emit("accessibility-audit-skipped", {
            tool: "axe-core",
            reason: "dom-too-large",
            nodeCount: auditNodeCount,
            limit: DOM_COMPLEXITY_LIMIT,
          });
          return;
        }
        void runAccessibilityAudit();
      }, 1_000);
    };
    if (document.readyState === "complete") scheduleAudit();
    else {
      window.addEventListener("load", scheduleAudit, { once: true });
      window.addEventListener("DOMContentLoaded", () => window.setTimeout(scheduleAudit, 1_500), { once: true });
    }
  }
}

export {};
