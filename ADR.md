# Architecture decisions

These decisions constrain the agent MVP. Scope: [MVP-SPECS.md](MVP-SPECS.md). Progress: [MVP-CHECKLIST.md](MVP-CHECKLIST.md). No decision authorizes a new dependency or integration installation.

## ADR-001 — One surface authority and minimal runtime boundaries

Date: 2026-10-25. Status: accepted for implementation.

Keep the existing engine/session store as the canonical surface authority. Task records reference session and surface IDs; they do not store parallel renderable artifacts. Conversation, activity and library views reuse the existing interactive surfaces, forms, actions and local controls.

Task policy, journals, queues, budget choices and workspace belong to Vakyartha. Reuse public framework APIs. Add only a demonstrated missing generic mechanism to Projection in its own repository, then consume a pushed pin. The first identified gap is in-process execution independent of HTTP response lifetime, using the host's existing session/store.

Keep orchestration beside that state and use the existing event connection. Native lifecycle and confined platform operations remain in Rust where useful. No native relay for field edits, surface streams or task steps. Any additional IPC or persistence owner must demonstrate a concrete benefit, one writer, explicit recovery semantics and measured overhead. No new storage dependency is selected.

## ADR-002 — Capability plugins through existing integrations

Date: 2026-10-25. Status: accepted direction; capability selection remains explicit.

Use the existing MCP catalog and integration lifecycle as the extension boundary for memory, reusable context and external tools. Users may choose catalog entries or configure their own servers. Do not add a parallel SDK plugin loader, arbitrary UI extensions, a second marketplace or an in-app memory/retrieval database.

Select a capability because a workflow needs its declared contract, not simply because a server exists. Task access is explicit and bounded by configured tool policies. Context returned by a plugin is untrusted data, not system instructions. State where data lives, what leaves the machine, authentication needs, costs, limits and unavailable-service behavior. User-supplied servers remain unverified; custom code is not made safe merely by speaking MCP.

Begin with free built-in and local choices: time, public-page reading, scoped files and persistent memory. Availability does not imply activation. Keep chargeable or account-dependent capabilities out of the default task setup; do not claim a hosted free tier guarantees no future charges. Any additional catalog entry requires source/version/security and cost verification. Installation still follows pinned, script-free framework machinery.

Task continuity is different from reusable knowledge. Execution checkpoints, pending input, approval identity, operation receipts and recovery state stay app-owned and local. They must not depend on an optional memory/context server being reachable. Core rendering, validation and local interactions remain framework primitives, not remote plugin calls.

## ADR-003 — Owned code before added dependencies

Date: 2026-10-25. Status: accepted constraint.

Prefer the existing stack and standard libraries. Build small maintainable capabilities in the owning repository. New SDKs, packages, crates, services and build tools require explicit approval and review of transitive changes, provenance and scripts. Development/testing integrations are assessed separately from shipped integrations and are used only for a concrete benefit. Approval of an integration category is not blanket trust in every implementation.

## ADR-004 — Typed contracts and validated boundaries

Date: 2026-10-25. Status: accepted constraint.

Use explicit domain types and discriminated unions for states, inputs and commands. Keep valid states representable and reject invalid combinations. HTTP, persisted JSON, tool output and native messages enter as `unknown` and are validated before becoming trusted domain values. A cast is not validation. Use typed capability contracts rather than arbitrary property bags in internal logic; unstructured tool data stays confined to the integration boundary.

Version persisted and cross-process contracts, define absence and error semantics, and test malformed, unsupported and stale data. Do not add a schema SDK for this: use small owned validators for the bounded contracts and existing framework validation for surfaces and tools. Avoid duplicate schema authorities across runtimes.

## ADR-005 — Durable tasks, bounded runs, triggers and chains

Date: 2026-10-25. Status: accepted design direction; scheduling and chains are not implemented by the first task slice.

A task's lifetime is distinct from the duration of an execution attempt. The same durable goal may be useful for seconds, days, months or years. A run is a bounded attempt with its own identity, limits, inputs, operation journal and result. A waiting task consumes no model work. Do not leave a model call, worker or timer alive for the lifetime of a long-running goal.

All execution enters one dispatcher with a durable ready queue. An immediate/manual command is a trigger too; a calendar schedule is optional. Scheduled, event-driven and dependency triggers must eventually use that same admission, permission, budget, deduplication and cancellation path. Do not add an independent execution loop for each trigger type.

Before adding schedules, separate task lifecycle, run state and trigger configuration in persisted typed records. Store bounded per-run history separately from task identity, with retention/compaction policies and durable command deduplication. A total lifetime run cap or a single ever-growing conversation/journal is not a long-term scheduling design. The first slice's bounded journal guards are temporary safeguards, not a promise of sustained unattended operation.

Scheduling requires persisted next-due time, a named time zone, recurrence rules, pause/resume, expiry and an explicit missed-run policy. Derive bounded wakeups from durable state; reconcile at startup and after sleep/clock changes. Define daylight-saving behavior and prevent overlapping runs by default. Never replay every missed occurrence automatically. Trigger delivery may repeat; dispatch identity and side-effect reconciliation must make that safe. Local execution requires the app and computer to be available; cloud execution is a separate decision.

Long-lived tasks need cumulative usage limits, recurring-run limits, permission expiry/revalidation, stale-input handling, storage retention and quiet notifications. Old consent does not grant indefinite access. Persistent knowledge uses selected MCP capabilities; task/run recovery cannot depend on them. Provide explicit failure and review states rather than making the model invent unavailable information.

A chain declares dependencies between tasks or steps. Start with explicit sequential handoffs; general graphs and parallel branches require a concrete need. A child becomes eligible only when the parent's required outcome has been verified. Pass typed, versioned artifact/result references and needed inputs, not copies of entire conversations or broadened permission grants. Each step retains interactive surfaces and its own access and execution limits.

Define stop, retry, skip, compensation and partial-success behavior before running a chain. Do not assume external actions are reversible. Cancelling a chain stops future dispatch and reports in-flight/finished effects. Deleting a parent must not silently delete children, shared artifacts or memory: dependencies require an explicit retain, detach or block decision and a minimal reference record where needed.

The first implementation proves the immediate queue, bounded execution and interactive continuity. Durable scheduled triggers, waiting-slot release, segmented run history and dependency-aware deletion are subsequent gates, not features inferred from the presence of a queue.

## ADR-006 — Explicit scoped task deletion

Date: 2026-10-25. Status: accepted for the first slice.

Deleting a task is an explicit user operation with its current revision. Running, queued and approval-waiting work must first be cancelled and settle. Deletion must reject stale state, block concurrent new inputs and require additional acknowledgement before removing uncertain-effect recovery records.

Remove only that task's journal, canonical conversation, raw transcript and local drafts. Do not recursively remove data directories, delete external effects or cascade through shared memory, integrations, credentials or other tasks. Shared integration logs and numeric usage records are retained and disclosed. If any removal fails, show the failure and retain enough identity for an idempotent retry. Full shared-log retention and future chain dependency handling remain separate requirements.

## ADR-007 — Schedule workspace and one-time triggers

Date: 2026-10-26. Status: implemented first timing slice.

Schedule is a permanent sidebar destination with its own overview, full-page composer and lifecycle detail page. Search, status filters, sort, starter ideas, activity and permission requests live here. Results open in the existing conversation/canvas, retaining interactive multi-surface ownership. Page navigation does not cancel work or duplicate the live surfaces. Settings remains the authority for global model and integration configuration; unsaved setup values survive a visit there.

Support immediate execution and a one-time future instant. Store the UTC instant, displayed time zone, armed/paused/dispatched status and missed-run policy as a typed optional trigger on the existing task journal. No new process, native relay or scheduling package is introduced. A bounded wakeup dispatches through the existing queue; it does no model work while waiting. Pause/resume, Run now and time changes require the current task revision. Only pending upcoming/paused work can change timing.

A one-time trigger is not a repeating schedule. On startup, past due work pauses for explicit review. While running, a delay greater than one minute also pauses instead of silently executing stale instructions. Future instants survive restart; queued/in-flight work interrupted by shutdown is still held for review. Cancellation/deletion disarms future work. The local date/time input resolves to an explicit instant shown before saving; changing the computer's time zone does not change that stored instant.

Repeating wall-clock rules, event triggers, chains, lifetime budgets and sustained long-term run history remain separate gates. Do not display nonfunctional recurrence controls. The local app and computer must remain available; this slice neither wakes the computer nor runs in the cloud.


## ADR-008 — Release compute capacity during permission review

Status: accepted, 2026-10-26. Owner: Vakyartha.

A task awaiting approval keeps its existing host call suspended and its task-local abort controller, but releases the single execution slot. Another ready task may run. A permission decision queues a resumption ahead of new admissions; only after it reacquires the slot can the suspended call continue. The original model/tool call is never replayed to resume work. Active-time accounting pauses during both review and slot acquisition.

The local journal records review state before yielding and the decision before resumption. Permission expiry, capability readiness, tool policy and capability revision are checked again at dispatch. Cancellation/shutdown abort all in-flight calls, including suspended calls. Deletion refuses a task until its call has unwound. Recovery after restart remains explicit and never restores permission authority or replays an uncertain operation. This is app scheduling through the existing public host API; no new process, framework contract, native IPC or dependency is required.


## ADR-009 — Typed bounded run records without content duplication

Status: implemented bounded slice, 2026-10-26. Owner: Vakyartha.

Task identity, execution identity and trigger state are distinct. Each admitted attempt receives a run ID, sequence and accepted input identity/kind. Store its start/end timestamps, recorded active milliseconds, tool-call count, stop reason and reviewed/accepted/failed/cancelled/interrupted outcome in the existing task journal. Operations reference their run ID. Schedule detail exposes expandable records alongside the task lifecycle. User acceptance applies to the latest reviewed run; a clean model stop alone never means the task is complete.

Do not copy conversations, surfaces or memory into run records. They continue to reference the canonical session, and historical surface snapshots are not promised. Use one strict schema (task journal version 5), with a complete ordered record for every run. No legacy adapters or migrations are needed before launch. Reject incompatible development journals explicitly; never delete them automatically. An unfinished record recovered after restart is interrupted, with recovery time and an unknown end time. Recovery still does not replay work or retain authority.

This preserves the temporary 32-run task bound, counts queued reservations before accepting inputs, and keeps the existing single journal writer. It does not yet provide sustained retention, lifetime deduplication or recurring execution; P3.10 remains open. Those require a deliberate migration/retention design before removing the lifetime bound. No package, crate, process or IPC path is added.


## ADR-010 — Attribute accounting at task execution admission

Status: implemented, 2026-10-26. Owner: Vakyartha.

The task dispatcher passes typed task/run identity into the existing FinOps observation scope. Provider measurement inherits that identity, including across approval suspension; HTTP bodies and model text cannot assign it. Keep the numeric ledger as the sole usage writer, separate from task journals and canonical content. Schedule reads a narrow run summary on demand; FinOps retains detailed inspection and export. No new process, native IPC, dependency or framework contract is needed.

Unreported/incomplete usage, absent records and missing prices remain unknown. Model API estimates use current configured rates and exclude tool/server charges, compute and hosting. Local API cost can be zero without implying zero total operating cost. Ledger rotation and save failures may make historical usage unavailable. This is attribution and accounting, not enforceable cumulative budgets or a monetary ceiling; those remain separate admission-policy gates.


## ADR-011 — Revision-bound user evidence review

Status: implemented manual-review slice, 2026-10-26. Owner: Vakyartha.

A clean run or rendered interface cannot certify completion. Review opens a full page with criteria, saved surface identities/versions and run-scoped tool-call records. The user inspects the canonical workspace and source receipts, writes an evidence note and explicitly confirms the criteria. Returned tool calls are labelled as responses, not verified external effects; unsubmitted form drafts are excluded.

Acceptance requires a current task revision/run and a fingerprint of the canonical saved timeline and surfaces. Recompute it immediately before acceptance, reject stale/duplicate review, and require a saved assistant result from the latest run. Persist the user's note, review time and evidence references on that run without copying canonical content. The fingerprint detects changes; it is not a truth or authenticity score. Existing surfaces remain interactive after acceptance.

Task schema v5 requires matching review metadata for accepted runs. No backward adapter or automatic development-data deletion is added. Source correctness, automatic criterion verification, output-file receipts and provenance labels remain separate gates (P1.9/P2.7). This uses the public host view API, standard hashing and the existing journal; no new dependency, process or IPC.


## ADR-012 — Explicit model spending admission

Status: implemented, 2026-10-26. Owner: Vakyartha.

Every task persists a typed spending policy. New tasks default to a declared local provider with a loopback endpoint. Provider labels alone are insufficient: validate the endpoint from the public registry settings. Model API charges require an explicit acknowledgement; changing the selected model clears it. Keep the task's provider/model fixed with no fallback. Expose the policy in Schedule details and explain it in settings.

Reject strict monetary-ceiling requests before saving/admitting work because current usage reports and prices cannot conservatively enforce them. Do not equate finite run limits with a dollar guarantee. Local services may have upstream or operating charges; tool/server charges, compute and hosting remain separate. Local-only routing is not a total-cost ceiling.

Revalidate at creation, scheduled dispatch, continuation, tool use and approval resumption. At provider construction, check the task-local execution policy against the same captured environment used to construct the provider, so configuration changes cannot bypass admission. Environment snapshots stay inside the app process and never reach MCP servers. This uses existing public provider APIs, the canonical task journal and in-process execution scope; no new dependency or IPC.

Strict task schema v5 requires this policy, with no compatibility adapter or automatic development-data deletion. Cumulative execution budgets are implemented in ADR-013; actual monetary enforcement remains a future gate.


## ADR-013 — Durable cumulative execution budgets

Status: implemented bounded slice, 2026-10-26. Owner: Vakyartha.

Every task stores finite limits and a reservation ledger for model requests, tool attempts and active time; run records account for the totals. Defaults are 32 runs, 96 model requests, 96 tool attempts and 30 active minutes. Setup can lower or raise them within supported caps (32/384/768/160 minutes). Per-run caps remain 12 generation requests, 24 tool attempts, five active minutes and 4096 requested output tokens per generation. Generation retries count as requests; queued inputs reserve run capacity. Continuations and restart never replenish the ledger. Limits cannot be changed after creation.

Persist model/tool reservations before dispatch. Provider admission precedes usage observation, so refused requests do not become measured model usage. Reserve a run's active-time allowance before execution, settle the unused portion on a known stop, and retain the full unfinished charge after crash recovery. Monotonic active-time accounting excludes approval and execution-slot waits. Check the deadline before new effects as well as using cooperative abort signals. Already dispatched operations may still have external effects; cancellation and reconciliation semantics remain unchanged.

These reservations are admission controls, separate from FinOps measurements and monetary ceilings. Task journals retain a single writer, with no new process, native IPC, framework contract or dependency. Schema v5 validates ledger totals against run records. The temporary 32-run ceiling, long-term retention/deduplication, source verification and repeating execution remain open gates.

## ADR-014 — Evaluate real outcomes and separate publication from run completion

Status: response-completion contract implemented and evaluated, 2026-10-26.

Use the installed local model/settings and existing pinned MCP runtime for opt-in development evaluation. Keep a persistent evaluation workspace at `.vak/evaluations/agent-mvp`, with raw sessions/transcripts and per-run reports for later sessions. The user explicitly authorized using or altering the dev setup; do not repeat that approval request. No paid model run, MCP reinstall or channel restart is needed. Machine checks exclude user instructions from result evidence and distinguish separate surfaces from nested sections; a candidate pass still needs semantic/interaction review.

The primary-local-model baseline fetched and cited both requested public sources and completed an approved Memory write/read-back with an independently persisted marker. It still combined requested interfaces or substituted components, so those outcome gates fail. The existing host ends a run after a clean projection; app composition cannot continue that same model/tool call stack through its public API. Do not split surfaces, synthesize extra tasks or send repeated chat requests to hide the failure.

Add a minimal general response-completion option in Projection's own repository: defaults retain projection-oriented behavior; opt-in tool runs may publish progress and continue until the model responds without tool calls, or a bound/error/abort stops them. This ends a run, not the product task. Product acceptance remains the separate evidence-bound user review. Re-evaluate the actual local model after adopting the pushed public API; do not mark interface correctness solved merely by adding the mechanism.

Projection `dbae5c2` implements the public option and passes 238 tests. Local trials show it permits additional publications and tool steps, while research and comparison still fail recorded requirements; see EVALUATION.md. The app enables the option only for task runs and retains explicit evidence-bound acceptance.

## ADR-015 — Typed result layouts and bounded completion checks

Status: implemented enforcement slice, 2026-10-26; real-output reliability remains open.

A task may choose a flexible workspace, a comparison with declared option names, or source excerpts with declared public HTTPS URLs. The latter two require separate form/table surfaces, preserving the canonical interactive workspace; the initial root-only restriction is superseded by ADR-019. Surface IDs remain author choices. Comparison checks visible option identities; it does not certify numeric accuracy or inferred recommendations. Source-excerpt rows contain only source and quote; whitespace-normalized excerpts must match a successful page-tool response in the same execution, and cover declared/read pages. A matched excerpt establishes response provenance, not independent truth or correctness of an inference. Supplied form defaults and arbitrary semantic completion criteria still need review.

Use Projection's public `validateCompletion` callback to return concrete failures into the same bounded run. With a callback, rejected/intermediate prose stays out of the public response; accepted completion uses a neutral acknowledgement. Corrections consume existing model/time budgets and never create hidden tasks or grant tool permissions. A clean check ends execution at user review; it never accepts the task automatically. Surfaces can still show partial work while running or after failure.

Projection owns the general callback and a successful-transport-result observer. Vakyartha owns result policy, source scope and checks. Observe only the current task's successful Web pages responses in process; retain at most eight clipped responses for the active execution, with no new database, process, IPC or dependency. Tool text stays untrusted data. Missing, denied, failed, other-session or aborted reads are not evidence. Declared source scope is checked before tool dispatch. Repeating a run requires fresh source evidence. Flexible tasks retain the existing behavior.

The optional typed policy is saved in the existing task journal and shown on setup/detail pages. UI manifests are bounded and required for the selected layout; Web pages must be explicitly selected for research. This is an opt-in product choice, with no schema conversion or data deletion. Projection `b519afc` supplies the pushed public mechanisms. Tests cover same-run repair and suppressed rejected prose, separate surfaces with arbitrary IDs, visible identities, missing reads, invented quotes, unsupported columns and malformed manifests. Local-model diagnostics and remaining failures belong in EVALUATION.md; this ADR does not close the automatic semantic-verification gate.


## ADR-016 — Bounded recovery from rejected tool generation

Status: implemented, 2026-10-26. Framework mechanism: Projection `399a3a9`; task policy and durable budgets remain here.

The public host already supports bounded execution, response completion and application checks. A retained real-model comparison nevertheless stopped on a provider-side tool-syntax rejection before delivering a usable call. App composition cannot resume that same host run through the existing API or safely distinguish a rejected generation from an uncertain tool effect. Repeated chat requests would bypass the run contract.

Projection adds a public `ToolGenerationError` classification and handles it in the existing tool loop. Only a rejection before any text or tool call may retry; the provider adapter performs no hidden retry. Each attempt re-enters the same provider wrapper and consumes the existing run/request/time allowance. Earlier operations and receipts remain in history without being replayed by the runner. Cancellation, partial streams and unrelated errors retain their prior behavior. Existing projection and response completion policies remain available; no app surface rewriting, process, IPC or dependency is added.

Vakyartha keeps its existing reservation writer and records rejected attempts against cumulative request limits. `test/task-budget.test.ts` verifies exhaustion and persisted counters after restart; the framework tests cover the exact rejected generation, classification, partial output, cancellation, step exhaustion and preserved tool receipts. Missing token measurements remain unknown. The recovery mechanism does not verify outputs or make retries of uncertain external writes safe; P1.6/P1.9/P3.4/P4.7 remain open. Real outcomes and the next authoring work are recorded in EVALUATION.md.


## ADR-017 — Repair authoring syntax without rewriting facts or replacement intent

Status: framework repairs adopted, 2026-10-26. Projection `ff9bfaa` (implementation `5ea729a`, strict regression-test fix `ff9bfaa`).

The public host already owns bounded execution, canonical surfaces, completion checks and correction feedback. The latest retained comparison demonstrates malformed keyless property groups becoming extra inputs, a stringified explicit list binding losing its pointer during JSON coercion, and replacements sending empty data. These are parser/normalizer/authoring responsibilities. App composition cannot safely repair them without rewriting canonical surfaces; no new app store or host API is needed.

Projection replays the verbatim fictional calls, repairs only syntax established by structure/schema, and retains live list bindings. Keyless groups require an extra containing closer, an object-valued prior member and noncolliding keys; normal anonymous/sibling nodes stay separate. Exact explicit bracket-wrapped bindings normalize only on array/binding props. Literal source/cell arrays remain unchanged. Bound container shape mismatches are diagnosed without rejecting harmless numeric formatting within actual lists.

Guidance initializes supplied controls at their exact data bind paths, preserves numbers/units/requested labels and uses distinct calls for independent outputs. Corrections receive a bounded existing-surface ID/root inventory and use patches; complete render replacement and explicit empty arrays keep their existing meaning. Do not silently restore deleted data, infer missing facts/defaults, rescale numeric values or synthesize extra app surfaces. Unit replays deliberately retain the recorded wrong numbers so a rendering repair cannot masquerade as factual verification.

No new public signatures, dependencies, IPC or permissions. Raw comparison/research trials and remaining limitations are recorded in EVALUATION.md. Structural authoring regression success does not close semantic completion, provenance, saved-output receipt, recovery/retention or installed-window gates.


## ADR-018 — Neutral review acknowledgement without wording-only retries

Status: implemented, 2026-10-26. Projection `9d44982` includes the additive mechanism introduced in `0b8bee3`.

The `ff9bfaa` comparison trial twice passed the structural checks but failed only because its final sentence was not exactly the requested acknowledgement. That stylistic failure consumed generation budget and later rewrites dropped requested columns. The app must withhold unverified final prose without asking a model to rewrite correct surfaces just to change a sentence.

The existing public completion callback could reject output but could not supply accepted UI prose. Projection therefore allows the existing issue array or `{issues, response?}`. A trusted callback can substitute a neutral acknowledgement only after its substantive checks pass; invalid decisions and any issues still withhold final text. Existing array callbacks remain compatible. Original provider prose stays diagnostic conversation/transcript data; only the supplied acknowledgement is emitted. No extra model invocation, persistence authority, process, IPC or dependency.

The app's `reviewTaskResult` returns its existing structure/source issues plus `Ready for review.`; wording is no longer an acceptance condition. Permission and source scope, structural checks, budget limits and the separate evidence-bound user acceptance remain unchanged. This does not extend the checker to numeric calculations, supplied defaults or arbitrary semantic completion. Regression tests cover one-request review without leaked provider claims, rejected/malformed decisions and continued source-check enforcement. Local outcomes and remaining limits are in EVALUATION.md.


## ADR-019 — Independent output roles, explicit blanks and precise surplus cleanup

Status: implemented, 2026-10-26. Owner: Vakyartha; existing public surface snapshots/resolved trees are sufficient.

Real comparison corrections retained separate interactive surfaces, but a layout wrapped around the comparison table failed the initial root-only policy. The user-visible requirement is independent form/table surfaces, not a specific layout root. Accept one form with no table on one surface, and one table with no form on another; title/layout wrappers are allowed. Combined surfaces, ambiguous multiple roles and surplus outputs still fail. When valid independent outputs coexist with an obsolete combined attempt, feedback names the kept IDs and the exact obsolete surface-removal arguments. Removal remains a model-authored surface operation, not automatic app rewriting or authority over external data.

The same report had a displayed `monthly_cost` column with only `cost` in each row and blank recommendations. Comparison checks now report blank displayed cells with column names and available row fields; known values or explicit missing-data labels are required. Zero/false remain actual values. The checker never guesses a renamed field, computes missing numbers, copies unused values into a surface, or treats a missing-data label as proof of completeness. Evaluation still checks requested associated numeric values separately; arithmetic, supplied defaults and arbitrary criteria remain open.

No framework API change beyond ADR-018, no new store, dependency, IPC or permission. Unit regressions cover layout wrappers, mixed-role refusal, exact surplus cleanup, blank-cell/key mismatch feedback and missing/zero/false values. Manual evidence review still determines product acceptance.


## ADR-020 — Explicit visible notices in the existing result manifest

Status: implemented, 2026-10-26. Owner: Vakyartha.

A comparison retained correct associated numbers/defaults and independent surfaces but omitted the requested fictional-data label. Add an optional `notices` array to the existing result policy: up to eight user-supplied nonempty labels of at most 120 characters. Setup exposes the field for checked layouts, persists it with the task and shows it in details. Flexible work ignores this checked-layout field. No journal-version migration is needed for the optional additive field.

Instructions copy notices into visible surface titles/content. Completion checks match normalized, case-insensitive whole phrases in resolved text; unused or hidden data and larger negated word fragments do not count. A failed notice returns concrete feedback into the same budget. No app renderer inserts or edits the generated surface, and no notice grants tools, establishes source provenance or proves semantic correctness. The evaluation explicitly supplies `Fictional` for its fictional fixture rather than inferring it from arbitrary prose. Numeric/default/recommendation checks remain separate; in particular, the latest machine candidate is overturned because its recommendation contradicts its correct numbers (EVALUATION.md).

Boundary/unit tests cover bounds, deduplication, both policies, visible vs unused data and word boundaries. Wide/narrow WebKit checks cover the field, flexible-layout hiding, persisted scheduled-task notices/details and existing interaction paths. No dependency, IPC or new persistence writer.


## ADR-021 — Conservative evaluation verdicts and independent constraint references

Status: implemented evaluation slice, 2026-10-26. Owner: Vakyartha's development evaluation; product execution/acceptance unchanged.

Automated layout/numeric checks cannot certify arbitrary recommendation prose. Replace evaluation `candidate-pass` with `needs-semantic-review` when checks pass, retaining `failed` otherwise. Compute row-local reference facts from a single typed fixture, beside canonical visible output, without guessing what prose means or rewriting it. Historical/manual failure evidence remains authoritative. Public resolution APIs suffice; no framework, dependency or persistence authority is added. Tests reproduce the retained contradictory Atlas row and exclude hidden/orphan/unused data. Automatic semantic verification and product acceptance remain separate open gates.
