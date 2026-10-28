# Sandbox execution and Realms

Vakyartha uses the separate [`vak-sandbox`](https://github.com/nranjan2code/sandbox) project for macOS Seatbelt containment and the durable Realm lifecycle. The app owns settings, the integration adapter, skill guidance, approvals and Settings UI. Projection's existing integration lifecycle owns tool discovery, policy, approval delivery and call logging; no framework dependency files are edited.

## Execution Tiers: Ephemeral Commands vs. Stateful Pooled Mini-Cloud Runtime

Vakyartha operates two distinct execution tiers for untrusted code execution:

1. **Tier 1 (Ephemeral Command & Realm Sandbox):** Documented here, powered by `vak-sandbox` (`vaksb`). Designed for tool-driven CLI commands (`run_command`), Skill Studio rehearsals (`POST /api/skills/:name/rehearsal`), and multi-step file manipulation within project Realms. Stateless, bounded to 30 seconds, fail-closed, and destroyed or snapshot-promoted on demand.
2. **Tier 2 (Multi-Tenant Sandboxed Application Pool):** Designed for full-lifecycle persistent Dynamic Artifact Applications and long-running daemons. Governed by `SandboxPoolManager` (`sidecar/sandbox-pool/pool-manager.ts`) and `AppRegistry` (`sidecar/sandbox-pool/app-registry.ts`) with bounded concurrency (`maxActiveWorkers = 3`), pre-warmed standby runners, LRU slot eviction/hibernation, sub-16ms Canvas reactive diffing, autonomous background crons, workstation sleep/wake clock reconciliation, and dedicated Admin Console (`admin.html`). Detailed in [Sandboxed Applications & Runtime Pool Architecture](../sandboxed-apps/ARCHITECTURE.md) and [Operations Guide](../sandboxed-apps/OPERATIONS-AND-LIFECYCLE.md).

## Workspace lifetimes

- `run_command` runs once in a bounded temporary project copy and removes it after the call.
- `create_realm` copies the configured project into a retained Realm. `run_in_realm` executes repeatedly in the same copy; files survive calls and app restarts. `list_realms` and `realm_status` inspect saved work. No command resumes automatically after interruption.
- `snapshot_realm` records a durable review manifest, with a fingerprint and paged changed paths. It is a review snapshot, not a restorable filesystem checkpoint. `read_realm_file` pages candidate or original file contents and marks lossy text.
- `promote_realm` takes the current fingerprint and every reviewed path in order. It rechecks the candidate and original versions, stages immutable candidates/backups outside the jailed workspace, journals the operation and applies files with atomic replacement. The committed receipt names the affected paths and transaction ID.
- `rollback_realm` restores the latest promotion for that Realm using the receipt ID and exact paths. It refuses later project edits. `recover_realm` requires the current recovery paths and authorization, rolls back incomplete promotion, and never replays commands. An interrupted creation is discarded and recreated.
- `destroy_realm` removes the isolated copy after recovery checks. It does not undo promotion or delete retained receipts/backups.

Mutating tools ask by default through existing per-tool policies. Inspection tools are read-only. The explicit Settings actions are user operations through the existing integration test/logging path; Apply and Undo show confirmation with affected paths. A skill never grants permission. Changing the configured project revokes agent access to older project copies until that project is selected again.

## Setup and Settings

1. Build/install the helper from the sandbox project. Release builds rebuild and bundle it. Desktop development and browser mode use `../sandbox/target/release/vaksb` or PATH; the explicit helper override remains available.
2. Open Settings → Sandbox and save an absolute, accessible project folder. System roots and the whole home folder are refused. Folder changes apply to future operations immediately.
3. Enable **Sandboxed execution** in MCP integrations. New installations enable it, with Ask policies for mutations; existing users retain their saved choice.
4. Inspect live helper compatibility, folder validity, integration/policy state and pending restart. Run the fixed test command to exercise the actual execution path. Manage retained workspaces and inspect candidate/original files before applying changes.
5. The global switch immediately blocks command execution and Realm mutation. Local stdio MCP wrapping uses its startup setting and needs an app restart. A helper version response does not prove every running MCP server is contained. Existing MCP behavior can fall back without isolation when the helper is missing; command/Realm execution fails closed.

Skills → sandbox links back to setup. Skills edits remain explicit reviewed updates; installation does not overwrite customized or removed skills.

## Ownership, data and bounds

`<app data>/sandbox/` is the helper-owned control store. `realms/<id>/workspace` contains only the jailed copy. Private records, stable OS lock files, snapshots, audit logs, journals, immutable candidates and backups are under `state/`, outside that copy. The CLI accepts `--store` so separate invocations share this canonical state. Realm and project locks serialize operations in that store. No new native IPC, package or persistence writer is added.

Commands deny network and receive minimal PATH/HOME/TMPDIR, without provider/app keys. Common credential paths, `.env*`, `.npmrc`, `.git`, `.vak`, credential-named files and PEM/key files are excluded from initial copies. This is a filename exclusion rule, not a content secret scanner. Regular files/directories are supported; symlinks, special files and file/directory type replacement are refused for Realm work.

Per command: 30 seconds and 32 KiB combined output. Per copy: 512 MiB, 50,000 entries and an 8 MiB manifest. At most 32 Realms are retained; promotion supports at most 200 changed paths, reviewed 20 per page. File reads return at most 16 KiB per page. CPU, memory, process-count and disk-growth quotas are not enforced; receipts/backups remain until separately managed. Linux isolation is unsupported.

Promotion is recoverable across files, not a single filesystem-wide atomic commit. External readers can observe intermediate files. External editors do not honor the helper's locks: do not edit the same files during promotion. Versions are rechecked before each apply; later edits cause rollback/recovery refusal rather than silent overwrite. A successful command or receipt is evidence of execution, not semantic correctness of its code or output.

## Verification

`node scripts/sandbox-check.ts` uses the actual macOS helper through agent tool adapters: approvals/denial, disposable execution, outside read/write and network denial, minimal environment, path checks, off/missing-helper failure, Realm creation/repeated writes, review/read, promotion, restart/resumption, rollback, conflicts and destruction. `node scripts/settings-check.ts` exercises the real Settings journey and Realm review/apply/undo/discard in WebKit at 1100/620/375 px. Rust tests inject partial apply and metadata interruption states and check recovery without command replay. See [EVALUATION.md](../EVALUATION.md) for receipts and independent model-outcome limits.
