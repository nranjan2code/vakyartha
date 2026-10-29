# Executable app package template

Use this structure for every new executable application. Read the current offered tool schema and runtime contract first. Adapt names/data/actions to the actual request; do not copy unsupported capabilities or leave template claims as completion evidence.

## Required package files

```text
app.json
server.ts
surface.json
README.md
AGENTS.md
SKILLS.md
ARCHITECTURE.md
```

Include every relative source module used by the backend. Add inert domain references or a verification procedure when needed. The documentation belongs inside the app package and travels with draft, source review and publication. No runtime permission comes from these files. `SKILLS.md` describes procedural support; it is not an executable skill-loader manifest.

## app.json contract

Declare a stable lowercase ID, exact semantic version, name/description, Node 24 backend and surface entrypoint. Start with no tools, no schedule and no external credentials. Add only actual exact offered MCP tool names. Use `network: {mode: "brokered", allowedDomains: []}` for governed tools; raw HTTP/DNS grants are unsupported. Opt into bounded DuckDB only if the app needs persistent SQL. Manifest memory/storage numbers do not establish process quotas. Schedules are explicit opt-in after publication and run only while the host is awake/running.

## Backend method

1. Define source-record identities, controls, nullable facts and units before layout.
2. Choose one canonical data owner: `context.state` for ordinary bounded state; `context.database` for opted-in SQL records. Derived surface data is a projection, not a second writer.
3. Validate all action IDs, enum selections, record identities and numeric/date inputs. Bind SQL values rather than interpolating them. Validate the actual source tool result before storage; record source/retrieval times and failures separately.
4. Export `async handleAction(controlId, value, context, action)`. Each promised refresh export must fetch or compute something real. Do not add a timer or pretend a counter is real external synchronization.
5. Return all affected independent surfaces through `{updates:[{surface,data,nodes?}]}`. Explicit navigation can additionally name a validated `focusSurface`. Preserve unrelated views and user edits.
6. Use `context.callTool` only for declared, actually permitted tools. Keys stay in the host. Rehearsal has no external-tool authority. Empty/offline/error results are explicit, not invented successful observations.
7. For SQL use `context.database.run(sql, parameters?)` and `query(sql, parameters?)`; keep queries/snapshots within current limits and plan migrations explicitly. No direct driver imports, persistent local volumes or arbitrary dependencies.

## README.md template

- Purpose and actual implemented capabilities.
- Setup: required integrations, exact read/write tools and per-tool permissions; no secrets in source.
- Main views and actions: what edits, submissions, refresh and navigation do.
- Data contract: provenance, units, dates/timezone, freshness, retention and missingness.
- Scheduling: cadence, opt-in, awake/running requirements, missed/failed run behavior; distinguish polling from streaming.
- Persistence and schema version/migration/reset policy.
- Error/recovery instructions and evidence/verification steps.
- Unsupported capabilities and current verification status. Never mark placeholders as implemented.

## AGENTS.md template

- Read order: this file, README.md, SKILLS.md, ARCHITECTURE.md, applicable repository rules.
- Canonical data owner, schema version, invariant fields, units and identities.
- Allowed action/tool contract and forbidden permission/credential shortcuts.
- Layout/independent-surface/interaction contracts that maintenance must preserve.
- Change method: inspect full source, preserve fingerprints/state, create draft, verify, review and publish.
- Required checks and frozen source/value/interaction/receipt expectations. Retain failures.
- Update the docs when code changes; explain unsupported capabilities truthfully.

## SKILLS.md template

List the relevant existing enabled skills and their actual responsibilities:
- `app-authoring`: complete package and reviewed draft construction.
- `app-maintainer`: updates, schema compatibility, preservation and rollback decisions.
- `app-debugger` plus `debug-error`: app-specific diagnosis with retained receipts.
- `app-operator` / `app-admin`: execution, scheduling and recovery.
- `interactive-ui` and required `surface-design`: canonical bindings, appropriate chart/layout/interaction choices.
- Only relevant domain skills, source integrations and when to use each.

Explain that skill names/descriptions are selected first, supporting text loads through `read_skill_file`, and skills grant no execution/tool authority. App actions execute ordinary code without a model request. Do not invent skill names or automatic chaining guarantees. State how to maintain this file after adding/removing a capability.

## ARCHITECTURE.md template

- File map and responsibilities.
- Flow: UI action → serialized app owner → supervised sandbox → permitted integration/SQL → validated canonical updates → atomic persistence → projections.
- Separate UI state/controls, source facts, derived data and receipts.
- Runtime/data/network boundaries, documented bounds and single-writer ownership.
- Schema evolution, errors, uncertainty, recovery and cancellation.
- Extension points: which changes belong in app code, Projection, integration lifecycle or sandbox helper.

## Verification and completion

Check package completeness, valid manifest/surfaces, actual handler exports, initial empty/error state, known-value calculations and every advertised action. Rehearse without external access, then independently check authorized real sources, controls, durable reopening, refresh and output receipts. Inspect native WebKit at wide and narrow widths; test keyboard/touch paths and visible source/empty/error states. A schedule declaration is not proof that an unattended run works.

Confirm all six required source/document files are in `save_app_draft.files` and app.json is supplied through the manifest argument, with no blank headings, unresolved TODOs or unsupported claims when declaring the app ready. Retain incomplete drafts as incomplete. Report separately: source saved, rehearsal result, source/value checks, publication receipt, scheduling state and installed-runtime scope. Source text alone proves none of those outcomes.

## Host settings and event ownership

Every executable app has a host-owned Settings entry for effective connection readiness, existing global integration policy/setup links, schedules, last-run status and package/data details. Put domain preferences (sources, criteria, repository) in the app’s canonical views and name them in README.md. Do not copy credentials or create an alternate permission store. Missing access must be visible before refresh; Ask is not silently promoted to Allow. Ordinary app actions/edits stay with their app runtime; local table controls remain local; model-backed chat/task controls continue only through their actual mounted owner. Status belongs to the app runner or Canvas top status region, not an unrelated chat.
