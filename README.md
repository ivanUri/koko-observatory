<div align="center">

# Koko Observatory

### See what your browser runtime is actually doing

**Real-time telemetry · Network timeline · Execution graphs · Runtime inspection**

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ivanUri)
[![Core](https://img.shields.io/badge/Engine-Koko%20Core-F7A41D)](https://github.com/ivanUri/koko-core)
[![SDK](https://img.shields.io/badge/Automation-Koko%20SDK-3178C6)](https://github.com/ivanUri/koko-sdk)

</div>

---

**Koko Observatory** is the inspection and observability workspace for the [Koko browser runtime](https://github.com/ivanUri/koko-core). It helps developers understand what happens during navigation, network requests, JavaScript execution, and agent-driven browser workflows.

It is a standalone **Next.js 15** application, separate from the runtime engine.

> **Status:** Active development. Live visualizations require a compatible telemetry source; this repository is not a hosted monitoring service.

## What can you inspect?

| Surface | Purpose |
| --- | --- |
| **Runtime overview** | Incremental charts powered by Apache ECharts |
| **Event timeline** | Windowed browsing of runtime and request events |
| **Execution graph** | React Flow graph with custom nodes and layout controls |
| **Action Journal replay** | Inspect versioned, deterministic workflow traces |
| **Structured event inspector** | Monaco-powered event and payload inspection |
| **Runtime console** | xterm.js-based console interface |
| **Artifact export** | Captured HTML, Markdown, and JSON outputs |
| **Advanced URL inspection** | Wait conditions, selectors, scripts, headers, User-Agent, and cookies |

## Quick start

```bash
git clone https://github.com/ivanUri/koko-observatory.git
cd koko-observatory
npm install
npm run dev
```

Open the local URL printed by Next.js (typically `http://localhost:3000`).

## Connect live Koko telemetry

Observatory consumes Koko telemetry over WebSocket. Set the endpoint before starting the UI:

## Product surfaces

- Realtime runtime overview using incremental Apache ECharts updates.
- Windowed event timeline and request explorer.
- React Flow execution graph with custom nodes, minimap, animated edges, and
  layout selection.
- Deterministic replay surface for versioned Action Journal workflows.
- Monaco-based structured event inspector.
- xterm.js runtime console.
- Export workspace for captured site HTML, Markdown, and JSON artifacts.
- Global inspector advanced run options for wait strategy, deadlines, selectors,
  wait scripts, User-Agent, fixed headers, and cookie JSON import.

## Nuclei active scans

Install [Nuclei](https://docs.projectdiscovery.io/opensource/nuclei/install)
and its community templates on the host running the telemetry bridge. The
bridge locates `nuclei` in PATH, `./.tools/bin/nuclei`, or the executable named
by `KOKO_NUCLEI_BINARY`. Install or update templates with `nuclei -ut` before
starting Observatory; scans disable automatic template update checks. Set
`KOKO_NUCLEI_TEMPLATES_DIR` to the community templates root when using a
non-default template installation. `./.tools/nuclei-templates` is also
detected automatically when present.

Inspect a URL, open **Security Evidence**, select that execution and an HTTP
template profile, confirm authorization, and start the scan. Profiles cover
community technology, exposure, or CVE templates. These make new requests and
are not passive inspection; templates may have side effects or contact endpoints
outside the target. Redirects and Interactsh are disabled, and scans are bounded
to 5 requests per second, 2 concurrent templates, 120 seconds and 500 findings.
The UI retains the template ID, matcher metadata, target URL without query
parameters and reference links. Request/response excerpts are opt-in, capped
at 16 KB each and stored in local telemetry. Common credential headers and
request query strings are redacted; other sensitive body data may remain.
Extracted values are not retained. A template match is not automatically proof
of exploitation.

The bridge's Nuclei commands reject browser origins other than localhost or
loopback. As with the existing local bridge, only run it in a trusted local
environment; local clients without a browser Origin can issue commands.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The telemetry bridge forwards completed runtime records over WebSocket. Set
`NEXT_PUBLIC_KOKO_TELEMETRY_URL` when the Observatory is started, for example:

```bash
NEXT_PUBLIC_KOKO_TELEMETRY_URL=ws://127.0.0.1:9223/telemetry npm run dev
```

Without an explicit endpoint, the UI uses `ws://127.0.0.1:9223/telemetry`. The endpoint must be available for live data.

### End-to-end local example

**1. Capture runtime events** from the Koko Core checkout:

```bash
mkdir -p .koko-observatory
KOKO_INTERNET_JOURNEY_FILE="$PWD/.koko-observatory/internet-journey.jsonl" \
  ./zig-out/bin/koko fetch https://example.com
```

**2. Start the forwarding bridge** from the Observatory checkout (adjust the relative path if your folders differ):

```bash
KOKO_INTERNET_JOURNEY_FILE="../koko-core/.koko-observatory/internet-journey.jsonl" \
  npm run telemetry:bridge
```

**3. Run the UI:**

```bash
NEXT_PUBLIC_KOKO_TELEMETRY_URL=ws://127.0.0.1:9223/telemetry npm run dev
```

The bridge forwards completed JSONL records; **Core owns timing calculations**. It does not infer or rewrite measurements.

## Telemetry model

Internet Journey can display network stages such as `dns`, `tcp`, `tls`, `request`, `routing`, `server`, and `response` when provided by Koko's `TelemetryEvent` envelope.

Optional payload fields include `url`, `responseStatus`, and `responseBodyBytes`. Available visualizations depend on the events actually emitted by the runtime.

The Advanced inspector can pass run options to the bridge. Fixed headers use `Name: value` lines, while cookies may be imported as JSON or supplied by file path. Avoid uploading or exposing sensitive session data in shared environments.

## Development and validation

```bash
npx tsc --noEmit
npm run lint
npm test
```

For implementation details, see [Architecture](docs/ARCHITECTURE.md).

## Koko ecosystem

| Project | Role |
| --- | --- |
| [Koko Core](https://github.com/ivanUri/koko-core) | Zig + V8 browser runtime and automation infrastructure |
| [Koko SDK](https://github.com/ivanUri/koko-sdk) | TypeScript automation, extraction, and agent APIs |
| [Koko Observatory](https://github.com/ivanUri/koko-observatory) | Runtime telemetry, network inspection, and execution visualization |

## Contributing

Bug reports, reproducible telemetry traces with sensitive data removed, UX feedback, and focused pull requests are welcome.

---

<div align="center">

**Make browser execution observable.**

[Explore Koko Core](https://github.com/ivanUri/koko-core) · [Explore Koko SDK](https://github.com/ivanUri/koko-sdk) · [Sponsor development](https://github.com/sponsors/ivanUri)

</div>
