---
name: app-authoring
description: Author, scaffold, create, and compose persistent sandboxed applications with dedicated interactive surfaces and local server logic.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.2"
---

# Build executable local apps

Before authoring, load `references/package-template.md` through `read_skill_file`. Every new app package must include **README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md**, alongside its manifest, executable source and surfaces. Follow the template’s file-specific method and completion checklist. Tailor all documentation to actual implemented behavior; do not leave generic headings, invented capability claims or TODOs while declaring the app ready. Incomplete drafts may remain incomplete.

Use enabled `app-maintainer` for updates, `app-debugger` plus `debug-error` for failures, and domain skills when relevant. These are selected procedures, not automatic execution or permission grants.

Use `read_app_package` to inspect an existing package and its fingerprints. First draft saves of a published app supply `base`; later draft saves supply `previous`. Use `save_app_draft` to stage a complete application for review in Studio. A surface is presentation, not executable behavior. Include real code for every promised action and refresh. Use enabled `interactive-ui` for bindings and actions; the required `surface-design` guidance applies. Preserve independent surfaces and project spoken content from the same canonical values.

The manifest names a Node 24 backend and an optional surface JSON file (one snapshot or an array). Include every relative source file. Python, shell daemons, file watchers, direct network grants and arbitrary durable filesystem databases are unsupported. Do not install dependencies.

The backend exports `async handleAction(controlId, value, context, action)`. Each named cron action exports `async functionName(context)`. The runtime awaits it in a fresh supervised sandbox. Module memory and local scratch files do not survive an invocation. Persist ordinary domain data in `context.state`. Opted-in `entitlements.storage.duckdb: true` provides sandboxed `context.database.run(sql, parameters?)` and `query(sql, parameters?)`; the bounded database snapshot commits with state/surfaces. Use parameters, explicit schema ownership and 2 MiB snapshot / 10,000-row / 256 KiB query limits. External database access and automatic extensions are disabled. Do not import drivers or write a second persistent file.

Return `{data: {...}}` to update canonical data of the first surface, `{patches: [{id,props}]}` to patch nodes, or `{updates: [{surface, data, nodes}]}` for multiple surfaces. These are Projection updates, not JSON Patch node operations. An explicit navigation action may also return `focusSurface: "existing-surface-id"`; the registry validates it and the app opens that independent view after commit. `context.surfaces` contains the current snapshots; all visible/spoken views must agree with canonical records.

For real data, declare exact offered integration tool names in `manifest.entitlements.mcpTools`, then await `context.callTool(name, args)`. Results remain tool-output text; parse the provider's actual documented output, never invent it. The host keeps credentials and enforces integration schemas and policies. Unattended calls require an enabled tool with Allow policy. Ask/off policies cannot be bypassed. A package declaration grants no permission.

Refresh is ordinary code: fetch through permitted tools, validate source data, compute values, update context.state, and return the projection update. No model generation is needed unless that specific application operation requires it; model invocation is not currently offered to app code.

Save a draft, rehearse it in Studio, independently check values and interactions, then let the user publish. Saving a draft never activates code or schedules. Schedules are off until explicitly enabled in Apps. Keep missing behavior and failed evidence explicit; do not claim installation from text or create a placeholder backend and describe it as complete.
