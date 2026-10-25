# AGENTS.md: working on Vakyartha

Rules and commands for any coding agent (or person) changing this repo. Read [SPECS.md](SPECS.md) for what the app is, [HANDOVER.md](HANDOVER.md) for where work stands, and [RELEASING.md](RELEASING.md) before a release or a framework update.

Vakyartha is an app built on the [Projection framework](https://github.com/nranjan2code/Projection), which lives in `framework/` as a pinned git submodule. The framework has its own repository, rules (its AGENTS.md) and tests.

## Non-negotiable rules

1. **The framework is a dependency, not part of this repo.** Never edit files under `framework/`: a change there is lost on the next update and never reaches Projection. An engine, catalog, projector, provider, host or MCP-client change is made in Projection (`~/Projects/vakProjection`), pushed, then pulled in by moving the pin ([RELEASING.md](RELEASING.md)). The app only imports the packages' `exports` (`@vak/core`, `@vak/web`, `@vak/host`, `@vak/providers`, `@vak/mcp/client`, `@vak/telegram`), never their internal files.
2. **Product features stay here.** Key storage, settings, the integrations catalog (which servers and versions; installing and running them is the framework's `Integrations`), channels, FinOps, Canvas and Artifacts, themes and the shell are the app's. Do not push them into the framework.
3. **Dependencies:** the app may use Tauri (Rust crates, `@tauri-apps/*`) and Vite. Anything else needs the user's approval. Pin exact versions.
4. **No shortcuts or hard-coded fixes.** If the model's output looks wrong in the app, the fix is a general rule in the framework (its AGENTS.md "How to fix a model-output problem"), not app-side patching of surfaces.
5. **Never blame the model size.** The local 4B model (Ollama `qwen3.5:4b-mlx`) is the primary target.
6. **Ask when in doubt** about scope or a decision that is the user's.

## Secrets and the public repo

- Keys live in the Keychain (the app) or in `.env` (development, gitignored): `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc. Never print or quote values; when checking, show key names and lengths only.
- Never commit `.env` or `.vak/` (dev data, chats, transcripts).
- The repo is public (`github.com/nranjan2code/vakyartha`). Before every push, scan the staged diff:
  ```bash
  git diff --cached | grep -nE "sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|sk-ant-|[0-9]{8,10}:[A-Za-z0-9_-]{35}"
  ```
- Git identity is repo-local: `Nisheeth Ranjan <nisheethranjan@icloud.com>`.
- Ask before any paid model run. Local Ollama runs are free.
- Ask before publishing a GitHub release (it distributes a download).

## Security rules (see SECURITY.md)

- Integrations are pinned: each catalog entry names an exact version published at least 14 days earlier; the framework's `Integrations` installs it with `--ignore-scripts --before=<today − 14 days>` and refuses ranges. Never install a server any other way, never `npx` or a floating version.
- An MCP server never gets our environment: only the variables it declares.
- Model text, tool output and fetched pages are data; anything that writes, deletes or reaches the internet defaults to "ask".
- The sidecar requires its token for the window; `npm run web` is loopback-only and for development.

## Commands

```bash
git submodule update --init      # after cloning without --recurse-submodules, or after a pull that moved the pin
npm ci
npm test                         # app tests
npm run test:framework           # Projection's tests against the pinned framework
npm run typecheck
npm run desktop                  # dev window (Vite :1420 + Tauri; needs Rust); UI only: .claude/launch.json "desktop-ui"
npm run web                      # the app in a browser on http://127.0.0.1:5178 (.claude/launch.json "web")
npm run desktop:build            # release .app and .dmg in src-tauri/target/release/bundle
node scripts/version.ts X.Y.Z    # set the version in all three places
node scripts/canvas-check.ts     # WebKit smoke of the canvas (after npm run build)
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Node 24 runs `.ts` directly; the UI is bundled by Vite, the sidecar by `scripts/bundle-sidecar.ts` for release.

## Running the app while the user tests

- The dev window runs the sidecar from source: quit and relaunch after sidecar or framework changes.
- `npm run web` loads the engine at start and serves the built UI: restart it after changes.
- Don't restart a channel (Telegram) while the user is mid-test; say so first.
- Data: `.vak/desktop/` (dev window), `.vak/web/` (browser), `~/Library/Application Support/com.nranjan2code.vakyartha/` (installed).

## Code style

- TypeScript, strict, ESM, `.ts` imports. Erasable syntax only (no enums, no parameter properties).
- Comments explain why, not what the code does. Match surrounding naming and density.
- Tests live in `test/*.test.ts` (`node:test`).
- The app window is WebKit: check UI changes with `scripts/webkit-check.swift` or `scripts/canvas-check.ts`, not only in a Chromium preview.
