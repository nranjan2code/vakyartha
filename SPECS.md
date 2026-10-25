# SPECS.md: Vakyartha

What the app is and how it is built. Rules: [AGENTS.md](AGENTS.md). State of work: [HANDOVER.md](HANDOVER.md). Releasing: [RELEASING.md](RELEASING.md).

Agent MVP planning: [MVP-SPECS.md](MVP-SPECS.md) defines the proposed task experience and preserves the existing interactive, multi-surface design. [MVP-CHECKLIST.md](MVP-CHECKLIST.md) tracks existing foundations, design decisions, MVP gates and later scope. These are planning documents; the implementation described below remains the current baseline.

Vakyartha is a desktop app (macOS first) where a model's answers are interfaces: cards, tables, charts, forms and buttons. It is a product built on the [Projection framework](https://github.com/nranjan2code/Projection) (the `@vak/*` packages); the engine, catalog, projectors, providers, host and MCP client are the framework's, and are specified in [Projection's SPECS.md](https://github.com/nranjan2code/Projection/blob/main/SPECS.md). This document covers only what the app adds.

## 1. The framework dependency

- **One way only.** The app imports `@vak/*`; the framework never imports, builds or tests the app.
- **How it is pinned.** `framework/` is a git submodule of `github.com/nranjan2code/Projection`, pinned to one commit (a release tag once Projection tags them). npm workspaces link `framework/packages/*` into `node_modules/@vak/*`, so the app runs the framework's TypeScript sources directly in development, and the release bundles them into the sidecar.
- **What the app uses:** `@vak/host` (sessions, chat, approvals, token auth, `/api/project`), `@vak/providers` (provider registry, keys, profiles), `@vak/web` (`<vak-surface>`, `VakClient`), `@vak/core`, `@vak/mcp/client` (`Integrations`: installing, configuring and running servers), `@vak/telegram` (`runTelegram` for the Telegram channel).
- **What stays in the app:** anything that is a product decision: key storage, settings, the integrations catalog (which servers, versions, descriptions), channels, FinOps, Canvas and Artifacts, themes, the shell. A general engine need goes to Projection first (see [RELEASING.md](RELEASING.md), "Updating Projection").

## 2. Identity

| | |
|---|---|
| Product name | Vakyartha (`Vakyartha.app`) |
| Bundle identifier | `com.nranjan2code.vakyartha` |
| Data folder (release) | `~/Library/Application Support/com.nranjan2code.vakyartha/` |
| Keychain service | `com.nranjan2code.vakyartha` (release), `.dev` (dev window), `.web` (browser version) |
| Version | one value in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, set by `scripts/version.ts` |

## 3. Architecture

Tauri 2 shell, Vite + plain TypeScript UI, the engine as a Node sidecar. **The browser version is the same app**: `scripts/web.ts` (`npm run web`) runs the same app server (`sidecar/server.ts`) open on loopback :5178 and serves the same built UI, so there is one interface.
- **Sidecar** (`sidecar/`): `@vak/host` on an ephemeral loopback port with a random token. Keys in the macOS Keychain via `/usr/bin/security` (writes through stdin, never argv; older file-stored keys move over on start); elsewhere a 0600 file. Logs to `logs/engine.log` in the data folder, including UI errors (`/api/client-log`). Routes: settings, channels, integrations, approvals (host), client-log, info.
- **Integrations** (`sidecar/integrations.ts`): the app's curated catalog (built-in Web pages and Time; MCP reference Files and Memory; Brave Search, Tavily remote, GitHub remote, Notion, Context7 by their vendors), each npm server pinned to a version, run by the framework's `Integrations` (`@vak/mcp/client`): pinned, script-free installs (`--ignore-scripts --before=<today − 14 days>`) into their own folder, only declared keys, folder checks for Files, per-tool policies and approvals, servers the user adds marked unverified, calls logged to `logs/tools.jsonl`. Time is on from the first run. Keys go to the app's Keychain store. Settings → Integrations shows a marketplace (original icons, trust badges), and a page per integration: what it can reach, setup, each tool with its policy, risk badges and a "Try it" run, recent calls, uninstall.
- **Channels** (`sidecar/channels.ts`): chat platforms answered while the app runs in the background, each declaring its secrets and a run-until-aborted function. Telegram runs `runTelegram` from `@vak/telegram` (shared with Projection's `npm run telegram`; a second poller on the same bot is reported, not crashed on). Off by default; each has its own model. Slack and Discord are listed as coming.
- **Shell** (`src-tauri`): starts the sidecar and hands the webview its address and token; menu-bar tray (Open, New chat, Quit); closing the window hides it while "keep running" is on; Dock click reopens; one instance only; launch at login; on quit the sidecar gets 4 s to stop channels. Links open in the system browser.
- **UI**: chats sidebar (date groups, rename, delete), the thread, a composer with a model picker (recent models plus installed local ones). The sidebar collapses (button or ⌘\\) and shows the app mark. Approvals appear in the chat as a card; tools used show as chips. Settings is a full page: Models (the provider's own model list from its key, plan, calibration), Providers (one card per provider: key, endpoint, status, model count), Channels (a page per channel), Appearance (System/Light/Dark, six themes, text size; surfaces follow), Chats (context window, engine notes, delete all), General (tray, login, model behaviour), About (version, data folder, log, shortcuts).
- **Canvas and Artifacts (app-only):** one sidebar Artifacts entry opens a searchable library of saved surfaces across chats, with type filters, sorting and pagination. Cards reopen the source chat and its live surface in a resizable canvas. The chat shows reference cards only; full content appears exclusively in the canvas. Closing it preserves the hidden live surface. Artifact render/update tool-start opens the canvas with progress; incoming snapshots select the target and render there. Manual close suppresses reopening within that turn; a new turn can reopen it. History redraws do not auto-open artifacts. Preview/Text, Copy, Markdown download, a surface picker, full/split view and keyboard controls wrap the same live element, preserving drafts and validation. The host's session summaries include lightweight `surfaceSummaries` metadata; the library never previews form values. Design research and checks: [CANVAS.md](CANVAS.md).
- **Right-click**: the webview's menu never shows. Text fields keep the native editing menu; selected text gets Copy. Chats: Open, Rename, Delete. Your message: Copy, Edit as new message. A reply: Copy. An interface: Copy as text. Links and images: Open in browser, Copy address. Elsewhere nothing. Option-right-click keeps the inspector in dev builds.
- **Icon**: a sibling of the Vakyartha mark (ink tile, ivory speech bubble holding the V, saffron line); the tray icon is its template version.
- **Checking UI**: the window is WebKit; `scripts/webkit-check.swift` renders and scripts pages off-screen as the window does. Debug builds run `VAK_DEBUG_JS` in the window for probes.
- **Release**: `npm run desktop:build` bundles the sidecar, the Node binary and npm (for integrations) (`tauri.release.conf.json`); a build without them tells you so at start.

## 4. FinOps

**FinOps is app-only**, not a framework responsibility. Settings → FinOps charts turn duration, context composition, repeated context, generated output, provider token/cache usage and estimated API cost, with turn details, work-type/conversation filters, task/run attribution, editable model rates and CSV export. Schedule run details can load a numeric usage summary on demand; missing measurements and prices stay unknown, and estimates exclude tool/server charges and do not enforce a spending ceiling. The sidecar observes its provider requests and saves numeric telemetry locally; old sessions are explicitly reconstructed with unknown token usage and paid spend. Details and limits: [FINOPS.md](FINOPS.md).


## 5. Agent tasks (first implementation slice)

Tasks are app-owned product records linked to the host's canonical sessions and interactive surfaces. The UI adds task creation, scoped capabilities, compact activity, one-time approvals, explicit result review, cancellation and revision-checked deletion. Runs continue across navigation while the app is running. Bound-field drafts persist locally and conflicting incoming values require an explicit choice. Completion requires a full-page user evidence review, tied to the current run and saved surface versions; it is explicitly not automatic verification. Acceptance leaves every surface interactive, and further actions create a continuation.

The framework supplies in-process execution, immutable views, session ownership protection, action release and idle-session/transcript removal. No second surface store or native execution relay is introduced. **Schedule** opens an overview with search, lifecycle filters, sorting and starter ideas. A full-page composer creates immediate work or a one-time future run; details show activity, timing, permissions, expandable per-run records and result access. Permission waits yield the execution slot and reacquire it with fresh authority checks. Upcoming work supports pause/resume, Run now and time changes. Missed times are held for review; local execution needs the app running and computer awake. Repeating schedules, chains and sustained long-term execution remain unbuilt. Detailed behavior, limits, evidence and remaining work are in [MVP-SPECS.md](MVP-SPECS.md), [MVP-CHECKLIST.md](MVP-CHECKLIST.md) and [ADR.md](ADR.md).
