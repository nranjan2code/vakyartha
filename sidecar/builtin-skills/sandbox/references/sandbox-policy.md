# Sandbox policy

Commands use macOS Seatbelt with network denied and writes restricted to an isolated project copy. One-shot `run_command` copies are discarded; persistent Realms retain writes across calls. Control records, review manifests, audit logs, promotion journals, immutable candidates and backups stay outside the jailed workspace.

The app's configured project is rechecked before Realm access. Changing that setting revokes access to older project copies until that project is selected again. Disabling sandbox execution blocks creation, execution, promotion, rollback, recovery and destruction; inspection remains available. The integration and per-tool policies still govern agent access. Mutating tools ask by default, and denial never authorizes another route.

Promotion checks the full reviewed candidate fingerprint, exact path list and original versions. It stages durable backups before mutation, applies changes with atomic file replacement and records a receipt. Incomplete work requires explicit recovery; rollback refuses to overwrite later edits. Locks serialize operations in the canonical control store. External editors do not honor those locks, so versions are checked again at apply time; do not edit the same files concurrently with promotion.

Snapshot means a durable review manifest, not a restore point for the workspace. Only the latest committed promotion for a Realm can be rolled back, and only while the affected project paths still match that receipt. Destroy removes the copy, not promotion history or backups.

Bounds: 30 seconds and 32 KiB command output; 512 MiB, 50,000 entries and 8 MiB manifest per copy; 32 retained Realms; 200 changed paths per promotion. No memory, CPU, process-count or disk-growth quotas. Regular files/directories only; symlinks, special files and file/directory replacement are refused.
