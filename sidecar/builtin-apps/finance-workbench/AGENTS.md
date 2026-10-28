# Working on Personal Finance Workbench

Read the repository AGENTS.md and docs/SKILL-AUTHORING.md, then this package's README.md, SKILLS.md and ARCHITECTURE.md before changes.

## Invariants and owner
DuckDB ledger is the canonical transaction owner. Amounts are signed integer paise. context.state owns only month/budget/import draft and import receipt; chart/table data is derived from the same selected ledger population.

Schema v1: ledger(id VARCHAR PRIMARY KEY, date VARCHAR, description VARCHAR, category VARCHAR, paise BIGINT). Exact decimal parsing supports at most two places and up to nine whole-number digits; no floating-point currency parsing. Positive is inflow, negative is outflow. Every import has 1–200 rows; ledger limit is 2,000 records. Current runtime database snapshot/query limits still apply. Transaction IDs are stable and unique; dates are actual YYYY-MM-DD values. Categories/descriptions are user-provided. Monthly totals use the same date filter as the table/charts. Net flow is not an account balance; transfers/refunds require deliberate owner classification.

## Change method
- Keep ordinary code inside the supervised app runtime; no host fallback, credential copying, new dependency or direct HTTP/DNS path.
- Preserve exact source/input identities, types, units, timestamps, missingness and all independent surfaces. Do not use visible labels as source values or introduce another persistent writer.
- Read complete actual source and published/draft fingerprints first. Make an inert draft, review schema/data compatibility, rehearse and verify before publication.
- Update README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md together whenever affected behavior/contracts change. Document migration/reset decisions explicitly.
- Freeze original values/actions/source/receipt expectations before evaluation; retain failure evidence. A unit test, safe rejection or committed change never substitutes for the original user outcome.
- Rendering/catalog/binding fixes belong in Projection's owning repository; containment belongs in the sandbox owner. Keep product/domain choices in this package.

## Verification
Use explicitly labelled synthetic transactions for arithmetic tests, never seeded personal financial values. Independently check exact paise totals, month boundaries, category population, budget denominator, duplicate batch rollback and persistence/reopening. Test malformed amounts/dates/IDs, zero values, negative budget and oversized imports. Confirm no external calls occur.

Run the reference-app tests/typecheck/build and authorized live/native-WebKit checker described in README.md. Never silently reset user data, run a paid model, install a new dependency or publish a release. Record verification/current state in the host project's HANDOVER.md/EVALUATION.md.
