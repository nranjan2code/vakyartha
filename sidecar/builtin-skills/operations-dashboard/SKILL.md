---
name: operations-dashboard
description: Create a service or delivery dashboard for backlog, throughput, aging, blockers and service targets from supplied operational records.
license: MIT
compatibility: Works with issue trackers, ticketing systems, delivery logs, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.2"
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

## Operations Dashboard Layout

Structure the operations canvas into three focused tiers:
1. **Queue Health KPI Strip**:
   - Total Open Backlog (with delta vs prior period).
   - Throughput (items resolved during period).
   - Average Cycle / Resolution Time.
   - SLA Target Compliance (% met).
   - Critical Blockers / High-Severity Incidents.
2. **Workload & Aging Visualizations**:
   - Queue composition: `bar` or `stacked` chart showing backlog items grouped by Severity, Status or Team.
   - Throughput trend: `line` chart tracking new arrivals versus resolved items over time.
   - Aging distribution: `bar` chart with defined age buckets (e.g. $<24$h, 1–3d, 4–7d, $>7$d).
3. **Exceptions & High-Priority Table**:
   - Detail table highlighting SLA-breached tickets, critical incidents and escalated blockers with Item ID, Title, Severity, Assignee, Status, and Age (days).

## Action Handling & System Boundaries

- **Interactive triage**: Provide bound filters (`select`, `checkbox`) for Team, Severity, or SLA Status with a submit action (`vak_submit`).
- **Coherent recalculation**: Submitting a filter must recalculate backlog counts, update charts, refresh the exception list and revise the natural-language summary together.
- **External ticketing sync**: Rendering an operational dashboard does not update tickets in Jira, ServiceNow, Zendesk or GitHub Issues unless an authorized tool returns a verified receipt.
