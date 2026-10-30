# Vakyartha handover — 2026-10-30

## Smart speech dictation cleanup, voice-notes skill & Voice Desk executable app — 2026-10-30

Implemented end-to-end intelligent voice flow and note-taking capabilities across chat, skills, and the Canvas without hard-coded providers or models:

1. **In-Composer Smart Dictation (Disfluency & Backtracking Cleanup):**
   - Added speech-to-text normalizer `cleanDictationByModel` in `sidecar/voice/resolve.ts` exposed via `POST /api/voice/clean` in `sidecar/voice/index.ts`.
   - Strips hesitation markers (*"um"*, *"uh"*, *"hmm"*, *"like"*, *"you know"*, *"if and but"*), eliminates stuttered repetitions, resolves mid-stream self-corrections, and fixes punctuation/sentence boundaries while strictly preserving first-person intent.
   - Zero hardcoded providers or models: strictly uses the user's active model from settings (`current.provider` and `current.model`), with graceful non-throwing fallback to verbatim text on offline/error conditions.
   - Added preference `dictationPrefs.clean` in `src/voice/dictation.ts` and user toggle in Settings → Voice (`src/voice/settings-page.ts`).
   - Wired in `src/main.ts` so dictation (⌘D or mic button) normalizes final transcription before composer insertion and submission.

2. **Built-in `voice-notes` Skill:**
   - Authored `sidecar/builtin-skills/voice-notes/SKILL.md` (total 40 bundled skills).
   - Methodology for transforming rambling spoken brain dumps and audio transcripts into structured notes: Executive Synthesis, Key Takeaways, Decisions Made, and Action Items with explicit Assignees & Deadlines.
   - Chains with `surface-design`, `interactive-ui`, `meeting-actions`, `task-tracker`, and `write-email`.

3. **Built-in `voice-desk` Executable App:**
   - Authored complete package under `sidecar/builtin-apps/voice-desk/`:
     - `app.json`: Productivity app manifest with isolated network mode and 256MB/30s quotas.
     - `surface.json`: Responsive liquid layouts for `workbench` (split note explorer, multi-line `textarea` note editor, action checklist, audio transcript drawer, metric strip) and `actions` (central deliverable register). Verified with `@vak/core`'s `SurfaceStore(basicCatalog).render()`.
     - `server.ts`: Full state management for note creation, deletion, editing, task addition, and markdown export receipts in `vaksb`.
     - `README.md`, `AGENTS.md`, `SKILLS.md`, `ARCHITECTURE.md`: All four documents created (>1600 characters each).

4. **Verification:**
   - 294 Node unit tests pass (`test/**/*.test.ts`), including `test/reference-apps.test.ts` and `test/voice.test.ts`.
   - TypeScript typechecking passes with 0 errors (`npm run typecheck`).
   - Skills WebKit check passes (`node scripts/skills-check.ts` at 1100px, 620px, 375px).
   - Apps WebKit check passes (`node scripts/apps-check.ts` at 1100px, 620px, 375px).

## TypeSafe AI provider, dynamic model discovery & official skill pack — 2026-10-30

Integrated TypeSafe AI (`typesafe.ai`) and its flagship System One decision model family (Jev) as a first-class provider and decision provider adapter.

1. **Dynamic Model Discovery (No Hardcoding):** Models are discovered dynamically using the user's configured `TYPESAFE_API_KEY` via `GET https://api.typesafe.ai/v1/models` in both the sidecar server provider registry (`sidecar/server.ts`) and `TypeSafeDecisionProvider.listModels()`. The Settings UI populates available models live from the API without static lists.
2. **Provider + Model Combination:** Preserved the unique `[provider, model]` combination contract across all preference stores, active provider state, and turn execution. `OpenRouter (Microsoft-Decision-1)` and `microsoft/decision-1` are retained unchanged.
3. **Rust Root of Trust & Network Egress:** Admitted `api.typesafe.ai` over HTTPS in the indestructible Rust engine (`src-tauri/src/policy.rs`) and sidecar egress guard (`sidecar/egress.ts`).
4. **Secret Management:** Registered `TYPESAFE_API_KEY` in `sidecar/settings.ts`, storing credentials securely in the macOS Keychain / cross-platform vault.
5. **Official Skill Pack Catalog:** Added `typesafe-ai/skills` as an official external publisher catalog source in Explore Skills (`shared/skills.ts`) with dedicated 200×200 brand mark (`public/brand/integrations/typesafe-ai.png`) and `skillPublisherIcon` mapping, completely separated from built-in skills.
6. **Verification:** All 287 Node tests (`test/**/*.test.ts`), all 11 Rust crate tests (`cargo test --manifest-path src-tauri/Cargo.toml --lib`), and TypeScript type checking pass with 0 errors.

## Agent runtime architecture documentation — 2026-10-29

At the user's request, added [agent-runtime/](agent-runtime/README.md): architecture/ownership, delegation/contracts, drift/evidence/stopping, operations/QoS, multi-job resources/observability, concrete Rust-first module/protocol/persistence/removal/delivery design, source-audited folder/storage and IA, local failure lessons, research, review and a standalone end-to-end implementation prompt. Twenty-two diagrams cover control, data and navigation relationships. The new design is proposed; no runtime implementation is claimed here.

The proposal defaults to one agent and zero children, separates usefulness judgment from enforceable admission, and places actual scheduling/control/persistence/reservations behind the native trust boundary. TS retains reasoning, framework semantic adapters and UI. Root corrections remove duplicate credential/policy/task/registry/scheduler authority instead of preserving runtime shims. Control/API/limit proofs remain AR-01–AR-09; storage/IA remains IA-01–IA-06. No prior outcome/isolation failure is closed, dependency adopted or installed runtime replaced.

The [Astra review](agent-runtime/REVIEW-2026-10-29.md) verified corrections to architecture/scale issues and later canonical commit, provider-payload and delivery-order gaps. Its final storage/IA pass required fixed original workspace grants and narrowed child inheritance; the primary agent incorporated them, but account usage exhaustion prevented independent final recheck. The implementing agent must re-review these boundaries; no unconditional final sign-off is claimed.

Read-only [latest-run evidence](agent-runtime/LOCAL-FAILURE-LESSONS.md) adds stream-versus-outcome, bounded diagnosis, typed stop/error attribution, retained post-abort Realm receipts and missing-evidence retention scenarios. Three synthetic registry probes also reproduced root issues, with temporary fixtures removed and later adapter limits noted. Source continued advancing in concurrent commits during documentation; the implementation prompt requires re-auditing current code. No application-provider run or channel restart occurred.

## Ongoing requirements and status replace MVP framing — 2026-10-29

At the user's direction, renamed the former planning files to [AGENT-TASKS.md](AGENT-TASKS.md) and [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), refreshed current framing/ownership language and updated references, including working rules. All 123 pre-existing checklist identities and checked states are preserved; nine AR and six IA items are additional unchecked gates. Dated evidence and failed outcomes remain. The rename does not certify every old statement as freshly tested; current source status, historical checkpoints and proposed architecture are explicitly separated. No obsolete alias files or runtime compatibility layer were added.

## Indestructible Rust Engine & Minimal Trusted Broker (ADR-052) — 2026-10-29

Formalized the simple rule defining what belongs in Rust vs. Non-Rust:
- **The Rust Engine (Root of Trust, Indestructible & Immutable):** Must remain unmutable, non-destroyable, and secure in any condition, even if the TypeScript worker is compromised. Implemented cross-platform credential vault (`src-tauri/src/vault.rs`) supporting native macOS Keychain (`/usr/bin/security`), Linux Secret Service/owner-only 0600 storage, and Windows user-isolated app data vault with strict input validation on service, account, and value formats. Implemented outbound network egress policy (`src-tauri/src/policy.rs`) admitting only authorized model providers over HTTPS and designated loopback ports (11434, 1234), refusing arbitrary IP or unapproved egress. Registered frontend IPC commands `vault_get`, `vault_set`, `vault_delete`, and `check_egress_endpoint` with window origin verification (`main_window`). Verified via 11 native cargo unit tests.
- **The TypeScript Worker (Runtime Flexibility):** Fast-evolving presentation and orchestration layer for agent reasoning loops, dynamic canvas, interactive UI elements, skills, voice, channels, FinOps usage ledger, and sandboxed tool execution. Operates without ambient host authority.
- **Clean Architecture Principle (0 Users):** No stale code, dead shims, or backwards compatibility compromises are retained. Updated `AGENTS.md` (Rule 8), `docs/ADR.md` (ADR-052), `docs/SPECS.md`, `docs/AGENT-TASKS.md`, `docs/IMPLEMENTATION-STATUS.md` (ISO0), and `SECURITY.md`.
- **Worker & UI Wiring:** Connected UI `secretField` ([`src/ui.ts`](../src/ui.ts)) to write directly to native `vaultSet`/`vaultDelete` commands in Tauri mode. Added Outbound Network Egress Policy section and interactive endpoint checker in Settings → Sandbox ([`src/sandbox-page.ts`](../src/sandbox-page.ts)), supporting custom user allowlists (`VAK_EXTRA_EGRESS_HOSTS`) in [`sidecar/settings.ts`](../sidecar/settings.ts). Implemented global worker egress guard in [`sidecar/server.ts`](../sidecar/server.ts) via [`sidecar/egress.ts`](../sidecar/egress.ts) with 4 unit tests ([`test/egress.test.ts`](../test/egress.test.ts)). Validated all integration catalog entries against SemVer pins and HTTPS in [`sidecar/integrations.ts`](../sidecar/integrations.ts).
- All 11 native cargo tests pass; all 263 Node tests (259 existing + 4 egress) pass; TypeScript typecheck passes with 0 errors.

## Prompt cleanup delivery — 2026-10-29

Executable source `4746d71` is pushed and locally installed with Projection `d017a18`, built from a clean remote clone and absent Rust release target. Fresh 259 app / 410 framework / 3 native tests, typecheck and private desktop transport checks pass; full build/install provenance and retained setup failure are in [RELEASING.md](RELEASING.md#prompt-and-skill-cleanup--installed-2026-10-29). Twenty-eight fingerprint-reviewed exact known-default packages are refreshed, preserving custom content, optional removal and enabled state. Native About and required Skills state agree with the new bundle. A free installed primary-local smoke passes exact one-card/title/Ready checks in 74.2 seconds, including Canvas and persisted reopening; the full bundle matches after launch and the prior model preference is restored without inference. The new folder-workspace default seeds once; existing identities and enabled choices are preserved.

The final documentation sweep corrects Realm limits (30 seconds/32 KiB versus direct/disposable 300 seconds/256 KiB), removes unproved arbitrary build/worktree claims, and labels pre-implementation workspace notes and prompt captures as historical. ADR-051 records ownership, default-refresh evidence and current-contract precedence. The mapped-table 2/3 timeout remains open; installation does not close original semantic/source/interaction gates.

## Prompt cleanup source implementation — 2026-10-29

Adopts pushed Projection `d017a18` from its owning repository. Reviewed local procedure loaders now deliver complete instructions once in current-run system context, retain untrusted external/reference boundaries, omit historical procedure bodies from later wire history without deleting facts, and have separate finite context admission. The app recognizes decoded submission contracts for required design injection, acknowledges repeat/required loads and supplies bounded task/recent conversation context to selection. callerInstructions metadata prevents copying generated catalog/protocol text into the selector.

Built-ins delegate visual composition to compact shared surface-design and canonical mappings/actions to interactive-ui. Removed fixed tiers/width bans, copied wire envelopes and old schema aliases while retaining domain/source/calculation/receipt rules. Workspace and app procedures describe actual offered tools or UI handoffs. Direct writes and retained/shared copies remain distinct; helper limits are not inferred from manifest/schema promises. Studio uses request-preserving deterministic starters, current chart choices and source-backed wording rather than invented findings. Its real selection-only evaluator requires an enabled published optional skill, explicit chosen provider/model and positive/negative expectations; no offline lexical substitute or draft/adherence claim. Preview/DAG/lint and resource labels now state their actual scope.

259 app tests, 410 framework tests/replay, typechecks, framework package/UI builds and native WebKit Skills, mixed/nine-chart surfaces, Canvas, collections and controls pass. New Studio request/preview/DAG checks pass at 1100/375 with actual pane/control bounds and screenshot review. A premature Layout Compliant badge and cramped wrapping were corrected. Off-screen sidebar transitions are disabled in the checker to inspect settled geometry; a speculative CSS compilation-target change was reverted. Earlier first-page/description-match checker failures and overturned narrow screenshot passes are retained. At this source checkpoint there was no native transport, sandbox mechanism, dependency, lockfile or installed app change; delivery is recorded above. Reviewed built-in updates preserve customized/on-off/removal state.

Primary local graph contract passes 3/3; table-only mappings pass 2/3 with the final case timing out before dispatch at the unchanged 60 seconds. The failure is retained, located offline at provider generation, and not rerun with prompt variants. Source cleanup does not close original source/value/interpretation/interaction/receipt or installed outcome gates. Current request-size/selector receipts and UI evidence are recorded in EVALUATION.md; the earlier audit below is superseded for implementation status, not erased.

## Prompt and skill assembly audit — 2026-10-29

[Current audit](PROMPT-AUDIT.md) traces the actual source, including checked/flexible tasks, executable apps, folder modes, channels, voice/OCR and Studio. There are 35 bundled packages. The app identity prompt is already small; remaining cost/conflicts come from required/selected design duplication, flat skill recipes versus inline schemas, stale fixed layouts/aliases, generic clipping/history of skill bodies, incomplete selector context and obsolete Studio templates/evaluation. Checked schema-constrained tasks miss required design injection; selected procedure output is also relabelled “never instructions” by the transactional wire path. These were baseline defects; the implementation checkpoint above supersedes this audit status.

Offline scripted-provider captures reproduce eleven assembly/generator/evaluator findings with fresh temporary data and no model, external service, installed user state or credentials. Plain-text authoring still carries 27,079 system and 23,320 schema characters in the isolated core fixture; required design is 11,072 characters and can be repeated as tool context. These are character counts, not tokens or performance measurements. Evidence: `.vak/evaluations/prompt-audit/2026-10-29/`.

Updated current specs, skill/authoring and Studio docs, ADR clarifications, workspace overview and planning introductions to distinguish implemented paths, intended contracts and open repairs. Historical evaluation failures and dated installation receipts remain. In particular, the earlier density checkpoint did not remove every fixed-tier instruction: several domain bodies and server-side Studio generation still prescribe them. Studio's evaluator currently bypasses the real selector and loses distractor polarity; pass badges do not verify selection/adherence. That audit changed no runtime bodies or installed application; the later source implementation is recorded above. Follow the audit's owner-specific cleanup sequence and unchanged primary-provider/source/value/interaction/receipt gates.

## Folder workspace implementation checkpoint — 2026-10-29

Historical implementation checkpoint, narrowed by the prompt-cleanup source audit: direct execution accepts up to 300 seconds/256 KiB, but retained/shared Realm execution remains capped by the helper at 30 seconds/32 KiB. Basic Git init/add/commit/log is tested; arbitrary worktrees, builds and every file format are not certified. The maintained [workspace contract](sandbox/FOLDER-WORKSPACES.md) and [operations guide](FOLDER-WORKSPACES-GUIDE.md) supersede broad claims below.

Recorded milestones FOLDER1 through FOLDER7 for the folder workspaces and project chats capability ([FOLDER-WORKSPACES.md](sandbox/FOLDER-WORKSPACES.md), [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)):

1. **FOLDER1 (Workspace Registry & Path Admission)**:
   - Built app-owned `WorkspaceRegistry` ([sidecar/workspace-registry.ts](../sidecar/workspace-registry.ts)): stores Projects and Session Workspace Bindings in `<dataDir>/workspaces.json`.
   - Strict path admission (`validateWorkspaceFolder`): canonicalizes paths, verifies directory status and read/exec permissions, rejects relative paths, files, system roots (`/`, `/System`, `/usr`, `/Library`, `/Applications`, `/private/etc`, `/etc`, `/var`, `/tmp`), user home directory (`homedir()`), and private app data directories (`dataDir`, `.vak`, `.git`).
   - Revision tracking and stale-approval prevention: revisions increment on folder change, rebind, or revocation. Revalidation marks missing or modified folders as `missing` / `revoked`, and `verifyDispatchScope` prevents execution of stale or revoked approvals.
   - Non-destructive project removal: deleting a project detaches `projectId` from existing chat bindings without deleting the source folder or invalidating the chat's folder authority.
   - Tested in `test/workspace-registry.test.ts` (8 unit tests).

2. **FOLDER2 (Session-Scoped Integration Seams & REST Endpoints)**:
   - Uses Node `AsyncLocalStorage` (`withSession`) in `WorkspaceRegistry` to establish execution context per turn without mutating global state, `process.cwd()`, or `VAK_SANDBOX_WORKSPACE`. Unbound chats fail closed.
   - Routed `sandboxExecutionEntry` tool dispatch through dynamic session resolution.
   - REST endpoints in `sidecar/server.ts`: `/api/projects` (CRUD), `/api/workspaces/bindings` (CRUD), and `/api/workspaces/validate-folder`.

3. **FOLDER3 (Retained Per-Chat Working Files & Concurrency)**:
   - Updated `sidecar/sandbox-realms.ts` to manage durable per-chat working copies in `vaksb` sandbox Realms under `<dataDir>/sandbox/realms/<id>/workspace`.
   - Executions inside folder-bound chats run in retained Realms (`vaksb realm exec`), persisting file modifications across turns and chat restarts while leaving original project files untouched until explicit review and promotion.
   - REST endpoints for Realm lifecycle: `status`, `ensure`, `review` (`snapshot_realm`), `apply` (`promote_realm`), `undo` (`rollback_realm`), `refresh` (with dirty check refusing uncommitted overwrite unless `force: true` is passed), and `DELETE` (`destroy_realm`).
   - Tested in `test/workspace-realms.test.ts` (multi-turn persistence, concurrent chats on same project folder with conflict handling, and dirty refresh refusal).

4. **FOLDER4 (Chat Controls, Projects Sidebar & UI Styling)**:
   - Built `WorkspacesPanel` ([src/workspaces-panel.ts](../src/workspaces-panel.ts)): manages `#chat-workspace-bar`, sidebar projects list, folder admission modal, project creation modal, and review drawer.
   - Verified wide and narrow WebKit responsive geometry (1440px, 620px, 375px) via `node scripts/control-layout-check.ts` and `node scripts/collection-ui-check.ts`.

5. **FOLDER5 (Security & Containment Verification)**:
   - Tested in `test/workspace-containment.test.ts` (7 comprehensive containment tests):
     - Path traversal and symlink escapes denied during admission and dispatch.
     - Stale bindings, revoked approvals, and missing on-disk folders fail closed.
     - Cross-chat Realm ID injection attempts return 403 or access denied.
     - Host environment scrubbed: parent secret variables (`OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `VAK_SIDE_KEY`) do not leak to sandbox child processes.
     - Outbound TCP/network connections denied inside macOS Seatbelt execution profile.
     - Missing or invalid sandbox helper fails closed without executing.

6. **FOLDER6 (Primary-Local Outcome Acceptance Gate)**:
   - Implemented `scripts/folder-workspace-outcome.ts` executing a complete inspect -> edit -> verify -> review -> apply -> undo cycle against local Ollama `qwen3.5:4b-mlx` model.
   - Admitted synthetic project fixture with POSIX verification script and initial state `COUNT=5`.
   - Real Ollama `qwen3.5:4b-mlx` chat turn completed in 113.8s.
   - Verified isolated Realm modifications while original on-disk project files remained untouched.
   - Promoted changes and verified bit-for-bit SHA-256 byte identity on disk (`COUNT=10\n`, target sha256 `97c20189691b206b6fb229197bea15fac18192d1f5786dd8d1011ef9a7737d03`).
   - Rolled back and verified complete restoration of original bytes (`COUNT=5\n`, initial sha256 `48014b8be219fa37492bc1dccc7e1c08687c290a7491533d64ef33102c22ce8b`).
   - Retained frozen evidence under `.vak/evaluations/folder-workspaces/`.

7. **FOLDER7 (Media & Document Composition)**:
   - Built governed workspace/media import and export endpoints:
     - `POST /api/workspaces/bindings/:session/export-asset`: copies binary media library assets or attachments into the session's retained Realm workspace.
     - `POST /api/workspaces/bindings/:session/import-file`: imports files from workspace/realm into the media library (for images/audio/video) or chat attachments (for documents/data) under 20MB limit.
   - Format detection and truthful disclosure: supports PNG, JPEG, WebP, WAV, MP3, MP4, WebM, PDF, CSV, JSON, Markdown, and Text; rejects unsupported binary formats with 415.
   - Format-aware review drawer in `src/workspaces-panel.ts`: distinguishes binary assets (PNG, WAV, MP4, PDF) from text diffs, displaying format badges, sizes, and hash previews.
   - Tested in `test/workspace-media.test.ts` (exporting asset to workspace, binary review snapshot, bit-for-bit apply promotion, undo rollback, and governed file import).

8. **UPGRADE (Direct In-Place Editing, Shared Project Realms, Long Builds & Git Worktrees)**:
   - Direct in-place editing mode (`mode: "direct"`):
     - Commands execute directly in the project folder with macOS Seatbelt kernel protection (network denied, path escapes prevented).
     - Writes modify files directly on disk without staging copies or requiring an Apply review step.
     - Direct mode does not copy or strip `.git`; access remains limited to the admitted root and runtime policy. The retained checkpoint tested basic repository commands, not a complete worktree/build compatibility matrix.
   - Shared project Realms (`sharedRealm: true`):
     - Multiple chats in the same project share a single durable Realm copy (`project.sharedRealmId`).
     - Operations are serialized per Realm ID using mutual-exclusion locks (`withRealmLock`), eliminating race conditions between concurrent chats.
     - Edits in one chat are immediately visible and runnable in other chats of the project without promotion. Unified review and Apply commits changes to the source folder.
   - Direct execution bounds:
     - Deadlines extended up to 300 seconds (5 minutes) with configurable `timeout_seconds` in `run_command` schema.
     - Maximum output buffer expanded to 256 KiB for extensive compiler logs and command output.
   - Tested in `test/workspace-realms.test.ts` (direct editing on disk, shared Realm cross-chat visibility and promotion, timeout_seconds validation, Git commit/worktree execution, and 64 KiB output).

All 255 repository tests pass, TypeScript typecheck is clean, Vite production bundle builds without errors, and WebKit checks pass across all viewports.

## Historical folder workspace research and design — 2026-10-29

This pre-implementation proposal is retained for provenance. Its statements about missing bindings and unchecked milestones are superseded by the implementation checkpoint and maintained workspace contract.

Follow-up scope: the user explicitly includes coding, document creation/editing and image/audio/video work. The design now specifies general-purpose capability composition, format-aware review, exact binary candidate identity, guarded handoff to existing media assets/jobs and honest format/large-file admission. FOLDER7 tracks those outcomes. No runtime feature, new dependency or hosted media call is introduced by this clarification.

The user requested folder-scoped chats, optional sidebar Projects containing chats, shell execution and safety, informed by the sibling source and web research. [Proposed design](sandbox/FOLDER-WORKSPACES.md) records shared file/shell scope, retained per-chat copies with reviewed promotion as the user-selected default, binding revisions, stale-approval prevention, integration ownership and independent acceptance gates. The user selected isolated copies with review and explicit Apply; direct editing is outside the initial scope. FOLDER1–FOLDER7 remains unchecked; this checkpoint adds research/design only, with no feature implementation, source execution, framework change, installation or expanded authority.

Inspected sibling workspace lists, Bash cwd/sandbox dispatch and the task-environment design's explicit incomplete acceptance status. Vakyartha's current global sandbox folder and one-shot copies cannot implement persistent per-chat work by themselves. Projection already admits tools per session but its built-in dispatch omits session context; identify and test the minimal public seam in its owning repo. Current `.git` exclusions, Realm symlink rejection, bounded copies/commands and spawn restrictions require compatibility tests before promising arbitrary development workflows. Research references are linked in the design; product requirements use capability language.

## Required system isolation — 2026-10-29

The user requested extending isolation beyond app code to host execution, provider requests and host-mediated integrations, plus CPU/memory limits and Linux support, and explicitly selected a minimal trusted broker. [ADR-050](ADR.md#adr-050-minimal-trusted-broker-and-required-system-isolation-2026-10-29) records the decision. [System isolation contract](sandbox/SYSTEM-ISOLATION.md) freezes ownership, broker grants, platform/resource semantics, implementation ordering and independent acceptance scenarios. Checklist ISO1–ISO8 remains entirely open. These are requirements and architecture records only; no runtime, helper, framework pin, installed data or running service changed.

Source inspection confirms the current gaps: the app host owns provider/integration dispatch; `ResourcePolicy` fields do not currently establish backend quotas; Linux backends remain stubs; Projection's local MCP client can launch directly when an enabled helper probe fails. Its present stdio command wrapper also cannot be assumed compatible with persistent MCP because the supervised target receives closed stdin. Implementation must address the complete transport/authority boundary, rather than only changing a status label or removing a fallback. Preserve existing containment, recovery, source and user-outcome evidence while adding the new gates. The pre-existing uncommitted RELEASING.md change is unrelated and preserved.

## Content sizing and collection UX — source checkpoint 2026-10-29

Projection `bd36389` adopts the pushed direct-child card padding repair and local grid/list pagination. Short cards are intrinsic with readable limits; explicit semantic measures and full-width data panels remain supported. Forms and metrics no longer require nested decorative boxes. Vakyartha libraries (Artifacts, Apps, Studio, installed/catalog Skills and MCP), tool/call details and expandable provider groups share bounded local paging/search where needed. Model names are searchable without changing selection. External MCP discovery retains its existing source cursor/Load more contract. Native small collections intentionally have no pager.

Shell cards remove decorative icon hero areas, reduce spacing and wrap titles. Schedule has a compact empty state and one primary create action. Studio collapses navigation on narrow windows. Routine refresh, delete, edit, app settings and close controls use labelled icons with tooltips/focus; primary and ambiguous actions retain text. Domain skills and Studio starters now treat layout patterns as optional, with shared `surface-design` 1.6 guidance. Existing custom skills/preferences still require reviewed updates; source changes alone do not update installed skill text.

232 app tests, 405 framework tests and typecheck pass. Native WebKit control geometry/paging checks pass at 1440/620/375. The new shell collection checks pass at those widths, including exact page contents, size/filter reset, compact cards, model selection and no horizontal overflow. Existing app sandbox/local-action ownership checks pass at 1100/620/375. The Canvas test was updated from the replaced 24-item Show more behavior to 12-item previous/next/last-page navigation while retaining sort and cross-chat opening checks. Original narrow Studio failure (sidebar squeezed content), old test expectation failures and final runs are retained under `.vak/evaluations/density-2026-10-29` and `/tmp/vak-density-*.txt`.

Free primary-provider contract gate at Projection passes all three numeric two-surface cases; two cases require a rejected root-ID attempt followed by accepted repair. Receipt `primary-provider-2026-10-29T01-07-54.690Z.json`. This only proves the small provider contract. General authoring, real source interpretation, new domain composition quality and earlier failed user-outcome gates remain open. No paid inference, new dependency, permissions grant or public release. Installation status is recorded separately in RELEASING.md.


## Practical reference feedback repairs — 2026-10-29

Installed feedback exposed two acceptance gaps: oversized/stretched shared actions and app events leaking into the last chat. Projection `a2470db` fixes intrinsic action sizing and consistent compact control spacing in its owning repo; the app pin adopts that pushed commit. Vakyartha consumes app action/edit events and admits chat/task events only from the currently mounted owner instance, so equal surface IDs cannot transfer authority. Local table controls stay local. Canvas action progress/errors appear in its existing top status region. The app runner always releases controls after failed actions and displays launch errors locally; stale asynchronous opens cannot replace a newer view.

Every app now has Settings with declared connection readiness and effective global permission scope, integration setup links, schedules, last run, data/package information and links to domain views/source docs. Blocked manual refresh opens setup before any sandbox/read attempt and returns to the originating app after configuration. The News Desk failure was Web pages default Ask, not a successful source read. No installed permission was changed. Interactive app Ask approvals and per-app policy overrides remain unsupported. Surface-design guidance now selects content-driven/container-responsive patterns instead of imposing one three-tier dashboard template.

231 app / 405 framework tests, typecheck, required Canvas/chart/Skills WebKit, shared control geometry, app/chat ownership and local table checks pass. Final live reference suite `vak-reference-suite-1jJsKL` passes source/value/board/persistence checks and nine views at 1440/620/375; setup/return/template journey `vak-app-authoring-yMzE13` passes at 1100/375. [Retained defects, failed fixtures and final evidence](EVALUATION.md#practical-app-defects-exposed-after-installation--2026-10-29). This checkpoint describes source verification; follow the next installation record for delivery. No new dependency, paid model call or general model-authoring gate closure.


## Reference suite installed — 2026-10-29

Pushed source `0fdd990` is freshly built and installed at `/Applications/Vakyartha.app`, with Projection `b28c317`, sandbox `475ae98` and verified bundled Node 24.22.2. All four documented references are visible, scheduling stays off, reviewed built-in skill/template updates are applied with preferences preserved, and installed DuckDB execution completes without seeded financial rows. The prior bundle/data subsets are backed up. 229 app / 405 framework / 3 Rust tests, native private IPC and the required WebKit suites pass. One free primary-local rendering smoke displays the requested exact heading and Ready text and opens in Canvas; the previous hosted-model preference is restored without inference. [Installation provenance, retained setup failures and backup](RELEASING.md#documented-reference-apps-and-analytics--installed-2026-10-29); ignored receipt `.vak/builds/2026-10-29-reference-app-install.json`.

This supersedes earlier source-only installation notes below. No public release, tag, signing/notarization, paid inference or closure of general model-authoring/source/reliability gates. The intermittent development-helper process-group setup failure remains retained and unclosed despite passing exact shipped-helper and final shipped-runtime checks. Documentation follow-ups do not change the executable snapshot.


## Reference suite acceptance follow-up — 2026-10-29

Committed the reference/runtime/method checkpoint as `94a15c4`, then completed the three new references' targeted live and native UI acceptance. [Reference suite guide](REFERENCE-APPS.md) maps all four packages, sources, data owners, views, supported layouts and extension boundaries. Add Reference App now discovers actual manifests and offers a chooser in both app entry points. Each package contains the four required documents; Studio source and draft saving preserve generated documentation.

229 app tests, typecheck and UI/self-contained sidecar build pass. Final live `vak-reference-suite-javjnv` verifies publisher and repository source facts, exact synthetic finance arithmetic and rollback, persistence, scheduler due-minute/deduplication and all nine new views at 1440/620/375. Native `vak-app-authoring-QZX1Qx` verifies chooser installation with scheduling off plus all four Studio documents and saved draft at 1100/375. Screenshot review caught a paise/INR budget-unit mismatch after the earlier geometry pass; corrected the app's projection and added visible-unit assertions. Original clipped-source checker failure and overturned unit acceptance are retained alongside final evidence in `.vak/evaluations/reference-apps-2026-10-29/`; see [Evaluation](EVALUATION.md#documented-reference-suite-and-authoring-method--2026-10-29).

These results supersede the open suite-acceptance note immediately below. General model app-authoring, sustained unattended refresh, source streaming and exhaustive accessibility/voice parity remain open. No installed replacement, public release or paid model run. Source packages and reviewed skill updates are distinct from the installed executable and existing user-owned packages; do not silently overwrite either.

## Executable app documentation method — 2026-10-29

The bundled app-authoring skill now explicitly requires README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md and loads its file-specific package template. Maintenance loads a change checklist; authoring, maintenance, operation, administration and the new app-debugger all reference these documents. Studio uses one shared scaffold to generate the documents with an honest executable local counter. This is procedural guidance and starter generation, not a new publication rejection rule or proof of general model compliance. Existing reviewed skill-update preferences remain preserved; no installed application replacement is claimed.

229 app tests pass, including real enabled-skill template loading, all reference packages' document/surface checks and actual scaffold sandbox persistence (0 → 1 → 2 → reopen). The three additional reference apps are still under acceptance review: the first live suite retained a failure in its independent repository comparison because the integration-test presentation endpoint truncated JSON. Live news, bookmark persistence and scheduler due-minute/deduplication checks passed before that failure; full suite/UI acceptance remains open. Keep that failure as evidence when repairing the checker, without weakening original source/value requirements.

## Market Terminal reference and general chart/layout fixes — 2026-10-29

Built `sidecar/builtin-apps/market-terminal/` with `README.md`, `AGENTS.md`, `SKILLS.md` and `ARCHITECTURE.md`. Independent Market/Instrument/Analytics views use real delayed NSE reads, validated dated OHLCV, persistent sandbox DuckDB, parameterized SQL analytics and source receipts. Apps → Add Reference App installs this package; new source data directories seed it once. Existing published/user packages and installed app data were not overwritten.

Projection `fae8a41` adds real validated OHLC candlesticks, fitted/disclosed trend scales, horizontal signed bars, exact values, semantic heights/axis context and inherited compact density. The adopted pushed pin is `b28c317`, which preserves missing OHLC shorthand for rejection and includes the exact-value pointer/touch/keyboard inspector and the separately documented concurrent provider maintenance. No framework submodule files were edited. App navigation now exposes independent views and retains local filters/scroll; explicit focus actions validate their surface target before committing. General capabilities and remaining gaps are in [the design audit](MARKET-TERMINAL.md).

ADR-049 enables bounded 2 MiB DuckDB snapshots committing atomically with state/surfaces through the existing single owner. Raw machine source receipts avoid model-facing clipping after unchanged integration schema/policy/log checks. The dependency adoption was user-authorized; exact reviewed DuckDB version, script-free installation, verified registry signatures, copied native runtime/licenses and release receipts are documented. No raw web tunnel, credential forwarding, new native relay or parallel connector was added.

224 app / 405 pinned framework tests, typecheck, UI/self-contained runtime bundling, real packaged private-sidecar sandbox SQL and wide/narrow Canvas checks pass. Final live `vak-market-check-qk21Ns` independently checks sources/calculations/persistence and actual UI navigation/inspection/SQL at 1440/1100/620/375. Earlier apparent visual passes were overturned by screenshots, then corrected with stronger geometry assertions; all failures are retained in [Evaluation](EVALUATION.md#market-reference-duckdb-and-analytical-geometry--2026-10-29). No installed replacement, public release or broader model-outcome closure. Next installed delivery requires the usual clean build/provenance procedure; pan/zoom/linked axes and general model app-authoring remain open.

## Edge model reasoning isolation and step policy (Projection f25a481) — 2026-10-28

Investigation into edge model execution (`lfm3:latest`, 1.7B) revealed that `think: false` forced models with native reasoning traces to emit their internal monologue into the user-facing text stream. Furthermore, the capability policy clamped models under 2B parameters to 2 steps, causing premature step-limit exits.

Changes pushed to Projection (`f25a481`):
1. **Step budget policy**: Removed the artificial 2-step limit on models $< 2\text{B}$ parameters in `policy.ts`. Edge models now receive the standard 4-step budget with core-tier worked examples.
2. **Ollama thinking activation**: `ollama.ts` automatically enables `think: true` for models reporting thinking support in `describeModel`, trapping internal chain-of-thought in `native: { thinking }` rather than leaking into the chat stream.
3. **Graceful fallback**: If an unflagged model returns HTTP 400 (`does not support thinking`), Ollama automatically retries without `think` and remembers the failure.
4. **Stream sanitation**: Added `ThinkFilter` stream parser in `ollama.ts` to sanitize raw inline `<think>...</think>` traces from text deltas.
5. 404 Projection tests pass with zero type errors. Framework pushed to GitHub (`f25a481`). No app build or submodule pin bump was made here to avoid disturbing the reference app work in progress.

## Executable app runtime repairs — 2026-10-28

This checkpoint supersedes the earlier “complete/enterprise-grade” app-pool claims below. The app now executes declared async Node handlers and named refresh functions through the existing supervised `vaksb run`, using bounded disposable package copies and a minimal environment. No ordinary Node fallback or prewarmed uncontained process remains. Direct app actions/refreshes do not call a model. Declared real-data tools use existing integration schemas, policy rechecks and logs; credentials stay in the host, and Ask/off tools cannot run unattended.

Private host-owned app records serialize publication, domain state, multiple canonical surface snapshots, revisions, schedule markers and bounded run history. Drafts are inert, retain actual source (including incomplete JSON text), and use review/base fingerprints. Studio rehearses/publishes explicitly, discovers app drafts and offers Build with chat as an editable request through the ordinary composer. Canvas promotion creates a presentation draft, not a fake executable backend. Startup imports compatible legacy source as inert drafts without deleting original data. Schedules start off; uncertain effects are retained, block execution and require exact-run acknowledgement without replay. [Current contract and deliberate limits](sandboxed-apps/RUNTIME-CONTRACT.md); ADR-048 records the boundary.

Verification: 217 app tests pass; final receipts and retained failed attempts are in EVALUATION.md. Typecheck, UI and self-contained sidecar/worker bundling pass; an actual bundled worker computes 42 under the helper. Targeted real-helper/API checks prove asynchronous execution, declared entrypoints, missing/rejected handlers, deadlines, outside-file denial, synthetic environment isolation, live local-network denial, concurrent tenant separation, brokered data and integration revocation, traversal refusal, draft isolation/stale review refusal, computed state across restart and schedule-minute deduplication. WebKit at 1100/620/375 proves 7×6=42, named background refresh to 47, two surfaces, restored values on reopen and usable width. Existing canvas WebKit passes at 1100/620. Off-screen animation handling follows the existing checker; failed fixture/checker attempts are retained.

The required free primary-provider graph gate remains **2/3**, receipt `~/Projects/vakProjection/.vak/contracts/primary-provider-2026-10-28T14-48-33.063Z.json`: one case still emits reserved node IDs after a rejected root ID. No broader model app-authoring trial followed. Runtime/UI checks do not close model-authoring or earlier source/value/interpretation/interaction/receipt failures. No paid model call, framework/sandbox source change, installed-app replacement, commit, push or public release was made for this checkpoint. Permanent daemons, persistent filesystem databases, file watchers, raw network/model brokers and strict CPU/RSS/disk quotas remain unsupported rather than advertised as enforced.


## Local multimodal voice adapter — 2026-10-28

Current correction supersedes the original provider-page selectors: Settings → Voice now owns read-aloud selection/preview/style alongside the original dictation selector and controls. Providers has compact expandable setup rows; existing labs and media providers link to voice setup without duplicate cards, standalone voice providers remain accessible there, and MCP has no Voice category. Saved IDs/keys/model choices and the existing dictation selection behavior are preserved. Master/individual switches now hide and disable real speaker/microphone/conversation controls; disabled entry points are blocked, active transcription is abortable, and late microphone-permission results cannot restart switched-off capture. 213 app tests, typecheck and build pass. `scripts/voice-settings-check.ts` passes canonical controls/navigation/preference/preview/ready/empty/visibility/late-permission regressions at 1100/620/375 px with fixture discovery and microphone I/O. Logs: `/tmp/vakyartha-voice-consolidation-tests.log`, `/tmp/vakyartha-voice-switches-races-webkit.log`. No live microphone or model-quality claim follows from those fixture tests. Installation receipt is recorded in RELEASING.md once refreshed.

Earlier adapter checkpoint (app `70c3391`, before the correction above): installed `lfm3-omni:latest` on Ollama 0.40.12 already works through the existing speech discovery/synthesis path (37 voice choices). The app now discovers installed audio-input models for dictation and uploads through Ollama's transcription endpoint, retaining the existing WAV limits, cancellation, errors and UI/engine connection. It rechecks installation/capability and refuses cloud-proxied dictation models. Architecture-based language declarations survive aliases. No dependency, model download, framework edit, new IPC, paid inference or saved user-setting change.

213 app tests, typecheck and UI build pass; the final adapter changes also pass all 38 voice tests. Isolated WebKit at 1100/375 px verifies actual model/voice/dictation selectors and mono audio decoding through `/api/speech`. Local synthetic transcription preserves the negative command exactly, but the frozen number-verbatim check fails (digits replace spoken number words), and silence incorrectly produces `And`. Both endpoint and adapter retain the same failures. This is a partial mechanism improvement, not a completed conversation outcome. No real microphone, interruption, multilingual quality, subjective listening or primary agent/surface gate is certified. Evidence and commands: [EVALUATION.md](EVALUATION.md#local-multimodal-voice--2026-10-28). Next: listening review and independently recorded microphone checks; investigate the earliest audio-input boundary before changing prompts or adding output filters. Existing primary-provider/source/value/interaction/receipt gates remain open.

## Earlier app-pool checkpoint — superseded

The original app-pool checkpoint claimed a warm process pool, embedded databases, sleep/wake recovery and sub-16ms reactions. The [baseline review](sandboxed-apps/REVIEW-2026-10-28.md) found those claims unsupported and reproduced containment, path, tenant-ownership and receipt failures. The executable app repair checkpoint above and [current contract](sandboxed-apps/RUNTIME-CONTRACT.md) replace that implementation description. Historical test totals did not establish those outcomes.

## Unified Creator Studio: Hub, Flow DAG, Multi-Tab Multitasking & Draft Lifecycle — 2026-10-28

A complete, production-grade **Creator Studio** workbench has been built and integrated into Vakyartha, fulfilling the full Agent Skills specification (`SKILL.md` + supporting schemas, references, scripts, tests) and Sandboxed Dynamic Applications (`app.json`, `server.ts`, `surface.json`):
- **Studio Hub & Multitasking**:
  - Direct entry from the sidebar (`✨ Studio`) and Settings → Skills opens the Creator Hub overview.
  - Non-destructive context switching allows navigating between active studio packages and ongoing chat turns without losing state, open files, or cursor positions.
  - Multi-package catalog lists skills, sandboxed apps, active drafts, and dedicated creators (`+ New Skill`, `+ New Sandboxed App`) with clean, single-line action button styling.
  - `#skills-studio-page` resides cleanly within the `.app` CSS grid (`grid-column: 2; grid-row: 1;`), fully preserving sidebar expansion/collapse transitions via `⌘\` or `#topbar-sidebar-toggle`.
  - **Strict Navigation Mutual Exclusion**: Switching from Studio to any other primary surface (`Schedule`, `Apps`, `Artifacts`, `Chats`, `Settings`) immediately hides `#skills-studio-page` synchronously and calls `closeSkillStudio()`, and vice versa, preventing overlapping UI layers or transparent bleed-through in the CSS grid.
- **Continuous Background Auto-Save & Quarantine Lifecycle**:
  - Debounced auto-save (800ms) continuously persists drafts to `<dataDir>/skills/.drafts/<name>/` (`PUT /api/skills/:name/draft`).
  - Navigating between app tabs immediately flushes pending auto-saves to disk.
  - Toolbar status indicators show real-time draft state (`Draft auto-saved (time)` vs `Live / Published`), with explicit `Save Draft`, `Discard Draft` (reverts to published package), and `Publish Skill` (promotes draft to active runtime).
- **Interactive Flow DAG (Directed Acyclic Graph) & Bidirectional Authoring**:
  - Visual node-based graph mapping execution flow:
    - *For Skills*: `User Intent` ➔ `use_skill Gate` ➔ `Allowed Tools & Sandbox` ➔ `Chained Skills` ➔ `Procedural Steps` ➔ `Canonical /records` ➔ `3-Tier Surface` ➔ `Dual Spoken TTS`.
    - *For Sandboxed Apps*: authoring shows declared triggers, backend and projections. Actual execution uses bounded supervised invocations and host-owned JSON state; no persistent SQLite capability is implied.
  - SVG cubic bezier curves, live node status badges, and interactive inspector drawer on node selection.
  - **DAG Direct Authoring**: `+ Add Tool`, `+ Add Chained Skill`, and `+ Add Procedural Step` buttons directly mutate the package specification, auto-save to draft, and synchronize across all tabs.
  - **Cross-Screen Navigation**: Node inspector provides one-click deep links (`✏️ Jump to Spec & Code`, `👁️ Preview in Canvas`, `🧪 Rehearse in Sandbox`) and contextual removal actions.
- **Spec & Code Editor & Reactive Tool Chips**:
  - Vertical stacked form fields (name, description with live 1024-character counter, allowed-tools tokens) and tab-indented monospace code editor.
  - Quick insertion bar (`+ 3-Tier Layout Contract`, `+ Spoken Voice Contract`, `+ Add Procedure Step`).
  - **Tool Selection Synchronization**: Combines declared tools, core system/canvas tools (`read_skill_file`, `vak_render`, `vak_update`, `vak_submit`, `use_skill`, `run_command`), and active MCP integrations into interactive checked chips (`✓ <tool>` / `+ <tool>`), eliminating disconnected tool counts.
  - Full support for multi-file packages (`schemas/`, `references/`, `scripts/`, `assets/`, `tests/`) and sandboxed apps (`app.json`, `server.ts`, `surface.json`).
- **Authentic Domain Live Canvas Staging & Linter**:
  - Live `<vak-surface>` mounting across responsive container viewports (`320px`, `720px`, `960px`, `100% Fluid`).
  - Domain-specific realistic surface synthesis for domain skills (e.g. `meeting-actions` renders Decisions cards, Action Items table, and Open Questions; `market-dashboard` renders live indices, sector returns, and active equities; `task-tracker` renders sprint tasks and velocity charts; `code-review` renders audit findings) rather than generic volume/segment fallback mocks.
  - Surface Design Linter checks single-chart full-width clamping, flags raw hex colors in favor of semantic tones, and validates the 8 standard chart kinds.
  - Dual Spoken Voice TTS auditioning via `lowerSurface` and `projectText`.
- **Sandbox Rehearsal & Selection Gate Testing**:
  - Skill scripts use their integrity-checked rehearsal path. App drafts use the separate fingerprint-bound bounded invocation path, with no external-tool authority during rehearsal.
  - For scriptless skills, displays prompt-guided procedural testing with `+ Add Helper Script (scripts/rehearse.py)` action.
  - Preloaded domain-specific positive and distractor verification prompts testing the `use_skill` selection gate (`/api/skills/eval`).
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

Read [AGENTS.md](../AGENTS.md), [SPECS.md](SPECS.md), [RELEASING.md](RELEASING.md) and the newest [evaluation](EVALUATION.md). Requirements and status: [task contract](AGENT-TASKS.md), [implementation tracker](IMPLEMENTATION-STATUS.md), [decisions](ADR.md), [proposed agent runtime](agent-runtime/README.md).

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

Current prompt-cleanup work is tracked in [PROMPT-AUDIT.md](PROMPT-AUDIT.md) and PC0–PC4 in IMPLEMENTATION-STATUS.md. PC1–PC3 source mechanisms are implemented; PC4 retains the unresolved mapping/source/interaction/receipt and installed gates. The earlier priorities below retain their original checkpoint scope.

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

## Single reference app cleanup — 2026-10-29

At the user's request, removed the obsolete portfolio-risk example package, its generated resource copy and sample-only calculation tests. Both Apps and the admin console now install the NSE Market Terminal. The user explicitly requested no retention of the old example's data; removed its saved draft and legacy app directory from installed local application data. No running Vakyartha/sidecar process was present during cleanup. The NSE package is the sole bundled executable reference; other app/chat/settings data is unchanged.

Cleanup verification: typecheck/UI build and all 220 remaining app tests pass. The count drops by four because the deleted example's formula/manifest/patch tests were removed with its implementation. No active source/UI route points to the removed package. An installed executable rebuild was not performed.
