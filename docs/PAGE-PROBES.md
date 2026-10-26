# Page probes

Every Observatory inspection builds `src/probe-entry.ts` into a standalone
browser script and passes it to Koko Core with `--inject-script-file`. Core
evaluates that script before each parsed document, including inspected frames.

The probe emits through the private `window.__kokoProbeEmit(name, json)` host
bridge. Core stores the JSON as `payload.probeJson`, preserving the original
library payload while keeping the normalized telemetry schema stable.

Included instrumentation:

- `rrweb`: DOM snapshots, mutations, input and selected interactions. Use the
  **Page Replay** plugin to play these events back.
- `web-vitals`: LCP, CLS, INP, FCP and TTFB callbacks. A navigation-timing
  fallback is reported as `source: navigation-timing-fallback` when supported.
- OpenTelemetry browser instrumentation: document-load and long-task spans are
  exported into `otel-span` events. Fetch/XHR are intentionally represented by
  Koko Core's native network lifecycle because browser OTel wrappers assume
  native invocation semantics that are not safe in Koko's lightweight runtime.
- `axe-core`: a post-settle accessibility audit. Violations and `incomplete`
  findings are preserved separately; `incomplete` means manual review is
  required and is never counted as a pass. Disable it per run in Advanced
  inspection options when measuring a page with unusually sensitive scripts.

Core limits one probe payload to 256 KiB. The Perfetto export converts all
normalized events to Chrome trace-event JSON and can be opened at
<https://ui.perfetto.dev>.
