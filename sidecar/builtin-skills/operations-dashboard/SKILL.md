---
name: operations-dashboard
description: Create a service or delivery dashboard for backlog, throughput, aging, blockers and service targets from supplied operational records.
license: MIT
compatibility: Works with issue trackers, ticketing systems, delivery logs, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Operations & Service Delivery Dashboards

Operational methodology for monitoring workload queues, incident response, team throughput, ticket aging, SLA compliance and service bottlenecks.

## Overview & Chaining

- **Purpose**: Use this skill when asked to evaluate team delivery performance, track customer support ticket queues, monitor incident resolution SLAs, or audit operational backlogs.
- **Skill chaining**:
  - Load `dashboard` and `interactive-ui` for metric strips, queue mappings and interactive filter controls.
  - The required `surface-design` skill governs visual layout, bar/line charts and spoken audio briefings.
  - Load `task-tracker` when the primary focus is managing individual tasks and assignees rather than aggregate operational metrics.

## Operational Metrics & Throughput Rules

1. **Queue lifecycle metrics**:
   - **Active Backlog**: Snapshot count of all currently open, pending or in-progress work items.
   - **Throughput / Velocity**: Count of tickets or tasks successfully resolved/closed within the stated reporting window.
   - **Work In Progress (WIP)**: Count of items currently under active execution.
2. **Aging & Cycle time**:
   - **Ticket Age**: Elapsed time from creation to present for open tickets.
   - **Cycle Time / Lead Time**: Elapsed time from ticket initiation to completion for closed tickets.
   - *Rule*: Distinguish missing creation timestamps from zero age. Never calculate average resolution time by mixing open and closed items.
3. **SLA compliance & Service targets**:
   - Evaluate SLA breaches strictly against explicit contractual or team thresholds (e.g. Severity 1 response $< 1$ hour).
   - Do not mark a ticket "Overdue" or "Breached" unless an explicit deadline, due date or SLA rule is defined.

## Adaptive Operations Canvas Layout

Never stretch charts across 100% width on wide desktop screens. Structure the operations canvas into three adaptive tiers:

1. **Queue Health KPI Strip**:
   - Place 4 key indicators at the top using a fluid `grid` (`props: { columns: 4, minItemWidth: "sm" }`):
     - Total Open Backlog (with delta vs prior period).
     - Throughput (items resolved during period).
     - Average Resolution / Cycle Time (hours/days).
     - SLA Target Compliance (% met).
2. **Side-by-Side Analytics Tier (No 100% Chart Stretch)**:
   - Place two complementary visualizations in a 2-column `grid` (`props: { columns: 2, minItemWidth: "sm", gap: "md" }`):
     - Queue Composition: `bar` or `stacked` chart showing backlog items grouped by Severity, Status or Team (`maxWidth: "lg"`).
     - Arrival vs Throughput: `line` chart tracking created vs resolved items over the weeks (`maxWidth: "lg"`).
   - Alternatively, use `split` (`props: { ratio: [2, 1], gap: "md" }`) to place the primary trend on the left and a critical blockers card/alert on the right.
3. **Exceptions & High-Priority Table**:
   - Granular detail table below the analytics in a clean `section` (`props: { title: "Active Exceptions & Breaches" }`).
   - Table uses `maxWidth: "full"` with searchable and sortable columns: `ID`, `Title`, `Severity`, `Assignee`, `Status`, `Age (days)`.

## Style & Theming Guide

- **Semantic Tones**: Use `tone: "danger"` for SLA-breached tickets or critical outages; `tone: "warning"` for approaching thresholds; `tone: "success"` for met targets. Never hardcode hex colors or inline CSS.
- **Typography & Tone**: Lead with a clean intro stating overall SLA health, timeframe and coverage caveats. The TTS gist speaks this sentence.
- **Numbers**: Store raw counts and hours in `data`. Put units in headers/labels (`"Age (days)"`, `"Throughput (items)"`).

## Action Handling & System Boundaries

- **Interactive triage**: Provide bound filters (`select`, `checkbox`) for Team, Severity, or SLA Status in a compact form (`maxWidth: "md"`) with an explicit submit action (`submit: "triage_filter"`).
- **Coherent recalculation**: Submitting a filter must recalculate backlog counts, update charts, refresh the exception list and revise the natural-language summary together.
- **External ticketing sync**: Rendering an operational dashboard does not update tickets in Jira, ServiceNow, Zendesk or GitHub Issues unless an authorized tool returns a verified receipt.
