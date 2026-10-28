---
name: sales-dashboard
description: Create a sales performance or opportunity-pipeline dashboard with stages, targets, period comparisons and source-backed deal detail.
license: MIT
compatibility: Works with CRM exports, sales pipeline spreadsheets, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Sales Performance & Pipeline Dashboards

Framework for analyzing sales pipeline health, revenue realization, win rates, quota attainment and deal-level execution.

## Overview & Chaining

- **Purpose**: Use this skill when asked to review sales rep or team performance, analyze pipeline conversion funnels, track quota progress, or build a sales dashboard.
- **Skill chaining**:
  - Load `dashboard` and `interactive-ui` for metric mappings, stage charts and filtering.
  - The required `surface-design` skill governs visual layout, funnel charts, detail tables and spoken summaries.
  - Load `periodic-report` if the deliverable is a written weekly or monthly sales briefing rather than an interactive canvas.

## Sales Pipeline & Revenue Metrics

1. **Revenue categorization**:
   - **Booked revenue**: Closed won deals contracted in the period.
   - **Recognized revenue**: Revenue earned according to delivery/accrual schedules.
   - **Open pipeline**: Unclosed opportunities currently in progress.
   - *Rule*: Never combine open pipeline with booked revenue into a single "actual" number.
2. **Stage definitions & Weighted forecasts**:
   - Respect explicit sales stages (e.g. Lead, Discovery, Proposal, Negotiation, Closed Won).
   - Only apply weighted pipeline forecasting (`Value × Probability`) when explicit stage probabilities are supplied. Never invent probability percentages.
3. **Conversion & Win rates**:
   - Win rate must be calculated from an explicit cohort population (e.g. `Closed Won / (Closed Won + Closed Lost)`).
   - Never sum percentages across sales reps or product categories.

## Adaptive Sales Canvas Layout

Never let single charts stretch across 100% width on wide desktop screens. Structure the sales canvas into three adaptive tiers:

1. **Executive KPI Strip**:
   - 4-metric fluid `grid` (`props: { columns: 4, minItemWidth: "sm" }`):
     - Total Booked Revenue (with delta vs Quota / Target).
     - Quota Attainment (%) with `trend: "up" | "down"`.
     - Total Active Pipeline Value.
     - Win Rate (%) and Average Deal Size.
2. **Paired Visual Funnel & Trend Analysis (No 100% Chart Stretch)**:
   - Place two complementary charts side-by-side using a 2-column `grid` (`props: { columns: 2, minItemWidth: "sm", gap: "md" }`):
     - Pipeline Stage Distribution: `bar` or `stacked` chart showing deal value or count by pipeline stage (`maxWidth: "lg"`).
     - Revenue Booking Velocity: `line` or `area` chart showing contracted revenue pace over weeks or quarters (`maxWidth: "lg"`).
   - If only one chart is needed, clamp it with `maxWidth: "md"` (720px) or `"lg"` inside a clean `section`.
3. **Deal-level Opportunity Table**:
   - Granular detail table below the analytics in a clean `section` (`props: { title: "Open Pipeline & Key Opportunities" }`).
   - Table uses `maxWidth: "full"` with searchable and sortable columns: `Opportunity`, `Account`, `Owner`, `Stage`, `Amount ($)`, `Expected Close Date`.

## Style & Theming Guide

- **Semantic Tones**: Use `tone: "success"` for exceeded quotas or closed deals; `tone: "warning"` for pipeline coverage risks; `tone: "danger"` for stalled deals past close date. Never use arbitrary hex colors or inline CSS styles.
- **Number Discipline**: Keep raw dollar amounts and rates as pure numbers in `data`. Put currency units (`$k`, `$M`) in labels and column headers.
- **Dual Projection**: Lead with a concise 1–2 sentence finding stating booked revenue against quota and the quarter's key driver. Spoken gist mode reads this first sentence in isolation.

## Filtering & Action Boundaries

- **Interactive filters**: Provide bound controls (`select`, `date`) in a compact form container (`maxWidth: "md"`) with an explicit submit action (`submit: "filter_sales"`).
- **Coherent updates**: Submitting a filter must recalculate KPI totals, update the stage chart, refresh the opportunity table and revise the natural-language summary together.
- **CRM integration boundaries**: Generating or editing a sales dashboard does not create, update or sync records in external CRMs (Salesforce, HubSpot) unless an authorized integration tool returns a verified receipt.
