# Working on Voice Desk

Read [Building a Vakyartha app](../../../docs/BUILDING-APPS.md) first; this app is its worked example. Then README.md, SKILLS.md and ARCHITECTURE.md here.

## Invariants

1. `context.state.notes` is the only data owner. Every run starts with `normalize()`, which accepts untrusted or older state and keeps only well-formed notes.
2. `view(state)` derives both surfaces (`desk`, `actions`) and their spoken text from the notes. Records go in surface data and render through repeaters (`children: {each, template}`); nodes are templates, and a region is emitted only when it applies (the editor only with an open note, the checklist only with items, the confirmation only while asked).
3. Fields autosave: `/note/title`, `/note/body`, `/note/tags`, `/note/actions/<i>/done`, `/open/<i>/done`, `/capture`, `/newAction`. Anything else throws.
4. Voice is the host's. Buttons declare `voice.dictate` `{into: <input node id>}` and `voice.read` `{text: "/spoken/..."}`; this code never records, transcribes or speaks.
5. No network, tools or model calls. Text is stored as inert strings.

## Change method

Change `server.ts`, then regenerate `surface.json` as `view({})` (the test fails otherwise), bump `version` in app.json, update these four documents, and run `node --test test/reference-apps.test.ts test/app-registry.test.ts` (the second runs it in the real sandbox).
