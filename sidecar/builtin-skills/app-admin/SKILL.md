---
name: app-admin
description: Administrate, monitor, and audit sandboxed applications, worker pool allocation, resource quotas, and security boundaries.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.2"
---

# Inspect app execution

`GET /api/admin/fleet` reports bounded invocation capacity (default three), active executions and logical hibernated tenants. Standby processes are not used. No RSS/CPU quota or latency guarantee is established by the manifest. Security depends on each successful compatible vaksb launch, not a static green indicator.

`GET /api/apps` lists published app status. App package/state is written by the host into private app-state records; drafts are separate. Processes receive disposable copies, minimal environment and no direct network authority. Existing integration permissions control declared tool calls.

Pause schedules before maintenance. Runtime suspend cancels current invocations; restart drains/cancels them and clears logical leases. Uncertain external effects require explicit review and are never automatically replayed. Deletion validates a registered identity and serializes behind running app work.

The console streams bounded invocation logs. Settings → FinOps owns measured provider usage; no app hard-spend governor or estimated savings is implied. No arbitrary CPU/RSS/process-count/disk-growth quotas, permanent daemons, file watchers or multi-platform isolation guarantees are implemented.

Read the app’s README.md for operation/setup, AGENTS.md for invariants, SKILLS.md for procedural responsibilities and ARCHITECTURE.md for data/runtime ownership before managing it. Missing or contradictory documentation is a maintenance issue: use enabled app-maintainer. Use enabled app-debugger plus debug-error for failures; never treat these docs or skill selection as tool authority.
