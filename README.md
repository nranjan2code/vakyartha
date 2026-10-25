# Vakyartha

**Ask any model, get an interface.**

Vakyartha is a desktop app (macOS first) whose answers are interfaces: cards, dashboards, tables, charts, forms and buttons you can use, not just read. Chats are saved, artifacts open in a canvas beside the conversation, and a menu-bar mode keeps channels like Telegram answering while the window is closed. Local models first (Ollama `qwen3.5:4b-mlx`); hosted providers work too.

Built on the **[Projection framework](https://github.com/nranjan2code/Projection)** (`@vak/*`): the engine that parses, repairs and projects model-written interfaces. Vakyartha draws the framework in as a pinned git submodule; the framework knows nothing about the app.

[Install from source](#install-from-source) · [Develop](#develop) · [How it fits together](#how-it-fits-together) · [Data](#data) · [Docs](#documentation) · [MIT license](LICENSE)

## Install from source

You need **macOS**, **Node.js 24+**, npm, **Rust** (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). For local models, run [Ollama](https://ollama.com) with `qwen3.5:4b-mlx` (or any installed model).

```bash
git clone --recurse-submodules https://github.com/nranjan2code/vakyartha.git
cd vakyartha
npm ci
npm run desktop:build
```

Then install the bundle (quit a running copy first: `osascript -e 'quit app "Vakyartha"'`):

```bash
ditto src-tauri/target/release/bundle/macos/Vakyartha.app /Applications/Vakyartha.app
```

Builds are not code-signed or notarized yet: install only what you built yourself. The full release procedure is in [RELEASING.md](RELEASING.md).

## Develop

```bash
npm run desktop          # dev window: Vite on :1420 + Tauri; the engine runs from source
npm run web              # the same app in a browser on http://127.0.0.1:5178 (builds dist/ first)
npm test                 # app tests
npm run typecheck
```

Hosted provider keys go in **Settings → Providers** (Keychain), or in a local `.env` for development (see [`.env.example`](.env.example)). Changes to the engine itself belong in [Projection](https://github.com/nranjan2code/Projection); [RELEASING.md](RELEASING.md) explains how to pull them in.

## How it fits together

| Part | Where | What |
|---|---|---|
| Framework | `framework/` (submodule) | Projection: engine, catalog, projectors, providers, `@vak/host`, MCP client, Telegram runner |
| Shell | `src-tauri/src/lib.rs` | starts the engine, hands the window its address and token (`backend`), tray, close-to-background, single instance, launch at login, graceful stop |
| Engine | `sidecar/main.ts` → `sidecar/server.ts` | `@vak/host` + settings, channels, integrations, client-log and info routes; token-protected for the window, open (loopback only) for `npm run web` |
| Settings store | `sidecar/settings.ts` | provider and channel keys in the macOS Keychain (elsewhere a 0600 file); plain values in `settings.env` |
| Integrations | `sidecar/integrations.ts` | the app's MCP catalog (which servers, pinned versions); installing and running them is Projection's `Integrations` |
| FinOps | `sidecar/finops.ts`, `src/finops-page.ts`, `finops.ts` | app-owned usage ledger, model rates, per-turn cost/context/output charts and CSV export; see [FINOPS.md](FINOPS.md) |
| Channels | `sidecar/channels.ts` | Telegram (`runTelegram`); Slack and Discord slots |
| UI | `src/` | `main.ts` (chats, thread, composer, approvals), `settings.ts` + `integrations-page.ts` (Settings), `models.ts`, `theme.ts`, `menu.ts` (right-click), `icons.ts`, `ui.ts` |
| Release packaging | `scripts/bundle-sidecar.ts`, `src-tauri/tauri.release.conf.json`, `scripts/version.ts` | the engine as one module, the Node binary, npm; one version everywhere |

## Data

| | Dev (`npm run desktop`) | Installed app | Browser (`npm run web`) |
|---|---|---|---|
| Folder | `.vak/desktop/` | `~/Library/Application Support/com.nranjan2code.vakyartha/` | `.vak/web/` |
| Keys | Keychain `com.nranjan2code.vakyartha.dev` + `.env` | Keychain `com.nranjan2code.vakyartha` | Keychain `com.nranjan2code.vakyartha.web` + `.env` |

Each folder holds `sessions/`, `integrations/` (one folder per installed server), `integrations.json`, `channels.json`, `settings.env`, `logs/engine.log` (engine and UI errors) and `logs/tools.jsonl` (every tool call).

## Canvas and Artifacts

**Artifacts** in the sidebar opens a library of surfaces from saved chats. Search by artifact or chat, filter by type, sort, and browse more than the initial 24 cards. Opening an item returns to its chat and shows it in the canvas. The chat shows compact artifact cards; full content appears only in the canvas, which keeps forms live and offers Preview/Text, Copy, Markdown download, resizing and full/split views. Shortcuts: ⌘B sidebar, ⌘⌥B canvas, ⌘⇧F full/split, ⌘⇧B cycle layouts. Details: [CANVAS.md](CANVAS.md).

## FinOps

**Settings → FinOps** charts duration, context composition, repeated context, generated output, provider token/cache usage and estimated API cost, with turn details, chat filters, editable model rates and CSV export. Telemetry is numeric and local. Details and limits: [FINOPS.md](FINOPS.md).

## Debugging

- **Engine log:** Settings → About → Engine log, or `logs/engine.log` in the data folder. UI errors land there as `[ui error]`.
- **The window is WebKit, not Chromium.** Check layout with `scripts/webkit-check.swift` (off-screen WKWebView; usage in its header) and `node scripts/canvas-check.ts` after `npm run build`.
- **Probe the real window** (debug builds only): `VAK_DEBUG_JS=/path/probe.js npm run desktop` runs that script in the window 4 s after start.
- **Inspector:** Option-right-click in a dev build.

## Documentation

- [SPECS.md](SPECS.md): what the app is, its framework dependency and identity.
- [RELEASING.md](RELEASING.md): releasing the app and updating Projection.
- [AGENTS.md](AGENTS.md) and [HANDOVER.md](HANDOVER.md): working rules and where work stands.
- [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).
- The framework: [Projection](https://github.com/nranjan2code/Projection) (its SPECS, SECURITY and CHANGELOG).

## Contributions and license

Maintainer-developed; external contributions are not accepted (see [CONTRIBUTING.md](CONTRIBUTING.md)). Copyright © 2026 Nisheeth Ranjan, released under the [MIT License](LICENSE).
