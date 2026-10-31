# Working on NSE Market Terminal

Read [Building a Vakyartha app](../../../docs/BUILDING-APPS.md) first; this app follows its method. Then README.md, SKILLS.md and ARCHITECTURE.md here. This is app code, not Projection framework source.

## Invariants

1. Two owners only: DuckDB `prices` for daily OHLCV, `context.state` for quotes, index snapshots, controls (`watchlist`, `watchDraft`, `symbol`, `symbolDraft`, `months`), receipts and the last refresh problem. Every run starts with `normalize()`, which accepts untrusted or version-1 state.
2. `view(state, analysis)` is pure and derives all three surfaces (`market`, `instrument`, `sources`); `analysis` is the DuckDB result for the selected symbol. Records go in surface data and render through repeaters or record-bound charts and tables. A region is emitted only when it has data; empty, offline and partial states say what to do.
3. Source values are validated in `source.ts` (identity, finite positive prices, OHLC consistency, integral volume, real unique dates, rounding-consistent published percentages) before storage. A failed read records a receipt and keeps earlier observations; it never becomes zero or fresh.
4. Only the three manifest tools are called, through `context.callTool`. No raw network, credentials, packages or model calls. SQL is parameterized.
5. Fields save drafts; buttons validate and apply them. A scheduled `refreshMarket` uses the saved watchlist only.

## Change method

Change `server.ts`, `source.ts` or `analytics.ts`; run `node scripts/app-surfaces.ts` to regenerate `surface.json`; bump `version` in app.json; update these four documents; run `node --test test/reference-apps.test.ts test/app-registry.test.ts` (the second runs it in the real sandbox). With network and the sandbox helper, `node scripts/market-terminal-check.ts --live` checks live NSE values independently and the views in WebKit. A chart or layout gap belongs in Projection, never in `framework/`.
