# Vakyartha handover — 2026-10-27

Read [AGENTS.md](../AGENTS.md), [SPECS.md](SPECS.md), [RELEASING.md](RELEASING.md) and the newest [evaluation](EVALUATION.md). Planning: [MVP spec](MVP-SPECS.md), [checklist](MVP-CHECKLIST.md), [decisions](ADR.md).

## Daily skills and surface layout — 2026-10-27

[Capability audit](SKILL-AUDIT.md) reviews the existing fourteen skills against actual runtime contracts. Thirteen focused built-ins add surface-design, dashboard, data-review, task-tracker, meeting-actions, research-brief, create-skill, operations-dashboard, sales-dashboard, finance-dashboard, periodic-report, daily-news and market-dashboard. The maintained method is [SKILL-AUTHORING.md](SKILL-AUTHORING.md), linked from README, AGENTS, specs and canvas docs. Data/action guidance remains in interactive-ui; enabled procedures chain to the shared design guidance without a forced execution stage. Vakyartha's creator produces self-contained instructions and does not pretend to install skills or import scripts/resources. Existing update previews, custom content, removals and on/off choices stay protected.

Projection `c045a3c` is pushed on `origin/codex/surface-design` and adopted as the exact pin. Common maxWidth measures cover all components; explicit grids preserve unused tracks, panels honor alignment, and bounded/deferred chart drawing avoids unwanted expansion and observer warnings. App theme tokens strengthen headings/metric values and spacing. No dependency, lockfile, native IPC or domain handler changes. App work is source-only; the installed build/skills are unchanged.

Validation: 164 app/393 framework tests, both typechecks, framework packages/UI build, reviewed-skill update WebKit (1100/620), mixed-layout WebKit (1440/1100/620, light/dark), and the existing canvas interaction checks (1100/620) pass. The new script preserves local drafts and filters without action dispatch. All 27 skills parse through the native loader; bodies still load only on demand. The chart matrix covers all eight standard kinds and explicit specialist gaps. A canonical report regression reproduces/fixes decimal truncation in spoken gist and checks gist/screen/details after a bound edit. Tests establish mechanisms, not live chain selection or authored outcomes.

The required primary-local mapped-table gate passed only one of three cases; two timed out at the unchanged 60-second generation deadline with no canonical publication. Raw receipt: `~/Projects/vakProjection/.vak/contracts/record-view-2026-10-27T09-27-46.683Z.json`. No full workflow trials or paid calls followed that failed gate. Primary-provider, original source/value/interpretation/interaction/receipt and installed outcomes remain open; no checklist outcome is marked complete. See audit for diagnosis and verification scope.

## Capability pipeline audit — 2026-10-27

[Review and remaining boundaries](PIPELINE-REVIEW.md). Pushed Projection `adf0604` dispatch hardening adds supported argument validation before effects, explicit MCP failure/denial results, stale-handle/grant invalidation, post-approval rechecks, transport cancellation and 8 MiB parsing bounds, incomplete-call/name guards and finite Retry-After retries. App task receipt wrapping preserves structured results. Stale skill selection fails explicitly and root skill reviews disclose supporting files correctly. No compatibility shim, dependency, IPC, domain handler or parallel execution path is added.

163 app/393 framework tests/replay, typechecks, package/UI builds and wide/narrow canvas WebKit pass. The user requested a fresh build and local installation: exact committed app `186b187` / Projection `1b06740` was archived into a new source directory, installed with fresh npm dependencies, compiled in an initially absent Rust target and installed as a complete app. All 1,931 installed files/links/modes match the fresh bundle; About/runtime, Skills, saved chats and canvas restoration pass. RELEASING.md records its provenance and recoverable backup. This does not close prior live model/source/interaction outcome failures. The single local smoke rendered/opened a card in 69.3s but omitted the requested Ready status in raw arguments and on screen; its content check remains failed, with no rerun. Evidence: `.vak/evaluations/pipeline-install/2026-10-27/`. Prior model preference was restored. No paid run, integration adoption or public release was made.

## Current architecture

Task procedures and presentation guidance live in selected skills. Chat/tasks perform a counted skill-selection generation before answer/external tools become available. Selection does not grant permissions or prove correctness. The interactive-ui skill maps one collection into tables/charts/stat aggregates and binds form inputs to canonical data. Multiple independent surfaces remain supported.

The adopted Projection includes dispatch hardening from `adf0604` and the earlier skill-led cleanup. At the user's explicit direction, the source-specific CSV bridge, derive/prepare tools, table source/parameter/relation options and automatic form/report compiler are deleted. No compatibility wrapper or second source-authoring runtime remains. Generic transactions, validation, local field edits, supported aggregates, approvals, persistence, recovery and output receipts stay at their existing owners. Per-record arithmetic needs an available governed tool or independently checked model-authored results.

Runtime compact/strict schema controls are removed. Agent tool descriptors are typed, while arbitrary record data stays dynamic JSON unless the caller supplies a known contract. Local context loaders consume answer-step limits without spending external-operation allowance. Form submissions preserve repeated leaf fields under canonical paths.

## Verification and limits

393 framework tests/replay and 163 app tests pass, with typechecks, package/UI builds and 1100px/620px canvas WebKit. The ordinary task regression verifies authored records, revised criteria and exact export read-back through the generic API; it is scripted authoring, not evidence of live arithmetic reliability. Nine framework and three app tests belonged to deleted APIs. Existing outcome checks and failed receipts remain.

The user authorized a bounded hosted Luna comparison using the installed Keychain credential, without restarting the installed app. The fresh garden observation test passes in four Responses requests (initial plus continuation), including live linked views, all three values on submit, current acknowledgement and untouched independent notes. Actual output passes wide/narrow WebKit. The skill is 222 words; the schema is about34k characters. Exact model, limits, failed predecessors and receipts are in EVALUATION.md. Local primary-provider failures remain open; hosted success does not close them. Historical source-workspace success does not certify current execution. The earlier cleanup installation used executable source `0d7ab3d` / Projection `6ca8487`; About, skills and the local primary-model Ready/canvas smoke pass. RELEASING.md records its full manifest and recoverable backup. Its historical receipt remains separate from the newer pipeline installation.

## Next

1. Broaden cross-domain outcome evidence from the fresh skill-led test; retain independent source/value/interaction/receipt requirements. A previous source-report continuation left explanatory text stale even though the form changed, so that outcome stays open. Keep failed evidence and fixed requirements; do not repeat fixtures for a lucky pass or add domain handlers.
2. Complete installed-window, accessibility, sustained multiple-surface/performance and recovery checks. Source tests alone do not prove the installed build.
3. Keep recurring schedules/chains, external exactly-once semantics, OAuth, cross-platform distribution, signing and future publication separate from this cleanup. No new dependency, native IPC, release or installed replacement is authorized by a test result.

## Earlier records

Earlier chronological notes and backlog are [archived](history/HANDOVER-BEFORE-SKILL-CLEANUP.md); their current-state claims are superseded here.

## Paths and commands

Framework changes belong in `~/Projects/vakProjection`, never inside the app dependency checkout. App runtime source is `sidecar/`; task/source checks are in `test/` and `scripts/`. Use `npm test`, `npm run test:framework`, `npm run typecheck`, `npm run build`, and `node scripts/canvas-check.ts` for relevant changes. A release/install additionally follows RELEASING.md.

Dev data: `.vak/desktop/`; web data: `.vak/web/`; installed data: `~/Library/Application Support/com.nranjan2code.vakyartha/`. Preserve local user data and secrets. Raw trial evidence stays gitignored under `.vak/evaluations/`; reports never include credential values. New built-ins seed once. Changed built-ins show an update preview and explicit action; stale previews cannot overwrite later edits, and removals/on-off choices are preserved. The authorized installer may refresh only known previous defaults after exact byte comparison; custom instructions remain untouched.
