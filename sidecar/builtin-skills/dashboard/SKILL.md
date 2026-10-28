---
name: dashboard
description: Build an operational or enterprise dashboard from supplied records or available governed data tools, with metrics, trends and detail views.
license: MIT
compatibility: Requires interactive-ui and surface-design capabilities for canvas projection.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Operational & Enterprise Dashboards

Design and implementation architecture for building comprehensive, decision-focused operational and executive dashboards.

## Overview & Chaining

- **Purpose**: Use this skill when asked to construct an analytical dashboard, executive KPI overview, or performance monitoring view from supplied data or read tools.
- **Skill chaining**:
  - Load enabled `interactive-ui` for data mappings, bound filters and action handling.
  - Apply the always-on `surface-design` principles for layout, typography, chart selection and responsive behavior.
  - Specialized dashboards (`sales-dashboard`, `finance-dashboard`, `operations-dashboard`, `market-dashboard`) provide specialized metrics and should be preferred for those domains.

## Dashboard Architecture & Layout

Organize the dashboard into three clear visual tiers:
1. **Executive KPI Strip**:
   - Place 2–4 critical metrics at the top using `stat` components inside a `grid`.
   - Show the primary figure, explicit currency/unit, and comparative delta (vs previous period or target) where data exists.
2. **Primary Analytical Visualizations**:
   - Feature 1–2 focused charts that answer the user's core business questions.
   - Use `line` or `area` for trends over time, `bar` for categorical comparisons, and `stacked` for composition.
   - Size panels appropriately (`maxWidth: "lg"` or `"full"`) and maintain balanced visual weight.
3. **Granular Detail Table**:
   - Provide a supporting data table below the charts to enable row-level inspection.
   - Include identifiable row keys, dates, categories and checked numerical values.

## Data Integrity & Metric Rules

- **Truthful business metrics**: Never invent sales volumes, server uptimes, profit margins or operational performance. Build strictly from verified facts.
- **Metric discipline**:
  - Separate actuals from targets, budgets, and speculative forecasts.
  - Disclose exact reporting periods, timezones, and currency denominations.
  - Never sum rates (e.g. conversion rates, percentages) or average averages across unequal populations without weighted calculations.
- **Data freshness**: Clearly display the timestamp or source date of the underlying data. Do not label static snapshots as "live streaming" unless true integration subscriptions exist.

## Filtering & Interactive Controls

- **Global filters**: For dashboard-wide filters (e.g. date range, region, product line), bind inputs in an interactive form container and provide an explicit submit button (`vak_submit`).
- **Coherent updates**: When a filter is submitted, update KPI aggregates, analytical charts, detail tables and natural-language summaries together.
- **Local view limits**: Local table search and column sorting operate as client-side view filters; explain that they do not alter dashboard-wide totals or underlying records.

## Dual Spoken & Visual Projection

- Include a prominent 1–2 sentence natural-language summary near the top of the canvas stating the primary takeaway, reporting timeframe, and any material caveats.
- Ensure that users listening to the voice projection understand the overall status without needing to see the individual chart pixels.
