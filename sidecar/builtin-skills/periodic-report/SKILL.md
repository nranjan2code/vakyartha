---
name: periodic-report
description: Prepare a daily, weekly or monthly status/performance report from supplied records, prior reports or governed source reads, with an optional dashboard.
license: MIT
compatibility: Works with text chat, markdown reports, and interactive canvas surfaces.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Periodic Status & Performance Reporting

Framework for drafting structured daily, weekly, monthly and quarterly status reports, progress reviews and operational retrospectives.

## Overview & Chaining

- **Purpose**: Use this skill when generating recurring performance reports, sprint recaps, management briefings or team updates from supplied records or notes.
- **Skill chaining**:
  - Load `dashboard` and `interactive-ui` if an interactive visual canvas with charts and KPI strips is requested.
  - The required `surface-design` principles govern visual and spoken layout when a canvas is rendered.
  - For simple text or email summaries, provide clean Markdown without forcing unnecessary UI surfaces.

## Period Definition & Boundary Discipline

1. **Exact boundaries**: Clarify the exact start and end timestamps, timezones and reporting cadence (e.g. "Monday Oct 21 00:00 to Friday Oct 25 23:59 UTC").
2. **Completed periods vs Period-to-date**: Clearly distinguish between a fully closed period (e.g. full month of September) and period-to-date metrics (e.g. October MTD, day 18 of 31).
3. **Comparability**:
   - Compare current metrics only against truly comparable prior periods (e.g. week-over-week, month-over-month, year-over-year).
   - Explicitly disclose anomalies, missing days, holiday schedules or altered metric definitions that affect comparisons.
   - Never fabricate historical benchmarks if prior period data is absent.

## Standard Report Architecture

Structure reports logically to facilitate executive scanning:

1. **Executive Summary**:
   - 2–3 sentences highlighting primary outcomes, milestone status, and the single most critical decision or escalation.
2. **Key Accomplishments**:
   - Bulleted list of shipped deliverables, resolved customer issues, or achieved milestones.
   - Ground items in verifiable evidence; omit speculative forward-looking claims here.
3. **Core Performance Metrics**:
   - Table or metric cards comparing Actual vs Target and Delta vs Prior Period.
   - Always state explicit units, percentages and currency symbols.
4. **Blockers, Risks & Mitigations**:
   - Document active impediments, technical risks, schedule dependencies and proposed mitigation actions.
   - Assign clear ownership for each risk.
5. **Priorities for Next Period**:
   - Outline the 3–5 high-impact objectives planned for the upcoming cycle with committed target dates.

## Liquid Canvas Architecture for Status & Performance Reports

Choose a content-driven composition with the shared `surface-design` guidance. A single column or a full-width analytical panel can be appropriate. The following are optional patterns; include only sections and indicators that answer the requested question, with no required tier or column count:

1. **Executive Briefing & 4-Column KPI Strip**:
   - **Spoken lead**: 1–2 sentences clearly summarizing period performance, key milestone attainment, and primary escalation so voice projection is immediate.
   - **KPI grid**: 4-column metric strip (`grid` with `props: { columns: 4, minItemWidth: "xs" }`):
     - Actual vs Target measures with signed deltas and semantic tones (`tone: "positive"` for beating target, `"caution"` for near-threshold, `"critical"` for missed SLA).
2. **Paired 2-Column Analytics Grid**:
   - Paired visual grid (`grid` with `props: { columns: 2, minItemWidth: "sm" }`):
     - **Left**: Milestone / Delivery Progress (`bar` chart, `props: { maxWidth: "md" }`).
     - **Right**: Burn / Velocity Trend (`line` chart, `props: { maxWidth: "md" }`).
   - If only one chart exists, clamp it with `props: { maxWidth: "md" }` or pair with an Accomplishments / Blockers summary card (`card` with `props: { maxWidth: "md" }`). Never span a chart across 100% width on wide desktop monitors.
3. **Granular Deliverables Table & Forward Commitments**:
   - **Deliverables Table**: Dense data table (`section` with `table`, `maxWidth: "full"`):
     - Granular rows mapping canonical records: Deliverable, Owner, Milestone, Status, Target Date.
   - **Next Period Priorities Card**: Bounded card or checklist (`card` with `maxWidth: "md"`).

## Presentation & Delivery Boundaries

- **Tone & Style**: Keep reporting objective, candid and balanced. Use semantic tones exclusively; never inject raw CSS or hex codes.
- **Dual projection**: When creating a canvas report, lead with a concise spoken-friendly headline so voice synthesis provides an effective audio briefing.
- **Delivery limits**: Generating a periodic report does not configure an automatic recurring cron trigger. Scheduled recurring tasks or email dispatches require matching configured tools and user approvals.
