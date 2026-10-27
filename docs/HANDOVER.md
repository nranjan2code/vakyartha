# Vakyartha handover — 2026-10-27

Read [AGENTS.md](../AGENTS.md), [SPECS.md](SPECS.md), [RELEASING.md](RELEASING.md) and the newest [evaluation](EVALUATION.md). Planning: [MVP spec](MVP-SPECS.md), [checklist](MVP-CHECKLIST.md), [decisions](ADR.md).

## Current architecture

Task procedures and presentation guidance live in selected skills. Chat/tasks perform a counted skill-selection generation before answer/external tools become available. Selection does not grant permissions or prove correctness. The interactive-ui skill maps one collection into tables/charts/stat aggregates and binds form inputs to canonical data. Multiple independent surfaces remain supported.

Projection `6ca8487` is pushed and adopted. At the user's explicit direction, the source-specific CSV bridge, derive/prepare tools, table source/parameter/relation options and automatic form/report compiler are deleted. No compatibility wrapper or second source-authoring runtime remains. Generic transactions, validation, local field edits, supported aggregates, approvals, persistence, recovery and output receipts stay at their existing owners. Per-record arithmetic needs an available governed tool or independently checked model-authored results.

Runtime compact/strict schema controls are removed. Agent tool descriptors are typed, while arbitrary record data stays dynamic JSON unless the caller supplies a known contract. Local context loaders consume answer-step limits without spending external-operation allowance. Form submissions preserve repeated leaf fields under canonical paths.

## Verification and limits

383 framework tests/replay and161 app tests pass, with typechecks, package/UI builds and1100px/620px canvas WebKit. The ordinary task regression verifies authored records, revised criteria and exact export read-back through the generic API; it is scripted authoring, not evidence of live arithmetic reliability. Nine framework and three app tests belonged to deleted APIs. Existing outcome checks and failed receipts remain.

The user authorized a bounded hosted Luna comparison using the installed Keychain credential, without restarting the installed app. The fresh garden observation test passes in four Responses requests (initial plus continuation), including live linked views, all three values on submit, current acknowledgement and untouched independent notes. Actual output passes wide/narrow WebKit. The skill is 222 words; the schema is about34k characters. Exact model, limits, failed predecessors and receipts are in EVALUATION.md. Local primary-provider failures remain open; hosted success does not close them. Historical source-workspace success does not certify current execution. Installed bundle now matches executable source `0d7ab3d` / Projection `6ca8487`; About, skills and the local primary-model Ready/canvas smoke pass. RELEASING.md records its full manifest and recoverable backup. Documentation-only commits after that point do not alter the executable snapshot.

## Next

1. Broaden cross-domain outcome evidence from the fresh skill-led test; retain independent source/value/interaction/receipt requirements. A previous source-report continuation left explanatory text stale even though the form changed, so that outcome stays open. Keep failed evidence and fixed requirements; do not repeat fixtures for a lucky pass or add domain handlers.
2. Complete installed-window, accessibility, sustained multiple-surface/performance and recovery checks. Source tests alone do not prove the installed build.
3. Keep recurring schedules/chains, external exactly-once semantics, OAuth, cross-platform distribution, signing and future publication separate from this cleanup. No new dependency, native IPC, release or installed replacement is authorized by a test result.

## Earlier records

Earlier chronological notes and backlog are [archived](history/HANDOVER-BEFORE-SKILL-CLEANUP.md); their current-state claims are superseded here.

## Paths and commands

Framework changes belong in `~/Projects/vakProjection`, never inside the app dependency checkout. App runtime source is `sidecar/`; task/source checks are in `test/` and `scripts/`. Use `npm test`, `npm run test:framework`, `npm run typecheck`, `npm run build`, and `node scripts/canvas-check.ts` for relevant changes. A release/install additionally follows RELEASING.md.

Dev data: `.vak/desktop/`; web data: `.vak/web/`; installed data: `~/Library/Application Support/com.nranjan2code.vakyartha/`. Preserve local user data and secrets. Raw trial evidence stays gitignored under `.vak/evaluations/`; reports never include credential values. New built-ins seed once. Changed built-ins show an update preview and explicit action; stale previews cannot overwrite later edits, and removals/on-off choices are preserved. The authorized installer may refresh only known previous defaults after exact byte comparison; custom instructions remain untouched.
