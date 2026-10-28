---
name: app-maintainer
description: Maintain, update, patch UI layouts, modify server code, and preserve self-describing architectural contracts across application versions.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.0"
---

# Maintaining and Updating Applications

Use this procedure when updating, modifying, or refactoring hosted applications.

## Reading the Architectural Contract
Before making any changes to an application, read its `AGENTS.md` and `app.json`:
1. Check the existing visual node IDs in `surface.json`.
2. Inspect the exported `handleAction` function in `server.ts`.
3. Check trigger action handlers.

Never guess node IDs, data binding paths, or action names.

## Modifying Backend Logic
- Edit `server.ts` directly.
- Preserve deterministic calculations and pure TypeScript logic.
- Return patches conforming to the surface tree:
  ```ts
  return {
    op: "batch_update",
    controlId,
    value,
    patches: [
      { id: "node-id", props: { ... } }
    ]
  };
  ```

## Updating Visual Surfaces
- Update `surface.json` with new or revised nodes.
- Increment the `version` field in `surface.json` and `app.json`.
- When adding interactive controls, update `server.ts` to handle the new `controlId` and update `AGENTS.md` to document the new control and its valid values.

## Syncing Self-Documentation
Always keep `AGENTS.md` in sync:
- Document newly added controls, data bindings, and action handlers.
- Record any updated entitlements (storage, memory, domains).

