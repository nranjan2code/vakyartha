---
name: app-authoring
description: Author, scaffold, create, and compose persistent sandboxed applications with dedicated interactive surfaces and local server logic.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.1"
---

# Build executable local apps

Use `read_app_package` to inspect an existing package and its fingerprints. First draft saves of a published app supply `base`; later draft saves supply `previous`. Use `save_app_draft` to stage a complete application for review in Studio. A surface is presentation, not executable behavior. Include real code for every promised action and refresh. Use enabled `interactive-ui` for bindings and actions; the required `surface-design` guidance applies. Preserve independent surfaces and project spoken content from the same canonical values.

The manifest names a Node 24 backend and an optional surface JSON file (one snapshot or an array). Include every relative source file. Python, shell daemons, file watchers, direct network grants and durable database files are unsupported. Do not install dependencies.

The backend exports `async handleAction(controlId, value, context, action)`. Each named cron action exports `async functionName(context)`. The runtime awaits it in a fresh supervised sandbox. Module memory and local scratch files do not survive an invocation. Persist domain data in `context.state`.

Return `{data: {...}}` to update canonical data of the first surface, `{patches: [{id,props}]}` to patch nodes, or `{updates: [{surface, data, nodes}]}` for multiple surfaces. These are Projection updates, not JSON Patch node operations. `context.surfaces` contains the current snapshots; all visible/spoken views must agree with canonical records.

For real data, declare exact offered integration tool names in `manifest.entitlements.mcpTools`, then await `context.callTool(name, args)`. Results remain tool-output text; parse the provider's actual documented output, never invent it. The host keeps credentials and enforces integration schemas and policies. Unattended calls require an enabled tool with Allow policy. Ask/off policies cannot be bypassed. A package declaration grants no permission.

Refresh is ordinary code: fetch through permitted tools, validate source data, compute values, update context.state, and return the projection update. No model generation is needed unless that specific application operation requires it; model invocation is not currently offered to app code.

Save a draft, rehearse it in Studio, independently check values and interactions, then let the user publish. Saving a draft never activates code or schedules. Schedules are off until explicitly enabled in Apps. Keep missing behavior and failed evidence explicit; do not claim installation from text or create a placeholder backend and describe it as complete.
