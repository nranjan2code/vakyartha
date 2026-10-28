# NSE Market Terminal

A reference executable Vakyartha app: ordinary sandboxed TypeScript reads the official NSE MCP integrations, stores dated observations in DuckDB, calculates analytics with SQL and publishes three independent Projection surfaces. There are no fabricated prices, paid model calls or model requests on interaction.

## Open and connect

1. Run the current Vakyartha source/build with the compatible `vaksb` helper. In **Apps**, open **NSE Market Terminal**. New source installations seed the package automatically; **Add Reference App** installs it through the existing app registry when it is absent. Existing published versions are not overwritten automatically.
2. In **Settings → Integrations**, install/enable **NSE** and **NSE Market Live**. Both use official hosted HTTPS MCP endpoints with no credentials. Grant **Allow** only to the three read tools listed below. Package entitlements do not change your policies. Ask/Off remain enforced.
3. Choose the **Market** view tab. Edit up to six comma-separated exact NSE equity symbols; click **Refresh market & watchlist**. Index levels, sector returns and watchlist quotes come from actual successful reads.
4. Choose **Instrument**, or select a watchlist symbol and press **Open instrument**. Enter an exact EQ symbol and a 1–3 month history window, then **Fetch quote & history**. Changing a control saves it but does not fetch. Existing history names its actual coverage until a new fetch succeeds.
5. Choose **Analytics**. Recalculate from the saved database with no internet/model request. Inspect observed return, sample volatility, closing drawdown, SMA warm-up and the source ledger.

The feed is a delayed snapshot, not streaming tick data. NSE describes the market feed as roughly 1–3 minutes behind; source cache age and exchange timestamps can differ. Outside a session the last observations remain. The terminal shows exchange, cache and retrieval times separately and never infers current trading status from the clock. Read the source ledger before treating saved numbers as current. See [NSE's official service and usage terms](https://www.nseindia.com/nse-mcp): informational/educational use, with no order execution or investment recommendation in this package.

## Views and chart choices

| Surface | Question | Projection |
| --- | --- | --- |
| Market | Where did the session move? | Index metric strip, signed sector-return bars, searchable watchlist and exact index table |
| Instrument | What happened to this security? | Delayed quote/range/volume, dated daily OHLC candles, separate volume bars, exact OHLCV table |
| Analytics | What do the retrieved records imply? | Return/volatility/drawdown metrics, running drawdown line, close/SMA line after warm-up, source ledger |

Peer analytics occupy two columns when space permits and collapse on narrow containers. Instrument analysis uses a 2:1 primary chart/context split; daily OHLC candles use a large plot and volume a compact plot. Individual charts are clamped to `lg`; metric strips use four tracks and adapt to the available width. Dense tables keep their own search/sort/paging/scroll behavior. Layout uses semantic Projection components and the app theme, with no domain renderer or custom canvas implementation. Pointer/touch and left/right/Home/End chart inspection show exact observations without a model request. Screen and spoken projections resolve the same canonical facts; chart colour is never the sole explanation.

Intraday history, order books, options chains, news, benchmark-relative returns and adjusted total returns are not supplied by this package. Daily history is never labelled intraday. Supported candle/line/bar charts and exact OHLCV values are deliberate choices rather than disguised specialist chart aliases. Sector-index up/down counts are not stock market breadth.

## Source contract

| Integration | Declared tool | Arguments |
| --- | --- | --- |
| `nse-cmmkt` | `cm_get_live_indices` | `group: broad / sectoral / derivatives`, `nameFilter: ""` |
| `nse-cmmkt` | `cm_get_stock_quote` | `symbol` |
| `nse` | `get_stock_history` | `symbol`, `months: 1–3`, `endDate: today` |

These arguments were discovered from the real servers on 2026-10-28. Historical references elsewhere are not authoritative schemas. Validation checks JSON shape, exact symbol/series, finite positive prices, OHLC consistency, nonnegative integral volume, real unique dates and index identity. Published session changes must overlap the interval implied by two-decimal price rounding; the published percentage is preserved. No LLM interprets source JSON.

One refresh reads at most nine tools (three index groups and up to six quotes); instrument refresh reads two. Reads are sequential through the existing bounded MCP mailbox. No raw HTTP/DNS grant, port listener, secret injection or separate web tunnel is needed: **sandbox → governed mailbox → existing integration → official HTTPS endpoint**. The host captures bounded original source text after the existing schema/policy/logging checks, avoiding model-facing truncation. Each attempt records tool, source time, retrieval time, validated row count and failure/success. Latest 40 receipts persist.

## Database and calculations

`app.json` opts into `entitlements.storage.duckdb`. Runtime-owned `context.database.run(sql, values?)` and `query(sql, values?)` execute in the disposable sandbox, using the pinned native DuckDB runtime. App code does not import a database driver or open an external data path. Parameters bind values; symbols are not interpolated into SQL.

The sole historical table is `prices(symbol, date, open, high, low, close, volume)` with a `(symbol,date)` primary key. A validated history refresh transactionally replaces the selected symbol's retrieved window. SQL derives return, running peaks/drawdowns, twenty-session average and sample volatility. There is no second history copy in app state. Surface data is its derived projection, rather than an independent persistence owner.

- Price return: `(last observed close / first observed close − 1) × 100`.
- Daily simple return: `(close / previous observed close − 1)`; first row remains null.
- Annualized volatility: sample standard deviation of daily simple returns × `sqrt(252) × 100`; unavailable with fewer than two returns. Short samples are indicative, not a forecast.
- Closing drawdown: `(close / running maximum close − 1) × 100`; maximum drawdown is the minimum of those nonpositive percentages.
- SMA: arithmetic average of twenty observed closing prices, omitted until twenty sessions exist.

Raw historical prices exclude dividend reinvestment and have no independent corporate-action adjustment check. Splits/bonuses can distort returns and volatility. Time charts use equally spaced observed sessions, not a continuous time-axis guarantee. Price and volume never share an axis.

The closed DuckDB file is checkpointed as a bounded base64 snapshot **inside the same host app record** as state, surfaces and revision. Each invocation stages its own copy. Successful validated output commits everything together. A failure, invalid surface, oversized database or interrupted execution retains the previous committed database. Reopening/restarting rehydrates it. This is bounded persistent analytics, not an unbounded filesystem database service: 2 MiB database snapshot, 10,000 query rows / 256 KiB query JSON, 4 MiB total invocation response and 8 MiB app record. Larger workloads require a separately designed storage contract. External database access and extension auto-install/load are disabled; raw network remains sandbox-denied. DuckDB's 128 MiB setting is not a hard whole-process RSS quota.

## Operations and maintenance

**Refresh:** run a view's button or the header **Refresh** control (market refresh only). Five-minute market scheduling is declared but off on publication. Enable it explicitly under **Manage → Enable schedule**. It runs while the app/computer are awake; missed intervals are skipped. Instrument history is fetched explicitly and is not silently refreshed every five minutes.

**Failure:** inspect the visible message and ledger; prior observations remain labelled by their source timestamps. A stopped/missing helper fails closed. Inspect uncertain runtime receipts in the existing console before acknowledgement; do not automatically replay effects. A source or calculation failure never means a dataset became fresh.

**Changes:** read [AGENTS.md](AGENTS.md), [SKILLS.md](SKILLS.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Edit the package in Studio or in source, rehearse an offline recalculation, review/publish through the normal fingerprint workflow. Inert draft files grant no execution or integration authority. Package publication disables scheduling; review existing database schema compatibility before changing it. The current table schema is version 1; this package performs no automatic destructive migration. Delete/reinstall is a deliberate data-reset operation, not an update procedure.

**Checks, from repository root:**

```sh
node --test test/market-terminal.test.ts test/app-database.test.ts
npm run typecheck
npm run build
node scripts/market-terminal-check.ts --live
```

The live check uses isolated temporary settings, real official MCP tools and real `vaksb`. It independently fetches reference history/quotes, checks exact rows and independently computed metrics, reloads persistence, then checks all three views and a real SQL action in WebKit at 1440/1100/620/375 px. Evidence paths and failures are retained. Unit tests and source runs do not certify installed builds or primary-model app authoring. Current results belong in the repository's `docs/EVALUATION.md` and `docs/HANDOVER.md`.
