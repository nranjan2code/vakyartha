---
name: app-maintainer
description: Revise an existing executable local app package and its backend, surfaces, schema and documentation. Use for versioned app maintenance, not ordinary chat-surface edits.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.3"
---

# Maintain app packages

Read the package’s **README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md** before changing it. Load `references/change-checklist.md` through `read_skill_file`. Update affected documentation together with behavior, schemas, calculations, integrations, schedules or limits; include the complete updated documents in the reviewed draft. Missing documents or obsolete claims leave maintenance incomplete. Load enabled `app-debugger` for diagnosis before a repair; use `app-authoring` and its package template when rebuilding an incomplete package.

Read the complete published source and current revision/fingerprint before changing an app. Use offered read_app_package for paged current draft/published source; otherwise ask the user to open its Studio source. Private UI routes are not model tools. Preserve existing surfaces, bindings, domain values and declared action semantics.

Edit an inert draft using `save_app_draft` or Studio; subsequent saves supply its previous fingerprint. Saving does not change the running package. Rehearse saved code with the current draft fingerprint, inspect its actual result, and independently check data and calculations. Rehearsal has no external-tool authority.

Publishing in Studio checks both draft and base package fingerprints. A stale review cannot overwrite a newer package. Publishing retains domain state, switches the complete package record and pauses scheduling. Surface schema changes require deliberate migration in application code; do not silently replace user data to obtain a pass.

Backend handlers are awaited, run in disposable supervised workspaces and persist context.state plus validated returned surface updates, and the opted-in bounded DuckDB snapshot through context.database. Arbitrary local files/module memory remain scratch. Review DuckDB schema compatibility deliberately and keep parameterized queries within documented limits. Never bypass the sandbox on execution failure or claim a static surface gained refresh logic automatically.
