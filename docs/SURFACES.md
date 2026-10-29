# Multi-Surface Projection Architecture: Web, Telegram, Slack, Discord & Voice

This document details the multi-surface projection architecture in Vakyartha and the underlying Projection framework. In Vakyartha, an agent or workflow can author multiple independent canonical surfaces (stored in `SurfaceStore` with typed nodes and canonical data). Each surface is projected into target-specific presentation layers across desktop/web, conversational channels, and voice audio.

For the full end-to-end rendering pipeline, liquid layout mechanics, Web Component lifecycle, token penetration, and Shadow DOM styles, see [End-to-End Architecture: Surfaces, Canvas, and Projections](rendering/END-TO-END-ARCHITECTURE.md).

---

## 1. Multi-Surface Overview & Degradation Matrix

Vakyartha supports five distinct projection surfaces, each governed by an exact capability profile:

| Feature / Node | Web & Desktop (`@vak/web`) | Telegram (`@vak/telegram`) | Slack (`@vak/slack`) | Discord (`@vak/discord`) | Spoken Voice (`src/voice/`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Markup** | HTML / Shadow DOM / SVG | HTML / Telegram Rich Msg | Block Kit JSON | Components V2 JSON | Plain Text / SSML WAV |
| **Layout Model** | Liquid Adaptive Container | Linear 1-Column | Linear 1-Column | Linear 1-Column | Prioritized Speech Sequence |
| **Grid / Split / Tabs** | **Native** (CSS Container Queries) | **Degraded** (linear by priority) | **Degraded** (linear by priority) | **Degraded** (linear by priority) | **Degraded** (traversed by priority) |
| **Charts** | **Native** (9 SVG kinds including OHLC, responsive) | **Degraded** (HTML Data Table) | **Degraded** (Slack `table` block) | **Degraded** (Monospace Code Block) | **Degraded** (Endpoint narration) |
| **Data Tables** | **Native** (Sortable, Search, Paged) | **Native** (HTML table, ≤20 cols) | **Native** (`table` block, ≤100 rows) | **Degraded** (Monospace Code Block) | **Degraded** (Top 3-6 rows spoken) |
| **Stats / KPIs** | **Native** (Grid-aligned stat cards) | **Native** (Compact HTML table) | **Native** (Section `fields` array) | **Native** (Bold KPI text inline) | **Native** (Label + value + delta) |
| **Forms & Inputs** | **Native** (Reactive 2-way bindings) | **Degraded** (Step-by-step Q&A flow) | **Native Modal** (`views.open` dialog) | **Native Modal** (Paged dialog, ≤5/page) | **Interactive Flow** (Voice Q&A) |
| **Buttons / Actions** | **Native** (Client `vak-action` events) | **Native** (Inline callback keyboard) | **Native** (Action row buttons) | **Native** (ActionRow button components) | **Voice Choices** (Meaning match) |
| **Images / Media** | **Native** (Local cache / web) | **Native** (Safe HTTPS only) | **Native** (Safe HTTPS only) | **Native** (MediaGallery component) | **Skipped** (Alt-text if available) |

---

## 2. Latest 2026 Platform Specifications

The conversational channel projectors are aligned with the latest 2025/2026 platform capabilities and boundaries:

### Telegram (Bot API 9.x – 10.3)
- **Streaming & Drafts**: Telegram Bot API 9.3+ introduced `sendMessageDraft` for live token streaming. Bot API 10.3 added `can_stop`, `keep_on_stop`, and `stopped_message_generation` updates to halt AI generation mid-stream.
- **Rich Message Blocks**: Expanded structured blocks including compact tables (`<table compact>`), expandable blockquotes (`<blockquote>`), file preview cards, and rich text formatting.
- **Keyboards & Buttons**: Inline callback buttons (`callback_data` ≤ 64 bytes). Support for `DisabledButton` to indicate unavailable controls without hiding them.
- **Limits**: Maximum 20 table columns (`MAX_COLUMNS = 20`), max 4,096 characters per message, strict HTML escaping for untrusted user/model text.

### Slack (Block Kit 2025 – 2026)
- **Streaming APIs**: `chat.startStream`, `chat.appendStream`, and `chat.stopStream` enable token streaming without repeated message edits.
- **Native Table Blocks**: Officially rolled out in August 2025, Slack provides native `table` blocks for tabular data.
- **Modern Display Blocks**: Slack introduced `alert` blocks (severity levels), `card` blocks, `carousel` blocks, and `container` grouping blocks.
- **Modals (`views.open`)**: Rich native forms open in a modal dialog supporting `plain_text_input`, `email_text_input`, `static_select`, and `checkboxes` with per-field validation errors returned on submit.
- **Limits**: Maximum 50 blocks per message (`SLACK_LIMITS.blocks`), 3,000 characters per section, 150 characters per header, 10 fields per section, and 10,000 characters total across table cells in a message.

### Discord (Components V2)
- **Components V2 Architecture**: Flagged with `flags: IS_COMPONENTS_V2` (`1 << 15` / `32768`). Replaces legacy embeds and message content entirely.
- **Component Primitives**:
  - `Container (type 17)`: Structural box holding child components.
  - `TextDisplay (type 10)`: Markdown text display.
  - `ActionRow (type 1)`: Container for interactive buttons.
  - `Separator (type 14)`: Visual spacing dividers.
  - `MediaGallery (type 12)`: Media previews.
- **Modals**: Forms open as native Discord modal dialogs. Because Discord limits modals to 5 inputs per view, fields are partitioned into pages of 5 (`modalPages`).
- **Monospace Tables**: Discord Markdown lacks HTML `<table>` tags, so tables and charts are formatted as aligned monospace ASCII/box-drawing code blocks (`tableText`).
- **Limits**: Maximum 40 total components per message (`DISCORD_LIMITS.components`), 4,000 characters max for text displays, and 5 buttons per `ActionRow`.

---

## 3. Surface Implementations in Vakyartha & Projection

### 3.1 Web & Desktop Canvas (`@vak/web`)
The primary interactive surface rendered inside the desktop app (Tauri / WebKit) and development browser:
- **Container Queries**: `<vak-surface>` uses `container-type: inline-size`. CSS tracks reflow dynamically based on width rather than window-level media queries.
- **Liquid 3-Tier Layout**:
  1. *Tier 1 (Overview)*: 3–4 column KPI metric strip (`grid` with `columns: 4, minItemWidth: "xs"`).
  2. *Tier 2 (Analytics)*: Paired 2-column visuals (`grid` with `columns: 2, minItemWidth: "sm"`) or split view (`split` with `ratio: [2, 1]`). Single charts and cards are clamped to `maxWidth: "md"` or `"lg"` to prevent stretching across 1400px+ monitors.
  3. *Tier 3 (Granular Data)*: Full-width data tables (`table` with `maxWidth: "full"`) and clamped action forms (`form` with `maxWidth: "md"`).
- **Styling & Theming**: Inter typography scale (`heading`, `subheading`, body, `caption`). Semantic tones only (`positive`, `caution`, `critical`, `neutral`). System theme series colors (`--vak-series-1` through `--vak-series-8`).

### 3.2 Telegram Projector (`@vak/telegram`)
Located at `framework/packages/telegram/src/project.ts`:
- **Linear Lowering**: `lowerSurface` flattens rich components. Containers are traversed in priority order using `byPriority`.
- **Chart Degradation**: Evaluates series data and outputs `<table compact>` with column headers and right-aligned numeric data.
- **Table Formatting**: Emits `<table bordered striped compact>` up to 20 columns.
- **Form Handling**:
  - The surface message renders a summary list of form fields and an action button (`Join...`).
  - Activating the button begins an interactive multi-step Q&A flow (`FormFlow` in `flow.ts`), asking each question sequentially with keyboard choices or validated text inputs.
- **Media Safety**: External images are verified via `SAFE_SRC = /^https?:\/\//i` and pre-checked to prevent Bot API rejection.

### 3.3 Slack Projector (`@vak/slack`)
Located at `framework/packages/slack/src/project.ts`:
- **Block Kit Mapping**:
  - Headers map to `{ type: "header", text: { type: "plain_text", ... } }`.
  - Stats map to `{ type: "section", fields: [...] }` (up to 10 fields per section).
  - Tables map to `{ type: "table", rows: [...] }`. If characters exceed 10,000 or rows exceed 100, falls back to a monospace code block.
  - Charts map to native Slack `table` blocks.
- **Modal System (`modal.ts`)**:
  - Surfaces with forms include an actions block button.
  - Clicking dispatches `views.open` returning `slackModal(fields)`.
  - Native elements: `plain_text_input`, `email_text_input`, `static_select`, `checkboxes`.
  - Supports initial values, required validation, and server-side errors on submit.
- **Strict Limit Enforcement**: Excess blocks beyond 50 are trimmed with an informative note (`"X more blocks not shown"`). Model text is sanitized via `markdownToMrkdwn` to escape `<!channel>` and injection attempts.

### 3.4 Discord Projector (`@vak/discord`)
Located at `framework/packages/discord/src/project.ts`:
- **Components V2 Container**:
  - Message flag: `IS_COMPONENTS_V2 = 1 << 15`.
  - Outermost wrapper: `{ type: C.Container, components: [...] }`.
  - Text displays: Adjacent markdown text is batched into `{ type: C.TextDisplay, content: "..." }`.
- **Monospace Text Tables**:
  - Renders tabular data and chart series through `tableText()`, producing formatted unicode text tables wrapped in ``` code blocks.
- **Paged Modals (`modal.ts`)**:
  - Forms generate an ActionRow button.
  - Modals support `TextInput` and `StringSelect`.
  - Multi-field forms exceeding 5 inputs are paged into consecutive modal steps (`modalPages`).
- **Strict Limit Enforcement**: Components capped at 40. Excess components are trimmed with `-# more not shown`. Text is capped at 4,000 characters.

### 3.5 Spoken Voice Projection (`src/voice/`)
Located at `src/voice/speech-text.ts`:
- **Dual Projection Contract**: The exact same resolved surface is lowered into spoken audio text via `lowerSurface`.
- **Spoken Gist**:
  - Gist retains the opening sentence of visible text.
  - Tables speak the first 3 rows in gist mode and up to 6 rows in detail mode.
  - Charts speak the series name and first/last endpoints.
  - Controls, dropdowns, and buttons are skipped in narration to keep voice natural.
- **Voice Choices & Forms**: Interactive voice choices (`decisions.ts`) match user speech by semantic meaning rather than requiring exact keyword clicks.

---

## 4. Verification & Testing

Every surface projector is backed by offline unit and integration tests:

```bash
# Run all framework channel tests (Telegram, Slack, Discord, Email)
npm run test:framework

# Run Telegram bot runner and projection tests
node --test framework/packages/telegram/test/**/*.test.ts

# Run Slack Block Kit and modal tests
node --test framework/packages/slack/test/**/*.test.ts

# Run Discord Components V2 and modal tests
node --test framework/packages/discord/test/**/*.test.ts

# Run Web & Desktop WebKit surface checks
node scripts/surface-design-check.ts
node scripts/canvas-check.ts

# Run Voice projection tests
npm test -- test/voice.test.ts
```


Analytical chart additions (2026-10-28): OHLC candlesticks, fitted/disclosed trend scales, horizontal signed bars, semantic heights and compact density are native web geometry. Lowered channels retain the canonical four OHLC series/observations; they do not receive a bitmap market chart or interactive inspector. App navigation remains product-owned.
