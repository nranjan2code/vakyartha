For an admitted direct binding, commands write in place and Realm promotion is not used. For an admitted copy binding, use its retained Realm; do not create a separate copy for each command. The explicit Realm examples below apply only when that mode and tool contract are offered.

# Isolated command examples

For a single check, call `run_command` with `command: "/bin/pwd"` and `args: []`. It returns a result from a disposable copy and does not save changes.

For multi-step edits, create a Realm, keep its returned ID, then call `run_in_realm` for each command. A second call sees files written by the first. Read actual stdout/stderr and exit codes; network-dependent installation will fail because network access is denied.

To apply work, snapshot the Realm, read every changed-path page and inspect candidate/original file contents as needed. Explain the effect before requesting `promote_realm` with the exact fingerprint and complete path list. A denied or stale request changes nothing. A committed promotion returns the transaction ID and affected paths required for rollback.

On restart, list Realms and inspect the selected ID. Do not replay an interrupted command automatically. Recovery rolls back incomplete promotion without executing commands. Discarding a Realm leaves the original project and prior promotion receipts intact.
