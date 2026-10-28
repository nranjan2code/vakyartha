---
name: surface-design
description: Design visual and spoken canvas content: forms, tables, charts, cards, metrics and mixed layouts. Combine with interactive-ui for data bindings and actions.
license: MIT
compatibility: Core required Vakyartha capability; active across desktop and web runtimes.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: vak_render vak_update vak_submit
---

# Visual & Spoken Surface Design

Design guidelines and layout architecture for crafting responsive, accessible visual canvases and harmonized spoken audio projections in Vakyartha.

## Overview & Core Principles

- **Always active**: This skill is required and always on. Its principles govern every visual canvas, whether generated in desktop windows, browsers or channel projections.
- **Skill pairing**: Pair with enabled `interactive-ui` whenever surfaces require data bindings (`{/records}`), mapped rows/series, form inputs or action handling.
- **Semantic component model**: Author interfaces strictly using offered semantic components and properties (`grid`, `stack`, `split`, `card`, `stat`, `table`, `chart`, `form`). Raw arbitrary HTML, inline CSS style strings, executable JavaScript and template expression scripts are not supported and are rejected by the renderer.

## Layout Architecture & Sizing

1. **Hierarchy**:
   - Establish a clear title and brief context at the top.
   - Lead with a compact metric strip (`stat`) if key indicators exist.
   - Follow with the primary analysis (chart or primary table).
   - Conclude with secondary detail, granular tables or action forms.
2. **Layout containers**:
   - **`grid`**: Use with explicit `columns` for peer panels and balanced multi-card sections. Use `span` to control panel width.
   - **`split`**: Use with `ratio` (e.g. `[2, 1]`) for primary/detail layouts only when offered.
   - **`stack`**: Use for linear reading order, forms, and compact vertical tool panels.
3. **Content measure (`maxWidth`)**:
   - `sm`: Compact summaries, confirmation receipts, single-card alerts.
   - `md`: Forms, configuration dialogs, medium charts.
   - `lg`: Detailed analytical views, mixed layouts, multi-metric dashboards.
   - `full`: Dense data tables, wide comparative matrices, multi-column operational boards.
4. **Spacing & Alignment**:
   - Size panels according to content length rather than forcing all panels to stretch.
   - Allow natural empty space rather than artificially padding short cards.
   - Use top alignment for adjacent columns with unequal content heights.

## Component Selection & Density

- **Cards**: Use cards to demarcate distinct logical groups. Do not wrap every isolated label or single metric in its own separate card.
- **Metrics (`stat`)**: Keep numbers legible with explicit units. Place sign (+/-) and delta comparisons close to the value.
- **Tables**: Ensure column headers state clear units. Provide visible row identities (names, IDs, dates). Limit default display to readable row limits.
- **Forms**: Place inputs logically, group related parameters, and locate the primary submission action directly beneath or beside its inputs.

## Chart Selection Matrix

Choose chart kinds strictly by the analytical question asked:
- **`bar`**: Comparing discrete categories or ranking quantities.
- **`stacked`**: Additive composition across categories (parts of total per category).
- **`line`**: Trends and continuous values over ordered time.
- **`area`**: Cumulative volume or magnitude over ordered time.
- **`pie`**: Non-negative proportions of a single whole (limit to 5–7 slices).
- **`scatter`**: Correlation between two paired numeric variables ($x$ vs $y$).
- **`heatmap`**: Intensity or density across two discrete dimensions (e.g. day vs hour).
- **`radar`**: Comparing multidimensional profiles across a shared normalized scale.

### Visualization Constraints

- **Histograms**: Must be rendered as `bar` charts using pre-calculated bin ranges.
- **Unsupported charts**: Do not attempt bubble charts (sized scatter), candlesticks, box plots, waterfall, or dual-axis overlays. If requested, explain the limit and provide an equivalent supported chart or table.
- **Truthful representation**: Before finalizing, check that a chart's plotted categories and series agree with its title, description and nearby interpretation. If it shows only part of the available data, name the selected categories or periods and say where the remaining values appear; do not describe a subset as complete. Avoid decorative or duplicate charts. Name periods, units and missing-data limitations.

## Dual Projection: Visual & Spoken Harmony

Vakyartha projects content simultaneously to the visual screen and to voice/speech synthesis:
1. **Lead with natural prose**: Put the central takeaway, reporting period and material caveat in 1–2 concise sentences near the top. Ensure this first sentence is meaningful when heard aloud in isolation.
2. **Self-contained text**: Do not hide crucial warnings or statuses solely in tooltip hover states, background colors or icon symbols. State them in readable text.
3. **Spoken conversation gist**: Spoken summaries compress long tables and skip control labels. Essential findings and limitations must exist in visible prose to be spoken.
4. **No synthetic fields**: Do not invent parallel `tts` properties or separate narration payloads. Speech reads directly from the canonical visual content.

## Responsive Adaptation

- Primary panels must remain first in reading order when multi-column grids collapse on narrow screens.
- Wide tables must be permitted to scroll horizontally within their panel rather than clipping or breaking column widths.
- Ensure that forms and summary text fit comfortably without truncation across mobile (375px), tablet (620px) and desktop (1100px+) viewports.
