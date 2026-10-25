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

Do not copy conversations, surfaces or memory into run records. They continue to reference the canonical session, and historical surface snapshots are not promised. Use one strict schema (task journal version 4), with a complete ordered record for every run. No legacy adapters or migrations are needed before launch. Reject incompatible development journals explicitly; never delete them automatically. An unfinished record recovered after restart is interrupted, with recovery time and an unknown end time. Recovery still does not replay work or retain authority.

This preserves the temporary 32-run task bound, counts queued reservations before accepting inputs, and keeps the existing single journal writer. It does not yet provide sustained retention, lifetime deduplication or recurring execution; P3.10 remains open. Those require a deliberate migration/retention design before removing the lifetime bound. No package, crate, process or IPC path is added.


## ADR-010 — Attribute accounting at task execution admission

Status: implemented, 2026-10-26. Owner: Vakyartha.

The task dispatcher passes typed task/run identity into the existing FinOps observation scope. Provider measurement inherits that identity, including across approval suspension; HTTP bodies and model text cannot assign it. Keep the numeric ledger as the sole usage writer, separate from task journals and canonical content. Schedule reads a narrow run summary on demand; FinOps retains detailed inspection and export. No new process, native IPC, dependency or framework contract is needed.

Unreported/incomplete usage, absent records and missing prices remain unknown. Model API estimates use current configured rates and exclude tool/server charges, compute and hosting. Local API cost can be zero without implying zero total operating cost. Ledger rotation and save failures may make historical usage unavailable. This is attribution and accounting, not enforceable cumulative budgets or a monetary ceiling; those remain separate admission-policy gates.


## ADR-011 — Revision-bound user evidence review

Status: implemented manual-review slice, 2026-10-26. Owner: Vakyartha.

A clean run or rendered interface cannot certify completion. Review opens a full page with criteria, saved surface identities/versions and run-scoped tool-call records. The user inspects the canonical workspace and source receipts, writes an evidence note and explicitly confirms the criteria. Returned tool calls are labelled as responses, not verified external effects; unsubmitted form drafts are excluded.

Acceptance requires a current task revision/run and a fingerprint of the canonical saved timeline and surfaces. Recompute it immediately before acceptance, reject stale/duplicate review, and require a saved assistant result from the latest run. Persist the user's note, review time and evidence references on that run without copying canonical content. The fingerprint detects changes; it is not a truth or authenticity score. Existing surfaces remain interactive after acceptance.

Task schema v4 requires matching review metadata for accepted runs. No backward adapter or automatic development-data deletion is added. Source correctness, automatic criterion verification, output-file receipts and provenance labels remain separate gates (P1.9/P2.7). This uses the public host view API, standard hashing and the existing journal; no new dependency, process or IPC.


## ADR-012 — Explicit model spending admission

Status: implemented, 2026-10-26. Owner: Vakyartha.

Every task persists a typed spending policy. New tasks default to a declared local provider with a loopback endpoint. Provider labels alone are insufficient: validate the endpoint from the public registry settings. Model API charges require an explicit acknowledgement; changing the selected model clears it. Keep the task's provider/model fixed with no fallback. Expose the policy in Schedule details and explain it in settings.

Reject strict monetary-ceiling requests before saving/admitting work because current usage reports and prices cannot conservatively enforce them. Do not equate finite run limits with a dollar guarantee. Local services may have upstream or operating charges; tool/server charges, compute and hosting remain separate. Local-only routing is not a total-cost ceiling.

Revalidate at creation, scheduled dispatch, continuation, tool use and approval resumption. At provider construction, check the task-local execution policy against the same captured environment used to construct the provider, so configuration changes cannot bypass admission. Environment snapshots stay inside the app process and never reach MCP servers. This uses existing public provider APIs, the canonical task journal and in-process execution scope; no new dependency or IPC.

Strict task schema v4 requires this policy, with no compatibility adapter or automatic development-data deletion. Cumulative budgets and actual monetary enforcement remain future gates.
