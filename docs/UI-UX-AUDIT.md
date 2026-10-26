# Koko Observatory UI/UX audit

Date: 2026-10-26

## Scope

Audited the Observatory shell and the implemented primary routes: Overview, Internet Journey, Browser Journey, System Journey, Global Timeline, Execution Graph, Network, Execution, Page Replay, Automation, Reverse Inspector, Event Inspector, Console, Application, Export, AI Insights, and Settings. The special Browser Journey and Replay Lab entry points were also smoke-tested where available.

The audit intentionally stays in the frontend. No telemetry, Core, or backend behavior was changed by the UI refinement layer.

## Findings and changes

- Added shared UI tokens for spacing, control height, body/meta sizes, radius, and control focus states.
- Raised operational text that was below a readable size, especially navigation labels, KPI metadata, panel headers, filters, graph detail, automation fields, settings controls, and network request/detail data.
- Normalized common controls to a 36px target height and added a consistent visible keyboard focus ring.
- Removed the Network panel's dense, duplicated font overrides and replaced them with a smaller scoped stylesheet that keeps request data compact without rendering it below 11–12px.
- Fixed the narrow layout's main failure mode: the inspection steps, dashboard selectors, sidebar footer controls, cards, and multi-column panels now wrap or collapse instead of widening the document.
- Added responsive rules for timeline, graph, network, automation, settings, and reverse-inspector layouts while preserving internal scrolling for data-dense lists.
- Preserved the dark Observatory visual language and existing functional behavior.

## Browser verification

Before the refinement, the 390px dashboard viewport measured `body.scrollWidth = 1035px`, which caused horizontal clipping. After the refinement it measured 375px (the available content width after the browser scrollbar), with no element wider than the viewport.

At 1440×900 and 390×844, the following routes were loaded and checked for runtime error text and document overflow:

`/`, `/timeline`, `/network`, `/graph`, `/automation`, `/settings`, `/ai-insights`, `/reverse`, `/page-replay`, `/browser-journey`.

All 10 routes completed without an application/runtime error and without horizontal document overflow. Representative before/after screenshots were captured for the dashboard mobile layout and Network desktop layout during the audit session.

## Validation commands

- `npm run lint` — passed.
- `npm run build` — passed. Vinext still reports the existing large-chunk advisory.
- `npm test` — passed, 48 tests.

## Remaining considerations

- Visual inspection was performed at 1440×900 and 390×844. The responsive rules cover the intermediate breakpoints, but a future CI visual-regression pass should capture 1920, 1366, 1280, 1024, 768, and 390 widths with stable seeded telemetry.
- Dense telemetry tables intentionally retain internal horizontal scrolling where columns cannot be meaningfully stacked; this is different from document-level overflow.
- The application can still show unavailable signals when the underlying runtime has not emitted them. That is data availability, not a UI inference introduced by this audit.
