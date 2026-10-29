# Folder Workspaces & Project Chats: Architecture and Operations Guide

This guide describes the architecture, runtime boundaries, execution modes, REST APIs, MCP tool semantics, and operational procedures for folder workspaces and project chats in Vakyartha.

---

## 1. Overview & Architecture

Vakyartha enables conversations to operate directly on local project folders. Canonical bindings and explicit modes select the working tree. The supported macOS helper confines commands; full broker/resource/Linux isolation remains open under ADR-050.

```
+-------------------------------------------------------------------------------+
|                                VAKYARTHA APP                                  |
|                                                                               |
|  +-------------------------+     +-----------------------------------------+  |
|  |     Projects Sidebar    |     |            Chat Workspace Bar           |  |
|  | (Group chats by folder) |     | (Folder badge, Mode pill, Review/Apply) |  |
|  +-------------------------+     +-----------------------------------------+  |
|               |                                       |                       |
|               v                                       v                       |
|  +-------------------------------------------------------------------------+  |
|  |                     App Sidecar (Node 24 / ESM)                         |  |
|  |                                                                         |  |
|  |  +---------------------+   +---------------------+   +---------------+  |  |
|  |  |  WorkspaceRegistry  |   |    SandboxRealms    |   | Media Service |  |  |
|  |  | (AsyncLocalStorage) |   |  (Mutex per Realm)  |   | (Export/Imp)  |  |  |
|  |  +---------------------+   +---------------------+   +---------------+  |  |
|  +-------------------------------------------------------------------------+  |
|                                       | (spawn supervised helper)             |
|                                       v                                       |
|  +-------------------------------------------------------------------------+  |
|  |                         vak-sandbox Helper (Rust)                       |  |
|  |                                                                         |  |
|  |            macOS Seatbelt Kernel Profile:                               |  |
|  |            - (deny network*)                                            |  |
|  |            - (allow file-read* file-write* <admitted-folder-only>)      |  |
|  |            - Direct: up to 300s/256 KiB; Realm: 30s/32 KiB        |  |
|  +-------------------------------------------------------------------------+  |
+-------------------------------------------------------------------------------+
```

### Canonical Registry Ownership
All project and chat binding state is stored in the application's private data directory:
`<dataDir>/workspaces.json` (mode `0o600`).
App metadata is **never written inside the user's project folder**. Source directories remain pure and untouched by app internal tracking.

### Session Scoping via `AsyncLocalStorage`
File and tool execution in Vakyartha does not use global `process.chdir()` or mutate process-wide environment variables. Instead, `WorkspaceRegistry.withSession(session, work, revision)` establishes an `AsyncLocalStorage` context per chat turn. All tool invocations resolve their effective workspace binding dynamically:
- Unbound chats fail closed with clear guidance ("Select 'Work in folder' to enable command execution").
- Concurrent chats across different projects execute independently without scope bleeding.

---

## 2. Path Admission & Boundary Security

Before any folder can be admitted to a chat or project, it must pass strict validation via `validateWorkspaceFolder(path, dataDir)`:

1. **Absolute Paths Only**: Relative paths, empty paths, or whitespace-only inputs are rejected immediately.
2. **Canonical Realpath Resolution**: Symlinks are resolved to their canonical disk target before inspection.
3. **Directory Verification**: The path must exist, be a directory, and possess read (`R_OK`) and execute (`X_OK`) permissions.
4. **Denied System Roots**:
   The following system and administrative directories are strictly refused:
   - `/`, `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/tmp`, `/private`, `/private/etc`, `/private/var`, `/private/tmp`, `/Users`, `/home`.
5. **User Home Root Rejection**:
   Selecting the user's home directory root (`/Users/<username>` or `/home/<username>`) is rejected. Users must choose a specific subfolder (e.g., `~/Projects/my-app`).
6. **Application Private Data Isolation**:
   The application data directory (`<dataDir>`) and its descendants cannot be selected as a workspace folder.
7. **Reserved Folder Names**:
   Directories named `.vak`, `.git`, `.ssh`, or `.aws` are refused as root workspace admissions.
8. **Revision Tracking & Stale Approval Protection**:
   Every binding tracks a monotonic `revision` integer. If a folder is modified, rebound, or revoked while an operation is awaiting approval, the revision mismatch cancels execution immediately.

---

## 3. The Three Working Modes

Vakyartha provides three distinct working modes tailored for different risk profiles, collaboration needs, and development workflows:

| Capability / Aspect | Mode 1: Isolated Copy (`copy_review`) | Mode 2: Shared Project Realm (`shared`) | Mode 3: Direct In-Place (`direct`) |
| :--- | :--- | :--- | :--- |
| **Default for** | Standalone chats | Multi-chat projects | Explicit selection in dialog |
| **Working Directory** | `<dataDir>/sandbox/realms/<id>/workspace` | Shared `<dataDir>/sandbox/realms/<proj-id>/workspace` | User's disk folder directly |
| **Persistence** | Across turns in same chat | Across all chats in same project | Permanent on disk |
| **Original Project Files** | Untouched until explicit Apply | Untouched until explicit Apply | Modified immediately |
| **Seatbelt Sandbox** | Enforced (network denied) | Enforced (network denied) | Enforced (network denied) |
| **Concurrency / Locking** | Isolated per chat | Serialized via mutex per Realm | Sandboxed directly in folder |
| **Review & Staging** | Snapshot diffs + explicit Apply | Snapshot diffs + explicit Apply | Not needed (writes are on disk) |
| **Rollback / Undo** | Exact transaction receipt undo | Exact transaction receipt undo | No app-owned rollback; use an authorized external recovery method |
| **Repository data** | `.git` omitted from copy | `.git` omitted from copy | Files preserved in place; basic Git commands tested |
| **Size / Copy Ceiling** | 512 MiB copy limit | 512 MiB copy limit | **No copy limits** |
| **Max Runtime** | 30 seconds (helper) | 30 seconds (helper) | Up to 300 seconds |
| **Max Output Buffer** | 32 KiB (helper) | 32 KiB (helper) | 256 KiB |

---

### Mode 1: Isolated Copy (`copy_review`) — The Safe Default
* **How it works**:
  When a chat admits a folder in isolated copy mode, a dedicated durable Realm copy is provisioned by the `vak-sandbox` helper (`vaksb realm create <project>`).
* **Turn Persistence**:
  Commands run inside this retained Realm (`vaksb realm exec`). Files created or edited in Turn 1 remain present in Turn 2, 3, and beyond.
* **Review & Promotion Cycle**:
  1. The user or agent inspects changes via `snapshot_realm`.
  2. Candidate files are examined via `read_realm_file` (with `original: true` for before-diffs).
  3. Changes are committed to the original project only when the user authorizes `promote_realm` with the matching SHA-256 review fingerprint and ordered path list.
  4. If needed, `rollback_realm` restores backups using the committed transaction receipt ID.
* **Dirty Refresh Guard**:
  If the user requests a workspace refresh from disk while unapplied changes exist in the Realm, the server returns HTTP 409 refusing silent overwrite unless `force: true` is explicitly passed.

---

### Mode 2: Shared Project Realm (`shared`) — Team Collaboration
* **How it works**:
  When a project is created with `sharedRealm: true`, all chats within that project share a single Realm working copy (`project.sharedRealmId`).
* **Real-Time Cross-Chat Visibility**:
  When Chat A writes a file or runs a build in the shared Realm, Chat B in the same project can immediately see, read, and build upon those modifications without requiring an Apply or export step.
* **Mutual-Exclusion Locking**:
  [SandboxRealms](../sidecar/sandbox-realms.ts) enforces a strict per-Realm Promise mutex (`withRealmLock`). If Chat A and Chat B issue commands simultaneously on the shared Realm, executions and snapshots are serialized cleanly without corrupted states or file races.
* **Unified Promotion**:
  Any chat in the project can review accumulated changes and promote them to the source project folder.

---

### Mode 3: Direct In-Place Editing (`direct`)
* **How it works**:
  Selected explicitly during folder admission. Commands execute directly inside the user's project folder (`vaksb run --workspace <folder>`).
* **Kernel Containment**:
  macOS Seatbelt confines execution to `<folder>`:
  - Network operations are completely blocked.
  - Filesystem writes outside `<folder>` are denied by the kernel.
  - Host environment secrets (`OPENAI_API_KEY`, etc.) are scrubbed.
* **Repository and toolchain bounds**:
  - No file copying occurs, so the 512 MiB copy cap and 50,000 file ceiling do not apply.
  - Files remain in place, including `.git`. Basic init/add/commit/log commands are tested; external worktree/submodule paths still require admission and may be denied.
  - Build compatibility depends on the admitted paths, available tools and supported process behavior. The 300-second/256-KiB interface limits are not proof of arbitrary build compatibility.
* **Review / Staging**:
  Because writes occur directly on disk, Realm snapshots and Apply steps are bypassed. There is no automatic app rollback. Existing version control or backups can support separately authorized recovery.

---

## 4. Governed Media & File Handoff

Folder workspaces include governed import and export endpoints for documents, media, and data assets:

### Export Asset (`POST /api/workspaces/bindings/:session/export-asset`)
Copies a binary asset from Vakyartha's media library or chat attachments into the active workspace:
- In isolated or shared mode: writes into `<dataDir>/sandbox/realms/<id>/workspace/<targetPath>`.
- In direct mode: writes directly into `<projectFolder>/<targetPath>`.
- Enforces boundary escaping validation (`targetPath` cannot escape the workspace root).
- Returns the file size and SHA-256 checksum receipt.

### Import File (`POST /api/workspaces/bindings/:session/import-file`)
Imports a file from the workspace into Vakyartha's media library or attachments:
- Verifies real file existence, regular file status, and boundary containment.
- Enforces a 20 MB size limit per imported asset.
- Detects format by content signature and extension:
  - Images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`)
  - Audio (`audio/wav`, `audio/mpeg`, `audio/webm`)
  - Video (`video/mp4`, `video/webm`)
  - Documents & Data (`application/pdf`, `text/csv`, `application/json`, `text/markdown`, `text/plain`)
- Unsupported binary formats are rejected with HTTP 415.

---

## 5. REST API Reference

All routes are authenticated via the desktop main-window IPC or loopback token.

### Projects
- `GET /api/projects`: List all configured projects.
- `POST /api/projects`: Create a project. Body: `{ name: string, folder: string, sharedRealm?: boolean }`. Returns HTTP 201.
- `GET /api/projects/:id`: Get project details.
- `PATCH /api/projects/:id`: Update project name, folder, or sharedRealm setting.
- `DELETE /api/projects/:id`: Remove project from sidebar (does **not** delete the source folder or chats).

### Workspace Bindings
- `GET /api/workspaces/bindings`: List all active session bindings.
- `GET /api/workspaces/bindings/:session`: Get binding for a specific chat session.
- `POST /api/workspaces/bindings/:session`: Bind a chat to a folder. Body: `{ folder: string, projectId?: string, mode?: "copy_review" | "direct", shareProjectRealm?: boolean }`.
- `DELETE /api/workspaces/bindings/:session`: Unbind a chat session. Destroys isolated private Realms; preserves shared project Realms.

### Folder Validation
- `POST /api/workspaces/validate-folder`: Validates folder path before admission. Body: `{ folder: string }`. Returns `{ ok: true, canonical, isReadable, isWritable }`.

### Realm Lifecycle & Review
- `GET /api/workspaces/bindings/:session/realm`: Inspect Realm status for the session. In direct mode, returns `{ mode: "direct", bound: true }`.
- `POST /api/workspaces/bindings/:session/realm/ensure`: Ensure a Realm exists for the chat. Returns `{ realmId, status }`.
- `GET /api/workspaces/bindings/:session/realm/review?offset=0`: Get paged changes (up to 20 per page) with fingerprint. In direct mode, returns empty change list.
- `POST /api/workspaces/bindings/:session/realm/apply`: Promote changes to source folder. Body: `{ fingerprint: string, paths: string[] }`.
- `POST /api/workspaces/bindings/:session/realm/undo`: Rollback previous promotion. Body: `{ transactionId: string, paths: string[] }`.
- `POST /api/workspaces/bindings/:session/realm/refresh`: Refresh working copy from disk. Body: `{ force?: boolean }`. Returns 409 if unapplied changes exist without `force: true`.

---

## 6. MCP Tool Contract for Agents

The `sandbox-execution` catalog entry registers tools available to the model:

### `run_command`
Runs an executable and argument list inside the admitted workspace:
```json
{
  "command": "/bin/sh",
  "args": ["-c", "npm test"],
  "workingDirectory": "packages/core",
  "timeout_seconds": 120
}
```
* **Parameters**:
  - `command` (string, max 256): Executable name or absolute path. No shell is implicit.
  - `args` (array of strings, max 64 items, max 16 KiB total): Arguments passed to the process.
  - `workingDirectory` (optional string): Relative path inside the workspace. Cannot escape root.
  - `timeout_seconds` (optional integer, 1 to 300): Direct/disposable deadline, default 30s and maximum 300s. Retained/shared Realm exec remains capped at 30s by the helper.
* **Output**: Direct/disposable stdout/stderr up to 256 KiB; retained/shared Realm helper output up to 32 KiB, with exit code and error status.

### Realm Tools (`mode: "copy_review"` and `shared`)
- `snapshot_realm`: Returns review fingerprint and changed paths.
- `read_realm_file`: Read candidate file or original (`original: true`).
- `promote_realm`: Promotes reviewed candidate changes to original folder with SHA-256 fingerprint check.
- `rollback_realm`: Reverts committed promotion using receipt ID.
- `realm_status`: Inspects recovery status and entry counts.
- `recover_realm`: Cleans interrupted promotion journal without re-running code.
- `destroy_realm`: Discards isolated Realm working copy.

