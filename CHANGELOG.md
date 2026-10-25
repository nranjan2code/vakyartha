# Changelog: Vakyartha

What changed in the app, newest first. Each release names the [Projection](https://github.com/nranjan2code/Projection) version it was built on; framework changes themselves are in Projection's CHANGELOG. Procedure: [RELEASING.md](RELEASING.md).

## Unreleased

- **Own repository:** split from Projection's `apps/desktop` with its history; the framework is now the pinned `framework/` submodule. The browser version is `npm run web` on :5178.
- **New identity:** `Vakyartha.app`, bundle ID `com.nranjan2code.vakyartha`, data in `~/Library/Application Support/com.nranjan2code.vakyartha/`. Installs of the old `vak.app` are not migrated: enter provider keys again once.
- `scripts/version.ts` sets the version in `package.json`, `Cargo.toml` and `tauri.conf.json` together; `npm run test:framework` runs Projection's tests against the pin.

## Before the split (developed in Projection as `apps/desktop`; hashes are Projection commits)

### 2026-10-25, night: Canvas and Artifacts (`edd0796`, `9399ca6`, `0dc3e49`)

- **Artifacts** page: a searchable library of saved surfaces across chats, with type filters, sorting and pagination; opening one returns to its chat.
- **Canvas** beside the chat: the live surface moves there (drafts and validation kept), with Preview/Text, Copy, Markdown download, a surface picker, resizing and full/split views. The chat shows reference cards only.
- Artifact creation and updates open the canvas as soon as the tool starts; closing it is respected for the rest of the turn.

### 2026-10-25: FinOps (`4392762`)

- Settings → FinOps: duration, context composition, repeated conversation, output shape, provider tokens/cache usage and estimated API cost charts.
- Per-turn drilldown, chat filter, CSV export and editable per-model rates. Numeric telemetry is stored locally; prompt and tool content is not copied into the ledger.
- Historical sessions are reconstructed; unavailable usage and paid spend stay unknown.

### 2026-10-25, evening: integrations and polish (`cf68562`)

- **Integrations marketplace** of pinned MCP servers: Files, Memory, Brave Search, GitHub, Notion, Context7; your own servers, marked unverified. Per-tool policies, approvals in the chat, a call log.
- **The browser version** runs the same server and UI; surfaces projected by outside agents (MCP) appear live.
- New icon (a sibling of the Vakyartha mark), sidebar collapse, WebKit layout fixes, UI errors in the engine log, the `webkit-check` tool, npm bundled for integrations, an elapsed-time status.

### 2026-10-25, afternoon: everyday driver (`406730a`)

- Keys in the Keychain, an engine log, a context window.
- Tray, close-to-background, single instance, launch at login.
- Telegram as an in-app channel; Settings as a full page with themes and provider settings generated from the registry; desktop-style right-click.

### 2026-10-25, midday: first desktop app (`93681cd`)

- Tauri 2 shell, Vite UI, the engine as a Node sidecar on `@vak/host`; a minimal chat UI with a model picker.
