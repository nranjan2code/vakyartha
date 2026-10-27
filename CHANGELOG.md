# Changelog: Vakyartha

What changed in the app, newest first. Each release names the [Projection](https://github.com/nranjan2code/Projection) version it was built on; framework changes themselves are in Projection's CHANGELOG. Procedure: [RELEASING.md](docs/RELEASING.md).

## Unreleased

- Add `sandbox` built-in skill teaching the LLM when and how to use OS-level process isolation. On/off supported via Settings → Skills.

- Integrate vak-sandbox for OS-level process isolation of MCP servers (macOS Seatbelt). Add sandbox integration in app catalog, Tauri dependencies, and framework MCP client support. See [docs/sandbox/OVERVIEW.md](docs/sandbox/OVERVIEW.md).

- Adopt pushed Projection `d330d99`: common surface-property guidance is emitted once instead of repeated in every strict component branch, reducing the primary local core-tier tool definition by 4,392 characters. The required record-view model gate still fails; this is a measured context-size improvement, not a proven latency or authoring-outcome pass.
- Preserve standard optional skill frontmatter in Settings edits, show license/author metadata/requested tools without granting access, and import reviewed UTF-8 script source as inert supporting text. Binary assets and script execution remain unsupported. Pinned external reviews and responsive WebKit checks cover the declared subset.
- Selecting a provider in Settings now applies its displayed installed/default model to the composer. Previously the model row could show the local model while a new chat still used the earlier hosted model.

- Bundle all 27 defaults as Agent Skills folders with reviewable text references. Rebuild `market-dashboard` as a reusable evidence-first Projection template with a layout checklist and fictional example; Settings previews package updates. The bounded local supplied-data dashboard passed. Real source-backed market work is deferred; its historical failures remain recorded. Adopt Projection `dab83cf` for positional mapped-table total rows; its broader local gate remains 2/3.

- Catalog skills now retain reviewed supporting text at the pinned commit. Settings shows included and omitted files, exact text previews, compatibility notes and concise detail navigation; the assistant can read integrity-checked files only after loading that skill in the current run. Script execution and binary assets remain unavailable. [ADR-040](docs/ADR.md#adr-040-standard-skill-packages-app-owned-capabilities-2026-10-27) records the package baseline and app-owned extensions. Three fresh local-model web sessions passed the file-reading gate.
- Make `surface-design` a required, always-on skill. The Skills UI and sidecar prevent disabling/removal, restore it from older state, and inject its reviewed guidance for surface-authoring requests across app, voice and channel providers. Canvas-capable built-ins now refer to the shared guidance; release checks cover responsive UI, API enforcement and chart/surface rendering. See [ADR-039](docs/ADR.md#adr-039-surface-design-is-a-required-shared-authoring-contract-2026-10-27).
- Add shared surface-design and Vakyartha skill-creation guidance, operational/sales/finance dashboards, periodic reporting, daily news, market review, data review, tracking, meeting actions and research briefs. Existing procedures reuse the same data/action/design skills; no new domain runtime or tool authority. [Authoring guide](docs/SKILL-AUTHORING.md) is discoverable from README, AGENTS, specs and canvas docs.
- Adopt pushed Projection `c045a3c` for semantic measures across components, stable explicit grid columns, responsive alignment and bounded chart sizing/redraw. Strengthen app typography/spacing tokens. The chart support matrix distinguishes eight standard kinds from unsupported specialist/statistical capabilities.
- Preserve decimal findings in the short spoken projection; reports use one canonical surface for visual and spoken content. Source-only verification does not replace the installed app or close the failed primary-local mapped-table gate (one of three cases passed). No paid run, new dependency or recurring-delivery claim.

- Adopt pushed Projection `adf0604`: validate supported native tool arguments before effects, preserve MCP errors/denials, invalidate stale integration handles/grants, recheck approval authority, abort/cap MCP transport work and bound Retry-After retries. Incomplete native calls and ambiguous tool names dispatch nothing. Task receipt wrapping preserves structured tool results. No new dependency or compatibility shim.
- Stale enabled-skill context fails explicitly; root-level skill reviews correctly disclose omitted supporting files. [Pipeline review](docs/PIPELINE-REVIEW.md) records execution flow and remaining capability limits.163 app/393 framework tests, typechecks, framework package/UI builds and wide/narrow canvas WebKit pass. Source adoption only; installed build and prior live outcome failures remain as recorded.

- Built-in skills have an Updates filter, Update available badges, current/proposed previews and explicit update actions. New skills seed once; edits/removals and on/off choices are preserved, and stale previews are rejected. Wide/narrow WebKit covers the update flow. Catalog pins are not silently advanced.

- Skill-led authoring uses shared record mappings for forms, tables, charts and metrics. The old CSV bridge, source options, derive/prepare tools and automatic source-report compiler are deleted; no compatibility wrapper or new source executor remains.
- Chat/tasks select enabled skills in a counted generation. Local context loading remains available with zero external-operation allowance and consumes answer-step limits. Selection, usage and external permissions retain their proper owners.
- The interactive-ui skill is reduced from355 to222 words and permits separate datasets for unrelated views. Runtime prompts now have one owner per active protocol. Removed the compact/strict runtime setting, context-erasing latest-message-only advice and conflicting research row instructions.
- Root/descendant tool schemas share one definition, reducing the native authoring schema from roughly66k to34k characters. Distinct form fields with the same leaf name submit canonical pointer keys instead of overwriting one another.
- Fresh authorized Luna trial passes initial authoring, local table/chart/total updates, all three submitted counts, visible acknowledgement and independent notes preservation. Actual retained output passes WebKit at1100px/620px. Earlier failed trials remain recorded; this is bounded evidence, not broad reliability or a local-model pass.
- Projection `6ca8487` is pushed/adopted.383 framework tests/replay,161 app tests, typechecks/builds and wide/narrow task/canvas WebKit pass. OpenAI uses Responses with no Chat Completions fallback; compatible-provider routes remain explicit. Fresh local build installed and verified (1,931 matching files/links, skill updates, About/runtime and local-model Ready/canvas smoke). See [evaluation](docs/EVALUATION.md) for exact receipts and unresolved outcomes.

- Transactional table authoring uses positional cell arrays, so row keys cannot drift from column keys. Resolved bindings are checked before admission. Rejected-candidate feedback no longer treats private IDs as saved surfaces.

- Projection `9b7af0b` enforces transactional arguments through advertised provider schema decoding, recursively types inline nodes, requires complete replacement data/required props and generates initial surface identities. Added outcome acceptance rules: mechanism tests/builds/installations cannot close a failed end-to-end repair.

- Checked tasks submit inline multi-surface replacements, targeted patches and removals as one validated transaction. Rejected candidates leave accepted results intact; stale/incomplete/mixed batches cannot publish. Accepted submissions finish without an extra generation. Existing interactions and canonical surfaces remain. The unused constrained-call experiment is removed from Projection.

- Checked tasks validate complete results at completion, allow sequential surface authoring and suppress dependent diagnostics when surface roles are ambiguous. Supplied initial control values remain asserted without rewriting output. Repeated unchanged rejected completions stop early; unknown engine endings cannot save or present a result for review. Native/inline authoring remains in use; the experimental constrained-call transport is not enabled for tasks.

- **Projection `e4eec18`:** correction lint checks the actual form/action submission scope, preserves usable published forms against scope-breaking retries, supplies bounded structural feedback and favors ID-only correction patches. Inline child identity and custom-summary/automatic-total guidance are clearer. Exact retained file-report edits and the replay gate cover these general repairs.

- **Bundled engine:** Node 24.22.1 (LTS security release) with npm 11.19.1. Release builds now refuse a Node that is not Foundation-signed, not LTS, or not its line's newest release; release builds are optimised for speed (`opt-level = 3`). [RELEASING.md](docs/RELEASING.md#the-bundled-node-engine).

- **Window chrome:** the traffic lights are centred in the 40px title bar on the same line as the sidebar hide/show buttons; the logo moved from the sidebar top to the right of Settings.

- **Interface font:** the app and generated interfaces use Inter 4.1 (variable upright and italic, SIL OFL, bundled under `public/fonts/` with its licence; no network font), with tabular numbers in answer tables.

- **Response typography:** text answers style headings, lists, links, inline code, code blocks, quotes, rules and tables with one rhythm instead of browser defaults.

- **Composer:** the model picker sits below the input bar on the right and opens a compact menu grouped by provider, with numbered shortcuts, keyboard navigation and More models; the conversation and the input bar share one column width so their edges line up.

- **New chat screen:** a quieter time-of-day greeting and five ideas drawn from a mix of everyday and technical starters. Choosing one fills the message box to edit before sending instead of sending at once.

- **Skills:** Settings → Skills installs, writes, edits and toggles `SKILL.md` instruction skills. Enabled skills are indexed in the system instructions and loaded on demand with `use_skill`, so they chain with each other and with integration tools without granting access. A catalog of six publisher repositories (plus any `owner/repository`) reads skills at a commit at least 14 days old; review shows the exact text and bundled files (never imported); added skills start off. Fourteen built-in skills ship on. [Guide](docs/SKILLS.md).

- **Settings navigation:** Integrations is now a group holding **MCP** and **Skills**; every settings item has an icon.

- **External catalog search:** multi-word queries send the longest word upstream and match every word locally (registries match one name substring); a catalog that times out says so instead of showing a raw abort error. No new dependency or native IPC.

- **Imported setup alignment:** one detail-page container aligns provenance notices with header, access and credential sections; three-width WebKit assertions cover their exact bounds.

- **Integration layout and identity:** aligned headings/tabs/toolbars/grids, consistent bottom card actions, official source/publisher assets with provenance, and authenticated bounded listing thumbnails with passive SVG rendering. Active card actions are visually distinct from status badges. Three-width WebKit checks cover the reported faults. Projection `da49065` fixes the checked DNS callback shape discovered by live icon requests.

- **External discovery:** browse optional public catalogs alongside our own, search/page results and review connection details, provenance, credentials, unknown costs and compatibility. Compatible hosted and pinned local connections import unverified/off through the existing integration lifecycle; unsupported runtimes/authentication remain explicit. Bounded cached metadata, stale/offline handling, review-bound consent, duplicate reuse and removal are covered. [Guide and verification](docs/EXTERNAL-CATALOGS.md). Projection `801e227` includes unreviewed-tool Ask defaults and negotiated HTTP/session/redirect fixes found during live checks. No new dependency/native IPC.

- **Workspace data connector:** remote MCP setup for governed data and workspace tools, with a user-selected HTTPS endpoint and secret-store bearer token. No local package is installed; the entry stays off until configured and enabled. Calls may incur service charges. Browser OAuth and hosted-app endpoints are not supported; authenticated workspace access remains unverified. [Setup guide](docs/DATABRICKS.md). Uses Projection `c147332` for general configuration-based HTTP endpoints.

- Task workspace: preserve keyboard focus during background updates and return Escape to a visible control; label deletion confirmation for assistive technology. Add selected-file outcome evaluation and native WebKit keyboard checks. Live file-report reliability and hands-on voice checks remain open.

- **Independent media plugins:** Images, Audio and Video have separate switches, per-tool provider/model choices and existing tool approvals. Keys are shared from provider settings and Voice. Current endpoint/model capabilities are reviewed for 26 October 2026; deprecated speech choices are excluded from new media narration. No SDK/server package/native IPC was added.
- **Saved media and background work:** scoped image/audio/video inputs, immutable outputs, authenticated download/range reads, provider job receipts, explicit status recovery and conservative unknown-submission handling. Chat attachments now accept supported audio/video too. Tool charges remain unknown and separate from chat-token FinOps.
- **Dedicated media projection:** screen image/player, captions/transcripts, text/channel fallback and local voice-addressable playback through the canonical host/store. Playback is never a model/tool action; clip-overlapping speech is discarded before transcription. Verification uses mocked providers plus the primary local conversation model, with no paid generation.

- **Attach images in the chat:** the image button in the message box copies images into the chat's own folder (`<data>/attachments/<chat id>/`, owner-only, at most 20 MB each) and the message carries their path; the bubble shows only the name. Deleting the chat deletes its attachments.
- **Local OCR integration:** "OCR (local)" in Integrations uses GLM-OCR in the local Ollama (`ollama pull glm-ocr`): read text, tables, formulas (LaTeX) and figures, extract named fields as JSON, and export Markdown beside the image (asks first, never overwrites). Images never leave this computer for recognition. Other OCR engines can be added as their own catalog entries.
- **Projection pin `2cc2174`:** a saved chat keeps no tool output (only the placeholder and the call id), so a reloaded history cannot replay injected text; session files for an id containing `/` no longer show or delete another chat's; a large interface no longer slows down as it streams; the web fetch cannot be pointed at loopback by a second DNS answer; one integration whose folder vanished no longer fails the whole turn; a failure before the model is asked still ends the turn. Locale numbers ("1.234,56", "12,50") are read as written in comparisons and number fields. `runAgent` now rejects on a caller's own bad options instead of returning `{ stop: "error" }`; the app's calls are valid.

## 0.2.0 (2026-10-26)

Built on Projection `2918883`. Unsigned and not notarized: build from source, or allow it in System Settings → Privacy & Security. No data moves; keys stay where they are.

- **Conversation mode (⌘⇧D, or the waves in the message box):** talk and listen hands-free. The end of each sentence is found on this Mac from the microphone level; talking over a reply stops it; "stop listening", "goodbye" or Esc ends it. Replies are read as a gist (headlines, stats, first rows), with "details" for the rest. Voice commands: repeat, details, new chat, show it on the canvas.
- **Answer by voice:** tools waiting for approval, choices ("the cheaper one", "the second", "Hilton") and forms are asked aloud and answered in your own words, in English, French, German, Spanish, Italian, Portuguese or Dutch. Choices and forms are read back first and then submitted exactly as a click. An approval needs its operation named ("allow write"), allows once only, and is never decided by a model; unclear answers leave it on screen. When the rules cannot place an answer, the chat's model maps it to what the surface allows.
- **One voice switch:** Settings → Voice → Use voice turns off the microphone, reading aloud and every voice request at once; each feature keeps its own setting beneath it. Voice code now lives in `src/voice/` and `sidecar/voice/`.
- **Per-item buttons name their item:** a "Choose" on each card tells the model which card was chosen even when the model left that out (Projection `2918883`).

- **Whistle dictation on this Mac:** a new voice provider transcribes on the CPU in seven languages, free and offline, in both the browser and the app window. Once installed, it becomes the app window's default. One click installs its pinned and checksum-verified pack; it runs with no environment and no network. Voice packs now install through a general `POST /api/voice/install`.
- **Read aloud sounds human:** interfaces are read as content, never as component names, controls or actions. Tables are summarised after six rows. Numbers, signs, currency and abbreviations are said in the reply's own language, with text normalized to NFC. Voices that accept a language are told it with the Mac's region. Voice style and slider settings now reach the provider; the engine had been dropping them.
- **The voice follows the reply's language:** a French reply is read by an installed French or multilingual Phonon pack even when English is the chosen voice. If none is installed, the reply is read anyway and a note names the pack to install. The app never switches to a billed voice on its own.
- **Dictation languages per model:** Settings → Voice lists only the languages the chosen model transcribes. Hosted models receive the full regional tag (spelling or script hints for OpenAI and Gemini) instead of the bare language, and "Same as this Mac" sends the Mac's regional language.

- Saved task Markdown preserves the latest assistant prose alongside its canonical surfaces, including mixed narrative/interface results.

- Task setup accepts bounded selected UTF-8 snapshots and an optional local Markdown destination. Saved output receipts include read-back hashes, size and available surface versions, with verify/download and save retry without generation. Missing/changed/stale outputs block acceptance.
- Task diagnostic retention and scoped deletion now include owned input/output/checkpoint content. Uncertain operations require exact-ID, revision-bound evidence review; duplicate call IDs are not redispatched and uncertain dispatched effects stop work.
- Projection pin `d1248e2` adds caller constraints during surface correction, schema-governed recovery of sibling settings inside serialized lists, and abandoned session-checkpoint removal. Checked research reaches user review and saves a verified output; general semantic/reliability gates remain open.

- Checked comparisons can declare immutable facts/formulas and editable numeric criteria; validated form submissions update expected claims, so old boolean claims are rejected after criteria change.
- Checked research requires a visible answer and limitations, verbatim evidence and application retrieval dates. Successful source receipts persist with each run and appear in details; fabricated dates and missing output fail checks. Full local research authoring reliability remains open.
- Projection pin `558ca0c` includes merged PR #2: cyclic ancestor references are removed without discarding valid sibling content or data. Checked tasks use the existing strict schema mode.

- Projection parser PR #1 is merged; pin `fb63ede` names the main-branch merge of `05c9d59`. Added a canonical-host regression for changed criteria with fixed assertions. Complete-outcome review records remaining stale-claim and research explanation/receipt gaps; no readiness claim.

- From Projection `05c9d59`: token-based recovery of a missing key quote before a complete JSON primitive preserves table rows. Standard JSON validates primitive tokens; uncertain streaming prefixes are deferred. Schema/claim checks still reject incorrect facts. Reconciled with the concurrent surface styling changes; framework review is PR #1.

- **Minimal surfaces:** Projection pin `05c9d59` (including styling commit `0b59e6f`) brings quieter cards, lighter type, compact actions, natural-height grids and inherited theme tokens. Existing app color themes and text-size preferences continue to control surfaces.

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
