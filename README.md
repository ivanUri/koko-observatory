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
