---
name: market-dashboard
description: Create a source-backed market, index or watchlist review for an exact daily, weekly or monthly window, with optional interactive dashboard and comparable returns.
---

## Establish the evidence
Resolve exchange, instrument identity, timezone, currency or index points, requested window and return basis. Identify the first and last comparable observations in that window, source URL or supplied file, observation time and retrieval time. Distinguish a completed session from a live or delayed quote. A single quote cannot establish a week or month return. If history or the comparison baseline is absent, leave that return unknown rather than using another window. Never invent prices, trading days, holidays, corporate-action adjustments, market causes or forecasts.

For a price return, calculate `(last comparable close / first comparable close - 1) × 100` from checked numbers. Do not add daily percentages. Label price return separately from a dividend-inclusive total return; use only the series matching the claimed basis. Keep point change, currency change, percent return and percentage-point change distinct. Never sum price levels or returns in a table total.

## Compose the requested result
For an interactive dashboard, load enabled `dashboard` and `interactive-ui` when needed; the always-on `surface-design` guidance applies. Read `references/market-dashboard-layout.md` for the reusable layout and evidence checklist, then `references/market-dashboard-example.json` when a concrete Projection shape is useful. The example is fictional structure: replace every sample fact and date with verified data, and omit sections lacking evidence. A short text recap need not become a dashboard.

Use one canonical dated record collection for the trend and its detail table. The first visible sentence names the instrument, exact window, observed move and material freshness or coverage limit so it also works when spoken. Follow with compact measures, a dated line chart only when history exists, exact rows and source/return-basis details. Use responsive semantic components rather than custom styling. Keep current-session values separate from completed-window performance. If several instruments use different calendars or currencies, give each its own basis and coverage; do not imply a common close.

Submit the complete `data.history` with every dated record in the same `vak_render` or `vak_submit` call that introduces mappings to `{/history}`. Do not submit empty `data` and assume mapped labels or text will populate it. A bound last-close metric uses the final zero-based row index (record count minus one), or a checked scalar summary. Validate the accepted result; if the tool reports missing paths, correct the data and bindings before finishing.

## Check before delivery
Match every stated return to its exact endpoints and basis. Check plotted dates against the table and summary, source freshness against the claimed window, and every caveat against visible and spoken text. A cited headline is evidence of a reported event, not proof it caused a price move. Edits to submitted criteria must update measures, chart, rows and summary together. A refresh, recurring delivery, trade or export needs its offered capability, authorization and actual receipt. State missing capabilities plainly; do not turn a market review into personal buy/sell instructions.
