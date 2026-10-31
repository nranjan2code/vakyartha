# Working on Personal Finance Workbench

Read [Building a Vakyartha app](../../../docs/BUILDING-APPS.md) first; this app follows its method. Then README.md, SKILLS.md and ARCHITECTURE.md here.

## Invariants

1. DuckDB `ledger(id VARCHAR PRIMARY KEY, date VARCHAR, description VARCHAR, category VARCHAR, paise BIGINT)` is the only transaction owner. `context.state` holds `month`, `budget` (as typed), `importText`, `lastImport {at, count}` and `confirmClear`; `normalize()` accepts untrusted and version-1 state.
2. Each run reads the selected month with `load()` and `view(state, ledger)` derives all three surfaces from that one read: totals, charts and the table use the same rows. Regions are emitted only when they apply; empty months and an empty ledger say what to do.
3. Money is integer paise end to end; `paise()` parses decimal strings exactly. Charts receive rupees as `paise / 100` from SQL.
4. Imports are validated as a batch (`records()`), checked for existing IDs, and inserted in one transaction. No external tool, network or credential.
5. Fields save as they change (`/month`, `/budget`, `/importText`); an invalid budget is kept as typed and shown with a hint rather than failing the run.

## Change method

Change `server.ts`; run `node scripts/app-surfaces.ts`; bump `version`; update these four documents; run `node --test test/reference-apps.test.ts test/app-registry.test.ts`. A schema change needs a migration in `load()` because updates keep the saved database.
