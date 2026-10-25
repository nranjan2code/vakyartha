# HANDOVER.md: Vakyartha, state of work (2026-10-25)

Start here in a new session. Rules: [AGENTS.md](AGENTS.md). App: [SPECS.md](SPECS.md). Releases and framework updates: [RELEASING.md](RELEASING.md).

## Handover prompt (paste into a new session)

```
Continue Vakyartha in /Users/nisheethranjan/Projects/vakyartha.

First read AGENTS.md (rules), SPECS.md (the app), HANDOVER.md (status and next steps) and RELEASING.md. Run `git submodule update --init`, `npm ci`, then `npm test`, `npm run test:framework` and `npm run typecheck`.

Vakyartha is the desktop app; the engine is the Projection framework (github.com/nranjan2code/Projection, locally ~/Projects/vakProjection), pinned as the `framework/` submodule. Never edit framework/: engine changes are made in Projection, pushed, then pulled in by moving the pin.

Rules that matter most:
- The app may use Tauri and Vite; anything else needs my approval.
- Never blame the small model: local Ollama `qwen3.5:4b-mlx` is the primary target. Ask before any paid model run.
- Secrets live in the Keychain or .env. Never print them; run the secret scan on the staged diff before every push. The repo is public: github.com/nranjan2code/vakyartha. Git identity: Nisheeth Ranjan <nisheethranjan@icloud.com>.
- The window is WebKit: check UI changes there.

Pick up from "Next" in HANDOVER.md, in order, and ask me if in doubt.
```

## Where things stand

- **Split from Projection (2026-10-25, user's request):** the app moved from `apps/desktop` in [Projection](https://github.com/nranjan2code/Projection) to this repository with its 7 commits of history (`git subtree split`), and lives at the repo root. `apps/playground` became `scripts/web.ts` (`npm run web`, :5178); Projection kept a framework-only viewer on :5177.
  - **Framework dependency:** `framework/` is a submodule of Projection pinned to a pushed commit; npm workspaces link `framework/packages/*`. `npm run test:framework` runs Projection's 197 tests against the pin. One way only: Projection does not reference the app beyond README/SPECS links.
  - **New identity** (user's choice, before the first Vakyartha release): `Vakyartha.app`, bundle ID `com.nranjan2code.vakyartha`, Keychain services `com.nranjan2code.vakyartha` (`.dev`, `.web`). Old installs (`vak.app`, `com.vakprojection.desktop`) are not migrated: keys are re-entered once. The user removed the old install for a fresh start; the old data folder `~/Library/Application Support/com.vakprojection.desktop` may still exist and is unused.
  - **Release procedure** written in RELEASING.md (SemVer, `scripts/version.ts`, checklist, framework updates); app docs (SPECS, SECURITY, AGENTS, this file, CHANGELOG) are the app's own.
  - **First local install (RELEASING.md steps 1–6, 2026-10-25):** built from `27c8d63` on Projection `0dc3e49` (the last pre-split commit; its `apps/` folder is unused). Checks: 197 framework + 11 app tests, typecheck, WebKit canvas smoke (wide/narrow), Rust lib test. `npm run desktop:build` → `Vakyartha.app` (133 MB) and `Vakyartha_0.1.0_aarch64.dmg` (42 MB); installed to `/Applications/Vakyartha.app` (`com.nranjan2code.vakyartha`, 0.1.0). The bundled engine was smoke-tested headless: 401 without the token; with it the local 4B answered with a surface and the chat was saved. Not yet checked by eye: the window, About page and Keychain entry of the installed app. Not tagged or published.
  - **Pin moved to Projection `e09b7ca`** (the split commit, pushed): the framework checkout no longer contains the old `apps/` folder. Rechecked: 197 framework + 11 app tests, typecheck, Vite build, Rust lib test, sidecar bundle, WebKit canvas smoke.
  - **0.1.0 released locally and tagged** (2026-10-25): `Release 0.1.0` (`e138578`) built with a fresh `npm ci`, installed to `/Applications/Vakyartha.app` (com.nranjan2code.vakyartha 0.1.0) and smoke-tested (bundled engine: 401 without the token; the local 4B answered with a surface). Tag `v0.1.0` pushed. No GitHub release yet.
  - Verified after the split: 11 app tests, 197 framework tests, typecheck, Vite build, `cargo check`.
- **Canvas reopening fix:** all live artifacts, including updates to existing ones, open in the canvas. `vak_render`/`vak_update` tool-start opens a pending panel before the first snapshot; the snapshot selects the actual target. Manual close suppresses reopening for the current turn, and the next request can reopen it. Saved history does not auto-open every artifact. Added deterministic SSE checks for early opening, target selection, manual close and failure cleanup in the wide/narrow WebKit smoke. 208 tests (then one repository), typecheck and WebKit checks pass; fresh release rebuilt and installed to `/Applications/vak.app` (pre-split name), then relaunched. No paid model runs.

- **Canvas and Artifacts:** app-only canvas beside chat, with a dedicated **Artifacts** page (one sidebar entry), metadata cards across saved chats, search/type filters/sorting/pagination, and reopening into the originating chat. The chat shows artifact reference cards only (user correction after seeing duplicate inline content); full content lives exclusively in the canvas and stays hidden when closed. The canvas moves the live surface rather than duplicating it, preserving drafts/actions; includes Preview/Text, copy, native/browser Markdown download, a surface picker, resize, full/split view, and shortcuts. Artifact render/update tool-start opens the canvas with progress; the first snapshot selects the correct artifact, and subsequent snapshots paint there. Manual close is respected for the remainder of that turn, and the next turn can reopen it. History redraws only restore the saved selection. Host session listing adds lightweight `surfaceSummaries` without messages/data. Research and verification: [CANVAS.md](CANVAS.md); deterministic wide/narrow WebKit smoke: `node scripts/canvas-check.ts` after the UI build. No paid model calls. Verified: 208 Node tests (then one repository) and typecheck pass; WebKit smoke passes at 1100px and 620px (including a 27-item library); native export test passes (path confinement, duplicate names, existing files and symlinks). `npm run desktop:build` produced the `.app` and `.dmg` successfully. Follow-up correction: chat now shows only artifact reference cards; closing the canvas keeps content hidden and preserves drafts. Rebuilt the release and installed it to `/Applications/vak.app` (pre-split name), then relaunched locally. Verified in the installed app with the saved article: chat shows only its reference card, opening displays the article in the canvas, closing hides it again. The 208 tests (then one repository), typecheck and wide/narrow WebKit smoke checks pass.

- **Desktop FinOps:** Settings → FinOps now has duration, context composition, repeated context, output shape, token/cache and estimated-cost charts, per-turn details, a chat filter, editable model rates and CSV export. This is app-only; keep accounting and prices out of the projection framework. Provider requests are observed by an app wrapper; telemetry is numeric and local. Old sessions are reconstructed with unknown usage/spend. See [FINOPS.md](FINOPS.md). Verified against a copy of the installed app's 22 turns (555s); WebKit rendered six charts with no horizontal overflow and turn selection worked. Five accounting tests include an authenticated HTTP chat against a local fake provider (no paid model call). Full suite: 194 passing, typecheck and UI build clean. The installed release needs a new build to include this feature.


## Done before the split (in Projection, as `apps/desktop`)

- **One interface:** the playground now runs the desktop app's server (`apps/desktop/sidecar/server.ts`) open on :5177 and serves the same built UI; the old playground UI is gone. `?session=` opens a chat; surfaces projected from outside (MCP, `/api/project`) appear live and their actions reach the outside agent.
- **App:** new icon (a sibling of the Vakyartha mark: ink tile, ivory speech bubble with the V, saffron line), tray icon from it, mark in the sidebar and empty screen; sidebar collapse/expand buttons; settings rows and selects laid out the same in WebKit and Chromium; UI errors go to the engine log; debug builds can run a probe script in the window (`VAK_DEBUG_JS`). Built and installed to /Applications.
- **Open from the user's testing:** "clicking doesn't change appearance" could not be reproduced (works in Chromium, off-screen WebKit, a `tauri://` WebKit harness, the dev window and a release-layout debug bundle); the reinstalled app now logs UI errors, so a repeat shows its cause in the engine log.

- **Desktop app, everyday-driver round (user's review, 2026-10-25):**
  - Host hardening: JSON-only bodies, Origin and Host checks (CSRF and DNS rebinding against the open playground), constant-time token check; session index (no full re-read per list), idle eviction (24 loaded), rename route.
  - Desktop: context window (last 10 turns by default), "Ollama isn't running" hint, Keychain for keys, engine log file, single instance, tray with close-to-background, Dock reopen, launch at login, graceful sidecar stop, a guard for builds without the engine.
  - Providers: 11 labs as declared OpenAI-compatible presets; Settings generated from the registry. The model list in Settings is the provider's own, fetched with its key (Ollama: installed models); nothing is pre-selected from an alphabetical list.
  - Channels: Telegram runs inside the app (`runTelegram`, shared with the script), off by default, own model; Slack/Discord slots listed as coming.
  - Settings is a full page with sections; themes (6, light-dark pairs) and text size, applied to surfaces too; desktop-style right-click everywhere.
  - Verified in the browser pane with a live sidecar and the 4B model (chat, Keychain round-trip with a dummy key, themes, menus, rename); release `.app` built; single instance and quit checked. Not checked live: the tray, close-to-background and launch at login (need the real window), and the Telegram channel turned on (it would poll the real bot).

- **Desktop app (user's request, 2026-10-25): `apps/desktop`**, a separate product on the framework, for everyday use.
  - Stack, chosen for late October 2026: Tauri 2.12 (stable; 3.0 is still alpha), Vite 8, plain TypeScript UI (the content is already the `<vak-surface>` Web Component, so no UI framework), the engine as a Node 24 sidecar (the providers need `node:fs`/`node:net`, so the engine stays on Node unchanged).
  - New framework package `@vak/host`: the playground's API extracted (chat, calibrate, project/actions/events, profile, models) plus saved sessions with a redraw timeline, bearer-token auth, CORS allowlist and app routes. The playground is now a thin wrapper; its behaviour is unchanged. `VakClient` takes headers.
  - UI (after the user asked for minimal): sidebar of chats grouped by date, thread, composer with a model picker; provider/model, plan, calibration, API keys/endpoints and advanced generation options in Settings. Engine notes are hidden unless turned on in Settings.
  - Verified in the browser pane against a live sidecar with the 4B model: dashboard rendered, chat restored after reload, signup form submitted and confirmed. Release `.app` built with the bundled Node and sidecar.
  - AGENTS.md rule 1 now names the exception: `apps/desktop` may use Tauri and Vite; `packages/*` stay dependency-free.

## Next (in order)

1. **GitHub release for v0.1.0** (only when the user says so): RELEASING.md step 8 with `Vakyartha_0.1.0_aarch64.dmg`, marked unsigned.
2. **Canvas check flake:** `scripts/canvas-check.ts` failed once (stack trace ending in `processTicksAndRejections`, not captured in full) right after repinning, then passed three runs in a row. If it recurs, capture the full output and find the timing cause.
3. **Ask the user to retry Appearance in the installed app**; if it still fails, read `logs/engine.log` in the data folder (`[ui error]` lines).
4. **Integrations, next:** OAuth for remote servers (Linear, Notion remote), an update check against newer pinned versions, macOS sandbox profiles for local servers. OAuth in the MCP client itself is a Projection change.
5. **Move the pin to a Projection tag** once Projection tags its first release.
6. **Optional, ask first:** code signing/notarization and auto-update; CI for releases; Windows/Linux builds.

## Useful paths

- Dev data: `.vak/desktop/` (sessions, settings, integrations, `logs/engine.log`, `logs/tools.jsonl`); browser: `.vak/web/`; installed app: `~/Library/Application Support/com.nranjan2code.vakyartha/`
- Release bundle: `src-tauri/target/release/bundle/{macos,dmg}/`
- WebKit check: `scripts/webkit-check.swift` (off-screen WKWebView; usage in its header); canvas smoke: `scripts/canvas-check.ts`
- Raw model output per session: `.vak/desktop/transcripts/`, `.vak/web/<session>.jsonl` (replay them in Projection to fix engine issues)
