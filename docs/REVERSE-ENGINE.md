# Koko Observatory Reverse Inspector

## What is implemented

The `/reverse` workspace runs a separate, explicitly targeted Koko Core MCP session. It registers a page init script before navigation, performs one user action, drains a bounded runtime probe, and stores the result as normal Observatory telemetry:

`user action → page runtime evidence → graph nodes/edges → JSON/Markdown report`

The probe records DOM events, event-listener entry/exit, DOM mutations, fetch/XHR request and response metadata, and timeout scheduling/starting. Request URLs are redacted to origin/path/query names and request/response bodies and headers are not captured.

## Evidence contract

Reverse records use schema version `1`. Each record has an action id, runtime kind, timestamp, mechanism, redaction flag and provenance class. The UI only labels a record `OBSERVED` when the page probe directly emitted it. Request/response and event/listener graph links are marked `CORRELATED` unless the runtime emitted the relationship directly. There is no hidden “likely” label presented as fact.

The graph currently supports `UserAction`, `DOMEvent`, `EventListener`, `NetworkRequest`, `NetworkResponse`, `DOMMutation`, and `AsyncTask`. The schema also reserves typed nodes and relations for later debugger/source-map integrations.

## Reused libraries and project components

| Need | Implementation | Reason |
| --- | --- | --- |
| Browser automation | Existing Koko Core MCP tools | Same browser/session boundary as Observatory automation |
| Runtime injection | Core `injected_script` plus new `addInitScript` MCP tool | Runs before author document scripts |
| AST analysis | `@babel/parser`, `@babel/traverse` | Handles modern JS/JSX/TypeScript syntax |
| Source maps | `@jridgewell/trace-mapping` | Maps generated positions without a custom VLQ parser |
| Source evidence editor | Existing `@monaco-editor/react` | Read-only payload/source presentation |
| Persistence and transport | Existing telemetry pipeline, Dexie and WebSocket bridge | Avoids a second event store |

`rrweb`, Web Vitals, OpenTelemetry and axe remain useful for the existing page-experience and replay features. They are intentionally not treated as proof of handler causality: replay is a UX artifact, while reverse evidence comes from the scoped runtime probe.

## Accuracy boundaries

- Listeners installed before the init script may only be visible through the resulting DOM event.
- A network response is observed, but a network-to-render edge is only correlated unless a stronger runtime identifier is available.
- Server-side code, browser-internal implementation details, closed shadow roots and cross-origin iframe internals are outside this probe.
- Static AST indexing is a candidate index, not proof that a function executed.
- The current targeted mode is opt-in and does not instrument every page inspection.

## Security and performance

Reverse mode is opt-in per automation session. The probe has a 400-record bounded drain, does not capture bodies or headers, and uses redacted URL metadata. It is not injected into ordinary site inspection. The MCP init-script capability is session-scoped; the bridge is bound to loopback.

## Verification status

Automated coverage includes graph provenance, request/response linking, Babel indexing and source-map mapping. Build and lint are the release gates. Live-site validation still requires starting the Core binary and bridge, then using `/reverse` against a permitted test site; results should be reported as observed/failed rather than inferred when the site blocks automation or injection.

Not implemented in this vertical slice: full CDP Debugger event streaming, source repository fetching, cross-frame distributed causal graphs, and an LLM query tool. These should be separate milestones because they change permissions, data volume and evidence semantics.
