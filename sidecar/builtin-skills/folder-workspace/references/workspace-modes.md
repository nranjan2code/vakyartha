# Workspace Modes Reference

Vakyartha folder workspaces support three distinct operating modes:

---

## 1. Direct In-Place Editing Mode (`mode: "direct"`)

### When to use
- Everyday software engineering with existing Git repositories.
- Large codebases exceeding 512 MiB or 50,000 files.
- Workflows using Git branches, Git worktrees, submodules, or local tooling caches (`node_modules`, `target/`).
- Longer builds that fit the offered deadline and installed helper limits.

### Behavior & Mechanics
- **Working Tree**: Commands run directly inside the admitted folder on disk.
- **Containment**: macOS Seatbelt enforces kernel confinement:
  - Network access is denied (`(deny network*)`).
  - Writes are permitted only within the workspace root. Writes outside the workspace are blocked.
  - Process environment is scrubbed of app/provider secrets.
- **Persistence**: Edits write immediately and directly to files on disk.
- **Review / Staging**: No Realm staging copy is created. `snapshot_realm` and `promote_realm` are bypassed.
- **Rollback**: Standard version control (`git status`, `git diff`, `git checkout`).

---

## 2. Isolated Copy Mode (`mode: "copy_review"`)

### When to use
- Safe exploration, refactoring experiments, or untrusted code runs.
- Workflows where the user requires complete visual diff review and explicit "Apply" approval before touching real disk files.
- Standalone chats outside a project.

### Behavior & Mechanics
- **Working Tree**: `<dataDir>/sandbox/realms/<realmId>/workspace` (a durable copy of the project folder created by `vaksb realm create`).
- **Containment**: macOS Seatbelt sandbox with network denial.
- **Persistence**: Retained Realm survives turns, approvals, and app restarts. The user's source folder remains untouched.
- **Review / Staging**:
  1. `snapshot_realm` returns review fingerprint and changed paths.
  2. `read_realm_file` reads candidate changes and original files.
  3. `promote_realm` applies changes to the source folder with bit-for-bit SHA-256 verification.
- **Rollback**: `rollback_realm` restores backups from the committed promotion transaction receipt.
- **Dirty Refresh**: Refreshes fail with HTTP 409 if uncommitted Realm changes exist, unless `force: true` is passed.

---

## 3. Shared Project Realm (`shared: true`)

### When to use
- Multi-chat collaboration in a project.
- Scenarios where Chat A (e.g. backend design) and Chat B (e.g. frontend integration) work on the same retained working copy without having to promote to disk after every turn.

### Behavior & Mechanics
- **Working Tree**: Shared durable Realm allocated on the project (`project.sharedRealmId`).
- **Containment**: macOS Seatbelt sandbox with network denial.
- **Persistence**: Shared across all chats assigned to the project. Edits made in Chat 1 are immediately visible and runnable in Chat 2.
- **Concurrency**: Operations are serialized per Realm ID using an internal mutual-exclusion lock (`withRealmLock`). Managed commands serialize through that owner; external editors still need conflict checks and must not edit promotion targets concurrently.
- **Review / Staging**: Same review and promotion procedure as Isolated Copy mode. When promoted, all accumulated changes in the project's shared Realm commit to the source folder.

