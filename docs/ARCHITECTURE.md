# Koko Observatory Architecture

## Layering

```text
UI plugins
    ↓
Observatory SDK boundary
    ↓
Telemetry engine
    ↓
Parser → normalizer → event bus → worker → indexed stores
    ↓
Transport interface
    ↓
Koko / Chrome / remote browser / browser cluster
```

The browser runtime never imports the Observatory UI. A transport adapter is
the only integration boundary, so a future TCP, gRPC, QUIC, remote browser, or
cluster transport can replace WebSocket without changing panels.

## Realtime path

Realtime data does not enter React component state:

1. `Transport` emits JSON or future binary frames.
2. `TelemetryPipeline` parses and batches frames on animation boundaries.
3. `EventBus` publishes normalized batches.
4. A module Web Worker maintains the million-event ring, FlexSearch index,
   metrics, graph window, and time-series samples.
5. Independent Zustand stores expose small indexed views to UI plugins.
6. ECharts receives incremental windows; React Flow renders only visible graph
   nodes.

TanStack Query is reserved for configuration, snapshots, history, and saved
sessions. Dexie owns offline sessions, recordings, snapshots, and event
history. LocalStorage is not used for telemetry.

## State stores

- Telemetry Store
- Graph Store
- Timeline Store
- Network Store
- UI Store
- Settings Store
- Selection Store
- Replay Store

Each store has one responsibility and can be tested without mounting React.

## Plugin contract

`ObservatoryPlugin` contains identity, navigation metadata, icon, and a lazily
renderable component. The shell resolves plugins through the registry; it has
no panel-specific data logic. Dashboard, Timeline, Network, Graph, Replay,
Compatibility, Performance, and AI can ship as independent plugins.

## Scale strategy

- One million retained events in a worker-side bounded ring.
- Ten thousand event UI window.
- Five hundred-node live graph working set with lazy expansion as the next
  backend integration step.
- ECharts LTTB sampling, inside data zoom, and canvas rendering.
- Frame-scheduled batches capped at 2,000 events.
- FlexSearch indexing outside the UI thread.
- Monaco, xterm.js, and React Flow loaded only when their plugin is opened.

## Production integration

The current demo transport is intentionally replaceable. Connecting Koko
requires a telemetry WebSocket endpoint that emits the normalized event
envelope in `src/core/types.ts`. Binary framing can be introduced inside the
parser while preserving the same worker and UI contract.
