# Continue from this checkpoint

Updated 2026-10-30. This handoff supersedes the earlier assumption that the decision/product features were absent from the runtime worktree.

## Location and source ownership

- **Use** `/Users/nisheethranjan/Projects/vakyartha-agent-runtime`, branch `codex/agent-runtime-implementation`. Always give shell calls this workdir and `login:false`.
- Original `/Users/nisheethranjan/Projects/vakyartha` stays on `main`; do not switch, reset or edit it. Product main through **`d8a2955a1025886825ed8ff4e898e6929cb67d4e`** is reconciled into the runtime branch, including the latest Voice Desk, dictation and app-update changes. Check for newer committed main work before assuming this snapshot is current; preserve other work.
- Runtime `ab25c07` is the native-supervisor checkpoint; `bc59bcf` is the source audit; `cec94cc` reconciles product through `625787d`. The subsequent merge includes `d8a2955` plus the corrections below. Read `git log` for the final saved merge hash.
- Framework pin **`196b7967c381023c02156e63c806dc86ba746ede`** includes native transport/candidate/session API work and the newer diagram renderer. Never edit `framework/`; framework changes belong in `~/Projects/vakProjection`, then push and move the pin.
- Reviewed helper: `~/Projects/sandbox`, clean pin **`19c493dc7f619ec772c99a5f6f397a4a71888f61`**. Containment changes belong there, not in an app shim.
- Node **26.13.0** is available at `/tmp/vak-node26.13.0/node-v26.13.0-darwin-arm64/bin`; Rust **1.99.1**. Keep the newest verified official LTS/stable stack and exact pins. No new dependency without approval. Existing approved crates: `reqwest =0.13.5`, `sha2 =0.11.1`.

## What is actually done

Read [code audit](CODE-STATUS-AUDIT.md), [implementation progress](IMPLEMENTATION-PROGRESS.md), [delivery plan](DELIVERY-PLAN.md) and [task contract](../AGENT-TASKS.md). Existing code must be reused, not rebuilt.

- Native actor/store schema 20, task metadata/controls, registry/folder primitives, root/child domain state, exact-byte consent and trusted UI, native vault/broker, cancellable streamed I/O with exact ACKs, separate contained reasoner/canonical entries and private cleanup evidence, candidate/publication receipts and restart fencing.
- A packaged-worker fixture carries consent through real synthetic HTTP, cleanup, canonical publication and root settlement. It leaves original-outcome requirements pending. Its task admission is explicitly test-only; it is not a user-started task or real model outcome.
- Product decision/shaping/chaining APIs, Skills/cache/defaults, caching visibility, diagrams, voice and executable apps are now present in this branch. Existing TypeScript task code already contains scheduling, permissions, continuation, review and output receipts; browser mode still uses it. Desktop uses native task metadata and refuses its sidecar task routes.
- New app-update UI is preserved, with automatic startup replacement removed and mandatory package/revision/candidate review restored. Drafts take precedence; running/uncertain work and unsaved UI edits block update. Source/permission inspection and cancel/accept are tested. State remains saved, views rebuild, scheduling pauses. The app registry remains a TypeScript owner pending common native mediation.
- Native supervisor invariants: one process launch object, process capacity released only by protected cleanup; root orchestration stays charged through canonical work. Proven no-spawn releases both holds. Restart uncertainty retains holds. Human wait and active work use separate absolute deadlines; buffered consent is closed through an actor barrier and recovered as unsent where provable. Charges are not refunded.

## Immediate implementation frontier

**Product Work execution is still disabled.** Startup uses `CapacityProfile::unconfigured()`. Do not just enable that profile or remove refusal guards.

1. `src-tauri/src/control/tasks.rs` exposes create/list/read/cancel/remove only; its DTO rejects `runs_started != 0`. Generic root mutation refuses native product tasks. `PrepareProductFixture` is `cfg(test)`. Implement real trusted native admission, lifecycle/status/run DTOs, cancellation and recovery. Separate observation revisions from authority fences so progress/consent polling does not invalidate legitimate I/O.
2. Connect those controls to existing `reasoner_supervisor::run`, native consent/I/O, `commit_candidate`, `canonical_supervisor::run`, publication acknowledgement and `settle_worker_completion`. Publication/cleanup do not complete a task. Preserve mandatory current evidence and revision-bound user review. Reuse task output/continuation semantics through their correct native owners.
3. Build explicit snapshots using existing context/Skills/decision capabilities. The reasoner currently receives supplied instructions/files/surfaces, offers `tools: []`, and has no selected-skill/tool/continuation adapter. Native state selects original goal/criteria/model/output cap and checks original files. Never grant app stores/environment, credentials or authority with a context snapshot.
4. Decision source is present but partially wired: chat forwards selected history/budgets/reasoning, not filtered tools/grammar; it omits history from the shaper input; message-only hook does not cover all actions/continuations/background work. Hosted shaper instances lack a configured native credential resolver. Chaining and decision usage have no automatic task/FinOps consumer. Reuse the existing capability with native mediation and finite bounds. Scores never authorize actions or replace independent source evidence.
5. Human wait still retains the root orchestration slot, and active time is not yet cumulative across attempts. Fix that deliberately with scheduler/resource ownership; do not release unknown process/I/O holds. Hard CPU/memory/PID/disk limits are not implemented; helper backends refuse requested resource-limit policies. Logical counts are not OS quotas.

Broader remaining gates: common admission for chat/tasks/apps/integrations and hosted spending/usage attribution; native workspace/IA writer cutover; evidence/drift/bounded correction/reconciliation; fair queues/pressure/observability; actual child launch/yield/join/cancel and measured adaptive benefit; original real-provider outcomes; Linux packaging/Windows durability; installed proof; final Astra review. Domain/guard code exists for many of these. No blanket subagent default, parallel memory store, duplicate writer or compatibility layer.

## Verification and retained evidence

- Latest full app run: **325 pass, 1 explicitly skipped paid test**, no failures. `/tmp/vak-main-latest-app-all.log`.
- Latest typecheck/UI build/runtime bundle: `/tmp/vak-main-latest-{types,build,bundle}.log`.
- Latest Apps WebKit adds exact update review/cancel/accept/state preservation at 1100/620/375: `/tmp/vak-main-latest-apps-ui.log`, receipt `vak-app-webkit-uE759b`.
- Latest collections/Canvas: `/tmp/vak-main-latest-{collections,canvas}.log`; Canvas receipt `vak-canvas-check-D7Ozs9`.
- Fresh native desktop: `/tmp/vak-main-latest-desktop.log`, receipt `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-desktop-private-pjJazi`.
- Same framework/native source pins: **423 framework, 151 macOS/153 Linux native tests**, all seven real-worker gates and strict Clippy passed before the app-only follow-up. Logs `/tmp/vak-main-integration-{framework,rust,clippy,linux}.log`. Skills/surfaces/controls WebKit also passed; see progress.
- Retain earlier merge/fixture failures. Collection expected four apps instead of five and then used a shortened Voice Desk name; Canvas assumed immediate mock stream creation before decision preparation. Checks were corrected for the new contract, not relaxed. The reference-app test was updated to submit exact reviewed fingerprints while preserving its saved-note assertion.
- Do not run `desktop-check.ts`/bundling while Rust tests read `src-tauri/resources`: rebuilds temporarily remove those files. Bundle first, then tests; desktop smoke afterward.
- Native tests with real workers use `VAK_TEST_WORKER_HELPER=/Users/nisheethranjan/Projects/sandbox/target/debug/vaksb`, `VAK_TEST_WORKER_NODE=/tmp/vak-node26.13.0/node-v26.13.0-darwin-arm64/bin/node`, `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored --test-threads=1`. Linux: `sh scripts/linux-worker-check.sh`.
- No real primary-local task outcome, new installed app or release is claimed. Earlier original source/value/interpretation/interaction/output failures stay open. Freeze checks; run the smallest matching primary-provider gate in Projection before broad workflows; diagnose the first failure offline rather than cycling prompts.

## Model permission

User permits free local Ollama and, if needed, the installed OpenAI key with **Luna**, asking to be generous. Release history records `openai/gpt-6-luna`; verify the exact currently available model before a paid call. Never print/read out key values or silently use another paid model. No paid call or key lookup occurred in this continuation. Default paid decision testing now requires `VAK_TEST_PAID_DECISION=1` and an exact `VAK_TEST_DECISION_MODEL`; it must fail for missing credentials or heuristic fallback. Do not enable it during routine tests. Astra is only for final third-party review, never development; do not spawn development subagents.

## Copyable continuation prompt

Continue implementation in `/Users/nisheethranjan/Projects/vakyartha-agent-runtime` on `codex/agent-runtime-implementation`. Read `AGENTS.md`, `docs/HANDOVER.md`, `docs/agent-runtime/NEXT-SESSION.md` and the code-status audit before changing code. Main through `d8a2955` is integrated; preserve all native runtime and newer product features. Leave the original main checkout and unrelated work untouched. Verify the current branch/source before assuming any remaining item is absent.

Implement the next real user-started single-agent Work path using the existing native actor, reasoner, consent/I/O and canonical supervisor, plus existing task/context/Skills/decision capabilities. Finish native admission/lifecycle/status, publication acknowledgement, cancellation/recovery, current evidence/review and output/continuation integration. Do not merely enable the empty profile, relax fences, use test-only admission, or rebuild existing components. Preserve multiple interactive surfaces, original inputs and unsaved drafts; keep one writer per entity and no ambient worker authority. Fix failures at the owning boundary.

Use free Ollama first; Luna with the installed key is authorized if needed, after verifying its exact ID, without exposing secrets or choosing another paid model. No new dependencies without approval; no development subagents or Astra development. Prove the smallest real primary-provider contract and original checks before expanding workflows. Keep failed evidence and broader open gates honest, run appropriate checks, update handover/status, and commit/push clean logical checkpoints after the required secret scan.
