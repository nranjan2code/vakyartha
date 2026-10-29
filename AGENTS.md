# AGENTS.md: working on Vakyartha

Rules and commands for any coding agent (or person) changing this repo. Read [SPECS.md](docs/SPECS.md) for what the app is, [HANDOVER.md](docs/HANDOVER.md) for where work stands, and [RELEASING.md](docs/RELEASING.md) before a release or a framework update.

Vakyartha is an app built on the [Projection framework](https://github.com/nranjan2code/Projection), which lives in `framework/` as a pinned git submodule. The framework has its own repository, rules (its AGENTS.md) and tests.

## Non-negotiable rules

1. **The framework is a dependency, not part of this repo.** Never edit files under `framework/`: a change there is lost on the next update and never reaches Projection. An engine, catalog, projector, provider, host or MCP-client change is made in Projection (`~/Projects/vakProjection`), pushed, then pulled in by moving the pin ([RELEASING.md](docs/RELEASING.md)). The app only imports the packages' `exports` (`@vak/core`, `@vak/web`, `@vak/host`, `@vak/providers`, `@vak/mcp/client`, `@vak/telegram`), never their internal files.
2. **Product features stay here.** Key storage, settings, the integrations catalog (which servers and versions; installing and running them is the framework's `Integrations`), channels, FinOps, Canvas and Artifacts, themes and the shell are the app's. Do not push them into the framework. OS sandboxing uses the separate [vak-sandbox](https://github.com/nranjan2code/sandbox) project integrated via framework support and app configuration.
3. **Dependencies:** minimize third-party SDKs, packages, crates, services and build tools. Reuse existing code and standard libraries; build small, maintainable capabilities in-repo where practical. The app may use its established Tauri (`@tauri-apps/*` and shell crates) and Vite stack; this is not blanket approval for new crates or plugins. Any other new dependency needs the user's approval before installation or adoption. Pin exact versions. Review provenance, transitive dependencies, lockfile changes and install/build scripts; a version pin or package age alone is not evidence of safety. Do not copy or vendor unreviewed external code as a way around this rule, and do not invent cryptography or authentication protocols to avoid a dependency.
4. **No shortcuts or hard-coded fixes.** If the model's output looks wrong in the app, the fix is a general rule in the framework (its AGENTS.md "How to fix a model-output problem"), not app-side patching of surfaces.
5. **Never blame the model size.** The local 4B model (Ollama `qwen3.5:4b-mlx`) is the primary target.
6. **Ask when in doubt** about scope or a decision that is the user's.
7. **Product and planning documents use our own capability language.** Do not name third-party products or competitors in product specifications, design comparisons, roadmaps or checklists. Preserve the existing interactive surfaces and multiple-surface support when planning agent work; read [AGENT-TASKS.md](docs/AGENT-TASKS.md) and track changes in [IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md). Add to Projection only after identifying a required general capability missing from its public API.
8. **Choose runtime boundaries deliberately (The Indestructible Rust Engine vs. Runtime Flexibility).** 
   - **Rust (The Indestructible Engine & Root of Trust):** Must remain unmutable, non-destroyable, and secure in any condition, even if the TypeScript worker or untrusted model execution is fully compromised. Rust owns: process supervision and graceful shutdown, private anonymous IPC pipes, platform windowing/tray/autostart, cross-platform credential vault (macOS Keychain, Linux Secret Service/owner-only 0600 store, Windows user-isolated vault), outbound network egress gating against approved providers, user approval enforcement (all mutations and egress default to Ask), and safe Downloads file export.
   - **Non-Rust / TypeScript (Runtime Flexibility):** Fast-evolving execution and presentation layer. Owns: agent reasoning loop, surface projection, dynamic canvas, interactive UI elements, skills, voice, channels, FinOps usage ledger, and sandboxed tool execution.
   - **Clean Architecture Principle:** There are 0 active users; do not retain stale code, deprecated shims, or backwards compatibility compromises. Keep one persistence writer per entity, narrow validated boundaries, and no ambient authority in the execution worker (ADR-044, ADR-050, ADR-052). See the task contract's runtime placement requirements in `docs/AGENT-TASKS.md`.
9. **Pluggable capabilities:** memory, reusable context and external tools use the existing MCP catalog/lifecycle with user-selected or user-configured servers. Prefer verified free choices. Do not build a parallel memory/retrieval database or plugin marketplace. Task checkpoints, approvals and recovery remain app-owned local state. See [ADR.md](docs/ADR.md).

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
- The desktop sidecar uses Tauri-owned private pipes and main-window IPC with no network listener; the host admission token stays in the engine. `npm run web` is loopback-only and for development.

## Outcome acceptance gate

For model-output work, prove the smallest real primary-provider contract before expanding the workflow. Run the matching Projection gate in its owning repo (`node scripts/record-view-check.ts --run-local --table-only` for record mappings, `node scripts/provider-contract-check.ts --run-local` for free-form graph authoring; source-backed tasks also retain their original independent source/value/receipt checks), retaining failures in other capabilities as open, then independently check the original task’s sources, values, interpretation, interactions and output receipt. Native tool schemas are guidance unless actual schema decoding is used. Retain failed evidence and freeze outcome checks before evaluation; do not weaken requirements after failure. Passing tests, safe rejection, a committed change or an installed build never closes a failed user-outcome gate. Diagnose the earliest boundary offline instead of accumulating prompt/parser variants. Do not call the repair complete until the original outcome passes; record partial mechanism improvements separately. Apply this gate in handover and release notes as well as code review.

## Skills, reports and dynamic surfaces

Before changing skill behavior or building a dashboard, report, form, table or chart workflow, read [SKILL-AUTHORING.md](docs/SKILL-AUTHORING.md). It is the maintained method: domain procedures chain to enabled `interactive-ui` and `surface-design`, one canonical data owner feeds visual and spoken projections, and existing integrations/tasks keep execution authority. [SKILLS.md](docs/SKILLS.md) owns loading/import/update contracts; [CANVAS.md](docs/CANVAS.md) owns placement and interaction. Read the chart support matrix before promising a specialist visualization. Do not rebuild a domain compiler, expression engine, connector path or narration store for a new report type. Update the guide when changing the method; put verification/current state in [HANDOVER.md](docs/HANDOVER.md) and [EVALUATION.md](docs/EVALUATION.md).

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
node scripts/surface-design-check.ts # mixed layouts + every standard chart kind in WebKit
node scripts/skills-check.ts     # reviewed built-in updates, wide/narrow WebKit
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Node 24 runs `.ts` directly; the UI is bundled by Vite, the sidecar by `scripts/bundle-sidecar.ts` for release.

## Running the app while the user tests

- The dev window runs the sidecar from source: quit and relaunch after sidecar or framework changes.
- `npm run web` loads the engine at start and serves the built UI: restart it after changes.
- Don't restart a channel (Telegram) while the user is mid-test; say so first.
- Data: `.vak/desktop/` (dev window), `.vak/web/` (browser), `~/Library/Application Support/com.nranjan2code.vakyartha/` (installed).

## UI density and collections

Short content must not acquire a fixed hero height, empty spacer nodes or nested decorative cards. Projection owns general surface geometry; shell libraries use the shared local pagination helpers. Long collections need bounded browsing/search without discarding canonical records. Use accessible utility icons with tooltips and focus states where meaningful; retain clear primary action text. Verify wide and narrow WebKit geometry and exact page/filter behavior with `scripts/control-layout-check.ts` and `scripts/collection-ui-check.ts` alongside the existing Canvas/Skills checks.

## Code style

- TypeScript, strict, ESM, `.ts` imports. Erasable syntax only (no enums, no parameter properties).
- Comments explain why, not what the code does. Match surrounding naming and density.
- Tests live in `test/*.test.ts` (`node:test`).
- The app window is WebKit: check UI changes with `scripts/webkit-check.swift` or `scripts/canvas-check.ts`, not only in a Chromium preview.
