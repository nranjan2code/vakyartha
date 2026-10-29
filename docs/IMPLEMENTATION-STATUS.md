# Implementation status and acceptance gates

Maintained tracker, reviewed 2026-10-29. Replaces the former MVP checklist without resetting item IDs, checked states, failed outcomes or historical evidence. Sections distinguish current foundations, active work, proposed architecture and future candidates. A historical checked item proves only its stated scope, not a newer expanded contract.

Original planning baseline: 2026-10-25. Scope and acceptance contract: [AGENT-TASKS.md](AGENT-TASKS.md). Current app: [SPECS.md](SPECS.md). Proposed execution/delegation architecture: [agent-runtime/](agent-runtime/README.md). This tracker keeps documentation, existing foundations, implementation and later scope separate.

Check an implementation item only after its acceptance behavior is verified. Append the change reference and evidence to that item. Use `Blocked: <reason>` for a dependency, without checking it. An existing foundation does not mark an expanded requirement complete. No unchecked item authorizes implementation by itself.

## Planning and design

- [ ] A1. Implement the [data-first authoring contract](plans/DATA-FIRST-AUTHORING.md): skills guide the agent; records, field mappings and operations replace independently authored table/chart/metric copies. Broad rewrite proposal deleted. No old-code/backward-compatibility requirement; preserve security and product capabilities.
- [ ] A2. Verify skill-led interactive authoring after cleanup. Shared record mappings, forms and transactional execution remain; source-specific execution and duplicate-array guidance are deleted. Fresh skill-led linked-view/edit/submit/independent-notes outcome and wide/narrow WebKit pass. Broader local intent, source interpretation/continuation and installed outcomes remain open. See [skills](SKILLS.md) and [evidence](EVALUATION.md).
- [x] D1. Draft task scope, existing capability inventory and later boundaries — `AGENT-TASKS.md` (original planning checkpoint retained).
- [x] D2. Create this tracker with ownership and acceptance gates.
- [x] D3. Independent design review completed; findings incorporated into spec sections 3, 4, 6 and 9 and the gates below. See evidence log.
- [ ] D4. Confirm initial audience, three outcome scenarios and supported inputs.
- [x] D5. Review a concrete workspace design: Schedule overview, full-page setup/detail, conversation, activity, existing multi-surface canvas and narrow layout. Evidence: `scripts/task-check.ts` wide/light and narrow/dark snapshots; full accessibility and installed-window review remain P2.8/P4.11 gates.
- [x] D6. Set run limits, draft/update conflict rules and recovery/deletion expectations.
- [x] D7. Prove the public-API composition for one canonical session/surface store, detached execution and durable action ownership. Review each proposed framework gap and record the smallest needed change or that no change is needed. No repeated chat requests or volatile inbox may be passed off as durable execution.
- [ ] D8. Assign runtime/data ownership before coding. Prefer no new IPC; justify any native boundary with a concrete benefit, define its narrow contract, and measure message count, payload/serialization cost and UI responsiveness. Establish a regression budget and one persistence writer per entity.
- [x] D9. Plan against zero new third-party dependencies. Reuse public APIs and standard libraries; identify small owned implementations. Any unavoidable SDK/package/crate/tool exception needs a concrete justification and user approval before installation or adoption.
- [x] D10. Record capability plugin architecture and runtime/ownership decisions — `ADR.md`. Reuse the existing MCP store; memory and reusable context are selectable integrations, while task recovery remains local.
- [ ] D11. Verify free capability choices, setup/access requirements and failure behavior. Add catalog entries only for concrete missing capabilities; no automatic installation or activation. Workspace data connector setup/host validation and wide/narrow WebKit checks are verified (2026-10-26); it remains outside free task capabilities. Live external access remains unverified, so this gate stays open.
- [x] D12. Record typed contracts, scoped deletion, task/run lifetime, shared dispatch and chain semantics — ADR-004–006. One-time scheduling is implemented; recurring and chain execution remain open gates.
- [x] D13. Schedule workspace and one-time triggers — ADR-007, `schedule.ts`, `src/schedule-page.ts`, `test/schedule.test.ts` and expanded task smoke. Recurring/event/chain triggers remain unimplemented.

## Existing foundations to retain

These are present today, not newly implemented agent capabilities. Baseline evidence is source inspection and the existing canvas checks; expanded regression gates below remain open.

- [x] B1. Multiple identified surfaces with render, update and removal behavior.
- [x] B2. Bound inputs, form validation, submissions and button actions.
- [x] B3. Local table sorting, filtering, pagination and calculated totals.
- [x] B4. Live canvas placement, surface picker, full/split view, text view and export.
- [x] B5. Saved conversation surfaces and metadata-only artifact library.
- [x] B6. Integration policies, approval controls, secret storage and usage tracking.
- [x] B7. Outside-agent projection and action delivery.

## P0 — Preserve interaction and establish boundaries

Owner: Vakyartha for product behavior; framework fixes only after D7. Acceptance: AGENT-TASKS sections 2, 3 and 6.

- [x] P0.1. Map the current render → field edit → validation → submission → update path and record which public APIs will be reused.
- [x] P0.2. Define task/session/run/surface identities and additive linkage for existing conversations and artifacts; no second artifact store.
- [x] P0.3. Protect local interactions from model calls and protect every surface's interactivity during task progress.
- [x] P0.4. Preserve independent drafts across canvas closing, surface/task switches and restart; expose conflicts with incoming updates.
- [x] P0.5. Replace implicit cancellation by follow-up submissions with explicit queue/rejection behavior and separate cancellation.
- [x] P0.6. Make complete approval arguments inspectable, define scope/revocation, and keep permission decisions outside generated surfaces.
- [x] P0.7. Task-local diagnostic retention and scoped deletion are defined together (ADR-026): owned raw transcripts, inputs, local outputs, checkpoints and drafts are removed; downloaded/shared/external records retained as explained. Filesystem and WebKit deletion checks cover the stated scope.

## P1 — Bounded task execution

Owner: Vakyartha; any missing general execution contract goes through D7. Acceptance: M1–M4.

- [x] P1.1. Persist goal, bounded selected UTF-8 input snapshots, completion conditions, model/tool scope, optional local Markdown output destination and limits (ADR-026). No implicit folder access.
- [x] P1.2. Implement persisted lifecycle states and allowed transitions, including waiting, interruption and explicit continuation.
- [x] P1.3. Execute one task at a time with a durable queue; release the slot during user waits. Approval suspends the same host call, resumes through the dispatcher and rechecks authority; three two-task interleavings and shutdown/restart covered in `test/tasks.test.ts`.
- [x] P1.4. Keep execution alive across view changes, hidden windows and event-stream disconnects while the app remains running.
- [x] P1.5. Separate progress/surface publication from task completion without breaking existing framework clients. Projection `dbae5c2` adds opt-in response completion; app tasks use it, ordinary clients retain projection completion. Host/provider regressions and app task WebKit checks pass. Product completion still requires user evidence review.
- [x] P1.6. Record operation identity/outcome; uncertain effects stop work and require exact-ID, revision-bound user reconciliation. Durable input deduplication and same-run call-ID guards prevent redispatch of those identities. Service-level exactly-once behavior is not claimed.
- [x] P1.7. Stop new work on cancellation and report completed or uncertain in-flight effects honestly.
- [x] P1.8. Persist pending approval identity and scope; enforce task tool restrictions and fresh checks for delayed, changed or resumed operations. Existing chat-wide grants do not silently transfer.
- [ ] P1.9. Verify completion conditions with evidence and retain useful partial results on failure. Manual evidence review implemented (ADR-011): required note/confirmation, current-run result, revision/fingerprint guard and recorded surface versions. Automatic/source verification remains open.

## P2 — Task workspace and results

Owner: Vakyartha. Reuse framework rendering and actions. Acceptance: M5 and M8.

- [x] P2.1. Add task discovery, clear start controls, current status and attention-needed states while preserving ordinary conversation use.
- [x] P2.2. Add compact activity with factual steps, tool outcomes, sources, requested input and recoverable errors.
- [x] P2.3. Reuse the existing multi-surface canvas and picker for inputs, intermediate work and results; no duplicate interactive renderings.
- [x] P2.4. Route any surface's action to its owning task/outside agent, independently of which task is visible.
- [x] P2.5. Preserve all supported interactions after completion; additional work becomes an explicit continuation with its own record.
- [x] P2.6. Prevent background updates from stealing focus, opening another task's canvas or changing the user's selection unexpectedly.
- [ ] P2.7. Link evidence and output receipts to artifacts; distinguish real, sample, missing and stale information. User review now records run/surface version references and rejects stale results; output-file receipts now have hash/size/version references, verify/download and missing/modified states (ADR-026). Broader provenance classification remains open.
- [ ] P2.8. Verify keyboard, assistive-technology status announcements, focus return and wide/narrow layouts. Automated WebKit coverage now includes native Space/Tab/Shift-Tab/Escape, focused receipt retention through a persisted revision, named delete dialogs and cancellation focus return. Installed `d29ffbd` confirms hidden optional fields are absent from native AX, Tab traversal and Back/Escape focus return. Full screen-reader and installed-window task lifecycle coverage remain open; see EVALUATION.md.

## P3 — Limits, data and recovery

Owner: Vakyartha for policies and records; general enforcement gaps through D7. Acceptance: M6–M7.

- [x] P3.1. Enforce finite active-time, model-request, tool-attempt and retry limits with understandable stop reasons. ADR-013: per-run guards plus persisted cumulative reservations, monotonic deadline checks, and no reset across continuations/restart. `test/task-budget.test.ts` covers limits, retries, effects, waits and recovery; task WebKit smoke exercises a shared three-request/three-run budget. In-flight effects still follow cooperative cancellation/reconciliation rules.
- [x] P3.2. Attribute usage to tasks/runs; identify unknown costs and prevent silent paid-model switching. Dispatcher-owned IDs reach the numeric ledger, Schedule summaries, FinOps work filters/details and CSV. HTTP tests reject forged attribution; concurrent-run isolation and unknown/missing costs are covered. Runs retain their explicit model, with no fallback. Tool/server charges are unmeasured and explicitly excluded; ceilings remain P3.3.
- [x] P3.3. Define behavior when a required monetary ceiling cannot be conservatively enforced. ADR-012: reject strict-ceiling requests before admission; local-only is default, external model API charges require acknowledgement, and operating/tool costs remain explicitly separate. `test/task-spending.test.ts`, HTTP admission tests and WebKit acknowledgement checks. Cumulative execution budgets are now implemented (ADR-013); actual monetary enforcement remains open.
- [x] P3.4. Persist expected output identity/hash before writes, expose failures, check pending saves after restart and offer explicit local save retry without model/tool replay. Dispatched uncertainty stops work; canonical host saves propagate errors.
- [x] P3.5. Content/drafts remain separate from numeric usage and credentials. Raw task diagnostics have discard/1/7/30 idle-day controls; canonical content remains until task deletion. Shared logs keep the stated separate scope.
- [x] P3.6. Scoped deletion removes task records, selected snapshots, local outputs, drafts, canonical session, raw transcript and abandoned checkpoints. Downloaded/shared/external data remain according to the explicit confirmation.
- [ ] P3.7. Show completion, failure, input and approval attention without unchanged repeat notifications.
- [ ] P3.8. Detect unavailable models/tools, lost authorization and unsupported inputs with actionable next steps.
- [x] P3.9. Keep native supervision/platform/file operations in Rust where justified; do not add native relays for task commands, surface streaming or field edits. Core task behavior remains available through the shared app server without the native window.
- [ ] P3.10. Segment task identity, per-run history and trigger state before sustained long-term operation; replace temporary lifetime journal guards with retention and durable deduplication policies. First typed per-run metadata records are implemented (ADR-009); Cumulative execution limits are now implemented; long-term retention/deduplication remains open.
- [ ] P3.11. Add trigger admission and dependency-aware result handoffs through the same dispatcher; define missed runs, time zones, pause/resume, cumulative limits, cancellation and safe deletion before enabling schedules or chains.

## P4 — Outcome and regression gates

Owners: Vakyartha end-to-end; Projection verifies any changed framework contract in its own repository. Record environment, change references and evidence. Use the primary local model; paid evaluation requires explicit approval.

- [ ] P4.1. Research comparison completes with cited evidence and an interactive criteria form plus comparison surface.
- [ ] P4.2. Workspace report completes from supported scoped files, with checked values, independent surfaces and requested output receipt. The earlier compiler-path success is historical: that execution is removed. Verify original source facts, arithmetic, changed-criterion continuation and saved receipts through skill-led generic authoring before closing this gate. Preserve failures and explicit user acceptance (EVALUATION.md).
- [ ] P4.3. Connected work review prepares a concrete change, waits for approval, applies only the approved operation and verifies the outcome.
- [ ] P4.4. Multi-surface regression: keep two independently edited forms and a sortable/filterable/pageable table; update another surface, switch selections/tasks and restart. Drafts persist, local operations make no model calls and exact validated payloads reach the right owner. Within a mounted task, picker, close/reopen, Preview/Text, full/split and library opening preserve live element identity. Test with an active task and pending approval too.
- [ ] P4.5. Interaction regression: invalid/stale submissions, duplicate clicks, queued actions and actions after completion have defined outcomes; failure/cancellation releases affected controls.
- [ ] P4.6. Ownership regression: outside-agent actions stay outside-owned and background task events do not contaminate the visible task.
- [ ] P4.7. Recovery regression: rejected-generation syntax recovery is covered by Projection `399a3a9` and the durable app-budget regression (ADR-016); composite recovery remains open. Event disconnect, app quit/restart, engine failure, uncertain write, expired approval, save failure and limit exhaustion preserve truthful state without duplicate effects.
- [ ] P4.8. Permission regression: generated content cannot authorize itself; denied/revoked access remains blocked, and changed targets require fresh review.
- [ ] P4.9. Establish and run a repeatable outcome evaluation set (initial local-model harness and diagnostic baseline in `EVALUATION.md`; research/comparison failures remain, no release thresholds agreed); report completions, failures, correctness, duration and intervention counts. Agree release thresholds before claiming readiness.
- [ ] P4.10. Run app tests, tests against the pinned framework, typecheck, build, canvas smoke and native tests; add targeted checks for new contracts.
- [ ] P4.11. Inspect the actual app window for setup, multiple interactive surfaces, waiting, cancellation, recovery and deletion. A rendering test alone does not close this gate.
- [ ] P4.12. Verify unavoidable process contracts: malformed/incompatible messages, stale IDs, duplicate commands, disconnect and reconnect. Check message counts, payload size, bounded queues and interaction latency against D8 without weakening authorization or isolation.

## V — Voice interaction

Owner: Projection for the voice projector; Vakyartha for the `voice/` module. Acceptance: AGENT-TASKS M9 and the voice projector framework record in section 6. Phases go in order; each keeps existing read-aloud and dictation behavior working.

- [x] V0. Voice interaction specified: M9, ownership row and framework record in `AGENT-TASKS.md`.
- [x] V1. App `voice/` module with no behavior change: read aloud, dictation, speech text, settings page and the sidecar speech routes behind one entry point each in `src/voice/` and `sidecar/voice/`; one master switch over read aloud, dictation and conversation mode; app tests, typecheck and WebKit check. Evidence: 109 app tests (master-switch test added), typecheck, UI build, sidecar bundle, canvas WebKit check, and an off-screen WebKit run of Settings → Voice (off hides the mic and the voice settings; on restores them unchanged). Conversation mode joins the switch in V3.
- [x] V2. Voice projector in Projection: agenda items, field model, deterministic resolver, constrained-resolution schema and action construction; tested and pushed, then the app pin moved (R2). Evidence: Projection `68faf03` (`@vak/core` `answer.ts`: `agenda`, `resolveAnswer`, `answerSchema`/`readModelAnswer`, `fillAnswer`, `actOn`, `question`/`readBack`), pushed; pin moved; 297 framework and 109 app tests and typecheck pass. Spoken and clicked actions are asserted identical; approvals resolve only to unmixed consent naming the change. English words only until V9.
- [ ] V3. Conversation mode: local end-of-speech, barge-in, echo safety, stop phrase and Escape, announced states; no microphone use when off. Implemented: `src/voice/conversation.ts`, `endpoint.ts` (noise-floor end of speech; higher bar and longer onset while the app speaks), `commands.ts`; ⌘⇧D or the waves button; replies read aloud in the mode; Esc, "stop listening" or the master switch end it. Endpointing and phrases unit-tested; WebKit shows the button and switches. Live (2026-10-26, installed build): the user held a spoken conversation; sentence endings and replies work. Still to confirm live: talking over a reply, no self-triggering on speakers, "stop listening"/Esc.
- [ ] V4. Approvals by voice: approval items on the agenda; deterministic resolution only; operation phrase for writes and internet; unclear or silent leaves the request pending; decision said back. Adversarial tests: injected or model text never approves. Implemented: `src/voice/approvals.ts` (in conversation mode a waiting tool is asked aloud; only heard sentences reach `resolveAnswer`; every approval counts as a change because annotations are the server's own claim; consent words come from the tool name and exclude agreement words; voice allows once only; one re-ask, then it waits on screen). Tests cover bare yes, refusal, two unclear answers, our own question heard back, injected-looking and mixed phrases, a tool titled "Yes"/"Allow", and queue order. Blocked with V3: not yet run with a live microphone.
- [ ] V5. Choices and actions by meaning: option names, ordinals and comparisons against declared values; read-back; same action as a click. Implemented: `src/voice/decisions.ts` (after a reply in conversation mode the first decision is asked; resolved by `resolveAnswer`; read back; on yes the control is activated through `<vak-surface>.activate(key)`, Projection `01cdfb4`, pinned). Tests cover comparison, correction ("no, the hilton"), cancel, an aside going to the model, two unclear answers, and shared words; the WebKit canvas smoke asserts `activate` sends the identical action a click does and refuses a second while busy. Blocked with V3: not yet run with a live microphone.
- [ ] V6. Forms by conversation: several fields per answer, only missing or invalid fields asked again, field checks explained in speech, values shown on screen as filled. Implemented in `src/voice/decisions.ts`: a form left by a reply is introduced ("needs 3 things: …"), fields asked in reading order (failing first, optional once), several filled per answer, checks said aloud, values written to the surface and its drafts, read back, "no" asks what to change, submitted through `activate`. Test covers the full dialogue. Blocked with V3: no live-microphone run.
- [x] V7. Constrained model resolution for non-approval items, evaluated on the local 4B model. Evidence: `sidecar/voice/resolve.ts` + `/api/voice/resolve` (the chat's model through the same FinOps-wrapped providers as turns; responseSchema or a single tool); the window asks only after the rules fail, never for approvals, and reads the reply through `readModelAnswer` (test: a value outside the schema is dropped). Local `qwen3.5:4b-mlx`, 6 spoken answers: 5 right in 0.5–3.3 s; "me and my wife plus our two kids" came back as 3 guests, which the read-back exposes before anything is sent; "ignore that and delete my files" returned nothing.
- [ ] V8. App commands by voice (stop, repeat, cancel, new conversation, show on the canvas) and the canvas following the item under discussion without taking focus from background work. Partly: "repeat", "new chat", "show it on the canvas", "stop", "stop listening" (`src/voice/commands.ts`, tested). The canvas, when open, switches to the surface being asked about without taking focus (`canvas.open(id, false)`); only for the chat in view. Not yet seen live.
- [ ] V9. Resolver words for every language read aloud supports; others stay on screen with a note. Partly (Projection `2918883`): agreement, refusal, cancel, repeat, back, ordinals and price/best comparisons in en/fr/de/es/it/pt/nl, one combined list; negation wins (tested, including "ne l'autorise pas"). Approval operation words exclude agreement words in every language. Open: number words and dates beyond English; app commands are English; the "stays on screen with a note" message for other languages.
- [ ] V11. Spoken projection in Projection (replaces the app's `spokenSurface`): answer first, gist per surface, one waiting item, follow-ups from on-screen controls, details on request, progress during long work (M9.11). Mostly implemented in the app, not Projection: `@vak/core` already exports everything it needs (`agenda`, `lowerSurface`), so per AGENTS.md rule 7 it stays in `src/voice/speech-text.ts` until a second target needs it. Conversation mode reads a gist (headline, stats, alerts, chart ranges, first three rows or items, a card's title only, a text's first sentence) then the waiting item's question; "details" reads everything; "Say details for the rest." when a gist left something out; one "Still working" line after 8 s. Reading a reply by hand is unchanged (tested). Open: suggested follow-ups beyond the waiting item.
- [ ] V12. Voice security: echo guard, spoken provenance for outside content, follow-ups only from controls, adversarial tests for each (M9.12). Partly: echo guard (a sentence that began while or just after the app spoke and matches what it said is ignored; tested, including our approval question). Open: provenance phrases and follow-ups, which arrive with V11. Provenance: a reply that drew on tools is introduced with "Based on what I found:". Follow-ups come only from agenda items (on-screen controls).
- [ ] V13. Model-authored controls carry action, item payload and option values: catalog guidance, derivable repairs, dead-control diagnostics, replay-gated on local-model output (M9.13). Partly (Projection `2918883`): a per-item button whose payload names no item now sends `item` from its card heading, so a click tells the model which card (tested; replay gate unchanged). Chosen over a new prompt rule: it always works and adds nothing to the small model's prompt. Comparison options already keep price and specs as fields. Open: a dead-control diagnostic, if a real local-model output shows one.
- [x] V10. Regression gates: recordings never stored; voice answers recorded like typed input; billed providers keep consent; keyboard parity for every voice action. Evidence: audio lives in window memory for one transcription; the local engine's clip is written 0600 and removed in `finally` (`sidecar/voice/whistle.ts`); a hosted transcriber receives it only when chosen in Settings → Voice. Heard sentences become ordinary messages, and spoken choices ordinary `vak-action`s, recorded like typed and clicked input. The model fallback uses the chat's chosen model and is counted by FinOps. Every voice action has a control: the approval card, the surface's own controls, the waves button / ⌘⇧D, Esc.

## Release readiness

- [ ] R1. Every requirement and regression gate applicable to the release has linked evidence; unresolved risks are explicitly reviewed. Proposed/future scope is not silently declared implemented.
- [ ] R2. Required framework changes are tested and pushed in Projection; the app pin is deliberately updated and checked. No dependency-checkout edits or internal imports.
- [ ] R3. Documentation distinguishes current behavior from later scope and explains local execution availability, permissions, data deletion and cost limits.
- [ ] R4. Follow the existing release procedure; distribution, signing, new dependencies and paid runs retain their existing approval requirements.
- [ ] R5. Review dependency and lockfile diffs, including transitive additions, provenance, integrity and install/build scripts. Record approval for every exception; no floating/ad hoc installs, unreviewed vendoring or remote executable downloads. Existing pins and package-age rules alone do not close this gate.

## Folder workspaces and project chats — 2026-10-29

User-requested feature; [researched design, existing seams and acceptance plan](sandbox/FOLDER-WORKSPACES.md). The current source retains isolated copies with review and explicit Apply as the default, and adds selectable direct editing and shared project Realms. FOLDER1–FOLDER7 below record the workspace checkpoint; their completion does not establish ISO1–ISO8, arbitrary format support or a fresh installed build.

- [x] FOLDER1. Private revisioned project/session bindings, explicit folder admission and revocation, safe missing/replaced-folder handling; no global cwd or setting mutation on chat switches. Tested in `test/workspace-registry.test.ts`.
- [x] FOLDER2. Session-scoped file/shell access through the existing integration lifecycle, with binding-aware approvals and no broader connector escape. Tested in `test/workspace-registry.test.ts` and `sidecar/server.ts`.
- [x] FOLDER3. Retained per-chat working files, review/Apply/Undo, restart/recovery, concurrency and conflict handling through the existing sandbox owner. Tested in `test/workspace-realms.test.ts`.
- [x] FOLDER4. Chat folder controls and sidebar Projects with visible scope/mode/readiness, bounded browsing, safe removal and preserved tasks/drafts/multiple surfaces; wide/narrow WebKit verification via `scripts/control-layout-check.ts` and `scripts/collection-ui-check.ts`.
- [x] FOLDER5. Actual containment tests for traversal/symlinks, stale approvals, cross-chat IDs, broad filesystem tools, shell environment/network and missing helper; supported runtime/repository limitations disclosed. Tested in `test/workspace-containment.test.ts`.
- [x] FOLDER6. Real primary-local file inspect/edit/verify/review/apply outcome with independent original bytes and receipts; packaging/installed verification recorded separately. Tested in `scripts/folder-workspace-outcome.ts` with local Ollama `qwen3.5:4b-mlx` and evidence under `.vak/evaluations/folder-workspaces/`.
- [x] FOLDER7. General-purpose document/data/image/audio/video capability composition, governed workspace/media import/export, format-aware previews and binary review/apply identity; verify supported formats, actual file content/playback and size/resource limits without claiming unrestricted format support. Tested in `test/workspace-media.test.ts`.

## Prompt assembly and instruction cleanup — 2026-10-29

[Source audit and offline evidence](PROMPT-AUDIT.md). Preserve runtime guards, caller-selected checked contracts, multiple interactive surfaces and direct executable app actions. Current source repairs and their deterministic tests are recorded in HANDOVER.md/EVALUATION.md. These mechanism checks are not broad provider-outcome passes.

- [x] PC0. Trace current paths and measure isolated request assembly; correct stale current-state docs while preserving historical decisions/failures.
- [x] PC1. Source mechanism: repair required design injection across native/decoded modes, selected-context instruction labelling, duplicate bodies, clipped loads and historical active-context treatment at their existing owners.
- [x] PC2. Source instructions: consolidate skill/runtime instruction ownership; remove stale fixed layouts and wire-envelope duplication, use canonical schema values and update workspace/operational guidance without weakening authority boundaries.
- [x] PC3. Source mechanism: correct Studio generation/suggestions/lint/DAG claims and evaluate the actual configured selector with positive/negative expectations; distinguish heuristics, previews and real provider evidence.
- [ ] PC4. Freeze/capture before-and-after requests, prove the smallest primary-provider contract in Projection, then original sources/values/interpretation/interactions/receipts and installed state as applicable. Retain all earlier failures.

## Required system isolation & indestructible engine — 2026-10-29

User-requested work, tracked separately from the earlier bounded macOS sandbox checkpoint. Formalized in ADR-052: establish the indestructible Rust engine as the root of trust (cross-platform vault, egress network gating, approval policy) with execution workers providing runtime flexibility. [Scope, ownership and acceptance gates](sandbox/SYSTEM-ISOLATION.md). Items below reflect progress under zero-user clean architecture; full end-to-end sandbox gates remain tracked.

- [x] ISO0. Establish the initial Rust vault (`src-tauri/src/vault.rs`), egress policy (`src-tauri/src/policy.rs`), and user-facing secret write/delete plus endpoint-check IPC. The general secret-returning `vault_get` UI command was removed on 2026-10-29. These primitives do not establish worker isolation or brokered provider dispatch; those remain open under ISO1–ISO3.
- [ ] ISO1. Isolate host execution workers from credential, network, app-private persistence and original-project authority; retain one canonical writer per entity.
- [ ] ISO2. Broker provider requests through configured authorized endpoints, with broker-owned credentials, bounded response processing, redirect/address checks and cancellation.
- [ ] ISO3. Mediate host integration calls through existing schemas/policies/approvals; local workers require verified containment with no uncontained fallback and a compatible persistent transport.
- [ ] ISO4. Enforce explicit CPU limits with documented units, scope and descendant behavior; verify native exhaustion, cleanup and receipts independently of wall timeout.
- [ ] ISO5. Enforce memory limits with explicit accounting/scope and independent native allocation evidence; disclose monitoring separately from hard quotas.
- [ ] ISO6. Implement Linux isolation and capability admission; verify filesystem/network/environment denial, descendant/owner-death cleanup, resource limits and unavailable-kernel refusal on Linux.
- [ ] ISO7. Measure private worker boundary overhead and verify existing desktop, provider, integration, task, channel and multiple-surface behavior through it.
- [ ] ISO8. Package and verify the exact installed app/framework/helper combination, with truthful capabilities, effective limits and retained failed evidence.

## Capability roadmap and future candidates

These boxes track future candidates only. Do not start them simply because they appear here. One-time clock triggers are now implemented; repeating/event triggers remain below.

- [x] L1. Reusable, reviewed skills with validation and permission boundaries. [SKILLS.md](SKILLS.md)
- [x] S1. Skill packages, tier 1: reviewed supporting text files stored and pinned, `read_skill_file` for skills loaded in the run, sectioned Settings detail/review pages and catalog descriptions. [Plan](plans/SKILL-FILES.md) [Evidence](EVALUATION.md#skill-supporting-files--2026-10-27)
- [x] S2. Bundled defaults use Agent Skills folders with reviewed text-reference updates and a reusable market-dashboard Projection example. Package lifecycle and responsive rendering checks pass; the bounded fictional local market outcome passes. A clean bundle is installed with the updated market package. The broader real-source market gate remains open. [Decision](ADR.md#adr-041-bundled-skills-use-reviewable-packages-2026-10-27) [Evidence](EVALUATION.md)
- [x] S3. Verify representative pinned external skill folders against the supported frontmatter/reference subset, with explicit accepted/omitted results. Optional scalar/metadata fields survive Settings edits; script source is stored inertly. Full YAML, binary assets and governed script execution remain separate. [Audit](SKILL-AUDIT.md#current-package-and-runtime-review--2026-10-27)
- [ ] S4. Reduce measured ordinary authoring latency on the primary local provider without losing tool access or mixed surfaces. The core tool definition is 4,392 characters smaller, but the local record-view gate failed and installed before/after latency remains unmeasured. [Evidence](EVALUATION.md#authoring-cost-and-skill-interoperability--2026-10-27)
- [ ] L2. User-controlled memory/context across tasks through selectable MCP integrations, with inspect, edit and delete capabilities where supported; no parallel built-in knowledge database.
- [ ] L3. Repeating routines and event triggers with wall-clock/DST rules, cumulative budgets and long-term run retention. One-time triggers and bounded run records are implemented.
- [ ] L3a. Task chains: verified sequential dependencies, typed artifact handoffs, per-step permissions and budgets, partial failure handling and deletion without cascades.
- [ ] L4. Additional connectors, authorization methods and document formats.
- [ ] L5. Browser/computer interaction and full autonomous provider outcomes. The bounded macOS command/Realm tool lifecycle and responsive Settings are verified independently (2026-10-28): approval/denial, containment, durable writes, review, promotion, restart, rollback, conflict refusal and destruction. Broader system/resource/Linux isolation is now explicitly requested work under ISO1–ISO8 above. [Evidence](EVALUATION.md#sandbox-settings-and-realms--2026-10-28).
- [ ] L6. Multiple agent roles, delegation and concurrent execution. Proposed [architecture, diagrams and runtime contracts](agent-runtime/README.md) are documented; AR-01–AR-09 below remain open. Default is zero children, and implementation/security/outcome gates remain independent.
- [ ] L7. Remote execution, remote notifications and cross-device channels.
- [ ] L8. Artifact history, collaboration and publishing.
- [ ] L9. Additional platforms and automatic updates.
- [x] L10. Initial independent image, audio and video plugins through existing integrations, shared provider keys, selected models, upload/cost approval, durable assets and recoverable job IDs. Dedicated screen/voice projections use canonical host publication. Supported subset and verification limits: [MEDIA-TOOLS.md](MEDIA-TOOLS.md); [research baseline](MEDIA-TOOLS-RESEARCH.md).
- [ ] L10a. Approve and run live provider/account quality benchmarks and hands-on microphone/media barge-in evaluation. Mocked API checks and synthetic voice checks do not establish these outcomes; broader media editing operations remain later scope.

## Agent execution and delegation implementation — 2026-10-29

User-requested architecture documentation is in [agent-runtime/](agent-runtime/README.md), including diagrams and [validation/rollout](agent-runtime/VALIDATION-AND-ROLLOUT.md). Implementation is active on `codex/agent-runtime-implementation`: source changes harden workspace binding admission, centralize shell navigation, remove a general-purpose secret read command, add an inactive native capacity/control actor, capture immutable workspace grants on native root creation and refuse stale grants at root start, persist typed task stop causes, preserve returned operation outcomes across cancellation, and retain validated sandbox Realm UUID receipts across task recovery with explicit deletion acknowledgement. These are interim corrections and foundational slices, not the native task/workspace ownership cutover. Existing single-agent and multiple-surface behavior remains the baseline. No existing outcome or ISO gate is closed by these changes.

The user selected Rust-first authoritative scheduling/control/persistence and root correction without legacy shims. [Implementation design](agent-runtime/IMPLEMENTATION-DESIGN.md), [removal map](agent-runtime/ROOT-CORRECTIONS.md) and [delivery slices](agent-runtime/DELIVERY-PLAN.md) specify how. The user approved and the app now pins an HTTPS transport dependency, but it remains unused until native approval, credential and dispatch enforcement are ready together. Protected framework persistence/prepare/fence seams remain prerequisites; writing the design does not implement them.

- [ ] AR-01. Confirm delegation policy modes, provisional one-level/four-child limits and eligible task classes against comparative evidence.
- [ ] AR-02. Specify the sole native execution-control writer, aggregate/transaction boundaries, cross-owner finalization and cutover from current task persistence; no duplicate task truth.
- [ ] AR-03. Prove public API composition, trust-domain/channel separation, version-bound finalization and hidden-window/headless lifecycle; record only concrete missing capabilities in their owning repository.
- [ ] AR-04. Freeze budget units, values, reservation/reconciliation semantics, queue/context/output bounds and single-slot scheduling behavior.
- [ ] AR-05. Specify protected requirement/checker definitions, isolated verifier identity/receipts, evidence invalidation and explicit semantic/user-review limits.
- [ ] AR-06. Freeze outcomes, sources, forbidden effects, detector labels/error/overhead thresholds, minimum useful delegation benefit, hardware and comparable evaluation budgets.
- [ ] AR-07. Prove non-bypassable broker admission and required isolation, including descendants, revocation, cancellation, crash uncertainty and resource enforcement; retain ISO1–ISO8 separately.
- [ ] AR-08. Map child/attempt/stop states onto one typed task lifecycle and preserve interactive continuations, multiple surfaces, local controls and wide/narrow WebKit behavior.
- [ ] AR-09. Prove [global capacity and observability](agent-runtime/SCALE-AND-OBSERVABILITY.md) across chats/tasks/children/verifiers/apps/integrations: aggregate limits, fair scheduling, overload/backpressure, bounded telemetry and saturation recovery on named hardware.

## Information architecture, storage and identified folders — 2026-10-29

Source-audited [data/storage](agent-runtime/DATA-AND-STORAGE.md) and [IA design](agent-runtime/INFORMATION-ARCHITECTURE.md) preserve existing folder modes and multiple surfaces while correcting root ownership. Isolated registry probes reproduce re-admission after revocation, same-path folder replacement admission and an unassigned Realm ID passing the registry check; later adapter source-path checks limit the last observation. These are open corrections, not outcome passes.

- [ ] IA-01. Adopt explicit project/workspace/binding/working-copy/task/artifact identities and source-versus-target navigation/storage contracts; project membership grants no filesystem authority.
- [ ] IA-02. Replace the TS registry writer with native controlled registration, physical folder identity, sticky revocation, fixed root/run and narrowed child workspace grants, dispatch-time target checks and explicit Realm membership; rebind invalidates queued/scheduled/waiting descendants without retargeting. Retain platform capability/refusal semantics.
- [ ] IA-03. Prove protected private namespaces and reference-based discovery; no project-name/path-derived duplicate state or hidden metadata/secrets in source folders.
- [ ] IA-04. Replace scattered page toggles with one TS navigation owner; Work includes Scheduled as a view, projects may organize without folders, effective workspace remains visible, and link producers update together.
- [ ] IA-05. Separate project removal, folder detach, working-copy discard, task/chat deletion and original-file changes; preserve shared references, dirty work and uncertain-effect recovery.
- [ ] IA-06. Prove standalone/project/task/app flows, shared/copy/direct work, replaced/revoked folders, artifact reopening, multiple surfaces, voice/actions, collections and actual wide/narrow WebKit; retain original source/value/interaction/output gates.

## Evidence log

| Date | Item | Evidence | Remaining limits |
| --- | --- | --- | --- |
| 2026-10-29 | Linux Secret Service value delivery and deletion | Secret is piped to `secret-tool store` stdin; Linux-only fixtures verify exact bytes, no argv exposure, deletion refusal and missing-command fallback. Docker Rust 1.99.1 suite passes 52/52 and strict Clippy. | No provider request is mediated by Rust yet. |
| 2026-10-29 | Native file-vault exact-value and write boundary | Unique owner-only temp file created at 0600 before secret bytes, file and directory sync around replacement; regression retains leading/trailing spaces and proves corrupt data is not overwritten. macOS unit suite 50/50; strict Clippy passes on macOS and pinned Linux Docker. | Does not implement native credential mediation. |
| 2026-10-29 | Projection isolated candidate generation seam | Owning repo commit `946ee39` exports `VakHost.runCandidate`; Node 26.13.0 typecheck, 413/413 full suite/replay, 19/19 host suite, package build pass. Canonical session/persistence is unchanged by candidate runs. | App pin unchanged. No native admission, fenced commit/acknowledgement, publish, isolation, or original task outcome gate is closed. |
| 2026-10-29 | Linux sandbox build/refusal boundary | In the owning `vak-sandbox` repository, corrected unconditional Linux backend claims, gated command/Realm execution before state mutation, and reported enforcement flags only on supported builds. Docker ARM64 Rust 1.99.1: workspace 51/51 and strict Clippy pass; pushed `c487ed9`. | Linux containment remains unavailable. No Vakyartha bundle rebuilt; AR/ISO and application outcome gates unchanged. |
| 2026-10-25 | D1–D2; B1–B7 | Draft documents; source inspection of surface mounting, canvas, library, bound edits, validation, local interactions, host dispatch and outside ownership. Earlier review ran existing suites and deterministic multi-surface canvas checks. | Foundations only; all new task behavior and expanded interaction/recovery gates remain open. |
| 2026-10-25 | D3 | Independent read-only design review: public execution primitives, private host state, volatile external action inbox, navigation cancellation, transient drafts, approval lifetime/scope and actual work limits. Findings incorporated into spec and checklist. | Public-API architecture proof, concrete workspace design and product decisions remain open. |
| 2026-10-25 | D3; D8 | Follow-up design review supports native Rust responsibilities, a single data authority and persistence writer, no duplicated surface schemas, and shared-server correctness. Runtime/IPC constraints incorporated into spec section 6. | Runtime placement proof and performance measurements are not completed. |


## First implementation checkpoint

Evidence for the completed items above: `sidecar/tasks.ts`, `shared/task-contract.ts`, `src/tasks-panel.ts`, `src/drafts.ts`, their tests and `scripts/task-check.ts`. Public host execution, ownership protection, action release and idle deletion were made in Projection first and introduced through pushed commit `caef74e`; the current app pin `8bd736e` also retains the later interactive graph capability. Product task state and UI remain here.

- D6: initial limits are 12 model rounds, 24 tool calls, five active minutes and separate five-minute approval expiry per run. Draft conflicts preserve edits pending an explicit choice. Deletion requires stopped execution, a current monotonic revision and additional acknowledgement of uncertain effects.
- D7/P0.1–P0.3: one canonical host/session/surface store; detached in-process execution and existing event delivery. No loopback execution relay, second renderer or native IPC path.
- P0.4–P0.6/P1.8: independent persisted field drafts, safe follow-up handling, complete inspectable approval arguments, one-time decisions, tool/config revision revalidation and no inherited chat-wide grants.
- P1.2/P1.4/P1.7: persisted lifecycle, input queue, navigation-independent work, cancellation and restart without automatic replay. An uncertain operation requires explicit reconciliation before continuation.
- P2.1–P2.6: task creation, capability/setup links, activity, completion review, continued interaction after completion and updates without recreating live surfaces on status refresh.
- D9/P3.9: no dependency or lockfile additions and no native runtime changes. Existing native responsibilities are retained; core task behavior works through the shared server.

Validation: 24 app tests, 232 pinned framework tests, typecheck, UI build, native export test and sidecar bundle. Existing canvas smoke and the new task smoke run in wide/narrow layouts. The task smoke exercises two forms and a table, validates before dispatch, preserves drafts through navigation/library access, checks background continuation and completed-task interaction, and verifies exactly six scripted model calls across six intentional runs; local controls trigger none. Unit/HTTP checks include malformed inputs, duplicate commands, restart, revoked approval, tool-call limits, authentication, guarded deletion and transcript cleanup.

This first checkpoint did not close the remaining composite gates. Approval-slot release was subsequently completed (P1.3); run history is not segmented for long-term schedules/chains. Automatic outcome verification, cumulative spend, complete shared-log retention, comprehensive accessibility/performance evidence and installed-window review remain open. A live primary-local-model task completed a run in about 30 seconds but returned one combined interactive surface instead of the requested two; record this as a failed outcome check, not a passing multi-surface evaluation. Generic output/execution fixes belong in Projection; do not split or patch model surfaces in the app.


## Schedule and dispatcher checkpoints (2026-10-26)

- `f5130ec`: permanent Schedule destination, full-page creation/overview/detail, one-time timing and guarded lifecycle controls. 28 app tests, typecheck/build, wide/light and narrow/dark task and canvas WebKit checks. No new dependency or framework change.
- `5aa1534`: approval review yields the execution slot; the same call resumes through the dispatcher with dispatch-time authority revalidation. 32 app tests, 235 pinned framework tests, typecheck/build and task WebKit checks.
- Run-history slice: typed execution records reference inputs and operations without copying canonical surfaces, messages or shared memory. Outcome, stop reason, recorded active time and user acceptance are visible in expandable detail rows. Schema v2 requires complete run records without legacy fallbacks; crash recovery never invents an end time. 35 app tests cover these boundaries and the run admission limit. P3.10 remains open until retention and durable deduplication support sustained long-term operation.


## Real-model outcome checkpoint — 2026-10-26

`EVALUATION.md` records the persistent installed-runtime setup, authorization, commands and before/after results. Baseline Projection `c8e7245` and opt-in response completion `dbae5c2` were each tried on three bounded local-model cases. Memory write/read-back produced independently persisted evidence. Research fetched/cited both sources but still failed layout and factual checks. Comparison gained separate surfaces but omitted table row identities and supplied form defaults; its initial machine candidate was corrected to failure. These observations do not close P4.1–P4.4 or P4.9. Retained-output WebKit checks verify local edits/filtering make no model requests, but do not certify factual correctness or full accessibility. App unit tests: 52; pinned framework tests: 238. No paid model calls or new integration installs.


- Follow-up replay checkpoint: Projection `9c6a0ae` normalizes known wrapped absolute list references using schema and existing array data; 240 framework / 52 app tests, typecheck/build/bundle and task WebKit checks pass. Targeted research rerun still fails output separation and source correctness (EVALUATION.md). P1.9/P2.7/P4.1 remain open; neither correct retrieval nor a repaired table binding certifies the answer.

- Typed result-layout checkpoint: ADR-015 adds opt-in same-run structure/visible-identity checks and successful-read excerpt matching. Flexible work remains available; no automatic user acceptance, arbitrary semantic-verification claim or extra execution process. Supplied form defaults, numeric correctness and general interpretation remain open under P1.9/P2.7/P4.9.

- Validation for ADR-015: 57 app/243 pinned framework tests, typecheck/build/bundle and responsive WebKit setup/lifecycle checks. Real local-model comparison/research diagnostics still fail (combined outputs, unresolved rows or upstream tool-format error); see EVALUATION.md. P1.9/P2.7/P4.9 remain unchecked. No app-side surface synthesis or automatic acceptance.


## Rejected-generation recovery checkpoint — 2026-10-26

Projection `399a3a9` recovers only a provider-rejected tool generation before any text/call, through the existing bounded run. Each retry reaches the app's provider admission; no adapter-level retries or runner replay of previous effects. The new app-budget regression verifies request exhaustion, persisted counters and refusal after restart. Framework regressions cover the retained exact syntax error, prior receipts, partial output, cancellation and ordinary failures. ADR-016 records the public-API gap and ownership. No dependency/lockfile/native changes. Real-output evidence and outstanding authoring work are in EVALUATION.md; P1.6/P1.9/P2.7/P3.4/P4.1/P4.7/P4.9 remain unchecked.

Validation: 58 app tests, 248 pinned framework tests/replay gate, typecheck, build, sidecar bundle, one native test and wide/narrow task/canvas WebKit checks pass. Retained comparison controls are checked at both widths without model calls. Local comparison report `2026-10-26T02-20-35.683Z-7a130c5f` remains failed after 12 requests/103.9s: incorrect numeric associations, empty defaults, missing fictional label and duplicate/replaced outputs. No XML rejection occurred in that trial, so it does not prove live recovery. Next is general authoring/data fidelity in Projection from its retained transcript; see EVALUATION.md.


## Authoring and review-feedback checkpoint — 2026-10-26

ADR-017–020: Projection `9d44982` provides keyless-property/list-binding repairs, bound-container diagnostics, correction inventories and neutral completion acknowledgements. App policy permits independent layout wrappers, rejects combined roles, names surplus outputs, reports blank cells and supports bounded user-supplied visible notices through existing task state. No canonical surface rewriting or new store/dependency/IPC. Setup/details, flexible-layout hiding and scheduled notice persistence are checked in wide/light and narrow/dark WebKit.

64 app tests, 257 pinned framework tests/replay gate, typecheck, UI build, sidecar bundle and native test pass; task/canvas and retained-output WebKit checks preserve local controls without requests. See EVALUATION.md for all seven diagnostic reports. The final comparison's numeric/default/layout/notice checks pass but its incorrect Atlas recommendation **overturns the machine candidate to failed**. Research source-excerpt candidates do not certify full explanations, dates or changed-criterion behavior. No task was accepted. P1.9/P2.7/P4.1/P4.9 remain unchecked; labels and nonempty values are not provenance or semantic verification. Next is row-local recommendation/constraint evaluation using explicit typed facts, followed by requested output receipts and recovery/retention gates.


## Current baseline and conservative evaluation — 2026-10-26

ADR-021: reconciled app `8f2d6dd`/Projection `a1537c3` changes, including background work, placement and voice. Evaluation uses canonical visible outputs and independent typed constraint references; successful machine checks require semantic review instead of reporting a candidate pass. Original failed semantic evidence is retained. 86 app/277 framework tests, typecheck/build and task/canvas WebKit checks pass. No live model/voice calls or dependency/framework changes. P1.9/P4.9 remain open for explicit semantic contracts/review; this is not automatic prose verification.


## Exact comparison assertion checkpoint — 2026-10-26

ADR-022: opt-in expected visible rows are bounded, persisted and inspectable. Exact scalar/type, identity and column checks feed corrections into the existing bounded run. Deterministic tests cover wrong booleans, numeric/string mismatch, missing/duplicate rows, hidden data, invalid/oversized inputs and same-run repair. Setup and scheduled persistence are checked in WebKit. 89 app/277 pinned framework tests, typecheck/build/bundle, native and task/canvas checks pass. Local report `2026-10-26T06-27-59.817Z-e242767d` fails after 12 requests/140.2s; the checker correctly rejects missing Atlas and wrong Birch claims. No automatic task acceptance, new dependency, framework pin change or IPC. P1.9/P4.9 remain open for reliable end-to-end outcomes and arbitrary prose review.


## Token-parser and styling integration checkpoint — 2026-10-26

Projection `05c9d59` (draft PR #1) combines the isolated token-based primitive-key repair with committed styling `0b59e6f`; a changelog overlap was resolved preserving both. Exact raw render/update and stream tests retain both rows and deliberately incorrect facts, with finalized-input guards and standard JSON primitive validation. No compound regex repair, schema/version adapters, dependency or app fact synthesis. 89 app/281 framework tests, typecheck/build/bundle and task/canvas WebKit checks pass. Local report `2026-10-26T06-52-18.822Z-72d38ec0` on preceding combined commit `4156e8f` passes declared numeric/default/layout/notice/claim checks in two requests/38.1s, but remains review-required; no causal reliability claim or automatic acceptance. P1.9/P4.1/P4.9 remain open for changed-criterion, research and semantic evidence. See EVALUATION.md for exact pin/trial scope.

## Vakyartha identity checkpoint — 2026-10-26

- Applied the original Songbird, outlined full-name wordmark and complete existing desktop/tray icon set from `Vak/code`; About uses the Vakyartha name without sibling wording. Asset provenance and font license are retained in `public/brand/`.
- Validation: typecheck and UI build pass; WebKit checks light/dark branding, loaded images, sidebar fit and About identity. All 18 native icon files match the source exports. No framework, dependency, native IPC or installed-app change is included.


## Merged parser and full-outcome review checkpoint — 2026-10-26

Projection PR #1 merged as `fb63ede` (app pin; same tree as `05c9d59`). 90 app/281 framework tests and typecheck pass; the new canonical-host test verifies submitted changed criteria, unchanged assertions, bounded correction and restart persistence. Live report `2026-10-26T07-07-21.090Z-criteria` fails changed-criterion correctness: three old boolean claims conflict with the new controls. Research report `2026-10-26T07-05-32.151Z-a7ce5796` passes fetch/citation/layout checks but fails explanatory-answer, retrieval-date and missing-verification requirements on review. Both pass wide/narrow retained-output WebKit controls without dispatch. Neither task accepted. P1.9/P4.1/P4.9 remain open. Next: explicit typed criterion revision and complete research interpretation/receipt contracts, preserving multiple interactive surfaces; see EVALUATION.md and HANDOVER.md.


## Submitted criteria and research receipts checkpoint — 2026-10-26

ADR-023/024 implemented: bounded caller-authored calculations, validated numeric criterion submissions, immutable facts/formulas, visible research answer/limitations, checked source excerpts and app-owned retrieval timestamps persisted with runs. No new store/IPC/dependency or app renderer patch. Projection PR #2 merged as `558ca0c` repairs ancestor cycles generally. 92 app/283 framework tests, typecheck, native and wide/narrow task/canvas/retained-output checks pass. The changed-criterion trial passes declared facts/control/type checks; research trials still fail end-to-end authoring, so P1.9/P4.1/P4.9 and semantic acceptance remain open. Clean build/local installation requested; record verified artifact provenance separately. See EVALUATION.md/HANDOVER.md.


Clean local install verified (2026-10-26): pushed code `2c71c44`/Projection main `558ca0c`, new Rust target and regenerated UI/sidecar, successful app+DMG, exact 1,949-file installed-bundle match and native About/new setup checks. Both repos have only pushed `main`. Unsigned/unnotarized, no public release or installed-model smoke. Final strict research report `2026-10-26T07-33-30.445Z-4c46b1ff` fails at the active-time cap; research correctness/reliability and P1.9/P4.1/P4.9 stay open. See EVALUATION.md for full provenance and the next raw replay.


## Research and scoped task-file checkpoint — 2026-10-26

ADR-025/026 implemented. Projection main includes batch-level caller constraints (`11b9123`), serialized list-member repair (`4b1131d`) and temporary-session cleanup (`d1248e2`). 99 app/287 framework tests and typecheck pass; native test and wide/narrow task/canvas checks pass, including snapshot selection, output read-back/download, no extra generation for verification, and exact-ID reconciliation. Research report `2026-10-26T08-15-19.960Z-08795b1b` reaches user review with matching source receipts and a verified 1,656-byte Markdown export in 10 requests/194.6s. Original harness verdict is retained; `review.json` records the corrected Markdown-visibility false negative. No automatic acceptance or broad reliability threshold claim. P1.9/P2.7/P4.1/P4.2/P4.9 remain open beyond this bounded evidence slice.

Live voice checks remain pending by user preference (2026-10-26); the concrete free/local procedure is [VOICE-CHECK.md](VOICE-CHECK.md).


## Optional external discovery checkpoint — 2026-10-26

Implemented under ADR-027: source browsing/search/pagination and review-bound unverified/off imports through the existing integration lifecycle, with credential/cost/compatibility disclosure, bounded caching, offline fallback and removal. Canonical installation, secrets, processes and tool policies remain framework-owned. Compatible hosted and pinned local package paths are covered; other runtimes and browser authentication remain explicit limitations. A live public documentation connection verified tool discovery, an explicit search, disable/reconnect and removal after an upstream protocol correction. No automatic free classification, task access, task acceptance, new dependency or native IPC. D11 and broader readiness/outcome gates remain open; see [verification scope](EXTERNAL-CATALOGS.md).


External discovery UI correction (2026-10-26): screenshot-reported axes and card actions now have geometric WebKit checks at wide/medium/narrow widths. Source/publisher identity assets are distinct from trust status; external icons use authenticated bounded image fetches and passive rendering. No change to task acceptance/free-capability gates or runtime ownership. See EXTERNAL-CATALOGS.md for checks and RELEASING.md for the requested clean local installation.


Pipeline audit checkpoint (2026-10-27): dispatch revalidation, supported native argument checks, explicit MCP failure status, bounded/cancellable transport and finite retries are covered by offline regressions. Stale skill selection fails explicitly and root skill review discloses omitted supporting files.163 app/393 framework tests/replay, typechecks, packages/UI and wide/narrow canvas WebKit pass. This does not close any unchecked live outcome, source/value/interaction, accessibility, channel-parity or sustained-operation gate. See [review](PIPELINE-REVIEW.md).


Fresh pipeline install (2026-10-27): exact committed source, fresh dependencies/empty Rust target and matching installed/standard file manifests; About, Skills and saved/new canvas rendering checked. The single local smoke omitted the explicitly requested Ready status in raw authoring, so content correctness fails and no model-outcome checkbox closes. Raw failure retained; no repeat attempt. [Evaluation](EVALUATION.md), [installation provenance](RELEASING.md).


## Skill and surface-layout audit checkpoint — 2026-10-27

[Maintained guide](SKILL-AUTHORING.md) and [audit](SKILL-AUDIT.md): thirteen focused built-ins and shared design chaining, plus Vakyartha instruction-creation guidance. Projection `c045a3c` adds semantic measures for all components, sparse-grid stability, explicit responsive alignment and bounded chart drawing. Mixed-layout and existing canvas WebKit checks preserve local controls and drafts. The canonical visual/spoken report regression retains decimal findings and caveats; all eight standard chart paths and dated heatmap are checked. 164 app/393 framework tests, typechecks and builds pass. Primary-local mapped-table gate passes only one of three cases; two abort before canonical publication. A1/A2 and all existing source/value/semantic/interaction/receipt/installed outcome gates remain open. No broad reliability claim, installed replacement or new dependency.

Canvas liquid layout audit & multi-surface projection checkpoint (2026-10-28): deep audit of `interactive-ui` and `surface-design` eliminated schema inversions, clarified top-level `surface` vs node `id`, separated client actions from task completions, established strict input taxonomy, and banned 100% chart/card stretching on wide monitors. All 18 canvas-authoring built-in skills updated to v1.3 with 3-tier liquid layouts, multi-column fluid grids, clamped measures, Inter typography, and semantic tones, mirrored in `sidecar/builtin-skills` and `src-tauri/resources/builtin-skills`. Multi-surface projection documented and audited in `docs/SURFACES.md` covering Web/Desktop, Telegram (Bot API 10.3), Slack (Block Kit 2026), Discord (Components V2), and Voice TTS. 185 app tests, 398 framework tests, typechecks, UI build, Rust tests, and real WebKit checks (1440/1100/620/375px) pass. Zero external dependencies or secrets.

## Unified Studio Workbench, Creator Hub, Flow DAG & Multi-Tab Lifecycle checkpoint — 2026-10-28

ADR-046 implemented: complete Creator Studio accessible directly from the sidebar (`✨ Studio`) and Settings (`src/skills-studio.ts`).
- **Creator Hub Overview:** Unified workspace launcher for both Agent Skills and Sandboxed Dynamic Applications (`app.json`, `server.ts`, `surface.json`). Filterable by type and drafts with instant search. Single-line action buttons and native layout within `.app` CSS grid (`grid-column: 2; grid-row: 1;`) ensuring seamless sidebar collapse/expand transitions via `⌘\` or `#topbar-sidebar-toggle` and strict synchronous mutual exclusion across all primary views (`Schedule`, `Apps`, `Artifacts`, `Chats`, `Settings`).
- **Multi-Tab Multitasking & Session Persistence:** Non-destructive context switching allows navigating between active studio work and live chat turns without losing state, open files, or cursor positions.
- **Continuous Background Auto-Save:** Debounced auto-saving (800ms) persists drafts safely under `<data>/skills/.drafts/<name>/` (`PUT /api/skills/:name/draft`).
- **Interactive Flow DAG & Authoring:** SVG-rendered Directed Acyclic Graph visualizes execution, tool boundaries, and surface projection pipelines with interactive node inspection. Direct authoring controls (`+ Add Tool`, `+ Add Chained Skill`, `+ Add Procedural Step`) directly update package frontmatter, auto-save, and synchronize across all tabs. Node inspector provides deep links (`Jump to Spec & Code`, `Preview in Canvas`, `Rehearse in Sandbox`) and contextual removal actions.
- **Tool Selection Synchronization:** Combines declared tools, core system/canvas tools (`read_skill_file`, `vak_render`, `vak_update`, `vak_submit`, `use_skill`, `run_command`), and active MCP integrations into interactive checked chips (`✓ <tool>` / `+ <tool>`), eliminating disconnected tool counts.
- **Authentic Domain Canvas Staging & Linter:** Live `<vak-surface>` mounting across responsive container viewports (`320px`, `720px`, `960px`, `100% Fluid`) with realistic domain surface synthesis for domain skills (e.g. `meeting-actions`, `market-dashboard`, `task-tracker`, `code-review`), Surface Design Linter checks, and Dual Spoken Voice TTS auditioning.
- **Disposable Sandbox Rehearsal & Gate Testing:** Runs inert scripts in `vak-sandbox` with SHA-256 integrity verification, provides prompt-guided procedural testing with helper script creation for scriptless skills, and verifies prompt matching against the provider selection gate (`/api/skills/eval`).
- **Verification:** 211 app tests, 399 framework tests, typechecks, UI build, and WebKit checks (`skills-check.ts` at 1100/620/375px and `canvas-check.ts` at 1100/620px) pass cleanly. Zero mocks or stubs.

## Earlier app-pool checkpoint — superseded (2026-10-28)

The original ADR-047 checkpoint overstated worker prewarming, persistent databases, resource protection and latency. These are not accepted completion evidence. [Original review](sandboxed-apps/REVIEW-2026-10-28.md), [current contract](sandboxed-apps/RUNTIME-CONTRACT.md) and the executable app repair checkpoint below define the supported scope. Primary-provider app authoring remains open.

## Executable app repair checkpoint — 2026-10-28

Supersedes the earlier mini-cloud completion claims: [current bounded runtime contract](sandboxed-apps/RUNTIME-CONTRACT.md).

- [x] Actual supervised Node app actions/declared refresh functions, canonical persistent state and multiple surfaces; direct execution without per-action model calls.
- [x] Inert app drafts, source loading, reviewed publication, bounded tool bridge with existing integration authority, opt-in schedules and uncertain-effect refusal.
- [x] Real-helper/API mechanism checks and WebKit arithmetic/refresh/reopen journeys at 1100/620/375; no installed-app claim.
- [ ] Reliable primary-provider chat-to-executable-app authoring: graph gate remains 2/3; no broader model workflow trial followed.
- [ ] Permanent daemons, filesystem databases, watchers and stronger resource/platform isolation remain later capabilities.

## Reference analytical app checkpoint — 2026-10-29

- [x] Deterministically authored executable reference package with independent market/instrument/analytics views, real governed source reads, bounded persistent sandbox DuckDB and complete operator/agent/skill documentation.
- [x] Reusable Projection OHLC intervals, truthful fitted trend scales, horizontal signed rankings, explicit plot sizes/axis context, compact density and exact observation inspection; adopted through pushed pin `b28c317`.
- [x] Independent source/SQL/persistence checks and actual WebKit navigation/inspection/actions at wide/narrow widths; ordinary Canvas remains covered. Earlier visual false positives are retained and corrected in Evaluation.
- [ ] Broader model-authored app reliability, installed delivery, comprehensive accessibility/channel parity, pan/zoom/brush/linked-axis capabilities and unbounded database volumes. No existing unchecked task-outcome gate is closed by this reference.

## Collection UX checkpoint — 2026-10-29

Compact shared geometry and local collection paging/search are implemented and checked in native WebKit; see HANDOVER.md and EVALUATION.md. This does not close broad accessibility, real model composition or source/outcome gates. Small collections intentionally omit pagination; model names use search in the native selector and external catalog discovery retains its cursor contract.

## Folder workspaces and project chats checkpoint — 2026-10-29

Historical workspace checkpoint, read with the bounded FOLDER1–FOLDER7 criteria above. Direct/shared modes are implemented; arbitrary builds/worktrees and unrestricted file formats are not certified.
- [x] App-owned `WorkspaceRegistry` (`sidecar/workspace-registry.ts`) manages project lifecycle, folder validation (`validateWorkspaceFolder`), and session-scoped bindings (`AsyncLocalStorage` context) outside admitted folders.
- [x] Path validation canonicalizes paths and rejects home folder root, root `/`, system paths (`/System`, `/Library`, `/Applications`, `/usr`, `/etc`, etc.) and private app data directories.
- [x] Retained Realm copies (`vaksb realm create/exec/snapshot/promote/rollback`) maintain file modifications across turns without touching the original project folder until reviewed and applied.
- [x] Direct in-place editing mode (`mode: "direct"`): Commands and tools execute directly in the admitted folder under macOS Seatbelt kernel protection (network denied, path boundaries enforced) with no copy limits or staging copies, writing directly to original project files.
- [x] Shared project Realms (`sharedRealm: true`): Multiple chats in the same project share a single durable Realm with mutual-exclusion locking per Realm ID, enabling real-time collaborative edits and unified promotion.
- [x] Direct execution accepts up to 300 seconds/256 KiB; basic Git init/add/commit/log and 64-KiB output are tested without copying `.git`. Retained/shared Realm exec remains 30 seconds/32 KiB. Actual worktree creation, arbitrary builds and maximum-duration workloads remain unverified.
- [x] Governed binary media handoff: `/export-asset` and `/import-file` endpoints validate chat bindings, paths, resource limits (20 MB), and media signatures (PNG, WAV, MP4, PDF, text).
- [x] UI integration: Responsive chat workspace bar and Projects sidebar (`src/workspaces-panel.ts`) with mode pills, review drawer, discard/refresh guards, and dialogs.
- [x] Verification: All 255 tests pass (`test/workspace-*.test.ts`), WebKit geometry checks pass at 1440/1100/620/375px (`scripts/control-layout-check.ts`, `scripts/collection-ui-check.ts`, `scripts/canvas-check.ts`, `scripts/surface-design-check.ts`), and frozen primary-local Ollama outcome gate passes (`scripts/folder-workspace-outcome.ts`).
