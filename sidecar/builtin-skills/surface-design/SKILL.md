---
name: surface-design
description: Design visual and spoken canvas content: forms, tables, charts, cards, metrics and mixed layouts. Combine with interactive-ui for data bindings and actions.
license: MIT
compatibility: Core required Vakyartha capability; active across desktop and web runtimes.
metadata:
  author: nranjan2code
  version: "1.6"
allowed-tools: vak_render vak_update vak_submit
---

# Visual & Spoken Surface Design

Design guidelines and layout architecture for crafting responsive, minimalistic, accessible visual canvases and harmonized spoken audio projections in Vakyartha.

## Overview & Core Principles

- **Always active**: This skill is required and always on. Its principles govern every visual canvas across desktop windows, browsers and channel projections.
- **Skill pairing**: Pair with enabled `interactive-ui` whenever surfaces require data bindings (`{/records}`), mapped rows/series, form inputs or action handling.
- **Minimalist aesthetic**: Emphasize clarity, typography and breathing room. Avoid clutter, heavy nested boxes, and border soup. Let whitespace, clear typography and clean layout containers structure the content.
- **Semantic component model**: Author interfaces strictly using offered semantic components (`grid`, `stack`, `split`, `section`, `card`, `stat`, `table`, `chart`, `form`, `text`, `alert`, `button`). Raw arbitrary HTML, inline CSS style strings, executable JavaScript and template expression scripts are not supported and are rejected by the renderer.

## Liquid & Adaptive Layout Architecture

Compose around the content and its reading order, not a fixed screen template. A single-column form or reading flow can be correct. Do not force every app/report into the same metric/chart/table tiers. Surfaces respond to their actual container (a side panel can be narrow on a wide screen).

Prefer `grid` with `columns: "auto"` and an appropriate `minItemWidth` for repeated peer content. Use explicit column counts only for an intentional grouping or comparison; they still collapse as space decreases. Use wrapping horizontal stacks for related actions. Ordinary buttons size to their content; reserve explicit `maxWidth: "full"` or stretch alignment for intentional full-width actions. Compact density reduces control spacing without shrinking labels or coarse-pointer targets.

Short cards size to their content by default. Do not add empty children, spacer nodes, arbitrary heights or extra boxes to fill the canvas. Data panels can use the available width; use an explicit semantic measure only when the task needs one. Forms and metric strips already provide structure and do not need enclosing cards solely for a border.

Long `grid` and `list` collections page locally at 12 items by default when they exceed 12. Set `pageSize` deliberately when needed (`0` explicitly shows all). Tables have their own local paging. Search, sorting and paging preserve canonical source data and do not invoke the model or app backend. Keep primary action labels explicit. Use compact, accessible utility icons where the host offers them; never replace labels with unexplained glyph text or unsupported icon props.

Choose the following patterns only when the content needs them:

1. **Fluid Grid Rhythm (`grid`)**:
   - **Metric Strips**: Place 2 to 4 key indicators at the top using `grid` with `columns: 2`, `3`, or `4` and `minItemWidth: "sm"`. On wide desktop screens this creates a balanced horizontal row; on narrow viewports it automatically wraps without horizontal clipping.
   - **Paired Visualizations**: Place complementary analytical components side-by-side using a 2-column `grid` (`props: { columns: 2, minItemWidth: "sm", gap: "md" }`):
     - Trend chart (`line`) + Categorical breakdown (`bar` or `pie`).
     - Primary visual chart + Key drivers/summary card.
     - Schedule/Timeline + Focus task card.
   - **Column Spans**: Use `span` on child nodes (`span: 2` or `span: "full"`) to balance asymmetric tracks.
2. **Proportional Split Layouts (`split`)**:
   - Use `split` with `props: { ratio: "2:1", gap: "md" }` for primary/detail layouts:
     - Left (2/3 width): Primary analytical chart or primary data view.
     - Right (1/3 width): Contextual summary card, filter form, or action buttons.
   - Automatically collapses into a clean vertical stack on narrow containers (<700px).
3. **Linear Flow & Toolbars (`stack`)**:
   - Use `stack` for vertical reading order (`direction: "vertical"`) or horizontal toolbars/actions (`direction: "horizontal"`, `align: "start" | "center" | "end"`, `gap: "sm" | "md" | "lg"`).
4. **Clamped Measures (`maxWidth`) — Preventing 100% Chart Stretch**:
   - Use readable measures for individual forms, charts and cards. Full width is an explicit content decision, not the default for every element.
   - **`sm` (320px)**: Compact summary cards, confirmation receipts, single-card alerts.
   - **`md` (720px)**: **Default standard for single analytical charts and interactive forms.** Keeps controls and charts ergonomically readable.
   - **`lg` (1040px)**: Paired analytics, multi-metric dashboard sections.
   - **`full` (100%)**: Content that needs the available measure, such as dense tables, multi-track timelines or explicitly full-width actions. Preserve responsive wrapping and appropriate chart aspect ratio.
5. **Sections vs Cards (Eliminating Card Soup)**:
   - **`section`**: Use `section` (`props: { title: "...", description: "..." }`) for primary visual divisions. It provides a clean heading and description with open breathing room and no bounding border box.
   - **`card`**: Use `card` deliberately for focal items, distinct actionable cards, or summary receipts. **Never wrap every single metric or paragraph in its own separate card, and never nest cards inside cards.**

## Color, Typography & Style Guide

Canvases follow a world-class, durable desktop design system:

1. **Color Codes & Theming**:
   - **No Raw Colors**: NEVER write raw hex codes (`#123456`, `#ff0000`), RGB, HSL, or inline `style="..."` attributes. The renderer rejects or strips arbitrary styles.
   - **Semantic Tones**: Use only semantic `tone` values for cards, badges, and alerts:
     - `"neutral"`: Default card, standard tag.
     - `"info"`: Informational notices, blue highlight.
     - `"success"`: Favorable variance, completed task, target met, green.
     - `"warning"`: Caution, pending approval, approaching threshold, amber.
     - `"danger"`: SLA breach, critical blocker, unfavorable variance, red.
   - **Chart Series Palette**: Chart colors are assigned automatically from the system theme palette (`--vak-series-1` through `--vak-series-6`). Do not specify custom stroke or fill colors.
   - **Desktop Theme Alignment**: Canvases automatically inherit the active desktop theme (Indigo, Ocean, Forest, Rose, Amber, Graphite) and light/dark color scheme.
2. **Typography & Hierarchy**:
   - System typography uses Inter Variable font (`ui-sans-serif, system-ui, -apple-system, Inter`).
   - Use semantic `text` variants:
     - `variant: "heading"`: Canvas and section headlines (weight 650, tight tracking).
     - `variant: "subheading"`: Subsection headers.
     - `variant: "caption"`: Data source footnotes, observation window caveats, fine print (muted color).
     - `variant: "code"`: Identifiers, JSON pointers, timestamps.
   - Use standard markdown inside `text.props.content` (`**bold**`, `*italic*`, `[link](url)`).
3. **Number & Unit Precision**:
   - Store **raw finite numbers** in `data` (e.g. `42500.5`, `0.08`), never pre-formatted display strings like `"$42,500.50"`.
   - Specify units in labels, table column headers, or deltas (`props.label: "Revenue ($k)"`, `columns: ["Date", "Close (points)"]`, `delta: "+3.2%"` with `trend: "up" | "down"`).
   - Use explicit `null` for missing metrics; never coerce missing values to `0`.

## Chart Selection Matrix & Constraints

Choose chart kinds strictly by the analytical question asked:
- **`bar`**: Comparing discrete categories or ranking quantities.
- **`candlestick`**: Dated open/high/low/close intervals, with four series in that order (mapped fields `["open","high","low","close"]`). Use real OHLC records and separate volume; never infer a candle from a quote or close-only series.
- **`stacked`**: Additive composition across categories (parts of total per category).
- **`line`**: Trends and continuous values over ordered time.
- **`area`**: Cumulative volume or magnitude over ordered time.
- **`pie`**: Non-negative proportions of a single whole (limit to 5–7 slices).
- **`scatter`**: Correlation between two paired numeric variables ($x$ vs $y$).
- **`heatmap`**: Intensity or density across two discrete dimensions (e.g. day vs hour).
- **`radar`**: Comparing multidimensional profiles across a shared normalized scale.

Analytical workspaces may set `density: "compact"` on a layout root to reduce spacing without shrinking text. Use `height: "sm" | "md" | "lg"` on charts to balance primary and secondary plots. Long rankings use `orientation: "horizontal"` on bars; signed changes may use `colorBy: "sign"` with exact values and labels. Line/candle `yScale: "auto"` fits observed values and visibly discloses its baseline; choose `"zero"` when that reference matters. Bars/areas include zero. `title`, `xLabel` and `yLabel` name the analytical question and units. Preserve exact detail tables and visible interpretation; pointer/touch/keyboard inspection is supplementary.

### Visualization Constraints

- **Histograms**: Must be rendered as `bar` charts using pre-calculated bin ranges.
- **Unsupported charts**: Do not attempt bubble charts (sized scatter), box plots, waterfall, or dual-axis overlays. If requested, explain the limit and provide an equivalent supported chart or table.
- **Truthful representation**: Before finalizing, check that a chart's plotted categories and series agree with its title, description and nearby interpretation. If it shows only part of the available data, name the selected categories or periods and say where the remaining values appear; do not describe a subset as complete. Avoid decorative or duplicate charts. Name periods, units and missing-data limitations.

## Dual Projection: Visual & Spoken Harmony

Vakyartha projects content simultaneously to the visual screen and to voice/speech synthesis:
1. **Lead with natural prose**: Put the central takeaway, reporting period and material caveat in 1–2 concise sentences near the top. Ensure this first sentence is meaningful when heard aloud in isolation (TTS gist mode).
2. **Self-contained text**: Do not hide crucial warnings or statuses solely in tooltip hover states, background colors or icon symbols. State them in readable text.
3. **Spoken conversation gist**: Spoken summaries compress long tables and skip control labels. Essential findings and limitations must exist in visible prose to be spoken.
4. **No synthetic fields**: Do not invent parallel `tts` properties or separate narration payloads. Speech reads directly from the canonical visual content.

## Responsive Adaptation

- Primary panels must remain first in reading order when multi-column grids collapse on narrow screens.
- Wide tables must be permitted to scroll horizontally within their panel rather than clipping or breaking column widths.
- Ensure that forms and summary text fit comfortably without truncation across mobile (375px), tablet (620px) and desktop (1100px+) viewports.
