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
