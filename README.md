# vak desktop

The everyday app built on the vak framework: chats whose answers are interfaces, a model picker, a Settings page (models, providers, integrations, channels, appearance), and a menu-bar mode that keeps channels answering while the window is closed. Architecture: [SPECS.md §10](../../SPECS.md); threat model: [SECURITY.md](../../SECURITY.md).

The same UI runs in a browser as the playground (`npm run playground` from the repo root, http://127.0.0.1:5177).

## Run and build

```bash
npm run desktop          # dev window: Vite on :1420 + Tauri; the engine runs from source (needs Rust, Node 24+)
npm run playground       # the same UI in a browser (builds dist/ first)
npm run desktop:build    # release .app in src-tauri/target/release/bundle/macos (Node and npm bundled)
```

Install a release build:

```bash
ditto apps/desktop/src-tauri/target/release/bundle/macos/vak.app /Applications/vak.app
```

Quit the running app first (`osascript -e 'quit app "vak"'`): it is single-instance, so a second copy only focuses the first. Run `tauri build` through `npm run desktop:build` only: a plain `tauri build` has no engine inside and says so on start.

## How it fits together

| Part | Where | What |
|---|---|---|
| Shell | `src-tauri/src/lib.rs` | starts the engine, hands the window its address and token (`backend`), tray, close-to-background, single instance, launch at login, graceful stop |
| Engine | `sidecar/main.ts` → `sidecar/server.ts` | `@vak/host` + settings, channels, integrations, client-log and info routes; token-protected for the window, open (loopback only) for the playground |
| Settings store | `sidecar/settings.ts` | provider and channel keys in the macOS Keychain (elsewhere a 0600 file); plain values in `settings.env` |
| Integrations | `sidecar/integrations.ts` | the MCP catalog, pinned installs, per-tool policies, approvals, call log |
| FinOps | `sidecar/finops.ts`, `src/finops-page.ts`, `finops.ts` | app-owned usage ledger, model rates, per-turn cost/context/output charts and CSV export; see [FINOPS.md](FINOPS.md) |
| Channels | `sidecar/channels.ts` | Telegram (`runTelegram`); Slack and Discord slots |
| UI | `src/` | `main.ts` (chats, thread, composer, approvals), `settings.ts` + `integrations-page.ts` (Settings), `models.ts`, `theme.ts`, `menu.ts` (right-click), `icons.ts`, `ui.ts` |
| Release packaging | `scripts/bundle-sidecar.ts`, `src-tauri/tauri.release.conf.json` | the engine as one module, the Node binary, npm |

## Data

| | Dev (`npm run desktop`) | Installed app | Playground |
|---|---|---|---|
| Folder | `.vak/desktop/` | `~/Library/Application Support/com.vakprojection.desktop/` | `.vak/playground/` |
| Keys | Keychain `com.vakprojection.desktop.dev` + repo `.env` | Keychain `com.vakprojection.desktop` | Keychain `com.vakprojection.playground` + repo `.env` |

Each folder holds `sessions/`, `integrations/` (one folder per installed server), `integrations.json`, `channels.json`, `settings.env`, `logs/engine.log` (engine and UI errors) and `logs/tools.jsonl` (every tool call).

## FinOps

**Settings → FinOps** charts duration, context composition, repeated context, generated output, provider tokens/cache usage and estimated API cost. Inspect individual turns, filter by chat, configure per-model rates and export CSV. New requests record numeric telemetry locally in `logs/finops.jsonl`; prices live in `finops-rates.json`. Old sessions are reconstructed and keep token usage and paid cost unknown. Accounting belongs only to the app, with no FinOps changes in `packages/*`. See [FINOPS.md](FINOPS.md) for scope and estimation limits.

## Canvas and Artifacts

**Artifacts** in the sidebar opens a library of surfaces from saved chats. Search by artifact or chat, filter by type, sort, and browse more than the initial 24 cards. Opening an item returns to its chat and shows it in the canvas. Library cards show metadata, without exposing form values.

The chat shows compact artifact cards with **Open in canvas**. Full content appears exclusively in the canvas; closing it keeps the content hidden while preserving form drafts, validation and local views. Larger artifacts open automatically beside the chat. The canvas offers a surface picker, Preview/Text, Copy, Markdown download to Downloads, resizing and full/split views. Shortcuts: ⌘B for the sidebar, ⌘⌥B for the canvas, ⌘⇧F for full/split view, ⌘⇧B to cycle layouts. Details, design references and checks: [CANVAS.md](CANVAS.md).

## Debugging

- **Engine log:** Settings → About → Engine log, or the file above. UI errors land there as `[ui error]`.
- **The window is WebKit, not Chromium.** Check layout and behaviour with `scripts/webkit-check.swift` (off-screen WKWebView; usage in its header); a Chromium preview misses WebKit's form controls and layout differences.
- **Probe the real window** (debug builds only): `VAK_DEBUG_JS=/path/probe.js npm run desktop` runs that script in the window 4 s after start; have it POST to `/api/client-log` (get the address and token from `window.__TAURI_INTERNALS__.invoke("backend")`) and read the engine log.
- **Inspector:** Option-right-click in a dev build.
- **Profile a turn:** `node scripts/profile-turn.ts ollama:qwen3.5:4b-mlx "request"` from the repo root.

## Tests

`apps/desktop/test/` (settings storage, channels, FinOps accounting and authenticated HTTP capture) runs with `npm test` at the repo root. Integration security is tested in `packages/mcp/test` and `packages/host/test`.
