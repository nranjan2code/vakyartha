# Canvas and Artifacts

The desktop app and playground own the canvas and the Artifacts library. The
framework continues to own surfaces, rendering, bindings, validation and actions.

## Experience

- **Artifacts** is one permanent sidebar entry. Its page lists saved surfaces
  across chats, with type filters, search by title/chat/type, sorting, source
  chat and date. It shows 24 cards initially, then offers Show more.
- Cards show metadata and a type illustration. They do not mount interactive
  forms or expose field values in previews. No extra copies of surfaces are saved.
- Opening a card returns to its chat and opens that surface in the canvas.
  Opening an artifact from the current chat preserves its live form draft.
- The chat shows a compact artifact card with Open in canvas; full content
  appears exclusively in the canvas. Closing the canvas keeps the content hidden
  and preserves its live draft. New and updated artifacts open automatically.
  A render/update tool-start event opens the panel with a progress indicator,
  without guessing the target artifact; the first surface snapshot selects it.
  Streamed snapshots paint there as they arrive. Closing during a turn suppresses
  reopening for the rest of that turn; the next request may open it again.
  Loading history only restores the explicitly saved open selection. An empty
  pending panel closes if generation fails or stops before producing a surface.
- One live element moves between hidden storage in the thread and the canvas. Drafts, validation,
  local filters and actions remain attached to it. The thread keeps a reference.
- The canvas provides a surface picker, Preview/Text, Copy as text, Markdown
  download, resizing, full/split view, close, and narrow-window full-width layout.
- Width and selected surface per chat persist in local UI preferences. The
  surfaces themselves continue to use the host's saved session persistence.
- Native downloads use the shell's `save_canvas` command, accepting a plain
  Markdown filename only and creating a new file in Downloads. Repeated names
  get a suffix; existing files and symlinks are never overwritten.

## Design decisions

Work opens beside the conversation in a resizable canvas, with a dedicated
Artifacts page for discovery. Labelled controls support keyboard access and
return focus to the reference when closed. Sidebar toggling, canvas visibility,
full/split view and layout cycling keep their existing shortcuts.

Multiple surfaces remain independently interactive. The picker changes which
live surface is visible; it does not flatten them into text or duplicate their
forms. Preview, text representation and Markdown export are the supported views.
Arbitrary code execution, document editing, publishing, collaboration and version
history are separate capabilities, not implied by the canvas shell.

Agent planning in [MVP-SPECS.md](MVP-SPECS.md) builds on this design. Preserving
live drafts within a mounted conversation is existing behavior; draft durability
across conversation changes and restart remains a tracked MVP requirement.

## Discovery and checks

`GET /api/sessions` includes additive `surfaceSummaries` metadata (ID, title and
component types). The host builds it while reading the existing session index,
updates it on save/removal, and overlays in-memory sessions. Browsing the library
does not load every conversation into memory or return messages/form data.
The library date is the source chat's last-updated date.

Run:

```sh
npm run typecheck
npm test
npm run build --workspace @vak/desktop
node scripts/canvas-check.ts
cargo check --manifest-path src-tauri/Cargo.toml --offline
cargo test --manifest-path src-tauri/Cargo.toml --offline --lib canvas_tests
```

The WebKit smoke check uses an isolated server and deterministic surfaces, with
no model calls. It exercises live drafts, full view, automatic placement, text,
updates, tool-start reopening, streamed target selection, manual-close suppression,
failure cleanup, picker navigation, library search/filtering, Markdown content, chat
restoration, removal, form submit, keyboard controls, pagination, sorting and
cross-chat opening at 1100px and 620px. It prints its screenshot directory.
`webkit-check.swift` also accepts `WK_WIDTH` and `WK_HEIGHT` for manual probes.
