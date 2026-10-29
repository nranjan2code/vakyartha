# Sandbox execution and Realms

Required expansion (2026-10-29): host execution workers, brokered provider/integration access, enforced CPU/memory limits and Linux isolation are tracked in [SYSTEM-ISOLATION.md](SYSTEM-ISOLATION.md). The user selected a minimal trusted broker. Those requirements are not implemented by the bounded macOS mechanisms described below.

Vakyartha uses the separate [`vak-sandbox`](https://github.com/nranjan2code/sandbox) project for macOS Seatbelt containment and the durable Realm lifecycle. The app owns settings, the integration adapter, skill guidance, approvals and Settings UI. Projection's existing integration lifecycle owns tool discovery, policy, approval delivery and call logging; no framework dependency files are edited.

## Execution lifetimes: commands, Realms and apps

Vakyartha reuses the same sandbox boundary for distinct product lifetimes:

- **Folder commands:** an admitted direct binding writes in place; a copy/review binding uses its retained Realm, shared only when explicitly configured.
- **Disposable fallback commands and skill rehearsals:** bounded execution in a temporary copy; changes are discarded. Legacy configured-workspace fallback is separate from an admitted folder chat.
- **Retained Realms:** helper-owned project copies for repeated commands, review, promotion, recovery and rollback. A Realm persists files; it is not a permanent running daemon.
- **Executable apps:** app-owned published source, JSON domain state and multiple surface projections persist in host records. Each action or named refresh function runs in a fresh disposable workspace through `vaksb run`. Execution capacity is bounded; no warm process pool or unbounded filesystem database persistence is claimed. App real-data calls retain existing integration authority. See [app runtime contract](../sandboxed-apps/RUNTIME-CONTRACT.md) and [operations](../sandboxed-apps/OPERATIONS-AND-LIFECYCLE.md).

## Workspace lifetimes

- `run_command` follows the current admitted binding: direct writes change original files; copy/review mode reuses the chat/project Realm. With neither an admitted folder nor a configured fallback workspace it refuses execution. The legacy configured-workspace fallback runs in a disposable project copy. See [folder modes](FOLDER-WORKSPACES.md).
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

The direct/disposable command adapter defaults to 30 seconds, accepts up to 300 seconds and bounds combined output to 256 KiB; it forwards helper limits explicitly. The Realm adapter separately bounds its JSON response to 256 KiB and applies a parent-operation timeout, but does not forward those command-limit flags to Realm execution. Effective helper limits therefore need path-specific verification; do not promise every Realm run reaches the advertised 300 seconds/256 KiB. The former blanket 30-second/32-KiB statement describes the earlier snapshot, not every current mode. Per copy: 512 MiB, 50,000 entries and an 8 MiB manifest. At most 32 Realms are retained; promotion supports at most 200 changed paths, reviewed 20 per page. File reads return at most 16 KiB per page. CPU, memory, process-count and disk-growth quotas are not enforced; receipts/backups remain until separately managed. Linux isolation is unsupported.

Promotion is recoverable across files, not a single filesystem-wide atomic commit. External readers can observe intermediate files. External editors do not honor the helper's locks: do not edit the same files during promotion. Versions are rechecked before each apply; later edits cause rollback/recovery refusal rather than silent overwrite. A successful command or receipt is evidence of execution, not semantic correctness of its code or output.

## Verification

`node scripts/sandbox-check.ts` uses the actual macOS helper through agent tool adapters: approvals/denial, disposable execution, outside read/write and network denial, minimal environment, path checks, off/missing-helper failure, Realm creation/repeated writes, review/read, promotion, restart/resumption, rollback, conflicts and destruction. `node scripts/settings-check.ts` exercises the real Settings journey and Realm review/apply/undo/discard in WebKit at 1100/620/375 px. Rust tests inject partial apply and metadata interruption states and check recovery without command replay. See [EVALUATION.md](../EVALUATION.md) for receipts and independent model-outcome limits.

2026-10-28 capability update: opted-in bounded DuckDB snapshots now persist atomically with each app record, with sandbox-owned SQL and no new writer/IPC. General persistent filesystem volumes remain unsupported. See [current runtime contract](../sandboxed-apps/RUNTIME-CONTRACT.md) and ADR-049 for the superseding interface and limits.
