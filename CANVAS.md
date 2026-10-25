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
- Small interfaces stay inline, with Open in canvas. Tables, charts, tabs,
  long code, forms with more than five fields, and large node trees open in the
  canvas on first creation. Updates do not reopen a panel the user closed.
- One live element moves between the thread and canvas. Drafts, validation,
  local filters and actions remain attached to it. The thread keeps a reference.
- The canvas provides a surface picker, Preview/Text, Copy as text, Markdown
  download, resizing, full/split view, close, and narrow-window full-width layout.
- Width and selected surface per chat persist in local UI preferences. The
  surfaces themselves continue to use the host's saved session persistence.
- Native downloads use the shell's `save_canvas` command, accepting a plain
  Markdown filename only and creating a new file in Downloads. Repeated names
  get a suffix; existing files and symlinks are never overwritten.

## Reference research (2026-10-25)

These are interaction patterns adapted to vak, rather than a copy of either UI.

| Official source | Documented pattern | vak decision |
| --- | --- | --- |
| [Claude artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) | Work opens beside the conversation; a sidebar Artifacts destination collects saved work; content can be exported | Dedicated Artifacts page and a live canvas beside the chat |
| [Claude artifact keyboard navigation](https://support.claude.com/en/articles/17457950-use-artifacts-with-a-keyboard-or-screen-reader) | Header controls, keyboard entry and focus return on close | Labelled controls, keyboard access, focus returns to the thread reference |
| [Codex workspace commands](https://learn.chatgpt.com/docs/reference/commands) | Sidebar toggle, show/hide tabs, full/split layouts and layout cycling | ⌘B (plus existing ⌘\\), ⌘⌥B, ⌘⇧F and ⌘⇧B |
| [Desktop browser layout](https://learn.chatgpt.com/docs/browser) | A workspace can expand or sit beside chat | Resizable split view and full view |

Claude's documentation distinguishes new artifacts from legacy artifacts; their
content/code/export controls differ. vak exposes the formats it actually supports:
live surface preview, a text representation and Markdown export. Arbitrary HTML
execution, document editing, publishing, collaboration and version history are
separate capabilities, not implied by the canvas shell.

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
node apps/desktop/scripts/canvas-check.ts
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --offline
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --offline --lib canvas_tests
```

The WebKit smoke check uses an isolated server and deterministic surfaces, with
no model calls. It exercises live drafts, full view, automatic placement, text,
updates, picker navigation, library search/filtering, Markdown content, chat
restoration, removal, form submit, keyboard controls, pagination, sorting and
cross-chat opening at 1100px and 620px. It prints its screenshot directory.
`webkit-check.swift` also accepts `WK_WIDTH` and `WK_HEIGHT` for manual probes.
