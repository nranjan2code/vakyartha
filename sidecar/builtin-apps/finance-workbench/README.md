# Personal Finance Workbench

Private imported INR cash-flow records, exact arithmetic and monthly spending analysis.

## Setup and data sources
No external tool, bank login, file permission or credential is required. Paste your own JSON transaction array into Import & methods. Each record requires id, date, description, category and amount as a signed decimal string in INR. This app never sends ledger data to a model or external integration during normal actions.

## Views and actions
Overview: choose YYYY-MM and a nonnegative monthly expense budget, inspect imported inflows/outflows/net flow and category/date charts. Ledger: inspect exact signed INR rows for that month. Import & methods: validate and append a complete transaction batch; successful import navigates to Ledger and clears the pasted draft. Duplicate stored IDs reject the entire batch. No delete/edit is advertised.

## Data contract, retention and calculations
Schema v1: ledger(id VARCHAR PRIMARY KEY, date VARCHAR, description VARCHAR, category VARCHAR, paise BIGINT). Exact decimal parsing supports at most two places and up to nine whole-number digits; no floating-point currency parsing. Positive is inflow, negative is outflow. Every import has 1–200 rows; ledger limit is 2,000 records. Current runtime database snapshot/query limits still apply. Transaction IDs are stable and unique; dates are actual YYYY-MM-DD values. Categories/descriptions are user-provided. Monthly totals use the same date filter as the table/charts. Numeric chart and budget progress values are displayed in INR after integer-paise arithmetic. Net flow is not an account balance; transfers/refunds require deliberate owner classification.

## Scheduling and persistence
No schedule or external synchronization is declared. Each action executes sandbox code and DuckDB directly without a model request. Data remains in the bounded atomic app database snapshot across reopening/restart.

## Failure and recovery
Inspect the current message and source/import/run receipts. Failed source reads never become fresh data; failed computation or invalid projection does not publish candidate state. Missing/disabled sandbox helpers fail closed. Inspect uncertain effects before any exact-run acknowledgement; never automatically replay them. Preserve original failures during diagnosis.

## Maintenance and verification
Read AGENTS.md, SKILLS.md and ARCHITECTURE.md. Inspect actual package/review fingerprints, create an inert draft, update code and affected docs together, rehearse, independently verify and publish explicitly. Check schema compatibility; publication is not a migration service. Use explicitly labelled synthetic transactions for arithmetic tests, never seeded personal financial values. Independently check exact paise totals, month boundaries, category population, budget denominator, duplicate batch rollback and persistence/reopening. Test malformed amounts/dates/IDs, zero values, negative budget and oversized imports. Confirm no external calls occur.

From repository root, run `node --test test/reference-apps.test.ts`, `npm run typecheck`, `npm run build` and `node scripts/reference-apps-check.ts --live`. The live checker uses isolated settings and real sandbox execution. Its finance data is explicitly synthetic. Current verification scope/results belong in docs/EVALUATION.md and HANDOVER.md; do not infer a pass from this procedure text.

## Limits
No bank connection, automatic statement parsing, multi-currency conversion, starting balance, tax/interest calculation, transfer detection, investment recommendation, unbounded storage or automatic schema migration. Empty initial views are intentional.

Native projections use the ordinary Projection catalog and wide/narrow layouts. Source/record values and visible explanations also feed spoken projection; there is no separate narration store. No additional SDK, package or raw network path is introduced.
