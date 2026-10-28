# Reference market workbench: design and capability audit

This app is a reference for executable, source-backed analytical work, not a themed mockup. The [package README](../sidecar/builtin-apps/market-terminal/README.md), [AGENTS.md](../sidecar/builtin-apps/market-terminal/AGENTS.md), [SKILLS.md](../sidecar/builtin-apps/market-terminal/SKILLS.md) and [architecture](../sidecar/builtin-apps/market-terminal/ARCHITECTURE.md) define its operation and maintenance.

## Independent design brief

A useful market workspace lets someone scan a session, focus a security, inspect price structure and check the evidence behind a calculation. The first generic dashboard layout did not meet that standard: it spent too much vertical space on headings/status, forced price trends onto a zero baseline, thinned sector labels and buried independent views in a dropdown. A successful source read or responsive page was insufficient visual acceptance.

The reference instead uses direct Market/Instrument/Analytics navigation, compact semantic spacing and a stable hierarchy of primary analysis versus context. Market shows benchmark levels, signed sector rankings, an editable watchlist and exact index observations. Instrument reserves the large pane for OHLC/volume and a smaller observation desk for quote context and the dated return interpretation. Analytics uses comparable peer charts and exposes assumptions/receipts. Controls, exact values, units, source times and independent views remain available at narrow widths. Management/console controls are secondary to the analytical workflow.

## Chart and shape decisions

| Question/data | Choice | Why / boundary |
| --- | --- | --- |
| Actual daily open/high/low/close | Candles; large fitted price axis | Each wick/body has real source values; close-only or single quotes cannot supply OHLC |
| Daily shares traded | Separate compact volume bars | Zero-based magnitude; same observed sessions, no mixed price/volume axis |
| Sector session change | Horizontal signed bars with exact numbers | Long names and every observed category stay readable; negative values are meaningful |
| Closing drawdown | Line with zero reference | Decline from running closing peak; not an area suggesting an additive magnitude |
| Close and SMA20 | Paired line series with fitted/disclosed axis | Comparable INR units; no fabricated warm-up values |
| Exact observations and receipts | Searchable, sortable, paged table | Supports audit and precise values beyond chart geometry |
| Portfolio proportions | No pie/radar here | This app has no actual portfolio weights or comparable multi-axis normalized observations |
| Market heatmap | No nonnegative heatmap for signed returns | Existing intensity heatmaps do not express diverging signed values truthfully |

Shapes are semantic sections, grids and asymmetric splits; cards are reserved for compact metrics. Single plots have bounded widths and deliberate heights. Compact density reduces padding, not readable text. Source explanations stay visible and speakable; colour and tooltip inspection supplement them.

## Gaps discovered and owners

| Gap | Owner | Current action |
| --- | --- | --- |
| No actual OHLC renderer/validation | Projection | Added candlestick kind, mapped OHLC series and interval/length validation |
| Zero-baseline line plots conceal price variation | Projection | Added fitted trend domains, explicit zero option, visible scale disclosure and finite flat-series ranges |
| Long signed rankings lose names/categories | Projection | Added horizontal bars, semantic sign colouring, readable rows and exact values |
| Fixed chart sizing and missing axis context | Projection | Added semantic plot heights and visible title/axis labels |
| All surfaces inherit loose spacing | Projection | Added opt-in inherited compact/comfortable density |
| Exact point inspection depends on native hover | Projection | Added pointer/touch/keyboard observation readout without model actions |
| Views hidden in dropdown / local view state lost | Vakyartha app shell | Direct navigation, cached view/filter/scroll state and validated explicit focus navigation |
| Flagged DuckDB support was rejected at execution | Vakyartha runtime | Added bounded atomic snapshots and sandbox SQL; no arbitrary-volume claim |
| Long machine JSON clipped as model prose | Vakyartha integration adapter | Capture bounded original source receipt after existing policy/schema checks |
| Benchmark indices absent from the upstream broad group | Reference source composition | Include the actual derivatives group too; preserve exact names and source timestamps |

## Remaining boundaries

Pan/zoom/brush linking, continuous time axes, synchronized crosshairs, multiple y-axes, diverging colour matrices, log scales and statistical/error-band plots remain open reusable capabilities, not claims of this reference. Intraday ticks, depth, option surfaces, corporate-action-adjusted total returns, trading and external news are also outside its actual source contract. No chart alias or static shape substitutes for those features.

This implementation keeps a common, reusable path: no app-specific SVG renderer, CSS injected into surfaces, duplicate SQL service, new connector or separate narration store. New specialist features should be justified by a real analytical question and implemented in their canonical owner. The original primary-model graph-authoring failures remain open; deterministic package authoring and source-backed runtime checks do not certify model reliability. Current receipts and visual review belong in HANDOVER/EVALUATION.
