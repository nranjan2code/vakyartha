---
name: dashboard
description: Build an operational or enterprise dashboard from supplied records or available governed data tools, with metrics, trends and detail views.
license: MIT
compatibility: Requires interactive-ui and surface-design capabilities for canvas projection.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Operational & Enterprise Dashboards

Design and implementation architecture for building comprehensive, decision-focused, adaptive operational and executive dashboards.

## Overview & Chaining

- **Purpose**: Use this skill when asked to construct an analytical dashboard, executive KPI overview, or performance monitoring view from supplied data or read tools.
- **Skill chaining**:
  - Load enabled `interactive-ui` for data mappings, bound filters and action handling.
  - Apply the always-on `surface-design` principles for layout, typography, chart selection and responsive behavior.
  - Specialized dashboards (`sales-dashboard`, `finance-dashboard`, `operations-dashboard`, `market-dashboard`) provide specialized metrics and should be preferred for those domains.

## Liquid & Adaptive Dashboard Architecture

Never output a rigid, single-column vertical stack where every element stretches 100% across the screen. Organize the dashboard into three balanced, fluid tiers:

1. **Executive KPI Strip**:
   - Place 2–4 critical metrics at the top using `stat` components inside a fluid `grid` (`props: { columns: 4, minItemWidth: "sm" }`).
   - Show the primary figure, explicit currency/unit, and comparative delta (vs previous period or target) where data exists (`props.delta`, `props.trend: "up" | "down"`).
2. **Adaptive Analytical Tier (Preventing 100% Chart Stretch)**:
   - **Crucial Rule**: Never stretch a single chart across 100% width on a wide canvas. This distorts the chart's aspect ratio.
   - **Option A — Paired Visuals**: Place two complementary charts side-by-side in a 2-column `grid` (`props: { columns: 2, minItemWidth: "sm", gap: "md" }`):
     - Trend over time (`line` or `area`) + Categorical breakdown (`bar` or `pie`).
   - **Option B — Split Primary/Detail**: Use a `split` container (`props: { ratio: [2, 1], gap: "md" }`):
     - Left (2/3 width): Primary trend or multi-series chart.
     - Right (1/3 width): Contextual summary card, highlight stats, or active triage form.
   - **Option C — Clamped Single Chart**: If only one chart is required, constrain it with `maxWidth: "md"` (720px) or `"lg"` (1040px) inside a clean `section`.
3. **Granular Detail Table**:
   - Provide a supporting data table below the analytics to enable row-level inspection.
   - Use `maxWidth: "full"` for the table, with `searchable: true`, `sortable: true`, and clear column headers with explicit units.

## Layout Structure Example

```json
{
  "surface": "operations-summary",
  "title": "Operations Performance",
  "data": {
    "kpis": { "openTickets": 142, "resolved": 389, "slaRate": 96.4, "critical": 3 },
    "trends": [
      { "week": "W1", "created": 95, "resolved": 92 },
      { "week": "W2", "created": 110, "resolved": 105 },
      { "week": "W3", "created": 88, "resolved": 94 },
      { "week": "W4", "created": 102, "resolved": 98 }
    ],
    "categories": [
      { "team": "Platform", "backlog": 52 },
      { "team": "Billing", "backlog": 31 },
      { "team": "Integrations", "backlog": 59 }
    ]
  },
  "nodes": [
    { "id": "root", "type": "stack", "children": ["intro", "kpiGrid", "analyticsSection", "tableSection"] },
    { "id": "intro", "type": "text", "props": { "content": "Operations throughput maintained a **96.4% SLA** for October 2026 across 389 resolved items. This is a supplied review snapshot." } },
    { "id": "kpiGrid", "type": "grid", "props": { "columns": 4, "minItemWidth": "sm" }, "children": ["statOpen", "statResolved", "statSla", "statCritical"] },
    { "id": "statOpen", "type": "stat", "props": { "label": "Open Backlog", "value": "{/kpis/openTickets}", "delta": "-8%", "trend": "down" } },
    { "id": "statResolved", "type": "stat", "props": { "label": "Resolved (Month)", "value": "{/kpis/resolved}", "delta": "+12%", "trend": "up" } },
    { "id": "statSla", "type": "stat", "props": { "label": "SLA Compliance (%)", "value": "{/kpis/slaRate}" } },
    { "id": "statCritical", "type": "stat", "props": { "label": "Critical Blockers", "value": "{/kpis/critical}" } },
    { "id": "analyticsSection", "type": "section", "props": { "title": "Workload & Composition", "description": "Weekly arrival vs resolution rate alongside queue distribution by team." }, "children": ["chartsGrid"] },
    { "id": "chartsGrid", "type": "grid", "props": { "columns": 2, "minItemWidth": "sm", "gap": "md" }, "children": ["trendChart", "categoryChart"] },
    { "id": "trendChart", "type": "chart", "props": { "kind": "line", "series": { "records": "{/trends}", "label": "week", "fields": ["created", "resolved"] }, "maxWidth": "lg" } },
    { "id": "categoryChart", "type": "chart", "props": { "kind": "bar", "series": { "records": "{/categories}", "label": "team", "fields": ["backlog"] }, "maxWidth": "lg" } },
    { "id": "tableSection", "type": "section", "props": { "title": "Weekly Throughput Details" }, "children": ["detailTable"] },
    { "id": "detailTable", "type": "table", "props": { "columns": ["Week", "Created", "Resolved"], "rows": { "records": "{/trends}", "fields": ["week", "created", "resolved"] }, "maxWidth": "full", "searchable": true } }
  ]
}
```

## Styling & Theming Guidelines

- **Clean Sectioning**: Use `section` (`props: { title: "...", description: "..." }`) to separate visual tiers. Do not wrap entire sections in heavy card borders.
- **No Raw Colors**: Never write hex codes or inline styles. Tones (`info`, `success`, `warning`, `danger`) are semantic and automatically styled. Chart series palette is assigned by the active theme.
- **Data & Number Discipline**: Keep raw numbers in `data`. Put currency symbols and percentage signs in labels, table column headers, or deltas.

## Filtering & Interactive Controls

- **Global filters**: For dashboard-wide filters (e.g. date range, region, team), bind inputs in a compact form (`maxWidth: "md"`) and provide an explicit submit button (`submit: "filter_action"`).
- **Coherent updates**: When a filter action is submitted, update KPI aggregates, analytical charts, detail tables and natural-language summaries together.
- **Local view limits**: Local table search and column sorting operate as client-side view filters; explain that they do not alter dashboard-wide totals or underlying records.

## Dual Spoken & Visual Projection

- Include a prominent 1–2 sentence natural-language summary near the top of the canvas stating the primary takeaway, reporting timeframe, and any material caveats.
- The voice projection speaks this opening sentence in gist mode; ensure it stands alone meaningfully without visual charts.
