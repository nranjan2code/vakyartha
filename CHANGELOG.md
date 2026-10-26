# Changelog: Vakyartha

What changed in the app, newest first. Each release names the [Projection](https://github.com/nranjan2code/Projection) version it was built on; framework changes themselves are in Projection's CHANGELOG. Procedure: [RELEASING.md](RELEASING.md).

## Unreleased

- **Minimal surfaces:** Projection pin `4156e8f` (including styling commit `0b59e6f`) brings quieter cards, lighter type, compact actions, natural-height grids and inherited theme tokens. Existing app color themes and text-size preferences continue to control surfaces.

- **Exact comparison checks:** optional caller-supplied expected rows now check displayed identities, columns and typed scalar claims within the same run. Setup and details expose the fixed assertions. Form changes do not recalculate them; extra prose and provenance still need review.

- **Outcome evaluation:** passing automated checks now require semantic review. Reports show independent constraint references beside canonical visible rows; hidden/unused data no longer supplies output evidence. This does not certify generated recommendations.

- **Inline or canvas, by size:** small interfaces stay in the conversation again; tables, charts, tabs, maps, boards, long code, forms with more than five fields and large or long surfaces leave a reference card and open in the canvas (`src/placement.ts`). Growing past the limit while streaming moves a surface to the canvas; nothing jumps back. The canvas no longer opens before the first snapshot shows how big a surface is. Inline surfaces have no extra header; open one in the canvas from the reply's actions.
- **Reply actions for interfaces:** replies that are only an interface now get copy, read aloud and open in canvas; copy and speech use the interface's text.
- **Plain answers stay text:** the app's instructions now say when to answer without UI (greetings, thanks, small talk, a fact or short explanation, or a request for text), matching Projection's new prompt rule. A title the content repeats is no longer drawn twice.

- **Dictation:** a mic in the message box (⌘D) turns speech into text. This Mac's speech recognition is the free default and shows words as you speak; a hosted model (OpenAI GPT Transcribe / GPT-4o Transcribe / Whisper, Gemini's transcribe models, ElevenLabs Scribe) gets a 16 kHz recording when you stop. Enter finishes, Esc discards; a timer and a ring that follows your voice show it is listening. Settings → Voice → Dictation picks the model and language and can send when dictation ends. Ollama has no transcription model yet; its card says so. The desktop app asks for microphone and speech recognition access (Info.plist).
- **Message actions:** small icon buttons under each message, shown on hover and always on the latest reply: copy and read aloud on replies, copy and edit on your messages. Copy shows a check when done.
- Gemini's speech and transcription models now come from its model list, so retired names never appear.

- **Read aloud:** every finished reply has a speaker button (and Read aloud in its right-click menu); Settings → Voice turns it off, reads new replies automatically, and sets speed (0.75–2×, pitch kept). Voices are a new Voice category in Integrations, one card per provider: Ollama's Phonon on this Mac (free, private; one-click voice packs for English, five-language, French, German, Spanish and Portuguese, with their licences shown), OpenAI, Google Gemini and ElevenLabs. Each model shows only the controls it accepts: a style line with presets (OpenAI gpt-4o-mini-tts, Gemini), stability/similarity/style (ElevenLabs). Speech starts after the first sentence; the next piece is fetched while one plays. Hosted voices say they are paid and that the text leaves the Mac. A voice provider is one adapter in `sidecar/voice.ts`.

- **Research turns always answer:** searches no longer use up the steps a reply needs. When the tool budget runs out the model answers from what it gathered; a turn a limit ended stays marked ("step limit" or "tool budget") with a Continue button that carries on from its results. Task runs keep their last model request for that answer. Uses Projection `10e0d90`.

- **Visible notices:** checked result layouts can require bounded user-supplied labels such as fictional-data notices. Setup and details retain them; completion checks require their actual display. Labels do not verify provenance or factual correctness. Real-model evaluation still reports semantic contradictions as failures.

- **Independent outputs:** typed result layouts allow titles/layout wrappers around the separate form and table. Combined or ambiguous outputs still fail. Corrections name obsolete surplus surface IDs and report blank comparison cells with their column/row keys, without inventing values.

- **Result review:** the app now supplies the neutral review acknowledgement after substantive layout/source checks. A different final sentence no longer forces another generation that can damage valid output. Unverified provider prose remains private; source checks and explicit user acceptance still apply. Uses Projection `9d44982`'s compatible trusted-response callback.

- From Projection `ff9bfaa`: malformed keyless property groups no longer create extra inputs; explicit stringified list bindings retain live data references. Bound container mismatches are reported. Authoring/correction guidance preserves supplied values and patches existing IDs, with a bounded saved-surface inventory. Full render replacements and explicit empty lists keep their existing semantics; these repairs do not certify factual accuracy.

- From Projection `399a3a9`: tool generations rejected for malformed XML can recover within the existing run/request/time budgets before any call or text is received. Each retry passes through task admission and preserves earlier tool receipts. Partial streams, cancellation and unrelated provider failures still stop normally; unknown token usage stays unknown. Output correctness remains a separate check.

- From Projection `9c6a0ae`: schema-declared wrapped list references such as `rows: ["data/evidence"]` resolve to existing array data and retain live bindings. Literal paths and unresolved/scalar targets remain unchanged. Real outcome failures remain tracked separately.

- **Task progress:** opt-in response completion lets a task publish interfaces and continue work in the same bounded run. Ordinary chat keeps projection completion. Added repeatable local outcome evaluation using installed capabilities; current research/comparison failures remain documented in EVALUATION.md.

- **Task budgets:** configurable limits across all runs for requests, tool attempts and active time. Reservations persist before work, survive restart and count retries. Crash recovery keeps unfinished time charged; approval waits do not use active time. Setup and task/run details show the limits and counters. Task schema is v5, with no compatibility migration or automatic data deletion.

- **Spending policy:** tasks default to a local provider on loopback. Model API charges require explicit acknowledgement; changing models clears it. Strict monetary ceilings are rejected before execution because they cannot yet be enforced. Policies are rechecked at dispatch and provider construction. Task schema is v4, without migration or automatic data deletion.

- **Result review:** full-page evidence review replaces one-click completion. Record what you checked against the criteria; changed results require a fresh review. Accepted runs retain review notes and saved surface-version references. This records user acceptance, not automatic verification. Task schema is now v3, with no compatibility migration or automatic data deletion.

- **Task usage:** run-level model usage in Schedule, task/run attribution and filtering in FinOps, and matching CSV columns. Missing costs remain unknown; model estimates exclude tool/server charges and do not enforce a spending ceiling.

Built on Projection `9d44982`.

- **Schedule workspace:** calendar navigation, full-page creation, lifecycle filters/search, starter ideas, activity, permissions and result access. Immediate and one-time future runs share the task dispatcher; pause/resume, reschedule, Run now and guarded deletion are available. Missed times require review. Existing multiple interactive surfaces stay in the canonical workspace.
- **Task execution:** permission waits release the execution slot and resume the same call after fresh authority checks. Expandable run history records distinct attempts, outcomes, active time, tool counts and user acceptance. Task journal schema v2 is strict, with no prelaunch compatibility migration or automatic data deletion. Repeating schedules, chains and sustained retention remain planned.

- **Graph view:** asking to see something "as a graph" (your memory, an org chart, dependencies) draws an interactive node-and-edge diagram in the canvas: drag to pan, pinch or Ctrl/⌘-scroll to zoom, Fit, keyboard, draggable nodes, and selecting a node shows its notes. It fits split, full-screen and narrow windows, and reads as a list of connections on Telegram and in text.
- **Tavily integration:** Tavily's hosted MCP server joins Settings → Integrations: web search, page extraction, site map and crawl, and research reports. Add a Tavily API key (kept in the Keychain, sent as a header); every call asks first, as for any tool that reaches the internet. From Projection `c8e7245`: MCP servers whose event streams end lines in CRLF (Tavily's does) no longer hang.
- **Richer components on the local model:** the 4B model now gets the timeline, steps, map, code, gallery or graph component when you ask for one by name, instead of falling back to cards.

- **Integrations run on the framework:** installing, configuring and running MCP servers moved to Projection's `Integrations` (`@vak/mcp/client`); `sidecar/integrations.ts` keeps only the app's catalog. Nothing changes in Settings → Integrations, and servers already installed keep working (same folders and `integrations.json`). One visible detail: a server you add is described as "not reviewed" instead of "vak has not reviewed it".
- From Projection `c575cd2`: the surface you see no longer gets worse while a model retries.
- New `test/integrations.test.ts`: every catalog server pinned exactly; earlier saved state still loads.

## 0.1.0 (2026-10-25)

Built on Projection `e09b7ca` (no tag yet). The first release as Vakyartha: macOS, Apple silicon, unsigned (build from source, or allow it in System Settings → Privacy & Security).

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
