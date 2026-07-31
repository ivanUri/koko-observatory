# Velora Observatory

Production-grade browser runtime observability, isolated from Velora core in
its own Next.js 15 application.

## Run locally

```bash
npm install
npm run dev
```

Validation:

```bash
npx tsc --noEmit
npm run lint
npm test
```

## Product surfaces

- Realtime runtime overview using incremental Apache ECharts updates.
- Windowed event timeline and request explorer.
- React Flow execution graph with custom nodes, minimap, animated edges, and
  layout selection.
- Deterministic replay surface for versioned Action Journal workflows.
- Monaco-based structured event inspector.
- xterm.js runtime console.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
## Live Velora telemetry

Internet Journey consumes real runtime events when the Observatory is started
with `NEXT_PUBLIC_VELORA_TELEMETRY_URL`, for example:

```bash
NEXT_PUBLIC_VELORA_TELEMETRY_URL=ws://127.0.0.1:9223/telemetry npm run dev
```

The transport expects the existing `TelemetryEvent` JSON envelope. Network
events can enrich the journey by including `payload.journeyStage` (`dns`,
`tcp`, `tls`, `request`, `routing`, `server`, or `response`) plus optional
`url`, `responseStatus`, and `responseBodyBytes`. The UI updates durations and
metadata from those events in realtime. Without the variable, the existing
local demo transport remains available for UI development.
