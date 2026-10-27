# Canvas and Artifacts

The desktop app and playground own the canvas and the Artifacts library. The
framework continues to own surfaces, rendering, bindings, validation and actions.

## Experience

Tables, charts and stat aggregates can map fields of one bound record collection. Form edits to that collection update every mapped view through the existing surface store. Display values participate in renderer refresh; controls with explicit synchronization preserve their focused DOM. Mappings do not create separate data copies or execute formula strings. Repeated field names retain their canonical paths when submitted, so editing several records cannot collapse their values.

- Media results use the canonical host session and dedicated media projection. Image/video results prefer the canvas; compact audio can remain inline. Playback controls are local and voice-addressable, while multiple result surfaces remain independently discoverable. Private resource resolution and the media library do not create another rendered-surface authority. See [MEDIA-TOOLS.md](MEDIA-TOOLS.md).

- **Artifacts** is one permanent sidebar entry. Its page lists saved surfaces
  across chats, with type filters, search by title/chat/type, sorting, source
  chat and date. It shows 24 cards initially, then offers Show more.
- Cards show metadata and a type illustration. They do not mount interactive
  forms or expose field values in previews. No extra copies of surfaces are saved.
- Opening a card returns to its chat and opens that surface in the canvas.
  Opening an artifact from the current chat preserves its live form draft.
- **Placement by size** (`src/placement.ts`). Small interfaces stay in the
  conversation, beside the words around them, with Open in canvas. Tables,
  charts, tabs, maps, graphs, galleries, calendars, boards, Gantt charts, diffs,
  comparisons, code over 12 lines, forms with more than five fields, trees of
  more than 24 nodes and long reads (over 1,500 characters) leave a compact
  reference card in the chat and open in the canvas. A surface that grows past
  the limit while streaming or updating moves to the canvas; nothing moves back
  on its own. Closing the canvas returns a small interface to the conversation
  and a large one to its card.
- New and updated large surfaces open the canvas automatically. A render/update
  tool-start shows progress in a canvas that is already open; a closed canvas
  waits for the first snapshot, which decides placement. Closing during a turn
  suppresses reopening for the rest of that turn; the next request may open it
  again. Loading history only restores the explicitly saved open selection.
- One live element moves between its place in the thread and the canvas. Drafts, validation,
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

Agent work in [MVP-SPECS.md](MVP-SPECS.md) builds on this design. Bound-field
drafts now persist across conversation changes and UI restart, with explicit
resolution when incoming values conflict. Status refreshes retain mounted live
elements; local view state remains attached to those elements. The task smoke
check covers multiple independent forms, local table interactions, navigation,
background continuation and interactions after completion.

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
