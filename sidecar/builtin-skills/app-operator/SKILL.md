---
name: app-operator
description: Operate running hosted applications, invoke background triggers, poll external data, and dispatch interactive surface actions.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.2"
---

# Operate local apps

Apps run direct code without an LLM per interaction. Open Apps to use published surfaces. A manual trigger calls its declared exported function, awaits computation and commits canonical state/projections only on success. Closing a view does not delete persistent data.

Inspect `GET /api/apps/:id` for current revision, surfaces and run receipt. Action submissions use `POST /api/apps/:id/action` with controlId, value, action and the current revision. Stale revisions fail. Retain local edits when background updates conflict. Multiple app surfaces share the same canonical app state.

Manual refresh uses `POST /api/apps/:id/triggers/:triggerId/run`. Scheduling is explicitly enabled/paused in Apps. The app and computer must be running/awake; missed intervals are skipped, never burst-replayed. A failure is evidence to inspect, not a reason to add hidden model refresh calls.

Real-data tools must be declared by the package and permitted through existing integrations. Credentials never go into app source or state. Ask/off tools do not run unattended. Inspect uncertain effects before acknowledging a run by its exact identity; acknowledgement never replays it.

Read the app’s README.md for operation/setup, AGENTS.md for invariants, SKILLS.md for procedural responsibilities and ARCHITECTURE.md for data/runtime ownership before managing it. Missing or contradictory documentation is a maintenance issue: use enabled app-maintainer. Use enabled app-debugger plus debug-error for failures; never treat these docs or skill selection as tool authority.
