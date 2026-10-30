# Working on Voice Desk

Read the repository root AGENTS.md, docs/SKILL-AUTHORING.md, and docs/sandboxed-apps/RUNTIME-CONTRACT.md before making modifications to this app package.

## Invariants and Ownership

1. **State Ownership**: `context.state.notes` owns all canonical note entities. Each note uniquely owns its respective action items (`actions`) and formal decisions (`decisions`).
2. **Persistence Boundary**: State mutations occur solely within `server.ts` and commit atomically through Vakyartha's sandboxed app supervisor. No parallel database writer, ambient filesystem mutation, or unvetted storage path is allowed.
3. **Deterministic Actions**: App actions (`create_note`, `save_note`, `delete_note`, `add_action`, `export_markdown`) execute deterministic TypeScript inside the supervised worker. They do not dispatch hidden LLM requests on basic UI interactions.
4. **Isolated Network Boundary**: Voice Desk runs with network isolation enabled. External integrations, web fetching, or remote sync require user-approved MCP tools outside this package boundary.
5. **Form & Data Binding**: Form inputs strictly bind to designated canonical paths (`/activeTitle`, `/activeTags`, `/activeContent`, `/newNoteTitle`, `/newActionText`, `/newActionOwner`). Never use presentation labels as canonical data keys.

## Change Method

- Whenever modifying `server.ts` or `surface.json`, ensure both `workbench` and `actions` surfaces remain valid against `SurfaceStore(basicCatalog).render()`.
- Update all four package documents (`README.md`, `AGENTS.md`, `SKILLS.md`, `ARCHITECTURE.md`) in lockstep.
- Verify that changes pass `npm test`, typechecking, and the WebKit apps checker (`scripts/apps-check.ts`).
