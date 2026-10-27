# Reusable market dashboard layout

Use this reference to adapt the companion Projection example. Its prices, source and dates are fictional test data, never facts to copy into a real answer.

1. **Context and finding:** identify instrument/exchange, timezone, exact inclusive observation window, return basis, latest observation and freshness/coverage limit in visible text. Its first sentence must stand alone for speech.
2. **Compact measures:** last comparable close in points or currency, checked window return with `%` in the label, and source/observation status. Omit a measure if its inputs are absent; do not render a numeric zero for missing data.
3. **Primary trend:** a line chart uses dated observations in chronological order. An index-point line and an asset-price line have different units; do not combine them into one comparable scale. If only a snapshot exists, omit the trend.
4. **Exact detail:** a table maps the same canonical history collection as the chart. Columns name date, close and units. Do not enable totals on prices or percentage returns. For multiple instruments, include identity and quote basis in every row, and separate incompatible histories.
5. **Evidence and caveats:** show source name/link or supplied file, observation time, retrieval time, price or total-return basis, adjusted/unadjusted status when known, gaps and any unsupported requested view. Keep unsupported chart types as a table or dated line when that conveys the facts honestly.

For comparable price levels `first` and `last`, a price return is `(last / first - 1) × 100` when `first` is finite and positive. Check the calculation independently. Dividend-inclusive total returns require a suitable source series; do not relabel a price series. Do not add daily percentage changes to obtain a multi-day return. Do not describe a week or month from one daily snapshot.

The example uses a stack, a two-column metric grid, titled sections, a mapped line chart and mapped table. Its canonical `data.history` owns the dated observations. `data.summary` owns checked derived values and a short visible interpretation. This is a reusable structure, not an expression engine: after a source update or submitted criterion, recompute checked derived values and update the summary together. Use the offered authoring tool's active envelope; the example shows the transactional `vak_submit` shape and should be adapted if a different authoring mode is offered.

Review at wide and narrow widths: the summary stays before the chart, the metric grid collapses cleanly, dates and units remain legible, exact rows remain accessible, and the source caveat is visible without hovering. Keep the chart, table and spoken summary consistent with the same window.
