# Building a Vakyartha app

The one guide for making an executable local app of any kind: a tracker, a dashboard, a note taker, a data workbench. Read it top to bottom once; it should answer how without reading runtime code. The exact limits live in the [runtime contract](sandboxed-apps/RUNTIME-CONTRACT.md); the in-app model follows the same method through the `app-authoring` skill and its [package template](../sidecar/builtin-skills/app-authoring/references/package-template.md).

## 1. When to make an app

Make an app when something should persist and act on its own data: records you keep editing, a view you reopen, a refresh you run again. A one-off answer, chart or form belongs in chat or Canvas instead. App interactions run ordinary code in a sandbox with no model request per click.

## 2. The package

```text
my-app/
  app.json          manifest: identity, entrypoints, entitlements, schedules
  server.ts         backend (Node 24, TypeScript or JS); every relative import included
  surface.json      the first view(s) shown before any action
  README.md  AGENTS.md  SKILLS.md  ARCHITECTURE.md   required package docs
```

Built-in apps live in `sidecar/builtin-apps/<id>/`. User apps are drafted in chat (`save_app_draft`), Canvas (Create app draft) or Studio, rehearsed, then published by the user.

`app.json` (schema: `shared/app-manifest.ts`):

```json
{
  "id": "reading-list", "version": "1.0.0", "name": "Reading List",
  "description": "Links to read later, with notes.", "icon": "book", "category": "productivity",
  "entrypoints": { "backend": "server.ts", "surface": "surface.json" },
  "runtime": { "engine": "node24" },
  "entitlements": { "network": { "mode": "airgap", "allowedDomains": [] }, "mcpTools": [], "storage": { "duckdb": false } },
  "triggers": []
}
```

`category` is one of finance, analytics, developer, productivity, utilities, custom. Use `network.mode: "brokered"` only with declared `mcpTools`; raw network is never granted.

## 3. The backend contract

```ts
export async function handleAction(controlId: string, value: unknown, context: Context, action?: string) {
  // action set: a button was pressed; value is its payload.
  // action absent: a bound field changed; controlId is its bind path, value its new value.
  return { updates: [{ surface: "main", nodes: [...], data: [{ op: "replace", path: "/", value: {...} }] }] };
}
```

- `context.state`: your persistent JSON. It is the only data owner; it is saved only when the run succeeds.
- `context.surfaces`: current snapshots. `context.callTool(name, args)`: declared integration tools. `context.database`: opted-in DuckDB.
- Return `{ updates: [...] }` for every surface whose content changed, and optionally `focusSurface: "<id>"` to switch views after saving.
- Throw an `Error` with a sentence the person can act on. The app header shows it in the status chip; nothing is saved.
- Each run is a fresh sandbox (30 s). Module memory and scratch files do not survive.

## 4. How interactions arrive

| In the surface | Reaches `handleAction` as |
| --- | --- |
| Button `{action: "add_item", payload: {id: "x"}}` | `action = "add_item"`, `value = {id: "x"}` |
| Bound field (`input`, `textarea`, `select`, `checkbox`, `date`) | `controlId = "/bind/path"`, `value` |
| `form` with `submit` | the submit action, with the form's bound values |

Field edits are batched by the host: they are sent about 0.7 s after typing stops, and always before the next button action. So a field can save itself (autosave) and a button can rely on the latest field values.

## 5. Design: one state, views derived from it

This is the method that keeps apps correct and simple:

1. Keep domain records in `context.state`. Validate and normalize it at the start of every run (it is untrusted JSON, and older versions of your app may have written other shapes).
2. Write a pure `view(state)` that returns, per surface, the complete node list and the complete data (`[{op: "replace", path: "/", value}]`).
3. Put records in the data and render lists with a repeater: `children: {each: "/notes", template: "note-card"}`, where the template binds item fields relatively (`"{title}"`, `bind: "done"` resolves to `/notes/3/done`, `payload: {id: "{id}"}`). Never bake one node per record.
4. Emit only the nodes that apply now: if nothing is open, do not emit the editor. Avoid hiding whole regions with `visibleIf` flags; replacing a container's children removes nodes that are no longer listed.
5. Keep node ids stable so updates patch rather than rebuild.
6. Derive spoken text (for `voice.read`) from the same records as the visual view, into the data (for example `/spoken/summary`).
7. Generate `surface.json` from `view(emptyState)` and keep a test asserting they are equal. Built-ins export `surfaceFile()` and `node scripts/app-surfaces.ts` writes every `surface.json`.
8. When a view depends on SQL, read it first and pass it in: `view(state, await load(db))` stays pure (Finance Workbench, Market Terminal).

## 6. Building surfaces

Surfaces use Projection's basic catalog (`framework/packages/core/src/basic-catalog.ts` lists every component and prop). The common ones:

- Layout: `stack` (direction, gap, align, wrap), `split` (ratio "1:2"), `grid` (columns, searchable, pageSize), `section` (title, description), `tabs`, `card` (title, subtitle, body, badge, tone, children).
- Content: `text` (content, variant), `alert` (title, body, tone), `table` (columns, rows, sortable, searchable, pageSize), `list`, `chart`, `stat`, `timeline`, `board`.
- Input: `input`, `textarea`, `select`, `checkbox`, `date` (label, bind, placeholder); `button` (label, action, payload, style: primary, secondary, danger, link); `form` (submit, submitLabel).
- `"{/path}"` as a whole prop value binds it to data; inside a repeater template `"{field}"` binds to the item. In a button payload a bare pointer (`"/spoken/x"`) is sent as the value it names. Tone: neutral, info, success, warning, danger. Gap: sm, md, lg.

The renderer lints every update and refuses invalid ones:
- Every bound input needs an action button or form in its enclosing container; otherwise "nothing submits them".
- Every `{/path}` must exist in the data.
- A repeater over an empty list renders nothing, so inputs in its template count as unsubmitted: emit the repeater only when it has items.
- Updates are applied on top of the previous snapshot; test a sequence of actions, not only single views (the real-sandbox test does this).
- Keep alert and card bodies to plain sentences; prefer separate `text` nodes for emphasis.

## 7. What the app host gives every app

- **Voice.** Declare buttons; the host does the rest, using the person's Voice settings (local or hosted):
  - `{action: "voice.dictate", payload: {into: "<input node id>"}}` dictates into that input, appended to its text, then delivered like a typed edit.
  - `{action: "voice.read", payload: {text: "/spoken/x"}}` reads aloud: Projection resolves a bare data pointer in a payload to its value, so the host receives the text.
  - ⌘D also dictates into the focused field. Apps never record audio or call voice providers themselves.
- **Views.** Several surfaces show as tabs; `focusSurface` switches after an action.
- **Status.** Running, saved and errors show as a small chip at the top right of the app header, with details on hover or focus.
- **Settings.** The app's settings show connection readiness, schedules, run receipts and package details.

## 8. Real data and storage

- External data: list exact tool names in `entitlements.mcpTools` and call `context.callTool(name, args)`. The host enforces the integration's schema and Allow, Ask and Off policies; Ask and Off never run unattended. Parse the tool's documented output; never invent values.
- SQL: set `storage.duckdb: true`, then use `context.database.run(sql, params)` and `query(sql, params)` (bounded snapshot, see the contract).
- Schedules: `triggers: [{id, kind: "cron", expression: "*/15 * * * *", action: "refreshData", maxDurationSec: 30}]` call the exported function named by `action`. They are off until the person enables them, and run only while the app and computer are awake.

## 9. Testing

1. Unit test the backend directly: call `handleAction` with a plain `context`, assert state and returned data, and render each update through `SurfaceStore(basicCatalog)` asserting no lint diagnostics (see `test/reference-apps.test.ts`).
2. Assert `surface.json` equals `view(emptyState)`.
3. Run it in the real sandbox with `AppRegistry` and `helperRun` (see `test/app-registry.test.ts`, "Voice Desk runs in the real sandbox").
4. Check the UI in WebKit: `scripts/apps-check.ts`, `scripts/control-layout-check.ts`, at wide and narrow widths. `npm run web` renders apps but cannot run their backends; use the desktop app for clicking through.

## 10. Shipping and updating a built-in

New data folders seed each built-in once. Changing a built-in shows **Update** on its Apps card (by package fingerprint). Updating keeps the app's saved state and pauses schedules, so normalize old state shapes in code. Bump `version` for every shipped change.

## 11. Package documents

README.md (what it does and how to use it), AGENTS.md (invariants and change method), SKILLS.md (relevant skills), ARCHITECTURE.md (files, data flow, boundaries). The [package template](../sidecar/builtin-skills/app-authoring/references/package-template.md) says what each must contain. Update them with every behavior change.

## 12. Examples to copy from

| App | Shows |
| --- | --- |
| [Voice Desk](../sidecar/builtin-apps/voice-desk/server.ts) | The full method in one file: normalized state, `view()` per surface, autosaving fields, checklists, two-step delete, host voice actions |
| [News Desk](../sidecar/builtin-apps/news-desk/server.ts) | Integration tool refresh, parsing, partial-failure warnings and receipts; editable records (feeds); coverage charts beside a card grid |
| [Project Activity Desk](../sidecar/builtin-apps/project-desk/server.ts) | Drafts applied by a button (repository), a bound board for local triage, tallies as charts |
| [Finance Workbench](../sidecar/builtin-apps/finance-workbench/server.ts) | DuckDB as owner, `view(state, ledger)`, exact arithmetic, CSV import, budget progress, many chart kinds |
| [Market Terminal](../sidecar/builtin-apps/market-terminal/server.ts) | Several governed tools, validated sources, DuckDB SQL analytics, schedules, splits of cards and charts |

Test fixtures in the documented source shapes live in `test/support/app-fixtures.ts`; the real-sandbox tests pass them as the registry's `callTool`.

Where the runtime lives, if you must change it: `sidecar/sandbox-pool/` (registry, packages, pool), `src/apps-page.ts` (app host UI, voice actions, status), `shared/app-manifest.ts` (manifest). A rendering or catalog gap belongs in Projection, not in an app.
