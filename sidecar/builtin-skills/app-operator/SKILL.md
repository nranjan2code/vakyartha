---
name: app-operator
description: Help operate an existing published executable local app using its Apps controls, receipts and explicitly enabled triggers; no private-route or background-tool authority is implied.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.3"
---

# Operate local apps

Apps run direct code without an LLM per interaction. Open Apps to use published surfaces. A manual trigger calls its declared exported function, awaits computation and commits canonical state/projections only on success. Closing a view does not delete persistent data.

Use the published app's controls and its Apps details for revision, surfaces and run receipts. Private app HTTP/IPC routes are not model tools. If no offered tool performs an operation, hand off to the matching Apps control; do not invent a route-calling capability. Stale revisions fail. Retain local edits when background updates conflict. Multiple app surfaces share the same canonical app state.

Open an app by clicking its card. Its run status (saving, saved, problems) is the small chip at the top right of the app header; hover or focus it for details. Dictate and Read aloud buttons in an app use the person's Settings → Voice choices and need voice turned on.

Manual refresh uses the declared trigger control in Apps. Scheduling is explicitly enabled/paused in Apps. The app and computer must be running/awake; missed intervals are skipped, never burst-replayed. A failure is evidence to inspect, not a reason to add hidden model refresh calls.

Real-data tools must be declared by the package and permitted through existing integrations. Credentials never go into app source or state. Ask/off tools do not run unattended. Inspect uncertain effects before acknowledging a run by its exact identity; acknowledgement never replays it.

Read the app’s README.md for operation/setup, AGENTS.md for invariants, SKILLS.md for procedural responsibilities and ARCHITECTURE.md for data/runtime ownership before managing it. Missing or contradictory documentation is a maintenance issue: use enabled app-maintainer. Use enabled app-debugger plus debug-error for failures; never treat these docs or skill selection as tool authority.
