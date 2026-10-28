# Working on NSE Market Terminal

Read the repository `AGENTS.md`, `docs/SKILL-AUTHORING.md`, this package's [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [SKILLS.md](SKILLS.md) before editing. This is app product code, not Projection framework source.

1. Keep one historical data owner: DuckDB `prices`. Keep quotes, controls and bounded source receipts in `context.state`. Publish all three surface updates together. Never use UI labels as source values or introduce another database/writer.
2. Keep handlers ordinary sandboxed code. Use `context.database` for parameterized SQL and `context.callTool` for the manifest's exact NSE read tools. Do not import external packages into package source, open raw network paths, copy credentials or bypass Ask/Off policies.
3. Validate source identity, numeric types, actual dates, OHLCV and precision-consistent reported percentages before storage. Preserve original source timestamps. Empty/error/clipped/malformed data is a failed read, not zero, a placeholder success or a fresh timestamp.
4. Preserve all independent surfaces, interactive controls, validated OHLC/line/bar chart kinds, liquid layout measures and visible calculation/source caveats. Shared records feed charts and tables. A specialist renderer belongs in Projection only after proving a general missing public capability; never edit `framework/`.
5. Freeze source/value/calculation/interaction expectations before evaluation. Preserve failed live reports. Check actual values, explanation, controls and persistence independently; screenshots alone are insufficient. Do not weaken source assertions merely to make a live run pass.
6. Changes to schema must include a reviewed compatibility/migration design. Do not silently drop retained prices. Respect runtime snapshot/query/response bounds; do not enlarge them as a quick fix for growing data.
7. Document new actions, tools, formulas, schedules and limits in this package. Put verification/current status in repository `HANDOVER.md`/`EVALUATION.md`. No claims of live ticks, adjusted total return, arbitrary database sizes, installed-app delivery or reliable model authoring without matching evidence.

Run `node --test test/market-terminal.test.ts test/app-database.test.ts`, `npm run typecheck`, `npm run build`, and the authorized live WebKit check in README when behavior changes. Do not run a paid model, publish a release, overwrite user app data or reset an existing app as part of a test.
