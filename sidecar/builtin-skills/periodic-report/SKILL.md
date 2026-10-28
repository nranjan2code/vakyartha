---
name: periodic-report
description: Prepare a daily, weekly or monthly status/performance report from supplied records, prior reports or governed source reads, with an optional dashboard.
license: MIT
compatibility: Works with text chat, markdown reports, and interactive canvas surfaces.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: use_skill
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

## Presentation & Delivery Boundaries

- **Tone**: Keep reporting objective, candid and balanced. Acknowledge setbacks with the same clarity as successes.
- **Dual projection**: When creating a canvas report, lead with a concise spoken-friendly headline so voice synthesis provides an effective audio briefing.
- **Delivery limits**: Generating a periodic report does not configure an automatic recurring cron trigger. Scheduled recurring tasks or email dispatches require matching configured tools and user approvals.
