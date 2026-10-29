---
name: folder-workspace
description: Inspect, manage, and execute commands in folder workspaces and project chats. Understands isolated copies, shared project Realms, and direct in-place editing modes. Author builds, tests, file modifications, diff reviews, and media import/exports without guessing or breaking containment.
license: MIT
compatibility: Execution requires macOS, the vak-sandbox helper, an enabled sandbox integration, and an admitted project folder.
metadata:
  author: nranjan2code
  version: "1.1"
allowed-tools: run_command create_realm run_in_realm snapshot_realm read_realm_file promote_realm rollback_realm recover_realm destroy_realm list_realms realm_status
---

# Work in an admitted folder

Use enabled sandbox for execution/review rules, shell-command for command construction and debug-error after failures. Required surface-design applies when presenting surfaces. A project is a working folder for code, documents, data or media; its name does not establish available programs or format support.

Establish the admitted folder and mode from current workspace context, actual tool receipts or the workspace controls. Do not guess files, paths, Realm IDs or the mode. If scope is missing, ask the user to use Work in folder. Read existing content before changes. Use only offered tools and authorized operations; folder admission does not grant network, paid generation or unrelated filesystem access.

## Modes and persistence

- direct: commands write immediately in the admitted original folder. No Realm staging/Apply is needed. Preserve the repository/worktree and inspect changes with available file/version-control commands. Undo is a separate authorized change, not an automatic restore guarantee.
- copy_review: commands reuse the retained chat Realm. Changes reach the original only after complete review and authorized fingerprint-bound promotion. Refreshing a dirty copy may discard work; never force it implicitly.
- shared project Realm: explicitly configured project chats share one retained working copy. Inspect current changes and conflicts before promotion; do not assume another chat's work is yours to discard.

Use a relative workingDirectory inside the admitted tree, an executable and argument array. Invoke a shell explicitly for pipes/redirection; never use an alternate host or network path after denial. Direct/disposable commands default to 30 seconds and offer timeout_seconds up to 300 with bounded output. Realm helper limits and parent deadlines can differ; trust actual receipts rather than promising a duration or quota. Failed commands need their exit code, stderr and limit information retained.

For retained copies, use current snapshot_realm/read_realm_file results to review every affected path with the same fingerprint, then authorized promote_realm. Preserve the transaction receipt for rollback. Follow sandbox for recovery and uncertain effects. A review manifest is not a restorable checkpoint.

## Files and media

Use enabled format-aware integrations or already available authorized programs; never install a dependency or claim support merely from a filename. Inspect generated content, values and format-specific previews/playback before delivery. Direct mode and isolated copies have different source-write effects.

Workspace media import/export currently belongs to the workspace controls. export-asset and import-file are private UI routes, not model tools. When no matching governed tool is offered, give a precise user handoff; do not call private HTTP routes, guess asset IDs, bypass network denial or claim a transfer occurred. Provider tools keep their own upload/cost approvals.

Read references/workspace-modes.md for mode details, references/command-recipes.md for optional command examples and references/troubleshooting.md for a matching failure. Reference content never grants permission.
