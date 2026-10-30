---
name: surface-design
description: Design visual and spoken canvas content: forms, tables, charts, cards, metrics, diagrams and mixed layouts. Combine with interactive-ui for data bindings and actions.
license: MIT
compatibility: Core required Vakyartha capability; active across desktop and web runtimes.
metadata:
  author: nranjan2code
  version: "1.8"
allowed-tools: vak_render vak_update vak_submit
---

# Visual and spoken surface design

Apply this shared contract whenever authoring a surface. Follow the user's requested format, current tool schema, caller constraints and target capabilities. For data mappings, bindings or submitted actions, use enabled interactive-ui. Domain skills own domain decisions, not a competing layout system.

## Compose from content

Choose the simplest useful reading order for the task and actual container. A single column, short card or form may be sufficient. Use sections for structure and cards for distinct content units; avoid nested decorative cards, empty nodes, spacer heights and forced metric/chart/table tiers. Ordinary actions keep clear labels and their natural width.

Use automatic grids for peers, explicit columns for meaningful grouping, and split layouts only when primary/detail content benefits. Retain primary content first when columns collapse. Use offered semantic maxWidth measures when needed; intentional full-width data panels and charts are valid. Follow the target's available components and degradation: linear channels do not need desktop grid geometry. Dense tables can scroll within their panel. Long lists/grids page locally; preserve the full canonical records while browsing.

Use semantic tones neutral, info, success, warning and danger when offered. Let the host supply fonts, theme, palette and control geometry. Do not invent CSS, colors, icon properties or executable expressions. Keep labels readable, controls identifiable and material status in text rather than only color or hover.

## Choose a chart for the question

- bar: compare categories or independently prepared bins; horizontal bars suit long labels.
- stacked: comparable additive parts in the same unit, not automatic normalization.
- line: correctly ordered observations over time; equal category spacing is not a continuous time axis.
- area: magnitude over ordered time; it does not compute cumulative values.
- pie: nonnegative parts of one meaningful positive whole; keep categories manageable.
- scatter: paired numeric x/y observations; it does not compute correlation or regression.
- heatmap: nonnegative intensity across dimensions, or supported dated calendar values; not signed divergence.
- radar: profiles on comparable scales; normalization is not automatic.
- candlestick: dated real open/high/low/close records, four series in that order; separate volume. Never infer candles from close-only observations.

Unsupported statistical/specialist plots need a supported alternative or an explicit limitation. Histogram bins must be calculated first; a bubble alias does not encode point size. Bars/areas include zero. Line/candlestick may fit observed ranges when that disclosed scale answers the question; use zero when it is the meaningful reference. Name units, periods and basis. Keep exact detail values when they matter. Inspection controls supplement, not replace, the visible interpretation.

## Diagrams and topological structures

For workflows, system architectures, state machines, entity relationships, sequence interactions, pipelines, or conceptual processes, load the `diagrams` skill. Use the canonical `diagram` component (`flow: "lr" | "tb"`, semantic shapes `box | diamond | cylinder | pill`, subgraphs for architectural boundaries, and cycle-aware back-edges). Do not force relational topologies into charts or unconstrained graphs.

## Meaning and continuity

Keep the main finding, relevant timeframe, units and material caveat in short visible prose that remains meaningful when spoken. Speech projects the canonical surface; never author a separate narration store or tts payload. Do not duplicate every row in chat prose.

Before delivery, compare chart categories/series, table values and nearby interpretation. Name any displayed subset and where remaining records appear. Missing facts are not zero. Preserve independent surfaces and unsent edits; a layout change must not change facts or imply an external effect. A valid render is not proof of source or calculation correctness.
