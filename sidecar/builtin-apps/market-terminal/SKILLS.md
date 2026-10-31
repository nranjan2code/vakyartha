# Skills for NSE Market Terminal

Skills guide procedures; they grant no tool or execution authority, and the app runs without a model.

- `app-authoring` and its package template: the method this app follows (one owner, pure `view`, repeaters, regions only when they apply).
- `app-maintainer`: changes to this package, keeping old state loading through `normalize()` and the DuckDB schema compatible.
- `app-debugger` with `debug-error`: a failed run. Start from the header status chip, the warning on the Market view and the Sources ledger.
- `interactive-ui` and `surface-design`: bindings, record-bound charts and tables, and wide/narrow layout.
- `app-operator` and `app-admin`: running actions, enabling the schedule, reading run receipts.
- `nse-mcp` and `market-dashboard` (in chat): NSE tool use and market dashboards outside the app; they never replace this app's source reads or SQL.

Update this list when a skill's role here changes.
