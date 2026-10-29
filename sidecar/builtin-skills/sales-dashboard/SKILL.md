---
name: sales-dashboard
description: Create a sales performance or opportunity-pipeline dashboard with stages, targets, period comparisons and source-backed deal detail.
license: MIT
compatibility: Works with CRM exports, sales pipeline spreadsheets, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Sales Performance & Pipeline Dashboards

Framework for analyzing sales pipeline health, revenue realization, win rates, quota attainment and deal-level execution.

## Overview & Chaining

- **Purpose**: Use this skill when asked to review sales rep or team performance, analyze pipeline conversion funnels, track quota progress, or build a sales dashboard.
- **Skill chaining**:
  - Load `dashboard` and `interactive-ui` for metric mappings, stage charts and filtering.
  - The required `surface-design` skill governs visual layout, supported charts, detail tables and spoken summaries.
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

## Filtering & Action Boundaries

- **Interactive filters**: Provide bound controls (`select`, `date`) in a compact form container (`maxWidth: "md"`) with an explicit submit action (`submit: "filter_sales"`).
- **Coherent updates**: Submitting a filter must recalculate KPI totals, update the stage chart, refresh the opportunity table and revise the natural-language summary together.
- **CRM integration boundaries**: Generating or editing a sales dashboard does not create, update or sync records in external CRMs (Salesforce, HubSpot) unless an authorized integration tool returns a verified receipt.
