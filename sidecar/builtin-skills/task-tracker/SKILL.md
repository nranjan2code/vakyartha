---
name: task-tracker
description: Create or revise a personal or team work tracker with statuses, owners, deadlines and blockers; use plan-my-day for time-blocking a single day.
license: MIT
compatibility: Works with text checklists, markdown tables, and interactive task management canvases.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Task Tracking & Work Management

Methodology for creating, structuring and managing personal or collaborative work trackers, project task lists, and sprint backlogs.

## Overview & Chaining

- **Purpose**: Use this skill when asked to organize tasks, manage a project action list, track team responsibilities, or build an interactive task tracker.
- **Skill chaining**:
  - Load `interactive-ui` for reactive checklist bindings, status updates and task creation forms.
  - The required `surface-design` skill governs card layout, status badges, typography and spoken summaries.
  - Use `plan-my-day` when the goal is scheduling tasks into specific calendar time slots for a single day.
  - Use `operations-dashboard` when measuring high-volume ticket queues, cycle times and team SLAs.

## Task Data Invariants

1. **Core attributes**:
   - **Identity**: Unique ID (e.g. `TASK-01`) and clear, actionable title.
   - **Status**: Standard states: `To Do`, `In Progress`, `Blocked`, `Done`.
   - **Owner / Assignee**: Preserve explicit names; leave unassigned tasks labeled `Unassigned` rather than inventing assignees.
   - **Priority**: Categorize as `P0 / Critical`, `P1 / High`, `P2 / Medium`, or `P3 / Low`.
   - **Due Date**: Preserve explicit deadlines; distinguish due dates from task creation dates.
   - **Blockers & Notes**: Document specific technical or external blockers impeding progress.
2. **Integrity rules**:
   - Never invent tasks, owners or completion dates not provided or authorized by the user.
   - Preserve existing task IDs and descriptions when updating tracker state.

## Adaptive Task Canvas Layout

Never stretch simple task forms or short checklists 100% wide across a desktop canvas. Structure the task tracker into balanced, responsive sections:

1. **Task Health KPI Strip**:
   - 4-metric fluid `grid` (`props: { columns: 4, minItemWidth: "sm" }`):
     - Total Tasks.
     - In Progress.
     - Blocked / Critical Items (with `tone: "danger"` if $>0$).
     - Completed (% Done or count).
2. **Adaptive Work Management Tier**:
   - **Option A — Split Primary/Detail**: Use a `split` container (`props: { ratio: [2, 1], gap: "md" }`):
     - Left (2/3 width): Main interactive task table or checklist with bound checkboxes (`bind: "/tasks/0/done"`), owners, due dates and priority tags.
     - Right (1/3 width): Clamped "Add Task" or triage filter form (`maxWidth: "md"`) with bound fields for Title, Assignee, Priority, and Due Date.
   - **Option B — Stacked with Clamped Measures**: If arranged vertically, place the task table in a full-width `section` (`maxWidth: "full"`), while keeping the "Add Task" form clamped to `maxWidth: "md"` (720px) so inputs remain ergonomically sized.

## Style & Theming Guide

- **Semantic Tones**: Use `tone: "danger"` for Blocked items or overdue tasks; `tone: "warning"` for tasks due today; `tone: "success"` for Completed items. Never hardcode hex color codes or inline CSS.
- **Clean Typography**: Use `variant: "heading"` for the tracker title, `variant: "caption"` for last-updated timestamps or project milestone contexts.
- **Dual Projection**: Lead with a concise 1–2 sentence summary stating total open items, blockers, and nearest deadline. Spoken gist mode reads this first sentence in isolation.

## State Mutations & External Boundaries

- **Checkbox semantics**: Toggling a task checkbox marks the task status in the interface; it does not perform the underlying physical or computational work.
- **Coherent updates**: Submitting a status change or adding a task must update summary metrics, the task list, and the natural-language summary together.
- **External sync boundaries**: Generating or editing a task tracker in Vakyartha does not sync with external task managers (Asana, Trello, Jira, Todoist, Apple Reminders) unless an authorized integration tool confirms a verified receipt.
- **Notification limits**: Do not promise automated background reminders or push notifications unless a supported scheduling tool is configured.
