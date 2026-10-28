---
name: sales-dashboard
description: Create a sales performance or opportunity-pipeline dashboard with stages, targets, period comparisons and source-backed deal detail.
license: MIT
compatibility: Works with CRM exports, sales pipeline spreadsheets, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.2"
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

## Dashboard Architecture

Structure the sales canvas into three coordinated tiers:
1. **Executive KPI Strip**:
   - Total Booked Revenue (vs Quota / Target).
   - Quota Attainment Percentage.
   - Total Active Pipeline Value.
   - Win Rate (%) and Average Deal Size.
2. **Visual Funnel & Trend Analysis**:
   - Stage breakdown: `bar` or `stacked` chart showing deal value or count by pipeline stage.
   - Time series: `line` or `area` chart showing revenue bookings over the quarter/year.
3. **Deal-level Opportunity Table**:
   - Granular table displaying Opportunity Name, Account, Owner, Stage, Amount, and Expected Close Date.

## Filtering & Action Boundaries

- **Interactive filters**: Provide bound controls (`select`, `date`) for filtering by Sales Rep, Region or Stage with a submit action (`vak_submit`).
- **Coherent updates**: Submitting a filter must recalculate KPI totals, update the stage chart, refresh the opportunity table and revise the natural-language summary together.
- **CRM integration boundaries**: Generating or editing a sales dashboard does not create, update or sync records in external CRMs (Salesforce, HubSpot) unless an authorized integration tool returns a verified receipt.
