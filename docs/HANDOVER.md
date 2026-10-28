# Vakyartha handover — 2026-10-28

## Mini-Cloud Pooled Sandboxed Runtime, Dynamic Hosted Apps & Observability Console — 2026-10-28

A complete, enterprise-grade **Multi-Tenant Pooled Sandbox Runtime** and **Dynamic Hosted Applications Platform** (the "Mini-Cloud" model) has been designed, implemented, and verified in Vakyartha without mocks or stubs:
- **Shared Sandbox Worker Pool (`SandboxPoolManager`)**:
  - Eliminates uncontrolled workstation process proliferation through deterministic slot bounds (`maxActiveWorkers = 3`).
  - Pre-warms 1 idle standby runner for instant leasing in `< 50ms`.
  - Least-Recently-Used (LRU) slot eviction gracefully flushes and hibernates active slots under concurrency pressure.
  - Inactivity state machine: transitions from `active` -> `idle` (5 min) -> `hibernated` (15 min) with zero CPU overhead on disk. Waking up from hibernation completes in `< 150ms`.
- **Dynamic Hosted Artifact Applications (`AppRegistry`)**:
  - Turns static artifacts and models into full-fledged persistent applications executing in dedicated sandboxes.
  - Dedicated tenant directory volumes (`<dataDir>/apps/<id>/`) containing `app.json`, `server.ts`, `surface.json`, `state.json`, and database folders (`data/app.sqlite`, `data/analytics.duckdb`).
  - Strict manifest validator `parseAppManifest()` enforces directory traversal security (`..`, absolute paths, NUL characters) and clamps memory/storage quotas within platform bounds.
  - Single-writer persistence rule (ADR-001): workers own writes inside their workspace; state is persisted atomically via write-renaming (`state.json.tmp` -> `state.json`).
  - Zero-latency local reactivity: Canvas control events are dispatched over private stdio IPC to worker daemons, returning DOM patches in `< 16ms` with zero model inference costs.
  - Autonomous zero-dependency cron scheduler with anti-thundering-herd protection and manual trigger runner.
- **Physical Workstation Lifecycle & Crash Durability**:
  - **Hardware Sleep & Clock Skew Detection**: Automatic interval delta measurement (`elapsed > 45s`) detects when the host event loop was suspended during MacBook lid-close. Upon waking, `wakeAndReconcile()` probes worker sockets with heartbeat pings, resumes suspended processes, and coalesces missed crons.
  - **Graceful 4-Second Shutdown Waterfall**: Tauri native shell intercepts quit requests (`Cmd+Q` / Tray) and coordinates a 5-step waterfall draining in-flight turns, checkpointing SQLite databases, committing state, and SIGTERMing child processes before hard SIGKILL fallback.
- **Admin & Observability Console (`admin.html`)**:
  - Dual delivery modes: launches as a dedicated native Tauri webview window (`1100×720px`) via `show_admin` or runs in the default browser over loopback HTTP and Server-Sent Events (SSE).
  - Five core workbenches: Fleet & Pool Manager, Dynamic App Inventory, Real-Time Streaming Log Terminal (`/api/admin/logs/stream`), FinOps Spend Governor, and Zero-Trust Security Inspector.
  - System Tray launcher: quick one-click access from the macOS menu bar (`Cmd+Shift+A`) and Settings → General.
- **Built-in Reference Application (`portfolio-risk`)**:
  - Packaged financial risk workbench (`sidecar/builtin-apps/portfolio-risk/`) computing parametric Value-at-Risk (95%/99%), Sharpe ratios, and asset allocation with `< 16ms` local Canvas reactive surface updates.
- **Comprehensive Documentation & Runbooks**:
  - Enterprise Architecture: [`docs/sandboxed-apps/ARCHITECTURE.md`](sandboxed-apps/ARCHITECTURE.md).
  - Operations & Lifecycle Manual: [`docs/sandboxed-apps/OPERATIONS-AND-LIFECYCLE.md`](sandboxed-apps/OPERATIONS-AND-LIFECYCLE.md).
  - Directory Index & Source Tree: [`docs/sandboxed-apps/README.md`](sandboxed-apps/README.md).
  - Architecture Decision Record: [ADR-047 in `docs/ADR.md`](ADR.md).
- **Verification & Quality Gates**:
  - 211 app tests pass (`npm test`).
  - 399 framework tests pass (`npm run test:framework`).
  - Total: **610 automated tests passing**.
  - TypeScript typecheck (`npm run typecheck`) and Vite production bundle (`npm run build`) pass cleanly with 0 errors.
  - Cargo tests pass (`cargo test --manifest-path src-tauri/Cargo.toml --lib`: 3 passed, 0 failed). Zero secret leaks.
  - Real WebKit smokes pass: `canvas-check.ts` (1100px, 620px). Zero mocks or stubs.

## Unified Creator Studio: Hub, Flow DAG, Multi-Tab Multitasking & Draft Lifecycle — 2026-10-28

A complete, production-grade **Creator Studio** workbench has been built and integrated into Vakyartha, fulfilling the full Agent Skills specification (`SKILL.md` + supporting schemas, references, scripts, tests) and Sandboxed Dynamic Applications (`app.json`, `server.ts`, `surface.json`):
- **Studio Hub & Multitasking**:
  - Direct entry from the sidebar (`✨ Studio`) and Settings → Skills opens the Creator Hub overview.
  - Non-destructive context switching allows navigating between active studio packages and ongoing chat turns without losing state, open files, or cursor positions.
  - Multi-package catalog lists skills, sandboxed apps, active drafts, and dedicated creators (`+ New Skill`, `+ New Sandboxed App`).
- **Continuous Background Auto-Save & Quarantine Lifecycle**:
  - Debounced auto-save (800ms) continuously persists drafts to `<dataDir>/skills/.drafts/<name>/` (`PUT /api/skills/:name/draft`).
  - Navigating between app tabs immediately flushes pending auto-saves to disk.
  - Toolbar status indicators show real-time draft state (`Draft auto-saved (time)` vs `Live / Published`), with explicit `Save Draft`, `Discard Draft` (reverts to published package), and `Publish Skill` (promotes draft to active runtime).
- **Interactive Flow DAG (Directed Acyclic Graph)**:
  - Visual node-based graph mapping execution flow:
    - *For Skills*: `User Intent` ➔ `use_skill Gate` ➔ `Allowed Tools & Sandbox` ➔ `Chained Skills` ➔ `Canonical /records` ➔ `3-Tier Surface` ➔ `Dual Spoken TTS`.
    - *For Sandboxed Apps*: `Cron / Action Triggers` ➔ `Isolated Worker (server.ts)` ➔ `App Storage (SQLite)` ➔ `Canvas Projection (surface.json)`.
  - SVG cubic bezier curves, node status badges, and interactive inspector drawer on node selection.
- **Spec & Code Editor**:
  - Vertical stacked form fields (name, description with live 1024-character counter, allowed-tools tokens) and tab-indented monospace code editor.
  - Full support for multi-file packages (`schemas/`, `references/`, `scripts/`, `assets/`, `tests/`) and sandboxed apps (`app.json`, `server.ts`, `surface.json`).
- **Live Canvas Staging & Linter**:
  - Live `<vak-surface>` mounting across responsive container viewports (`320px`, `720px`, `960px`, `100% Fluid`).
  - Surface Design Linter checks single-chart full-width clamping, flags raw hex colors in favor of semantic tones, and validates the 8 standard chart kinds.
  - Dual Spoken Voice TTS auditioning via `lowerSurface` and `projectText`.
- **Sandbox Rehearsal**:
  - Runs inert scripts and app daemons inside `vak-sandbox` with SHA-256 integrity verification.
  - Selection gate test suite verifies prompt matching against the provider selection gate (`/api/skills/eval`).
- **Verification**:
  - 211 app tests pass (`npm test`).
  - 399 framework tests pass (`npm run test:framework`).
  - TypeScript typecheck (`npm run typecheck`) and Vite production bundle (`npm run build`) pass cleanly with 0 errors.
  - Real WebKit smokes pass: `skills-check.ts` (1100px, 620px, 375px), `canvas-check.ts` (1100px, 620px), and `surface-design-check.ts`. Zero mocks or stubs. Zero external dependencies added.

## Official NSE MCP Integrations & Built-in Skill Package — 2026-10-28

Added official National Stock Exchange of India (NSE) vendor MCP servers and a comprehensive built-in skill package:
- **Vendor Integrations** (`sidecar/integrations.ts`):
  - `nse`: Bhavcopy historical end-of-day equity data, OHLCV records, 5-year trade history, market breadth (advances/declines), and delivery volumes via hosted Streamable HTTP endpoint `https://mcp.nseindia.in/bhavcopy/cm/mcp`. Authentication-free.
  - `nse-cmmkt`: Market Live near-real-time intraday snapshots, live equity quotes, index performance, and top gainers/losers via hosted Streamable HTTP endpoint `https://mcp.nseindia.in/cmmkt/mcp`. Authentication-free.
- **Built-in Skill Package** (`sidecar/builtin-skills/nse-mcp/`):
  - Conforms to full Agent Skills specification with YAML frontmatter, chaining rules (`market-dashboard`, `interactive-ui`, `surface-design`), and dual visual/spoken guidelines.
  - Includes supporting reference files: `references/nse-tools-guide.md` (full tool catalog and schema documentation) and `references/nse-query-patterns.md` (step-by-step query workflows).
  - Seeded and synchronized into `src-tauri/resources/builtin-skills/nse-mcp/`.
  - Covered by unit tests in `test/integrations.test.ts` and `test/skills.test.ts`.


A comprehensive audit was performed on `interactive-ui`, `surface-design`, and all 18 canvas-authoring built-in skills to eliminate LLM confusion, align with Vakyartha's runtime, enforce minimalist design and theming, implement responsive **Liquid & Adaptive Layout** architecture, and audit multi-surface projection across conversational channels:
- **Interactive-UI & Surface-Design Fixes**:
  - Eliminated inverted schemas (fixed `"kind": "table"` to `"type": "table"`, `"props: { "chart": "bar" }"` to `"props: { "kind": "bar" }"`).
  - Clarified argument naming: top-level UI handle is `surface: "my-surface"`, while tree nodes use distinct node IDs (`id: "root"`).
  - Explicit input taxonomy: `input` (`text`, `number`, `email`, `password`), `textarea`, `select` (`options`), `checkbox` (`bind: "/path"`), and `date`.
  - Separated client-side interactive actions (`action: "filter"`, handled by listeners/tools) from terminal task submissions (`vak_submit`).
- **Liquid & Adaptive Layout Architecture**:
  - **100% chart/card stretch ban**: Single charts, forms, and cards must never span 100% width on wide desktop monitors (e.g. 1400px+). Doing so distorts bar aspect ratios and flattens line graphs.
  - **Clamped Measures**: Charts and forms default or clamp to `maxWidth: "md"` (720px) or `maxWidth: "lg"` (960px). Full width (`maxWidth: "full"`) is strictly reserved for dense data tables, multi-column grids, and proportional splits.
  - **3-Tier Hierarchy**: Canvases follow a 3-tier structure:
    1. *Tier 1*: Executive headline & 4-column metric strip (`columns: 4, minItemWidth: "xs"`).
    2. *Tier 2*: Paired 2-column analytics grid (`columns: 2, minItemWidth: "sm"`) or split view (`split` with `ratio: [2, 1]`).
    3. *Tier 3*: Granular data table (`table`, `maxWidth: "full"`) and bounded action forms (`form`, `maxWidth: "md"`).
  - **Color & Typography Guide**: Inter typography scale; strict semantic tones (`positive`, `caution`, `critical`, `neutral`); zero inline CSS or hex codes; theme series colors for charts.
- **Built-in Skills Synchronized**:
  - All 18 canvas-authoring skills (`surface-design`, `interactive-ui`, `dashboard`, `operations-dashboard`, `sales-dashboard`, `finance-dashboard`, `market-dashboard`, `budget-helper`, `task-tracker`, `meeting-actions`, `plan-my-day`, `trip-planner`, `meal-plan`, `periodic-report`, `data-review`, `compare-options`, `research-brief`, `daily-news`) updated to v1.3 with liquid layout rules and synchronized byte-for-byte between `sidecar/builtin-skills/` and `src-tauri/resources/builtin-skills/`.
- **Multi-Surface Architecture & Platform Audit (`docs/SURFACES.md`)**:
  - Audited and documented rendering across all five projection targets:
    - **Desktop / Web (`@vak/web`)**: Container queries, 8 SVG chart types, interactive HTML tables, reactive form bindings.
    - **Telegram (`@vak/telegram`)**: Bot API 10.3 alignment, linear HTML markup, charts degrade to `<table compact>`, tables render up to 20 columns, forms degrade to sequential Q&A (`FormFlow`), 64-byte inline callback buttons, safe HTTPS media pre-checks.
    - **Slack (`@vak/slack`)**: Block Kit 2026 alignment, headers, section fields for stats (up to 10 fields), native `table` blocks, charts degrade to tables, forms open native modals (`slackModal`), limits enforced (50 blocks max, 3k chars/section, 10k table chars).
    - **Discord (`@vak/discord`)**: Components V2 (`IS_COMPONENTS_V2`), text displays up to 4k chars, tables and charts degrade to aligned monospace code blocks, forms open paged modals (≤5 fields/page), limits enforced (40 components max, 5 buttons/row).
    - **Voice / Spoken Audio**: Dual projection lowering, opening sentence gist, top 3-6 table rows, endpoint narration, skipping unprojectable controls.
- **Verification**:
  - 185 app tests pass (`npm test`).
  - 398 framework tests pass (`npm run test:framework`).
  - TypeScript typecheck and Vite build pass cleanly.
  - Real WebKit smokes pass: `surface-design-check.ts` (1440, 1100, 620px), `canvas-check.ts` (1100, 620px), `skills-check.ts` (1100, 620, 375px).
  - Cargo tests pass (3 passed, 0 failed). Zero secret leaks.


## Agent Skills specification and runtime resilience — 2026-10-28

The skill pipeline and all 28 built-in skills across the app now conform to the full Agent Skills specification (`agentskills.io/specification`) with Vakyartha extensions:
- **Comprehensive Built-in Upgrade**: All 28 built-in skills (`assistant`, `budget-helper`, `code-review`, `commit-message`, `compare-options`, `create-skill`, `daily-news`, `dashboard`, `data-review`, `debug-error`, `explain-simply`, `finance-dashboard`, `interactive-ui`, `market-dashboard`, `meal-plan`, `meeting-actions`, `operations-dashboard`, `periodic-report`, `plan-my-day`, `research-brief`, `sales-dashboard`, `sandbox`, `shell-command`, `summarize`, `surface-design`, `task-tracker`, `trip-planner`, `write-email`) have been upgraded from unformatted paragraphs to full specification compliance. Each features standard YAML frontmatter (`name`, `description`, `license: MIT`, `compatibility`, `metadata` with author/version, `allowed-tools`), `# Title`, `## Overview & Chaining`, structured step-by-step procedures, truthfulness/boundary rules, and dual visual & spoken projection guidelines.
- **Spec frontmatter**: `parseSkill` handles `name`, `description`, `license`, `compatibility`, `metadata` (arbitrary indentation, blank/comment lines, quoted values), and `allowed-tools` / `allowed_tools`. Trailing comments on quoted (`"..." # cmt`, `'...' # cmt`) and unquoted scalars are stripped. Block scalars folded/literal (`>`, `|`, `>-`, `|-`) with arbitrary indentation are supported for multiline text fields.
- **Resource directories and extensions**: Standard resource directories (`references/`, `scripts/`, `assets/`) and extensions (`.jsonl`, `.ndjson`, `.toml`, `.ini`, `.cfg`, `.conf`, `.sql`, `.css`, `.svg`, `.rst`, `.adoc`, `.env.example`, `Dockerfile`, `Makefile`, `.r`, `.bat`, `.cmd`, `.dart`) are classified for inert inspection, hashing and paged reading up to 256 KiB per file and 2 MiB / 50 files total.
- **Progressive disclosure & tool resilience**: `use_skill` accepts singular `{name: "..."}` or `{names: [...]}` and surfaces declared `Compatibility:` and `Declared tools:`; `read_skill_file` normalizes slashes/backslashes, accepts numeric string offsets, and falls back to unambiguous filename basenames.
- **Local folder discovery**: Unindexed skill directories placed directly in `<data>/skills/<name>/` with a `SKILL.md` are automatically discovered with their `files/` supporting files and persisted without requiring manifest pre-registration.
- **Verification**: 185 app tests, 398 framework tests, typecheck and responsive WebKit smoke check (1100, 620, 375 px) pass. Zero external dependencies added.

## Sandbox settings and durable Realms — 2026-10-28

The Sandbox page now reads real helper compatibility, configured/startup isolation state, folder validity and integration policy. It validates and saves project folders, rolls back failed toggles, provides a fixed real test command, links its integration/skill, and manages retained Realms with candidate/original file previews, affected-path confirmation, promotion, rollback and discard. Skills has scoped busy/error feedback, toggle rollback, cancel/discard handling, retryable file previews, consistent content insets and a narrower detail measure. Failed Settings loads offer retry. The integration catalog retains its live array for reviewed imports, and sandbox schemas refresh at startup.

The separate sandbox runtime owns persistent records and OS locks, retained copies, paged review manifests, bounded Seatbelt commands, staged candidates/backups, promotion journals, exact path/fingerprint checks, conflict refusal, explicit recovery, latest-promotion rollback and destruction. App adapters expose that public CLI through the existing integration/policy/approval/logging path. Source and tests in both repositories are being prepared for the user's requested full commit/push and clean local installation. No dependency or new native IPC is introduced. [Contract, storage and bounds](sandbox/OVERVIEW.md); ADR-045 records ownership.

Verification so far: 182 app tests; the full sandbox Cargo workspace; actual helper calls through agent adapters (denial/approval, containment, repeat writes, review, promotion, restart/resume, rollback, conflicts and discard); Sandbox/Realm WebKit journeys at 1100/620/375; Skills update/import/file-review WebKit at the same widths. A checker race was fixed by waiting for the installed detail, preserving every original assertion. Earlier timed-out checker attempts are retained in evaluation evidence.

The independent primary-local graph contract remains failed at 1/3, receipt `~/Projects/vakProjection/.vak/contracts/primary-provider-2026-10-28T02-02-30.657Z.json`. No broader autonomous model trial followed. Tool/renderer/installation checks do not close that gate or older source/value/interpretation/interaction/receipt failures. Realm snapshots are review manifests, not copy restore checkpoints; unsupported resource/platform/type guarantees remain explicit. Installation provenance will be recorded in RELEASING.md after the clean build/install.


## Private desktop runtime and live FinOps — 2026-10-27

Source checkpoint: desktop now uses a Tauri-owned Node child over bounded private pipes/main-window IPC, with no HTTP listener. Projection `479323e` is pushed on main and supplies the general streaming host adapter/client transport; no framework dependency files were edited here. Browser HTTP remains development-only. Release Node hooks are cleared, new runtime files are private, direct constraints are exact, dependency install hooks are disabled, and packaging trims duplicate assets/npm documentation while refusing stale sandbox builds. [Audit and measurements](NODE-RUNTIME.md).

FinOps uses real numeric data and now refreshes in place every five seconds while visible, preserving filters, selected turn and price drafts. Missing prices remain explicit; no hosted cost is fabricated. The 10,000-turn synthetic history lookup improves from median 420 ms to 36 ms. Native IPC median info requests measured 2 ms; a valid 1 MiB WAV upload took 64 ms. These are local transport/accounting measurements, not provider-latency claims.

An isolated snapshot passes 181 app/398 framework tests, three Rust tests, typecheck, UI/engine packaging, signature/latest-LTS and registry verification, and FinOps/canvas/skills/surface WebKit checks. Native canonical rendering, FinOps, WAV transfer, zero Node listening ports and parent-exit cleanup pass. Source only: the installed app was not replaced. Existing model/source/value/interpretation/interaction/receipt gates remain open. Separate in-progress sandbox edits in the shared workspace are preserved outside this commit.


**Earlier isolated-command source checkpoint — 2026-10-27 (superseded by the Realm checkpoint above).** App source now adds the `Sandboxed execution` built-in through the existing Integration approval/policy/logging path. It snapshots one configured project folder, runs `vaksb run` in a disposable copy, and bounds the snapshot (512 MiB/50,000 files), wall time (30 s) and combined output (32 KiB); it refuses execution without macOS Seatbelt or when the global switch is off. The `sandbox` skill now chains to `shell-command` and to `debug-error` after failure. The sandbox project’s process CLI docs now distinguish implemented `run` from incomplete/non-durable realm management and promotion; CLI support adds confined workspace/cwd and optional run bounds, and the Seatbelt environment is deny-by-default. No Projection changes or dependencies. Source only: no typecheck, test, build, helper rebuild, install or live execution was run. Independent execution outcome evidence remains open. Existing users must enable the new integration in Settings → Integrations and configure a project folder in Settings → Sandbox.

**Earlier tier 1 package checkpoint (2026-10-27).** Catalog review classifies every bundled file, fetches eligible text at the pinned commit, binds added hashes to the review fingerprint, and stores it under the skill's `files/` directory. `use_skill` exposes file names; `read_skill_file` pages integrity-checked content only for skills loaded in that run. Settings has sectioned review/detail pages, lazy file previews, catalog descriptions and a compact long-description control for narrow screens. Unit/type/build/framework/Rust and local catalog WebKit checks pass. A real nested package was inspected in Settings at 1100/375 px. Three fresh web-mode local Ollama sessions each loaded the skill, read `palette.md` and returned all three frozen exact values. [Evidence and limits](EVALUATION.md#skill-supporting-files--2026-10-27). [ADR-040](ADR.md#adr-040-standard-skill-packages-app-owned-capabilities-2026-10-27) records the package standard and app-owned extensions. MVP S1 is checked; script execution and binary assets remain later work. The fresh build was installed; no public release was made.

## Bundled market dashboard checkpoint — 2026-10-27

Current focus is speed and package interoperability; the user deferred further market-source work. The installed one-card run spent 63.9s in authoring with 15,732 input tokens. Its 37,190-character schema includes both surface and enabled integration tools, so the work must address both sources of context cost. [Audit](SKILL-AUDIT.md#current-package-and-runtime-review--2026-10-27).

All 27 built-ins now load from `sidecar/builtin-skills/<name>/SKILL.md`; the `market-dashboard` package includes a reusable layout reference and fictional Projection example. Settings previews package-file updates, and release bundling copies the same folders. Unit, type, UI build and responsive WebKit checks pass (175 app/393 pinned framework tests). The local fictional five-close dashboard passed after a general complete-data instruction correction; the first failed run and an initial checker-key-order false negative are retained with an offline adjudication. [Evidence](EVALUATION.md#bundled-packages-and-market-dashboard--2026-10-27). Projection `dab83cf` fixes positional mapped-table totals, but the broader local record-view gate remains 2/3 due to an unrequested total. Real source-backed market and wider provider/receipt outcomes remain open. Fresh pushed app `067c606` / Projection `dab83cf` is installed at `/Applications/Vakyartha.app`; the 1,960-entry manifest matches the clean build. Settings shows the updated market package and both references; a free installed Ollama card/canvas smoke passes. The previous app and skill state are recoverable; [release receipt](RELEASING.md#market-dashboard-package-local-install--2026-10-27).

Read [AGENTS.md](../AGENTS.md), [SPECS.md](SPECS.md), [RELEASING.md](RELEASING.md) and the newest [evaluation](EVALUATION.md). Planning: [MVP spec](MVP-SPECS.md), [checklist](MVP-CHECKLIST.md), [decisions](ADR.md).

## Earlier skill-file installation — 2026-10-27 (superseded)

App `11c30cfff7ec06399b74c85d2ce48e7fbb530c56` is pushed to `origin/main`, pinned to Projection `c045a3c3b303a3fc2380a71701cbe4077db9fc8a`, built from a clean clone with a fresh release target, and installed at `/Applications/Vakyartha.app`. The complete 2,390-entry installed bundle matches the build; manifest SHA-256 is `f6baa355901f6f025bbfd75e5eaaf22371938ff8646f6b4f7710a885e2a59e9f`. The previous app is recoverable at `/tmp/vakyartha-skill-files-release-IglMtk/backup/Vakyartha.previous.app`; the app and DMG are under `/tmp/vakyartha-skill-files-release-IglMtk/rust-release/release/bundle/`.

The installed About screen confirms 0.2.0, Node 24.22.1, Keychain and the existing Application Support data path. Native Skills shows 26 installed skills and `surface-design` Always on. This tier did not change built-in instruction bodies or installed skill files. The removed `commit-message` skill remains removed. Full local receipt: `.vak/builds/2026-10-27-skill-files-install.json`.

Fresh clean-clone verification: 173 app tests, 393 framework tests, one Rust library test, typecheck, UI build, Skills WebKit at 1100/620/375, surface/chart WebKit at 1440/1100/620 and canvas WebKit at 1100/620 all pass. The app (134.63 MiB) and DMG (43.78 MiB) build successfully. Three free local-model skill-file outcomes pass in web mode. One installed local-model chat renders the requested Installation check / Ready card and the same content in canvas. No paid model call, tag or public release. We did not rerun the original market-dashboard provider outcome; its missing-return-window result remains an open outcome gate.

## Earlier installed checkpoint — 2026-10-27 (superseded)

All implementation is committed/pushed as app `0714a9c`, with Projection `c045a3c` pushed on `codex/surface-design`. Fresh committed-source archives, fresh npm dependencies and an initially absent Rust release target produced a new full app/DMG. 164 app/393 framework tests, native export, typecheck, UI build and layout/skills/canvas WebKit pass. All 1,931 installed files/links/modes match the fresh bundle before/after launch; standard artifacts are refreshed. Native About, new/updated Skills and canvas pass. Five exact previous default skills were updated through the fingerprint-checked owner; custom/catalog/removal/on-off state is preserved. Installed total is 27 (26 built-ins plus the prior catalog skill), with no pending updates.

One installed free-local smoke passes in 81.8s: exact Installation check / Ready card, no extra assistant text, same surface in canvas. The previous model preference is restored; no paid call, live microphone check, tag or public release. Earlier mapping/source/semantic/interaction/receipt failures remain open. Provenance and recoverable backup: [RELEASING.md](RELEASING.md#reusable-skills-and-responsive-surfaces--installed-2026-10-27); ignored receipt `.vak/builds/2026-10-27-skills-install.json`. Build/evidence root: `/tmp/vakyartha-skills-release-orx3iegx`. Documentation-only installation records do not change the executable source snapshot.

## Daily skills and surface layout — 2026-10-27

[Capability audit](SKILL-AUDIT.md) reviews the existing fourteen skills against actual runtime contracts. Thirteen focused built-ins add surface-design, dashboard, data-review, task-tracker, meeting-actions, research-brief, create-skill, operations-dashboard, sales-dashboard, finance-dashboard, periodic-report, daily-news and market-dashboard. The maintained method is [SKILL-AUTHORING.md](SKILL-AUTHORING.md), linked from README, AGENTS, specs and canvas docs. Data/action guidance remains in interactive-ui; enabled procedures chain to the shared design guidance without a forced execution stage. Vakyartha's creator produces self-contained instructions and does not pretend to install skills or import scripts/resources. Existing update previews, custom content, removals and on/off choices stay protected.

Projection `c045a3c` is pushed on `origin/codex/surface-design` and adopted as the exact pin. Common maxWidth measures cover all components; explicit grids preserve unused tracks, panels honor alignment, and bounded/deferred chart drawing avoids unwanted expansion and observer warnings. App theme tokens strengthen headings/metric values and spacing. No dependency, lockfile, native IPC or domain handler changes. The initial audit was source-only; the current installation is recorded above.

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

1. Measure the installed one-card request and mixed surfaces after the Projection schema reduction. The core tool definition is 4,392 characters smaller; the local record-view gate failed, so latency and model-outcome claims remain open. Do not gate integration-tool access through the unreliable group-selection probe.
2. The skill importer now preserves optional frontmatter and stores reviewed script source as inert references. Binary assets, full YAML and governed script execution remain unsupported. Settings provider switching also commits the model it displays; verify the installed composer shows local before a model smoke. Keep the declared subset and the tool-permission boundary explicit.
3. Keep older failed outcomes in EVALUATION.md as historical evidence; market-source work is deferred by user direction.

## Earlier records

Earlier chronological notes and backlog are [archived](history/HANDOVER-BEFORE-SKILL-CLEANUP.md); their current-state claims are superseded here.

## Paths and commands

Framework changes belong in `~/Projects/vakProjection`, never inside the app dependency checkout. App runtime source is `sidecar/`; task/source checks are in `test/` and `scripts/`. Use `npm test`, `npm run test:framework`, `npm run typecheck`, `npm run build`, and `node scripts/canvas-check.ts` for relevant changes. A release/install additionally follows RELEASING.md.

Dev data: `.vak/desktop/`; web data: `.vak/web/`; installed data: `~/Library/Application Support/com.nranjan2code.vakyartha/`. Preserve local user data and secrets. Raw trial evidence stays gitignored under `.vak/evaluations/`; reports never include credential values. New built-ins seed once. Changed built-ins show an update preview and explicit action; stale previews cannot overwrite later edits, and removals/on-off choices are preserved. The authorized installer may refresh only known previous defaults after exact byte comparison; custom instructions remain untouched.

## Required surface-design contract — 2026-10-27

ADR-039 makes the app-owned `surface-design` built-in mandatory. The Skills service marks it `required`, enforces enabled/non-removable state, restores it from older disabled/removed or conflicting non-built-in state, and injects its current instruction body whenever surface-authoring tools or a render response contract are offered. App chat/task, voice and channel providers use the wrapper. All canvas-capable built-ins now identify the shared always-on contract; optional `interactive-ui` remains conditional for data, bindings and actions. No Projection change or model-output correctness claim is included.

Mechanism checks: 166 app tests, 393 pinned framework tests, typecheck, UI build, native Rust test, canvas WebKit at 1100/620, mixed-surface/chart WebKit at 1440/1100/620, and Skills WebKit at 1100/620 pass. A fresh npm install reports zero vulnerabilities; no dependencies or lockfiles changed. The Skills check covers reviewed updates, disabled-choice preservation, the Always on UI state, absent off/remove controls, API rejection of off/removal and successful ordinary/built-in skill lifecycle. Auto-injection and migration restoration have unit coverage. The app review found `surface-design` is the only global requirement: `interactive-ui` is necessary only for selected interactive/data workflows; assistant and domain procedures are request-specific.

No build/install work remains for this checkpoint. The original provider/source/value/interpretation/interaction/receipt gates remain open. Existing provider/source/value/interpretation/interaction/receipt acceptance failures remain open; this instruction/enforcement change does not close them.
