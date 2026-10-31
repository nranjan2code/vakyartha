# Voice Desk architecture

## Files

- `app.json`: manifest; no network, tools, storage database or schedules.
- `server.ts`: `normalize`, `handleAction`, and `view` with `deskSurface`, `editorNodes`, `actionsSurface`.
- `surface.json`: `view({})`, the empty state shown before the first action.

## Flow

```text
type or dictate (host voice.dictate) → field edit, batched by the host → handleAction(bindPath, value)
button → handleAction(action, payload) → normalize(state) → change notes → view(state)
view → updates for desk and actions (nodes + whole data) → registry validates and commits atomically → surfaces
voice.read button → payload pointer resolved by Projection → host reads the text aloud
```

## Data

State: `notes[]` (`id`, `title`, `body`, `tags[]`, `actions[]` of `{id, text, done}`, `created`, `updated`), `openId`, `seq`, `capture`, `newAction`, `confirmDelete`. Surface data is derived: `/notes` records for the list, `/note` for the editor, `/open` for open items, `/spoken/*` for read-aloud text. Visual and spoken views come from the same notes.

## Boundaries

Each action runs in a fresh sandbox (30 s); state is saved only on success, and errors show in the app header's status chip. Voice input and output stay with the host's voice settings and providers. Limits: 500 notes, 20,000 characters per note, 300 per line field, 12 tags.
