# Root corrections and removal map

Status: source-inspected design input, 2026-10-29. No runtime code was changed or security exploit attempted by this documentation task. These observations identify why the [implementation design](IMPLEMENTATION-DESIGN.md) changes ownership; they do not certify all other code as correct. Current source may advance independently, so verify exact interfaces before implementing.

## 1. Correct the authority boundary, not its symptoms

| Observation in current source | Root issue | Target correction and removal |
| --- | --- | --- |
| `sidecar/server.ts` constructs `keychainStore`/`fileSecrets` and passes the secret store into integrations | Native vault APIs coexist with a credential-capable execution process | Move stored-secret reads and authorized insertion to native mediation; remove desktop worker secret-store construction/direct retrieval |
| `src-tauri/src/lib.rs` exposes `vault_get`; `src/backend.ts` exposes `vaultGet` | Stored secrets can be returned to UI code instead of used inside the broker | Remove general secret retrieval from runtime/UI commands; retain trusted user write/delete and non-secret configured/test metadata |
| `sidecar/egress.ts` has a TS allowlist/fetch wrapper beside native `policy.rs` | Duplicated policy can diverge; wrapping fetch cannot constrain a compromised process or another network API | Native configured policy is sole authority; enforce direct-network denial with sandboxing, then remove the TS safety mirror |
| `check_egress_endpoint` accepts caller-provided custom host lists | A per-request check is not a trusted endpoint-configuration decision | Only an admitted native settings/approval transaction changes endpoint exceptions; dispatch requests cannot author their own exceptions |
| `sidecar/tasks.ts` owns journal writes, queue, reservations, approvals and completion state | Security-critical task control lives in the runtime-flexible worker | Replace that control path with native state/scheduler/store; keep thin TS framework execution and semantic adapters |
| `SandboxPoolManager` has an independent queue/active limit | Task/app queues can individually pass while aggregate machine capacity is exhausted | Native common capacity allocator grants leases; pool adapter retains only app-specific invocation behavior |
| Framework `host.run` performs model execution on canonical session/store and offers in-process checks; `sessionsDir` selects host-managed disk persistence | Merely moving the task queue to Rust does not separate candidate processing from protected canonical commits/persistence | Prove exported candidate/prepare/fence and native-injected persistence seams; retain framework semantic ownership and one native durable writer without copying internal session code |
| Desktop request bridge forwards broad app routes to one sidecar | Presentation routing is not a worker capability protocol | Route authoritative operations to native typed commands and give workers only invocation-bound operation families |
| Native endpoint/pin/approval helper unit tests exist | Correct helper functions do not establish that all effects pass through them | Prove non-bypassable dispatch/containment with compromised-worker canaries and exact installed runtime gates |
| Registry revalidation derives admission from current filesystem availability | An explicit revocation can be cleared by ordinary dispatch validation | Native sticky permission state is separate from availability; only explicit readmission restores a grant |
| Bindings store canonical path strings without physical folder identity | A replacement directory at the same path inherits the recorded binding | Native identified workspaces plus platform object/volume identity and check/use-safe sandbox scope |
| Unassigned binding can pass `verifySessionRealmAccess` for a supplied ID | Source-folder equality does not establish working-copy ownership | Explicit Realm membership/ownership grant; unassigned means no Realm access |
| Project grouping is carried by the access binding; disconnect attempts Realm destruction | Organization, permission and data lifetime are coupled | Separate membership/workspace/binding/Realm identities and detach/discard actions, with reference-aware retention |

The first three registry behaviors above were reproduced in isolated synthetic source-level probes, with the later tool adapter's extra source-path check explicitly retained as a limitation. See [data/storage audit](DATA-AND-STORAGE.md#7-source-level-audit-evidence-and-root-corrections). None is repaired by this design artifact.

Removing a guard before its native dispatch/containment replacement is proved would weaken security. Build the replacement in an isolated proof, then enable one complete path and delete the superseded production path together. Do not ship a fallback that silently restores the old authority.

## 2. Preserve the correct existing owners

- Keep Projection's canonical component/record/transaction semantics and public package imports. Do not reimplement a surface engine, model parser or provider loop in native code.
- Keep sandbox-owned containment, workspace review/promotion/rollback and process-tree cleanup. Strengthen missing quotas in that project rather than add an app-side imitation.
- Keep selected skill procedures, multiple live surfaces, local controls/drafts and shared visual/spoken data. They do not acquire task-control authority.
- Keep existing integration catalog/lifecycle and declared credentials. Native mediation must compose with it, not create an alternate tool launcher/marketplace.
- Keep numeric FinOps and content retention separate from trusted admission; use native receipts for attribution, not a second budget writer.

## 3. No compatibility layer for an incorrect control path

The user confirmed zero active users and prefers root correction. Do not preserve `Tasks` as an authoritative TS backend behind a Rust facade, two endpoint-policy lists, two task journals, a hidden old scheduler, or direct-network fallback for a missing native transport.

Within the implementation branch, replace each whole vertical capability before enabling it. Unsupported protection is an explicit refusal, not a simulated pass. Old state needs an explicit offline export/conversion or a user-approved reset; local developer/installed data is not disposable merely because there are no production users.

## 4. Root-cause investigation method

For a failed outcome, retain the original contract, source/input versions, failed receipt and candidate. Locate the earliest boundary: admission, persistence, dispatch, provider generation, schema/semantic validation, canonical commit, interpretation, interaction or delivery. Repair the owning mechanism there and rerun the frozen outcome. Do not add a child, parser variant, renderer data patch or larger retry allowance just to make a surface look correct.

Mechanism acceptance, full user outcome and installed proof remain separate. Read [validation](VALIDATION-AND-ROLLOUT.md) and the [independent review](REVIEW-2026-10-29.md) before treating a local unit test as closure.
