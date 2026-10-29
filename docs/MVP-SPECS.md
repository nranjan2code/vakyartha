# Vakyartha agent MVP

Authoring implementation method: [SKILL-AUTHORING.md](SKILL-AUTHORING.md) defines reusable procedures, data/view contracts, supported charts and visual/spoken projection requirements. It reuses canonical runtime ownership; new report types do not require new domain engines.

Current authoring boundary (2026-10-27): skills guide procedures and composition; shared record mappings, canonical transactions and governed capabilities execute them. Source-specific derive/prepare/workspace compilation is deleted. Original source/calculation/interaction/output requirements below remain acceptance requirements; historical compiler-path results do not close them for the current implementation.

Reviewed catalog and bundled skill packages retain bounded supporting UTF-8 text, including inert script source, and expose it on demand only for skills loaded in the run. Bundled defaults are authored as Agent Skills folders; market-dashboard includes a reusable Projection example. Binary assets and script execution remain outside the current import tier. The package format and app-owned capability boundary are recorded in [ADR-040](ADR.md#adr-040-standard-skill-packages-app-owned-capabilities-2026-10-27); outcome evidence is in [EVALUATION.md](EVALUATION.md#authoring-cost-and-skill-interoperability--2026-10-27).


Planning baseline: 2026-10-25. Status: implementation in progress; the checklist distinguishes working behavior from planned requirements. Progress and release evidence: [MVP-CHECKLIST.md](MVP-CHECKLIST.md). Current implementation: [SPECS.md](SPECS.md). Working rules: [AGENTS.md](../AGENTS.md).

Architecture decisions: [ADR.md](ADR.md). Implementation is now authorized; the checklist records which parts actually work.

Task and plugin contracts are explicitly typed and versioned. Validate untrusted boundary data before converting it to domain types; do not treat type assertions as validation. See ADR-004.

Task lifetime, bounded runs, trigger dispatch and task chains are separate concerns. All runs share a dispatcher; a calendar schedule is optional. ADR-005 defines the long-term contract and the additional gates before scheduled or dependency-driven execution. ADR-006 defines explicit, revision-checked deletion without hidden cancellation or cascading effects.

## 1. Product goal and scope

Vakyartha helps a person complete a bounded task using selected information and tools. The person can give instructions in conversation, interact with any of the task's surfaces, inspect progress, supply missing information, and approve consequential actions. Results remain useful, interactive artifacts.

The first MVP proposes one agent for individual knowledge work on the desktop. A task can have multiple steps, multiple interactions, multiple execution runs, and multiple surfaces. A conversation turn, an execution run, a surface, and a task are distinct concepts. Producing a valid interface does not by itself complete the task.

Work continues when the user switches tasks or hides the window while the app and computer remain running. Quitting, sleep, loss of connectivity, and engine failure have explicit recovery behavior. No promise of execution while the computer is off or asleep is made.

## 2. Existing design to preserve

The interface is already interactive. Agent work extends its execution and continuity; it does not replace its rendering or interaction system.

| Existing capability | Required treatment |
| --- | --- |
| Multiple identified surfaces, individually rendered, updated and removed | Keep stable identities and support several live surfaces per task. Do not collapse them into a single answer or final-output slot. |
| Bound field values, validation, form submissions and button actions | Keep the existing interaction contract and server-side validation. Route actions to their owning task or outside agent. |
| Local sorting, filtering, pagination and computed totals | Keep these local; no agent run or model request is needed for an existing local interaction. |
| One live element per mounted surface, moved into the canvas | Preserve live state and avoid mounting duplicate interactive copies in activity, conversation or library views. |
| Canvas picker, resizing, full/split view, Preview/Text, copy and export | Retain these controls and their keyboard behavior. Text remains an optional representation. |
| Artifact library with metadata-only cards | Reuse it, link results to their task, and keep private field values out of previews. |
| Streamed creation and updates, manual-close suppression and history restoration | Preserve these behaviors; background task updates must not hijack the visible task or steal focus. |
| Outside-agent ownership and action delivery | Preserve routing; task execution must not intercept those actions. |

The reviewed paths are `src/main.ts` (surface mounting and action dispatch), `src/canvas.ts` (live-element placement and picker), `src/artifacts-page.ts` (discovery), and the framework's surface, interaction, rendering and host code. The existing canvas smoke exercises multiple surfaces and form submission. New task tests must extend that coverage.

## 3. Task workspace and interaction

Current source extension (2026-10-29): standalone chats can bind to a selected folder, and sidebar Projects group chats around a folder. Binding is runtime authority distinct from sidebar membership. File tools and shell commands use the admitted working tree through the existing integration/sandbox lifecycle, without changing global cwd. Isolated copy/review is the default; direct editing and shared project Realms are selectable. FOLDER1–FOLDER7 are recorded as checked in [MVP-CHECKLIST.md](MVP-CHECKLIST.md), with their dated evidence in the [workspace contract](sandbox/FOLDER-WORKSPACES.md) and HANDOVER.md. This documentation audit does not rerun those outcomes or establish expanded system isolation; ISO1–ISO8 remain open. The task/surface requirements below are preserved.

The app adds task discovery and task status to the existing workspace. Conversation remains the place for instructions and feedback; activity is a compact, expandable account of work; the existing canvas displays the selected live surface. Three permanently visible columns are not required.

Each task shows its goal, status, current step, requested input or approval, results and limits. Task lists distinguish work needing attention from running and finished work. Existing conversations and artifacts remain discoverable; historical conversations are not silently marked as completed agent tasks.

### Multiple interactive surfaces

One task may contain a requirements form, plan, comparison table, editable review and final report at the same time. The canvas picker selects among them. Selection changes presentation, not ownership, validity, or interactivity.

- Every surface keeps its supported interactions, whether it is an input, intermediate result or final result. Completion does not automatically make the task's surfaces read-only.
- A local interaction changes only local view state. A submitted action carries task, surface and source identity, relevant data, and a revision sufficient to reject stale operations.
- An agent update to one surface must not replace another surface's values, validation or view state. A live update conflicting with unsent edits must preserve the edits and expose the conflict rather than silently discard them.
- Drafts survive canvas closing, switching surfaces, switching tasks and restarting the app. Persist only needed draft state with the same data controls as task content.
- A submitted action is acknowledged, validated and recorded. Deduplicate known submissions; after an uncertain external outcome, reconcile or request a decision before retrying. Arbitrary external effects cannot be promised exactly-once execution. Busy state is scoped to the affected action or conflicting operation, not every surface.
- While work is running, additional submissions are queued within the owning task or explicitly rejected with a reason. They never implicitly cancel the active run. Cancellation is a separate control.
- Submitting an action on a completed task creates an explicit continuation with its own execution record. The earlier completion evidence is retained.
- Old or removed controls cannot authorize actions against a newer target. A stale submission requests a fresh review when necessary.

Engine-enforced permission requests remain trusted application controls. A model-generated form or button cannot approve tool access or manufacture permission by displaying an approval-looking interface.

## 4. MVP requirements

### M1. Task definition and setup

Create a task from a written goal and selected inputs. Save the expected result and completion conditions; ask for missing information only when needed. Let the user inspect the chosen model, enabled tools, accessible folders or accounts, output destination and execution limits. Use the existing model and integration settings. No new agent marketplace or persona builder is required.

Initial inputs are pasted text, explicit public-page addresses and files reachable through enabled, scoped tools. Support only readable formats verified by the available tools. Do not imply document conversion, image understanding, spreadsheet calculation or unrestricted web search from a generic attachment control.

### M2. Durable lifecycle

| State | Meaning and next action |
| --- | --- |
| Queued | Saved and waiting for the execution slot; can be cancelled. |
| Running | Performing bounded work; can request input, approval, complete, fail, or be cancelled. |
| Needs input | Missing information or a recoverable conflict; user response queues continuation. |
| Needs approval | A concrete operation awaits an explicit decision; denial is recorded and handled. |
| Interrupted | Execution stopped unexpectedly or during shutdown; reconcile pending effects before offering continuation. |
| Completed | Completion conditions have supporting evidence; later interaction can start a continuation. |
| Failed | Cannot safely finish within available access or limits; retain useful partial results and explain recovery. |
| Cancelled | No further new operations may start; preserve the record and report effects already completed or still uncertain. |

Allow one executing task at a time initially; other tasks can be queued or awaiting user attention. Switching the visible task or losing the UI event connection does not cancel execution. Release the execution slot while waiting for user input or approval.

Persist the task before execution and checkpoint progress around operations. On restart, never silently repeat a potentially completed write or restore a permission grant that no longer applies. Unknown outcomes remain unknown until checked; provide a safe manual recovery path when reconciliation is unavailable. Cancellation cannot promise to undo an external action already sent.

### M3. Execution, progress and verified completion

Use bounded steps and relevant tools. Progress records distinguish planned, attempted, succeeded, failed and uncertain work. Do not display invented percentage progress or hidden reasoning. A progress surface may be updated without ending the task.

Completion requires checking the task's stated conditions against sources, artifacts or execution receipts. An interface rendering successfully, a model declaring success, and a request being sent are insufficient evidence of a completed external effect. Partial results, sample data, unavailable sources and stale information are labelled. Never replace missing real evidence with unlabelled invented data.

### M4. Tools and approvals

Task access is a subset of the user's configured integration permissions. Permissions are enforced outside model-written content; selecting a task tool cannot override a blocked tool. Keep existing installation, secret isolation and network protections.

Requests show the operation, destination, affected resource, relevant data and complete inspectable arguments. Permission for one operation does not imply permission for unrelated arguments. Users can deny or revoke future access. Recheck authorization immediately before a delayed or resumed operation; reject expired or stale approvals. Persist the decision and operation identity without retaining credentials in the activity record.

### M5. Results and continuity

Link tasks to existing surface identities and source sessions; do not introduce a second store of rendered artifacts. Keep multiple input, intermediate and result surfaces discoverable. Source links, output files and execution receipts identify what supports a result. Unsupported operations are explained before the interface promises to perform them.

Preserve plain conversation use. Provide a clear task-start action so that asking a question does not silently create unattended work. Existing conversation data remains readable; task linkage is additive and recoverable.

### M6. Limits, usage and attention

Every run has finite active-execution-time, model-call, tool-call and retry limits, enforced outside the model. Waiting for a person has a separately defined expiry policy. A model round may contain multiple tool calls; a per-request output limit is not a cumulative task budget. Show limits before starting and explain when they stop work. FinOps gains task/run attribution; include any operation that spends through the task, and identify costs it cannot measure.

Do not claim a strict monetary ceiling when prices or usage are unknown. If the user requires such a ceiling, block execution until a conservative enforceable policy is available. No silent switch to a paid model. Exact default limits are a pre-implementation design decision.

Provide in-app attention for completion, failure, input and approval. Do not generate repeated unchanged status notifications. System notifications are optional and require user-controlled enablement; remote delivery is later scope.

### M7. Data, recovery and diagnostics

Save task definitions, runs, events, operation identities, surface references and necessary drafts locally. Separate user content from numeric telemetry and credentials. Record only the content necessary for the task and its recovery; provide retention controls for optional diagnostic transcripts.

Deletion states its scope and removes task-owned content, drafts and raw diagnostic content in that scope. Shared records are retained only when still referenced and explained. Credentials, integrations and external files are not silently deleted with a task. Deleting a running task first stops new work and resolves or reports in-flight effects. Failures to save or delete are visible and retryable.

### M8. Usability and accessibility

Setup checks readiness and offers an actionable recovery path. Keyboard and assistive-technology users can navigate tasks, select surfaces, edit fields, submit, inspect full approvals and cancel work. Announce meaningful status changes without repeatedly reading streaming content. Preserve focus while background work updates. Check wide and narrow layouts in the app's actual rendering engine.

### M9. Voice interaction

Voice is another projection of the same surfaces and approvals, not a remote control for the screen. The person answers what the task is waiting for in their own words ("two people, next Friday, the cheaper one"); they never name a button, list, dropdown or field. Everything a voice answer does is something a click or typed value could already do, through the same action, validation and authority checks.

One master switch covers voice. Off: no microphone use, no spoken output, no speech requests. On: read aloud, dictation and conversation mode each keep their own setting beneath it.

1. **Agenda.** At any moment voice derives what is waiting on the person, in order: pending approvals; then the most recently active surface with an unanswered form, action or choice. With nothing waiting, speech is a new message or an app command.
2. **Asking.** Each agenda item becomes a spoken question built from its meaning: field labels, allowed options with the values that tell them apart, and the action's purpose. Controls are never described as controls.
3. **Filling.** One answer may fill several fields; only missing or invalid fields are asked again. Field checks (required, email, ranges, dates) apply exactly as for typed input and are explained in speech. Heard values are written to the surface's bound data, so the screen shows them as they are filled and either input method can finish the form.
4. **Read-back.** Before an action is sent, a short sentence states what will happen. Agreement sends the identical action a click would send. Local interactions (sort, filter, page) stay local, as today.
5. **Understanding.** First, a deterministic resolver per language: yes/no/cancel/back/repeat words, option names, ordinals ("the second one"), comparisons against declared values ("the cheapest", "the earliest"), numbers and dates. Only when that is empty or ambiguous, and the item is not an approval, the model receives the answer and the agenda item and may return only values the item allows; its result passes the same validation. An answer still unresolved is asked once more, then left on screen.
6. **Approvals.** Resolved only by the deterministic resolver, never by model output, so text in a page, tool result or reply cannot approve anything. A write or an internet operation needs a phrase naming the operation ("allow the write"); a plain yes suffices only for read-only operations. Silence, timeout, noise or ambiguity leaves the approval pending on screen; it is never approved by default. The applied decision is said back. M4 authority checks are unchanged.
7. **Hands-free loop.** Conversation mode states: off, listening, hearing, understanding, asking, speaking, acting. End of speech is detected locally from the input level. Speaking stops as soon as the person talks. The microphone is echo-cancelled or paused while the app speaks, so it never hears itself. A fixed stop phrase and Escape end the mode. No always-listening wake phrase in this scope; a shortcut or control starts conversation mode.
8. **Every placement.** The agenda produces the same action for inline, canvas and remote-channel surfaces. In conversation mode the canvas follows the item being discussed, but background tasks never take focus.
9. **Language.** Questions and resolver words follow the person's language and the reply's language. Where a language has no resolver words, voice says so and the item stays on screen.
10. **Data and cost.** Recordings are transient and never stored; a voice answer is recorded like typed input. Billed speech providers keep their existing consent; local ones are preferred.

11. **What is said.** Speech is its own projection, not the screen read in order. The reply's answer comes first in a sentence or two; each surface follows as its gist: a dashboard's headline numbers and anything unusual, a table's count and leading rows, a chart's trend in one sentence, a comparison's differences and pick, a form's list of what it needs. Then at most one thing waiting on the person, and two or three things they can say next, taken only from controls on screen. "More", "details" and "read the table" give the rest. Long work gives short progress. Numbers come from the surface data, so what is heard matches what is shown.
12. **Hijacking.** Only words heard from the microphone answer or act; model text, pages and tool output never reach the resolver. A heard sentence matching what the app just said is ignored (echo guard). Content from outside the app is introduced as such ("The page says…"). Suggested follow-ups come only from on-screen controls, never from model prose. A heard sentence that becomes a message cannot act by itself: writes and internet operations still need a tool approval that names the operation.
13. **Controls the model authors.** Buttons, choices and forms carry what both a click and a voice answer need: an action name, a payload naming the item for per-item buttons, and option values (price, date, rating) as their own fields rather than inside prose. The catalog teaches this; general repairs fill what is derivable (an item's name from its card); a diagnostic goes back to the model only when the person would otherwise get a dead control. Checked against recorded local-model output.

Accessibility: each state change is announced once, and every voice action remains available by keyboard.

## 5. Initial outcome scenarios

These are proposed validation scenarios, not new standalone agents or guaranteed integrations.

| Scenario | Inputs and actions | Completion evidence |
| --- | --- | --- |
| Research comparison | User supplies criteria and public sources; the agent collects current evidence through authorized tools. Criteria form and comparison remain independently interactive. | Cited comparison, retrieval dates, missing-data labels and response to a changed criterion. No purchase or contact is implied. |
| Workspace report | User selects accessible, readable files and an output location. Agent collects facts and produces useful tables or charts. | Traceable input references, checked calculations, interactive report and a saved output receipt when saving was requested. Unsupported formats are reported. |
| Connected work review | Read selected work records using an enabled integration, group findings, prepare a proposed change, and ask before applying it. | Linked findings, exact reviewed operation, confirmed receipt or explicit failure, and no duplicate change after interruption. |

No additional integration or dependency is implied by these scenarios. Start with existing capabilities; any addition follows repository approval and security rules.

## 6. Ownership and dependency gate

Product features stay in Vakyartha. Existing framework capabilities are reused through public exports. A requirement is not permission to move its whole implementation into Projection.

| Area | Vakyartha owns | Projection involvement only if needed |
| --- | --- | --- |
| Tasks and agent product | Definitions, task records, queues, statuses, workspace, completion criteria and result associations | A missing general execution hook or event contract. |
| Surfaces and interactions | Canvas placement, selection, task routing, draft persistence policy and artifact discovery | Existing bindings, validation, rendering, updates and action semantics remain framework-owned; general fixes go there. |
| Execution continuity | App queue, checkpoints, recovery policy and user experience | Demonstrated gaps in run lifecycle, disconnect behavior, completion policy or replayable events. |
| Integrations and permissions | Catalog choices, task access policy, permission UI and secret storage | Existing install/run machinery and general policy enforcement; additional scoped enforcement only if public APIs cannot support it. |
| Accounting and data | Limits chosen by the product, usage attribution, retention, deletion UX and diagnostics | General cancellation, operation receipts or host deletion hooks when missing. |
| Voice (M9) | One `src/voice/` and `sidecar/voice/` module: speech and transcription providers, local engines and voice packs, recording, end-of-speech, barge-in, echo safety, the conversation loop, master switch, settings, approval items supplied to the agenda, and app commands | The voice projector: agenda derivation from resolved surfaces, spoken questions, field model, deterministic resolver, constrained model-resolution contract and validated action construction. |
| Future capabilities | Skills library, user memory, schedules, notifications and channels | General primitives only after a concrete requirement and API gap exist. |

Before each proposed framework change, record the existing public capability, the precise missing behavior, why app composition is insufficient, the smallest additive framework contract, compatibility expectations and verification. Implement there in its own repository, test and push, then deliberately update the app's dependency pin. Never edit the dependency checkout here or import its internal files.

In particular, do not remove projection-oriented completion for existing clients globally. Establish a general, compatible execution policy only if task execution requires it. Reuse external projection/action delivery where suitable before inventing a parallel surface protocol.

An architecture proof must first establish one canonical session/surface store and durable action ownership using public exports. The public provider API already exposes execution, tool and event primitives; do not assume a new runner is needed. The current host privately owns session state, and its external-action inbox is volatile. Repeated HTTP chat requests or external projection alone do not establish durable task execution. Record the precise composition seam before choosing an app adapter or a minimal framework addition.

Existing live-turn approvals are not durable task permissions: they expire, depend on the event emitter, and may allow a tool across a whole chat. Pending task requests need durable identities and exact scope; existing chat grants must not silently transfer into task authorization.

### Voice projector framework record

- **Existing public capability:** catalog roles (`form`, `action`, `choices`), bindings, field checks, `lowerSurface`, `VpsAction` and the text projectors. The app's `spokenSurface` reads content aloud and deliberately skips controls.
- **Missing behavior:** a projector-neutral description of what a surface is waiting for (decision and choice items; fields with type, allowed options and checks), and a way to turn a text answer into validated field values or a `VpsAction`.
- **Why app composition is insufficient:** the app would have to re-derive role, binding and check semantics from framework internals, duplicate validation, and the result would not serve other targets such as remote channels.
- **Smallest additive contract:** exports that derive agenda items from a resolved surface, resolve an answer deterministically against an item (fill, choose, confirm, cancel or unknown), describe the constrained model-resolution schema for an item, and build the `VpsAction` from completed values. The app supplies approval items in the same shape. The package placement is decided in Projection.
- **Compatibility:** additive only; existing projectors, action semantics and tool contracts are unchanged.
- **Verification:** Projection tests per catalog type and per language's resolver words, including adversarial text that must never resolve an approval; app tests that a voice answer and a click produce identical actions; the WebKit canvas check.

### Runtime placement, performance and security

The user requested broader system isolation on 2026-10-29 and selected a minimal trusted broker for credentials, approvals, persistence and authorized network operations, with isolated execution workers. Host execution, provider requests, host-mediated integration calls, CPU/memory enforcement and Linux containment are required work under [the system isolation contract](sandbox/SYSTEM-ISOLATION.md) and ISO1–ISO8 in the checklist. The present engine is not yet that minimal broker. Existing bounded macOS command/app isolation does not satisfy these requirements. Any additional worker connection must meet the ownership, validation and measurement rules below; the existing private desktop UI/engine connection remains canonical.

The user selected a private desktop transport on 2026-10-27: the existing UI/engine connection now crosses main-window native IPC and parent-owned pipes instead of a loopback listener. This is a deliberate exception to the earlier no-native-relay preference. The relay carries only versioned request identity, route, bounded body, status and streamed bytes; the engine retains all session/task/data authority, cancellation and admission checks. Consumer acknowledgements bound streaming, and native integration checks cover rendering, no listening port and parent-exit cleanup. Browser HTTP remains a development adapter. See [runtime audit](NODE-RUNTIME.md).

Prefer no additional interprocess boundary. Keep related behavior beside its canonical data owner and reuse the existing UI-to-engine connection. Do not relay ordinary task commands or streamed surfaces through the native shell. Field edits, local table controls and canvas placement stay in the UI; they require no native IPC or model call. Task orchestration stays near the existing engine/session state by default.

Use Rust where native capabilities or a demonstrated correctness, performance or security benefit justify it: process supervision and graceful shutdown, platform integration, and confined native file operations already belong there. Evaluate native notification or credential changes individually rather than moving working code by language preference. The task authority, not the process supervisor, determines recoverable or uncertain execution state.

Each durable entity has one authority and one persistence writer. Do not maintain parallel task truth, independent write caches or separate copies of framework surface schemas across runtimes. Rust-owned transactional storage is an option only if a focused design demonstrates enough benefit to justify the required boundary; it is not an MVP prerequisite or an approved migration. That design must assign transactions, schema versions and migrations to one owner. The storage format and any new dependency remain explicit decisions.

Any unavoidable cross-process contract must be small, versioned and validated at the receiving boundary. Prefer stable task/session/surface/action IDs and necessary values over full state snapshots. Define unknown, absent, error and incompatible-version behavior; reject invalid or stale commands and deduplicate known operation IDs. Do not shuttle large files, credentials or every surface change through native IPC. Task correctness must remain available through the shared app server without a native window; native capabilities have explicit availability and failure behavior.

Before adding a boundary, measure request counts, payload size, rendering responsiveness and serialization overhead using deterministic fixtures, separately from model latency. Establish an acceptable baseline and regression budget during the architecture proof. Avoid unbounded event queues, unnecessary full snapshots and synchronous native calls on interaction paths. Authorization, validation, credential isolation and operation receipts cannot be removed to reduce message count; Rust alone is not a security boundary or a reason to expose broad privileged commands.

### Dependency and supply-chain policy

The MVP defaults to no new third-party SDK, agent framework, package, crate, service or build tool. Reuse the existing application, framework public APIs and language/platform standard libraries. Build small, bounded capabilities in the appropriate repository when that keeps the implementation understandable and maintainable. Do not add a dependency merely to wrap an existing API or avoid a modest amount of owned code.

Any necessary exception requires the user's approval before installation or adoption, with the precise gap, alternatives, maintenance cost and security implications documented. Assess the complete transitive dependency change, publisher/source provenance, artifact integrity, exact resolved versions and install/build scripts. Review lockfile diffs and unexpected network or code-generation behavior. Script-free integration installation and existing version-age rules remain mandatory; they do not establish that a package is safe to execute.

Do not use floating versions, ad hoc package execution, model-suggested installs, unreviewed vendored code or remote executable downloads to bypass review. Treat a dependency update as a deliberate change with targeted verification. Apply the same requirement to native and scripting-language dependencies, optional tools and framework additions. General framework work still belongs in Projection and must follow its own rules too.

Dependency avoidance does not justify custom cryptography, a new authentication protocol or a larger execution privilege. Prefer established platform primitives; if those cannot meet a security requirement safely, present the concrete dependency decision instead of quietly weakening the design. New isolation, persistent storage or native integration work does not imply approval of a supporting library.

## 7. Later scope

The optional media slice is now implemented independently of task admission: three integrations select provider/model per operation, share credentials, retain private files and known provider job identities, and publish results through the canonical host/store. Dedicated screen/voice media projections keep playback local. This does not change scheduled-task free-capability admission, establish a monetary ceiling or implement every prospective editing operation. No new native relay or parallel agent loop was introduced. Current scope and evidence: [MEDIA-TOOLS.md](MEDIA-TOOLS.md).

Memory, reusable context and external tool capabilities use the existing MCP integration/plugin boundary, with catalog choices and user-configured servers. Prefer free built-in/local choices initially. Do not build a parallel memory database, retrieval stack or plugin marketplace. Optional capability failure cannot prevent local task recovery. This is the selected architecture for later knowledge features, not a claim they are implemented; task-local continuity remains MVP scope. See ADR-002.

The following are planned candidates, not MVP commitments or implemented features:

- Reviewed reusable skills after the initial outcomes are reliable.
- Inspectable, editable user memory across tasks; task-local continuity is already MVP scope.
- Scheduled routines and event triggers, including time zones, missed runs and change-only notifications.
- Additional connectors, authorization flows and supported input formats.
- Browser/computer interaction and broader isolation guarantees. The bounded macOS command/Realm lifecycle is implemented and independently tool-tested; [scope and limits](sandbox/OVERVIEW.md). Autonomous provider outcomes remain separate.
- Multiple agent roles, delegated work and concurrent execution.
- Remote channels, cloud execution and work while the local computer is unavailable.
- Artifact version history, collaboration and publishing.
- Broader platform distribution and automatic updates.

## 8. Decisions before implementation

The proposed defaults are individual knowledge work, one agent, one executing task, existing readable inputs and existing interactive surfaces. These remain product decisions for discussion, not evidence of user approval of every feature.

Settle the task-entry and navigation design, draft/update conflict behavior, exact run limits, minimum supported input formats, runtime/data authority and the initial outcome evaluation set before implementation. Show a concrete workspace design covering multiple surfaces, waiting states, recovery and narrow layouts. Keep third-party product names and competitor comparisons out of product and planning documents.

The MVP is complete only when every MVP gate in the checklist has evidence. Passing the existing rendering suite alone does not establish reliable task execution.

### First implementation slice and limits

The initial slice supports manually created tasks, one executing run, persisted input queues, per-run limits, one-time task approvals, explicit user review, safe continuation, multi-surface interaction and scoped deletion. The task journal references the existing canonical conversation; it does not duplicate surfaces. Native responsibilities remain unchanged and no new dependency or native IPC path is introduced.

This is not the complete MVP. Approval waits now yield the execution slot and resume the same call through the dispatcher with fresh authority checks (ADR-008). Typed per-run records retain identity, input identity, timing, tool-call count, stop reason and reviewed/failed/cancelled/interrupted outcomes; schema v5 requires complete run records without compatibility fallbacks (ADR-009). Long-term retention and durable lifetime deduplication are still open, so conservative journal/continuation guards remain. Repeating/event triggers, chains, automatic evidence-based outcome verification, monetary spending controls and complete shared-log retention remain open. Free/local capability choices reuse the existing catalog; configured custom servers require explicit cost/trust review. No additional server is installed automatically.

The implemented timing slice adds the Schedule page with a full-page composer and lifecycle overview/details. Immediate and one-time future runs use the same queue. Timing records persist an instant, display time zone and armed/paused/dispatched status. Upcoming work can pause, resume, change time or run now; controls require the current revision. Past due triggers on startup, or those delayed over a minute during operation, pause for review. Repeating schedules and event/chain triggers are still not supported. See ADR-007.

Local field drafts persist in UI storage, with explicit resolution of conflicting incoming values. Task deletion removes its journal, conversation, raw transcript and local drafts; shared integration logs, numeric usage records, credentials, memory and external files remain. Deletion requires stopped execution, a current revision and additional acknowledgement of uncertain effects.

## 9. Design review

An independent architecture and interaction review on 2026-10-25 confirmed the need to retain one canonical surface store, serialize surface actions, separate execution from navigation, and distinguish live drafts from persisted drafts. Its findings are incorporated into sections 3, 4 and 6. The review also requires independent tool-call limits, durable approval identity and explicit uncertain-effect recovery. This is design review evidence, not implementation approval or outcome validation.


The manual evidence-review slice (ADR-011) replaces one-click completion with a full-page review. User notes and explicit confirmation attach to the latest run and saved surface versions. Task revision and canonical-result fingerprints prevent stale acceptance; no saved assistant output from the latest run means there is nothing to accept. These are structural checks and a user attestation, not automatic proof of source correctness or external effects. Automatic verification and output receipts remain open.


Spending admission (ADR-012) now defaults tasks to a declared local provider on loopback. Model API charges require explicit acknowledgement; selecting a different model clears it. A requested strict monetary ceiling is rejected before admission because the current architecture cannot conservatively enforce one. Finite run caps and local routing are not total-cost guarantees. Task policies are rechecked at dispatch and provider construction; cumulative execution limits are implemented in ADR-013; monetary enforcement remains unimplemented.


Cumulative execution limits (ADR-013) persist across runs and restart: by default 32 runs, 96 generation requests, 96 tool attempts and 30 active minutes. Setup exposes supported finite limits; per-run caps also apply. Reserve before dispatch, count retries, and retain unfinished active-time charges after a crash. Approval/slot waits do not consume active time. Admission reservations are separate from measured FinOps usage and do not imply a monetary ceiling. Long-term retention and execution beyond the bounded task lifetime remain open.


The initial outcome evaluation is repeatable through `scripts/task-evaluate.ts`, with retained real outputs and WebKit inspection described in `EVALUATION.md`. Response-oriented task runs now continue after progress publication via Projection's public opt-in completion API; default projection clients remain unchanged. This mechanism does not establish outcome correctness: current research and comparison trials still fail recorded requirements.

### Result layout enforcement checkpoint (2026-10-26)

Setup offers a flexible workspace, separate editable criteria and comparison, or separate editable criteria and source excerpts. Typed option/source manifests bound the selected layout. Completion checks repair within the same execution budget and retain manual evidence review; arbitrary IDs and all existing interactive surfaces remain supported. Source excerpts match successful current-run tool responses; numeric correctness, interpretation, supplied defaults and general semantic completion remain open. See ADR-015 and EVALUATION.md.


### Rejected-generation recovery checkpoint (2026-10-26)

A tool generation rejected before any usable text/call may retry in the same bounded execution (ADR-016). Attempts re-enter provider admission and consume durable request/time limits; earlier tool receipts remain without runner replay. Partial output, cancellation and unrelated failures stop normally. This is syntax recovery only: independent output authoring, completion evidence and uncertain external-effect reconciliation remain separate gates. No new task, store, process, IPC or dependency is introduced.


### Authoring/data fidelity checkpoint (2026-10-26)

General parser/normalizer repairs and correction guidance come from Projection `ff9bfaa` (ADR-017). Keyless property fragments remain on their node, explicit stringified list bindings retain live references, and bound container shape mismatches are diagnosed. Corrections receive an existing-ID/root inventory and use patches that preserve omitted data. Render replacement and explicit empty arrays remain intentional replacements; no data is silently restored and no supplied facts are rewritten. Real numerical/default/label correctness still requires separate outcome evidence, recorded in EVALUATION.md.


### Review acknowledgement checkpoint (2026-10-26)

Substantive layout/source checks now return a trusted neutral acknowledgement through Projection's additive completion decision (ADR-018). Different model wording alone cannot trigger more work or destructive output rewrites. Unverified final prose stays private; any content/source failure still requires correction, and product acceptance still requires user evidence review. This does not add numerical/default verification or certify arbitrary completion conditions.


### Independent layout and blank-value checkpoint (2026-10-26)

Typed form/table layouts accept ordinary title/layout wrappers while enforcing independent surface identities and roles (ADR-019). Feedback identifies obsolete extra surfaces separately from the outputs to keep. Comparison cells require real visible values or explicit missing-data labels, with field-key mismatches reported rather than guessed. Zero/false remain valid values; missing labels do not certify completion or numerical accuracy. Semantic/default/calculation and full research requirements remain outcome gates.


### Explicit visible-notice checkpoint (2026-10-26)

Checked layouts optionally retain up to eight user-supplied visible notices (120 characters each), configured in setup and shown in task details (ADR-020). Resolved titles/content must display these notices; unused metadata does not count. Labels do not grant authority or certify provenance, numerical correctness or reasoning. The final diagnostic comparison passed numeric/default/layout/notice checks but was manually classified as a failed full outcome because its recommendation contradicted the displayed facts.


### Explicit comparison assertions (2026-10-26)

Checked comparison layouts optionally accept bounded caller-supplied expected rows (ADR-022). Public resolved-table data and existing completion feedback enforce declared visible identities, column sets and exact scalar values/types, without inferring facts or rewriting outputs. Setup/details expose the fixed assertions; form edits do not recompute them. The evaluation independently derives fixture constraint booleans. This is a narrow formal-claim check, not general semantic or source verification; the new live trial fails and P1.9/P4.9 remain open.

### Submitted comparison criteria and complete research contract (2026-10-26)

ADR-023 separates caller-supplied facts from bounded typed calculations and editable submitted criteria. Only the canonical validated criteria-form action revises numeric criteria; facts/formulas remain immutable, local drafts remain local, and stale visible claims are corrected through existing completion feedback. No app renderer recalculates or rewrites model surfaces. Fixed contracts still mean fixed values.

ADR-024 requires research's explanatory answer and explicit limitations beside its quoted evidence table, preserving two independent interactive surfaces. Successful scoped reads produce app-owned retrieval timestamps, persisted with the run and inspectable in details; dates shown by the model must match. Missing reads and unsupported evidence fail checks. Structural checks do not establish interpretation semantics; user review still controls acceptance. Projection PR #2 repairs ancestor layout edges generally; the app consumes the pushed merged pin.

### File snapshots, output receipts and scoped recovery (2026-10-26)

ADR-026 implements bounded user-selected UTF-8 input snapshots and an opt-in app-owned Markdown output destination, preserving the existing interactive multi-surface workspace. Receipts tie saved bytes/hash to task/run and available surface versions; verification and save retry operate through the existing app server without generation or external-operation replay. Missing, changed and stale evidence remain explicit. Live file/folder access continues through configured MCP capabilities, with no parallel plugin or retrieval system.

Task diagnostic retention and deletion now share an explicit scope, while canonical content, numeric telemetry and credentials retain separate owners. Exact uncertain-operation reconciliation records what the user checked, and dispatched uncertainty stops automatic work. This closes the implemented local checkpoint/retention/deletion slice; it is not a guarantee of remote exactly-once writes or automatic interpretation correctness. Broader scenario, accessibility and readiness gates remain in the checklist.


External discovery supplements selectable integrations through the existing capability lifecycle (ADR-027). Browsing grants no task access, installation or activation. Imports stay unverified/off; service charges remain unknown, and task scopes and interactive multiple-surface behavior remain intact. Unsupported runtime/authentication requirements and stale/offline metadata are explicit. Implementation and verification boundaries are in [EXTERNAL-CATALOGS.md](EXTERNAL-CATALOGS.md).

## Executable app runtime boundary (2026-10-28)

The mini-cloud hosts apps with persistent state and ordinary executable behavior, rather than routing every refresh through a chat turn. Draft/source construction and reviewed publication remain distinct from app execution. The app owns records, scheduling and projection commits; the existing sandbox owns contained process lifetime, and existing integrations own external-tool authority. Independent interactive surfaces remain supported. [Current app contract](sandboxed-apps/RUNTIME-CONTRACT.md) and ADR-048 replace earlier warm-daemon/database assumptions. This app-specific cron capability does not certify recurring agent tasks. Model-authoring correctness remains an open gate tracked in the checklist and Evaluation.
