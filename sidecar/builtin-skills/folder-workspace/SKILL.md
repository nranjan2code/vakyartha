---
name: folder-workspace
description: Inspect, manage, and execute commands in folder workspaces and project chats. Understands isolated copies, shared project Realms, and direct in-place editing modes. Author builds, tests, file modifications, diff reviews, and media import/exports without guessing or breaking containment.
license: MIT
compatibility: Execution requires macOS, the vak-sandbox helper, an enabled sandbox integration, and an admitted project folder.
metadata:
  author: nranjan2code
  version: "1.0"
allowed-tools: run_command create_realm run_in_realm snapshot_realm read_realm_file promote_realm rollback_realm recover_realm destroy_realm list_realms realm_status
---

# Folder Workspaces & Project Chats

This skill guides agents when interacting with admitted local project folders, multi-chat projects, command execution, and file composition.

Load `shell-command` for command construction guidelines and `debug-error` when a command or build fails with non-zero exit codes.

---

## 1. Safety & Determinism — No Guessing

Before taking action, follow these deterministic rules:

1. **Never guess the workspace state or contents**:
   - Do not hallucinate file existence, directory trees, or project configurations.
   - Use `run_command` with `/bin/ls -la` or `/usr/bin/find . -maxdepth 2 -not -path '*/.*'` to discover the layout.
   - Read actual files with `read_realm_file` or `/bin/cat` before proposing modifications.
2. **Never attempt to escape the workspace boundary**:
   - All file operations and `workingDirectory` arguments must remain strictly within the admitted folder.
   - Paths containing `..` that escape the root or absolute paths pointing outside the folder are rejected by the sandbox kernel.
3. **Respect macOS Seatbelt confinement**:
   - Network access is denied (`(deny network*)`). Do not attempt `curl`, `wget`, `npm install` without cached dependencies, or socket calls.
   - Destructive commands (`rm`, `git reset --hard`) affect real files in direct mode or Realm files in copy mode. Always inspect the target path before issuing mutations.
4. **Honest exit code verification**:
   - A command is successful **only if exit code is 0**. If exit code is non-zero, report the failure and stderr clearly. Never claim a test, build, or script succeeded without a receipt proving exit code 0.

---

## 2. Identify the Active Mode

Vakyartha operates in one of three modes for folder-bound chats. Identify the active mode from the chat context or tool responses:

```
                                  +-----------------------------------------+
                                  | What mode is active in this chat?       |
                                  +-----------------------------------------+
                                           /           |             \
                                          /            |              \
             [Direct In-Place Mode]      /             |               \      [Isolated Copy Mode]
             - mode: "direct"           /              |                \     - mode: "copy_review"
             - Writes modify disk directly             |                 \    - Retained Realm copy
             - Native .git & worktrees                 |                  \   - Changes staged until Apply
             - NO Realm staging/Apply                  |                   \  - Conflict & rollback tracking
                                                       v
                                            [Shared Project Realm]
                                            - shared: true (in Project)
                                            - Shared durable Realm copy
                                            - Real-time cross-chat visibility
                                            - Serialized via mutex locks
                                            - Unified review & Apply
```

### Flow A: Direct In-Place Editing Mode (`mode: "direct"`)
* **Execution**: Call `run_command`. The executable runs directly inside the admitted folder under macOS Seatbelt kernel confinement.
* **Side Effects**: File edits write **directly to the user's project files on disk**.
* **Review / Staging**: **Do not call `snapshot_realm` or `promote_realm`**. In direct mode, files are already committed to disk. Calling Realm staging tools will inform you that direct mode is active.
* **Git & Builds**:
  - Full Git capabilities (`git status`, `git diff`, `git branch`, `git worktree`) work directly.
  - Large builds and compilation tools operate without the 512 MiB copy ceiling.
  - For long runs (e.g. `npm test`, `cargo build`), pass `timeout_seconds: 120` (up to 300).
* **Rollback**: Rollback in direct mode relies on standard version control (`git checkout`, `git restore`).

### Flow B: Isolated Copy Mode (`mode: "copy_review"`)
* **Execution**: Call `run_command` (or `run_in_realm`). It executes inside a retained Realm copy (`<dataDir>/sandbox/realms/<id>/workspace`).
* **Turn Persistence**: Files modified in Turn 1 persist in Turn 2 and beyond in the same chat.
* **Original Project Untouched**: The user's original disk files remain completely unchanged until explicit promotion.
* **The Review & Apply Procedure**:
  1. **Snapshot**: Call `snapshot_realm` to obtain the latest SHA-256 `fingerprint` and the list of modified `paths`.
  2. **Inspect**: Call `read_realm_file` to review candidate changes and compare with `original: true`. Explain the changes clearly to the user.
  3. **Promote**: Only when authorized, call `promote_realm` with:
     - `fingerprint`: exact SHA-256 fingerprint from `snapshot_realm`.
     - `paths`: exact array of changed relative paths in review order.
  4. **Record Receipt**: Note the returned `transaction_id`. If the user later requests an undo, call `rollback_realm` with this `transaction_id` and the affected paths.

### Flow C: Shared Project Realm Mode (`shared: true`)
* **Execution**: Multiple chats within the same project share one durable Realm (`project.sharedRealmId`).
* **Cross-Chat Sharing**: Work done in Chat 1 is immediately visible to Chat 2 without an Apply step. Both chats share the same workspace copy.
* **Serialization**: The runtime automatically serializes concurrent commands and snapshots per Realm using internal mutual-exclusion locks.
* **Promotion**: Follow Flow B's Review & Apply procedure. Applying commits all changes in the project's shared Realm to the source folder.

---

## 3. Command Authoring Best Practices

When calling `run_command`:

1. **Executable and Arguments**:
   - `command`: Use an explicit executable name or path: `/bin/sh`, `/bin/zsh`, `/usr/bin/git`, `/usr/bin/python3`, `node`, `cargo`, `npm`.
   - `args`: Pass arguments as individual strings in the `args` array:
     ```json
     {
       "command": "/usr/bin/git",
       "args": ["status", "--short"]
     }
     ```
2. **Shell syntax requires an explicit shell**:
   - If using pipes (`|`), redirections (`>`, `>>`, `2>&1`), heredocs (`<<`), or shell variables (`$VAR`), invoke `/bin/sh` or `/bin/zsh` with `-c`:
     ```json
     {
       "command": "/bin/sh",
       "args": ["-c", "npm run build 2>&1 | tail -n 20"]
     }
     ```
3. **Deadlines & Long Builds**:
   - Default timeout is 30 seconds.
   - For long builds, tests, or compiler runs, specify `timeout_seconds`:
     ```json
     {
       "command": "/bin/sh",
       "args": ["-c", "cargo test --all"],
       "timeout_seconds": 180
     }
     ```
   - Maximum timeout is 300 seconds (5 minutes). Maximum output buffer is 256 KiB.
4. **Working Directory (`workingDirectory`)**:
   - Relative path inside the workspace (e.g. `src/components`, `packages/backend`). Defaults to `.`.
   - Must be a relative path and must not escape the workspace root.

---

## 4. Media & Binary Asset Composition

For non-text files (images, audio, video, PDF documents, spreadsheets):

- **Exporting generated assets to workspace**:
  When an image, audio clip, or report is generated or attached to the chat, use `export-asset` to place it in the project:
  Target path must be relative (e.g. `assets/logo.png`, `public/audio.wav`).
- **Importing workspace files into attachments / media**:
  When a file created by code or commands in the workspace needs to be surfaced in chat or audio/visual projections, use `import-file`:
  Supports PNG, JPEG, WebP, GIF, WAV, MP3, MP4, WebM, PDF, CSV, JSON, Markdown, and Text under 20 MB.

---

## 5. Troubleshooting & Error Recovery

| Error / Symptom | Root Cause | Agent Action |
| :--- | :--- | :--- |
| **"No folder workspace is admitted for this chat"** | Chat is standalone with no folder bound | Inform user to click **Work in folder** or select a Project in the sidebar. |
| **"timeout_seconds must be an integer between 1 and 300"** | Parameter out of bounds | Clamp timeout between 1 and 300 seconds. |
| **"Sandbox execution exceeded the N second limit"** | Build/script exceeded deadline | Increase `timeout_seconds` (up to 300s) or run the build in smaller steps. |
| **"Sandbox output exceeded the 256 KiB limit"** | Run generated excessive stdout/stderr | Pipe output through filtering (e.g. `grep`, `tail -n 100`, `--quiet`). |
| **"workingDirectory must stay inside the project folder"** | Path traversed outside root | Ensure `workingDirectory` is relative without `../` escape. |
| **"Cross-chat Realm access denied"** (HTTP 403) | Attempting to access another chat's private Realm | Do not use hardcoded or guessed Realm IDs; use the current chat's session Realm. |
| **"Realm has N uncommitted changes"** (HTTP 409) | Refresh attempted with dirty Realm | Review and promote candidate changes, or explain that `force: true` will discard them. |
| **"Conflicts detected during promote"** | Source folder files changed externally | Call `snapshot_realm` to review conflicted paths. Do not force overwrite without user consent. |

---

## 6. Reference Documentation

- See `references/workspace-modes.md` for detailed side-by-side mode comparisons.
- See `references/command-recipes.md` for common Node.js, Rust, Python, and Git command recipes.
- See `references/troubleshooting.md` for error recovery procedures.

