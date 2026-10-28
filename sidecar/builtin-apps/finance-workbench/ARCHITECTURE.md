# Personal Finance Workbench: architecture

## File map
server.ts owns decimal validation, import transaction/rollback, parameterized SQL and monthly projections. surface.json defines Overview, Ledger and Import & methods. app.json opts into DuckDB with no tools/schedules. README.md owns setup/use/data limits; AGENTS.md owns maintenance invariants; SKILLS.md maps relevant procedures. Those documents travel with source and reviewed publication.

## Canonical data and projections
DuckDB ledger is the canonical transaction owner. Amounts are signed integer paise. context.state owns only month/budget/import draft and import receipt; chart/table data is derived from the same selected ledger population.

## Runtime flow
Visible control → current-revision serialized app dispatch → disposable supervised sandbox → validated domain inputs and permitted integration/SQL → independent canonical Projection updates → atomic app record commit → visible/spoken projections. This uses the existing app host and integration lifecycle; there is no domain renderer, native relay or separate connector.

## Data/network boundaries
No external tool, bank login, file permission or credential is required. Paste your own JSON transaction array into Import & methods. Each record requires id, date, description, category and amount as a signed decimal string in INR. This app never sends ledger data to a model or external integration during normal actions.

No schedule or external synchronization is declared. Each action executes sandbox code and DuckDB directly without a model request. Data remains in the bounded atomic app database snapshot across reopening/restart.

## Failure, persistence and evolution
The app host is the only persistent writer. Failed invocation or invalid projection retains committed state; external uncertainty is never automatically replayed. Domain schema changes require an explicit compatibility/migration design, not a user-data reset. Runtime bounds remain 30-second invocations, bounded tool/response sizes and the opted-in database snapshot bound where relevant. General CPU/RSS/disk quotas and permanent app daemons are not promised.

## Extension decisions and verification
Keep source parsing/calculation/product behavior in this package. Reuse the existing integrations and standard Projection components. A missing general visual/binding capability belongs in Projection's own repository, not a package-specific surface patch. Use explicitly labelled synthetic transactions for arithmetic tests, never seeded personal financial values. Independently check exact paise totals, month boundaries, category population, budget denominator, duplicate batch rollback and persistence/reopening. Test malformed amounts/dates/IDs, zero values, negative budget and oversized imports. Confirm no external calls occur.

No bank connection, automatic statement parsing, multi-currency conversion, starting balance, tax/interest calculation, transfer detection, investment recommendation, unbounded storage or automatic schema migration. Empty initial views are intentional.
