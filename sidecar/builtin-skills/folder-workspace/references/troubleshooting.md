# Troubleshooting Folder Workspaces

Common issues, boundary rejections, and resolution steps when working with folder workspaces.

---

## 1. Admission & Permission Failures

### Symptom: "Choose a specific project folder, rather than your home or a system folder."
- **Cause**: The selected directory is `/`, `/System`, `/usr`, `/Library`, `/Applications`, `/private/etc`, or the user's home directory root (`/Users/<name>`).
- **Resolution**: Point to a specific project subdirectory, such as `~/Projects/my-app` or `/Users/<name>/workspace/repo`.

### Symptom: "Application data directory cannot be selected as a workspace folder."
- **Cause**: Attempted to admit the internal app data folder (`<dataDir>` or `.vak/`).
- **Resolution**: App private data directories are reserved for databases and settings; choose a normal user workspace folder.

---

## 2. Execution & Timeout Errors

### Symptom: "Sandbox execution exceeded the N second limit"
- **Cause**: The process exceeded its allocated wall-clock time (default 30 seconds).
- **Resolution**: Provide `timeout_seconds` in `run_command` arguments (e.g. `timeout_seconds: 180`). The maximum supported timeout is 300 seconds (5 minutes).

### Symptom: "Sandbox output exceeded the 256 KiB limit"
- **Cause**: The command emitted more than 262,144 bytes of combined stdout and stderr.
- **Resolution**: Filter verbose outputs:
  - Pipe through `tail -n 100` or `grep -E "ERROR|WARN|PASS|FAIL"`.
  - Use quieter compiler flags (e.g. `npm test -- --reporter=spec`, `cargo build -q`).

### Symptom: "workingDirectory must stay inside the project folder"
- **Cause**: The `workingDirectory` argument contained path traversal (`../`) escaping the workspace or pointed to an absolute path.
- **Resolution**: Provide a relative path inside the project root (e.g. `.` or `packages/core`).

---

## 3. Realm & Promotion Issues

### Symptom: "This chat is operating in direct in-place editing mode"
- **Cause**: A Realm tool (`snapshot_realm`, `promote_realm`, `create_realm`) was invoked in a chat that is bound with `mode: "direct"`.
- **Resolution**: In direct mode, files are written directly to disk. Do not invoke Realm staging tools. Use `git status` or file inspection directly.

### Symptom: "Realm has N uncommitted changes" (HTTP 409 on refresh)
- **Cause**: The user or agent attempted to refresh the workspace from disk, but unapplied changes exist in the Realm.
- **Resolution**:
  - To keep changes: review and promote them (`promote_realm`).
  - To discard changes and force reload: pass `force: true` to the refresh endpoint.

### Symptom: "Cross-chat Realm access denied" (HTTP 403)
- **Cause**: An operation requested a Realm ID belonging to a different session.
- **Resolution**: In Vakyartha, chat sessions are isolated. Use the session's own admitted Realm or work within a project that has `sharedRealm: true`.

