---
name: market-dashboard
description: Create a source-backed market, index or watchlist review for an exact daily, weekly or monthly window, with optional interactive dashboard and comparable returns.
license: MIT
compatibility: Compatible with market data feeds, financial time-series snapshots, and Vakyartha canvas surfaces.
metadata:
  author: nranjan2code
  version: "1.5"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# Financial Market & Index Reviews

Analytical methodology for authoring evidence-backed market, equity, index and commodity performance reviews with verified endpoints and interactive time-series dashboards.

## Overview & Reference Files

- **Purpose**: Use this skill when asked to review stock, index, currency, commodity or portfolio performance over an explicit daily, weekly, monthly or multi-period window.
- **Skill chaining**:
  - Load enabled `dashboard` and `interactive-ui` when creating an interactive canvas.
  - The required `surface-design` skill governs layout, line charts, metric strips and spoken summaries.
- **Reference files**:
  - Read `references/market-dashboard-layout.md` via `read_skill_file` for the canonical layout patterns and evidence checklist.
  - Read `references/market-dashboard-example.json` via `read_skill_file` for a concrete reference surface schema.

## Establish the Evidence

1. **Verify instrument & window metadata**:
   - Resolve exchange, ticker/symbol identity, trading timezone, quoting currency or index points.
   - Establish the requested evaluation window: identify the exact first and last comparable trading sessions.
   - Distinguish closed trading sessions from delayed or live intraday quotes. A single spot quote cannot establish a multi-day return.
   - Never fabricate market prices, trading volume, trading calendar dates or corporate-action adjustments.
2. **Deterministic return calculations**:
   - Compute price return as `((last close / first close) - 1) × 100` from verified numbers.
   - Clearly separate price return from dividend-inclusive total return.
   - Distinguish point change, currency change, percentage change and percentage-point change.
   - Never sum price levels or percentages across instruments in a table total.

## Compose the Requested Result

1. **Liquid Canvas Architecture**:
   Choose a content-driven composition with the shared `surface-design` guidance. A single column or a full-width analytical panel can be appropriate. The following are optional patterns; include only sections and indicators that answer the requested question, with no required tier or column count:
   - **Natural-Language Headline & Metric Strip**:
     - Lead with a concise natural-language sentence naming the instrument, exact evaluation window, observed move, and data freshness so speech projection is immediate.
     - Follow with a compact metric strip (`grid` with `props: { columns: 2, minItemWidth: "sm" }`) showing Last Close and Window Price Return (`%`) with appropriate semantic `tone: "positive" | "caution" | "critical"`.
   - **Clamped Time-Series Visual**:
     - Render a dated time-series chart (`line`) plotting historical close values over the window, clamped to `maxWidth: "lg"` (or paired with volume/sector metrics in a 2-column grid `columns: 2, minItemWidth: "sm"`). Never stretch a single line chart across 100% of a 1400px canvas.
   - Use `candlestick` when actual open/high/low/close records answer the price-structure question: map the same history fields in that exact order. Use `line` for a close-only trend. Candles/trends fit observed ranges by default (`yScale: "auto"`); preserve the disclosed scale and use a separate volume bar plot. Long sector rankings use horizontal signed bars rather than a nonnegative heatmap.
   - Compact workspaces may use root `density: "compact"` and a `split` with `ratio: "2:1"` for primary price analysis and secondary context. Set chart heights deliberately, without losing readable labels.
   - **Granular Historical Table**:
     - Provide a granular historical table (`section` with `table`, `maxWidth: "full"`) mapping the canonical `{/history}` collection with trading dates, close prices and volume. Set `totals: false` on price series and returns.
2. **Canonical data submission**:
   - Submit the complete `data.history` array containing all dated records in the same `vak_render` or `vak_submit` call that references `{/history}`.
   - Bind the latest close metric using the final row index or a checked scalar value.
   - Verify that all data paths resolve cleanly; fix any schema errors before final presentation.

## Check Before Delivery

- Match every stated return to its verified endpoints and underlying calculation basis.
- Verify that plotted chart dates align perfectly with the detail table rows and text summary.
- Clarify whether external news or headlines are correlated observations rather than proven causal drivers of a price move.
- State clearly that market reviews constitute historical analysis, not personal financial advice or buy/sell recommendations.
