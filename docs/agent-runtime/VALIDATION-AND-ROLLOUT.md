# Validation, open decisions and rollout

Status: proposed, 2026-10-29. Documentation completion is separate from implementation, security acceptance and user-outcome acceptance. Track implementation in [MVP-CHECKLIST.md](../MVP-CHECKLIST.md); keep receipts and failed evidence in [EVALUATION.md](../EVALUATION.md) and current state in [HANDOVER.md](../HANDOVER.md).

## 1. Decisions required before implementation

| Gate | Decision / proof required | Owner |
| --- | --- | --- |
| AR-01 | Confirm proposed modes, one-level/four-child envelope and task classes eligible for adaptive delegation | Product policy |
| AR-02 | Specify one native execution-control aggregate, writer, persistence transactions, startup recovery and cutover from current task writer | App native/task owners |
| AR-03 | Inventory existing public host/session/provider/MCP APIs; identify exact missing isolation, candidate-commit and cancellation seams | App and Projection in its owning repo |
| AR-04 | Freeze units and values for root/attempt requests, tools, children, active work, deadline, waits, retries, context, output and queue bounds | Product policy and scheduler |
| AR-05 | Specify registered verifier identity, protected fixtures, receipts, semantic unknown handling and user-review boundary | Task/evidence owners |
| AR-06 | Freeze representative tasks, required outcomes, sources, forbidden effects, hardware and comparative budgets | Evaluation owner |
| AR-07 | Prove required isolation and broker paths, including non-bypassable dispatch and descendants | Native, sandbox and transport owners |
| AR-08 | Map proposed child/stop states onto one typed lifecycle and all existing interactive continuations | App task/UI owners |

No unchecked gate authorizes a new dependency, paid inference, release, installation or framework edit in the pinned checkout. Do not paper over an ownership conflict with a second writer or broad native command.

## 2. Mechanism and failure matrix

| Scenario | Required independent observation |
| --- | --- |
| Ordinary single-agent task | Zero children; original tools and multiple interactive outputs continue to work |
| Tool-sufficient task | No required delegation; deterministic result satisfies original outcome |
| Separate bounded investigation | Child receives only relevant admitted inputs; parent checks/integrates evidence |
| Duplicate creation and concurrent admission | One logical child per request identity; conflicting reuse rejected; root reservations never oversubscribe |
| Depth/count/provider pressure | Refusal or bounded queue; no recursive spawn, hidden paid escalation or starvation |
| Cyclic dependency or parent holding slot | Cycle refused; waiting parent releases capacity; child can run on one slot |
| Forged identity/scope/consent | Synthetic compromised worker cannot obtain credentials, dispatch outside scope, or impersonate another task |
| Direct bypass | Native file/signal/network/runtime-launch canaries fail while admitted work succeeds |
| Permission/criteria revision during wait | Old operation and candidate refused; affected evidence invalidated |
| Candidate modifies checker/expected values | Protected verifier inputs unchanged; candidate cannot manufacture a passing receipt |
| Child reports success without evidence | Root remains unverified; no successful completion transition |
| Repeated failure and plan churn | Bounded diagnosis, retained earliest-boundary evidence, explicit stalled/failed result |
| Legitimate exploration and alternative valid path | Detector does not require one fixed tool sequence; false alarm measured |
| Mid-operation cancellation, including every descendant | Durable fence blocks new admission; already dispatched effects and actual cleanup reported |
| Crash before/after each reservation, launch, dispatch, receipt and commit | Recoverable state or exact uncertainty; no silent replay or refunded unknown usage |
| Late/stale child and duplicate/reordered events | Stale commits fenced; cursor/dedup recovers canonical state without duplicate effects |
| External timeout and idempotent retry | Correct logical identity; reconcile uncertain non-idempotent effects; test with local synthetic service |
| Concurrent project edits and combined candidates | Isolation, conflict refusal, reviewed promotion and combined outcome tests |
| Partial results and optional children | Mandatory failure remains open; unused children retired before root completion |
| Retention, deletion and output save retry | Scope matches UI; shared records retained explicitly; save retry causes no model/tool replay |
| Control-plane overload and malformed protocol | Queues/frame limits enforced; controls/terminal events survive progress saturation |
| Resource and platform enforcement | Native CPU/touched-memory/descendant tests and unsupported-mode refusal; no inference-based quota claim |
| Existing interactive behavior | Wide/narrow actual WebKit, independent surfaces, drafts, local filtering/paging and voice/action equivalence |

Use synthetic credentials, temporary projects and local endpoints for fault/security tests. Do not expose live secrets or spend on hosted inference to prove deterministic mechanisms. Do not count safe refusal as completion of the intended user task.

## 3. Prove the outcome, not just the mechanism

```mermaid
flowchart TD
    F[Freeze task contract and independent checks] --> M[Deterministic scripted-worker and fault tests]
    M --> I[Required broker and isolation gates]
    I --> P[Smallest real primary-local contract]
    P --> O[Original source, value, interpretation, interaction and output checks]
    O --> B[Compare one agent, tools, serial children and bounded parallel work]
    B --> G{Benefit with acceptable failure and overhead?}
    G -->|Yes for specific class| ENABLE[Explicit bounded rollout for that class]
    G -->|No or unknown| KEEP[Keep delegation disabled or restricted]
```

Start with one child returning a small version-bound result through the actual proposed path. Establish dispatch, evidence and checking before a broader workflow. Then run the original requested outcome with independent source/value/interpretation/action/output checks. Preserve every failed receipt and diagnose the earliest boundary offline before changing prompts/parsers or accumulating variants.

When output authoring is involved, run the matching primary-provider gate in Projection's owning repo: `node scripts/record-view-check.ts --run-local --table-only` for record mappings, or `node scripts/provider-contract-check.ts --run-local` for free-form graph authoring. Source-backed tasks retain independent source/value/receipt checks. Passing one gate does not close failures in another capability.

Compare the same task/input/provider versions across: one agent plus tools; deterministic workflow where applicable; serial children; bounded parallel children only where supported. Use comparable total budgets and report actual extra compute, context duplication, checking/merge effort and wall time. Record both constrained-budget results and any separately labelled larger-budget experiment. Repeat frozen trials enough to expose variability, with the sample plan chosen before observing results.

Metrics: original outcome pass rate, false completion, unsafe dispatch, detector false positives/missed drift, child acceptance/usefulness, redundant/unused output, total requests/tokens/tool attempts, queue/active/wait/merge time, measured resource use and recovery success. Report uncertainty and missing measurements. A different provider or extra budget cannot silently substitute for primary-local acceptance.

## 4. Incremental delivery

1. **Documentation and review:** complete this package, independent architecture review and explicit unresolved decisions. No runtime claim.
2. **Control proof:** implement AR-02/03/04/05 with scripted workers, one writer and fault injection; satisfy applicable isolation gates. No adaptive model delegation enabled.
3. **Single-agent parity:** route existing bounded tasks through the target authority boundary, preserving interactions and original outcome checks.
4. **One child:** prove the smallest primary-local contract with shared limits, explicit evidence, cancellation and restart.
5. **Bounded adaptive classes:** enable only after comparative benefit and failure evidence; keep one local generation initially.
6. **Concurrent or effectful children:** separate gates for provider capacity, branch dependencies, exact approvals, resource enforcement, combined commits and uncertain effects.
7. **Installed verification:** prove the exact app/framework/helper build and native WebKit behavior. Installation does not close failed outcome gates.

If evaluation shows unnecessary delegation, restrict eligible policy rather than rewarding child count. Runtime/model/skill changes trigger regression scenarios for both single-agent and delegated work. Do not automatically raise allowances or weaken acceptance after a regression.

## 5. Review checklist

- Can a fully compromised reasoning worker bypass native authority, overwrite control state or fabricate consent/check receipts?
- Is every durable entity assigned one writer, including the ownership cutover and cross-entity crash boundaries?
- Can a parent waiting for children deadlock a single-slot dispatcher?
- Do descendants, retries, verification and synthesis share one durable root allowance?
- Can cancellation, permission changes or revised criteria race with dispatch/commit?
- Does any success predicate accept mandatory unknowns, stale evidence, missing delivery or uncertain effects?
- Does drift detection penalize a valid alternative approach, or confuse activity with evidence?
- Can loss of optional memory, a channel or a child prevent safe local recovery?
- Are target controls, inspected foundations, installed behavior and proposed defaults clearly separated?
- Do source-backed original outcomes remain open until independently proved?
