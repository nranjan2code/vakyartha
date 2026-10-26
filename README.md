<p align="center"><img src="public/icon.svg" width="96" alt="Vakyartha"></p>

<h1 align="center">Vakyartha</h1>

<p align="center"><b>Ask. Then go live your day.</b><br>
An AI helper that stays with the work: everyday jobs, unfinished plans, and what comes next.</p>

<p align="center"><a href="https://vakyartha.com">vakyartha.com</a> · <a href="#get-started">Get started</a> · <a href="#where-the-rebuild-stands">Where the rebuild stands</a> · <a href="#your-control">Your control</a> · <a href="#develop">Develop</a> · <a href="LICENSE">MIT license</a></p>

---

From *Vākyārtha*, the meaning of a sentence. You bring an idea in your own words; Vakyartha helps carry its meaning into useful work, from the first thought to the next step.

1. **Bring what you have.** A rough idea, a document, a spreadsheet. Start with what you want to get done.
2. **Make something useful.** Answers come back as interfaces you can use, not just read: cards, tables, charts, dashboards, forms and buttons, opened in a canvas beside the conversation.
3. **Keep your say.** You choose which tools and services it can reach, approve what writes or goes online, and see what every turn cost.

This repository is the **rebuild** of the app described on [vakyartha.com](https://vakyartha.com): a desktop app (macOS first) with a local model as the primary target (Ollama `qwen3.5:4b-mlx`) and hosted providers when you want them. It is built on the **[Projection framework](https://github.com/nranjan2code/Projection)** (`@vak/*`), the engine that parses, repairs and projects model-written interfaces, pinned here as a git submodule.

## Where the rebuild stands

The site describes where Vakyartha is going. Here is what this repository does today.

| On vakyartha.com | In this rebuild |
|---|---|
| Ask, and get something you can use | **Works.** Answers project as live surfaces; chats are saved; an **Artifacts** library gathers every surface across chats and reopens it in the canvas. |
| Your choice of models | **Works.** Local models through Ollama; 11 hosted providers with keys in the macOS Keychain. |
| Connected tools and services | **Works.** A curated integrations catalog (Web pages, Time, Files, Memory, Brave Search, Tavily, GitHub, Notion, Context7), each pinned, with per-tool policies and approvals. |
| In your everyday chat | **Telegram works**, answered from the menu bar while the window is closed. Slack and Discord are listed as coming. |
| Spending limits and usage | **Usage works:** Settings → FinOps charts tokens, context and estimated cost per turn. Spending limits are not built yet. |
| Agent tasks | **First slice works:** Schedule provides full-page setup, lifecycle views, immediate and one-time future runs, review, continuation, per-run records, shared execution limits and guarded deletion. Results reuse the interactive canvas. Repeating schedules, task chains and long-term run history are not built yet. |
| Pick up the thread (commitments) | Not yet. |
| Vakyartha and seven companions | Not yet. |
| Headless & Cloud, scheduled routines | Not yet. `npm run web` serves the same app on loopback for development only. |
| Voice | **Works.** Replies read aloud as natural speech, interfaces included, by a voice in the reply's language. Dictation in the message box. Conversation mode (⌘⇧D) talks hands-free: approvals, choices and forms are answered in your own words, read back, then acted on exactly as a click. All run free on this Mac (Phonon through Ollama; Whistle for dictation) or through a hosted provider with your key. |
| Email and calendar | Not yet. |
| macOS and Linux | macOS only so far. |
| `vak setup`, `vak doctor`, `vak serve` | Those belong to the [earlier codebase](https://github.com/nranjan2code/code) the site still links to; the rebuild installs from source as below. |

## Get started

Open source under MIT. Download the latest Apple-silicon build from [Releases](https://github.com/nranjan2code/vakyartha/releases) (unsigned and not notarized: quit any running Vakyartha first, drag it to Applications, then allow it in System Settings → Privacy & Security), or build it from source.

You need **macOS**, **Node.js 24+**, npm, **Rust** (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). For a free local model, run [Ollama](https://ollama.com) with `qwen3.5:4b-mlx` (or any installed model). Hosted AI services may charge for use.

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

Builds are not code-signed or notarized yet: install only what you built yourself. Add hosted provider keys in **Settings → Providers**. The release procedure is in [RELEASING.md](RELEASING.md).

## Your control

- **You choose the access.** Apart from the built-in clock (Time), integrations stay off until you turn them on; each declares what it can reach, and the Files server is limited to the folders you pick.
- **Actions follow your rules.** Anything that writes, deletes or reaches the internet asks first; each tool's policy can be allowed, ask or blocked. Model text, tool output and fetched pages are treated as data, never as instructions.
- **Servers are pinned.** Each integration is a fixed version published at least 14 days earlier, installed without install scripts, and given only the environment variables it declares.
- **Your work stays on your Mac.** Chats, artifacts and usage records live in the app's data folder; keys live in the Keychain. Requests go only to the providers and services you connect, and a local model keeps them on your machine.
- **You can follow the outcome.** Every tool call is logged to `logs/tools.jsonl`; the engine window is token-protected.

Details: [SECURITY.md](SECURITY.md).

## Develop

```bash
npm run desktop          # dev window: Vite on :1420 + Tauri; the engine runs from source
npm run web              # the same app in a browser on http://127.0.0.1:5178 (builds dist/ first)
npm test                 # app tests
npm run test:framework   # Projection's tests against the pinned framework
npm run typecheck
```

For development, provider keys can also go in a local `.env` (see [`.env.example`](.env.example)). Changes to the engine belong in [Projection](https://github.com/nranjan2code/Projection), never in `framework/`; [RELEASING.md](RELEASING.md) explains how to pull them in. Working rules: [AGENTS.md](AGENTS.md).

### How it fits together

| Part | Where | What |
|---|---|---|
| Framework | `framework/` (submodule) | Projection: engine, catalog, projectors, providers, `@vak/host`, MCP client and `Integrations`, Telegram runner |
| Shell | `src-tauri/src/lib.rs` | starts the engine, hands the window its address and token, tray, close-to-background, single instance, launch at login, graceful stop |
| Engine | `sidecar/main.ts` → `sidecar/server.ts` | `@vak/host` plus settings, channels, integrations, client-log and info routes; token-protected for the window, loopback-only for `npm run web` |
| Settings store | `sidecar/settings.ts` | provider and channel keys in the Keychain; plain values in `settings.env` |
| Integrations | `sidecar/integrations.ts` | the app's catalog (which servers, pinned versions); installing and running them is Projection's `Integrations` |
| FinOps | `sidecar/finops.ts`, `src/finops-page.ts` | local usage ledger, model rates, per-turn charts and CSV export ([FINOPS.md](FINOPS.md)) |
| Channels | `sidecar/channels.ts` | Telegram (`runTelegram`); Slack and Discord slots |
| UI | `src/` | chats, thread, composer, approvals, canvas and Artifacts ([CANVAS.md](CANVAS.md)), Settings, themes, right-click menus |
| Release | `scripts/bundle-sidecar.ts`, `src-tauri/tauri.release.conf.json`, `scripts/version.ts` | the engine as one module with Node and npm; one version everywhere |

### Data

| | Dev (`npm run desktop`) | Installed app | Browser (`npm run web`) |
|---|---|---|---|
| Folder | `.vak/desktop/` | `~/Library/Application Support/com.nranjan2code.vakyartha/` | `.vak/web/` |
| Keys | Keychain `com.nranjan2code.vakyartha.dev` + `.env` | Keychain `com.nranjan2code.vakyartha` | Keychain `com.nranjan2code.vakyartha.web` + `.env` |

Each folder holds `sessions/`, `integrations/`, `integrations.json`, `channels.json`, `settings.env`, `logs/engine.log` (engine and UI errors) and `logs/tools.jsonl` (every tool call).

### Debugging

- **Engine log:** Settings → About → Engine log, or `logs/engine.log` in the data folder.
- **The window is WebKit, not Chromium.** Check layout with `scripts/webkit-check.swift` and `node scripts/canvas-check.ts` after `npm run build`.
- **Probe the real window** (debug builds): `VAK_DEBUG_JS=/path/probe.js npm run desktop`.
- **Inspector:** Option-right-click in a dev build.

## Documentation

- [SPECS.md](SPECS.md): what the app is, its framework dependency and identity.
- [MVP-SPECS.md](MVP-SPECS.md), [MVP-CHECKLIST.md](MVP-CHECKLIST.md) and [ADR.md](ADR.md): agent MVP implementation, preserved interactive surfaces, architecture decisions, progress gates and later scope.
- [RELEASING.md](RELEASING.md): releasing the app and updating Projection.
- [AGENTS.md](AGENTS.md) and [HANDOVER.md](HANDOVER.md): working rules and where work stands.
- [SECURITY.md](SECURITY.md), [CANVAS.md](CANVAS.md), [FINOPS.md](FINOPS.md) and [CHANGELOG.md](CHANGELOG.md).
- The framework: [Projection](https://github.com/nranjan2code/Projection).

## Contributions and license

Maintainer-developed; external contributions are not accepted (see [CONTRIBUTING.md](CONTRIBUTING.md)). Copyright © 2026 Nisheeth Ranjan, released under the [MIT License](LICENSE).
