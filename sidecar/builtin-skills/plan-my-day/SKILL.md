---
name: plan-my-day
description: Use when the user wants to plan a day or organise a to-do list into a schedule.
license: MIT
compatibility: Works with text chat, timeline displays, and interactive daily schedule canvases.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Daily Planning & Time Blocking

Structured methodology for converting task backlogs, deadlines and daily goals into realistic, time-blocked daily schedules.

## Overview & Chaining

- **Purpose**: Use this skill when asked to plan an itinerary for the day, organize a to-do list into a schedule, prioritize daily tasks, or time-block a workday.
- **Skill chaining**:
  - Load `interactive-ui` when rendering an interactive agenda canvas with editable time blocks.
  - The required `surface-design` skill governs timeline layout, typography and spoken briefings.
  - Use `task-tracker` when the user needs general multi-day task backlog management rather than hour-by-hour time blocking.

## Daily Planning Methodology

1. **Lock in fixed commitments first**:
   - Identify immovable calendar events: scheduled meetings, flights, medical appointments, school pickups, or time-bound deliverables.
   - Place these into the day's timeline as fixed anchor blocks.
2. **Identify top daily priorities**:
   - Select 1–3 high-leverage "must-win" tasks that represent meaningful progress for the day.
   - Dedicate prime uninterrupted energy hours (typically morning) to deep focus on these priorities.
3. **Allocate realistic durations & transition buffers**:
   - Assign realistic time estimates to tasks; avoid hyper-optimistic scheduling that assumes zero friction.
   - Include 10–15 minute buffer intervals between meetings or intensive focus blocks for context switching, transit and rest.
   - Explicitly schedule meals, hydration and mental downtime.
4. **Build contingency overflow**:
   - Reserve an unallocated 30–60 minute block in the late afternoon to handle emergent issues, email backlog or overruns.
5. **Classify flexible tasks**:
   - Clearly delineate which tasks *must* finish today versus which items are flexible and can slide to tomorrow if schedule pressure mounts.

## Schedule Architecture & Canvas Presentation

When presenting a daily plan on an interactive canvas:
1. **Daily Focus Header**:
   - Lead with a concise summary stating the day's primary objective and total scheduled hours.
   - Metric cards (`stat`) showing Total Hours Planned, Deep Focus Time, Meeting Hours, and Available Buffer.
2. **Chronological Time-Block Table**:
   - Structured table listing `Time Window` (e.g. `09:00 - 10:30`), `Activity`, `Category` (`Focus`, `Meeting`, `Admin`, `Break`), and `Priority`.
   - Visual emphasis distinguishing fixed appointments from flexible focus blocks.
3. **Spoken Briefing Harmony**:
   - Ensure the first sentence articulates the start time, top priority, and total meeting load so the voice projection gives an immediate daily morning briefing.

## Calendar System Boundaries

- **Plan vs Write**: An agenda generated in Vakyartha is a proposed plan, not a calendar booking or calendar modification.
- **Calendar sync**: Adding, editing or deleting events in external calendars (Google Calendar, Apple Calendar, Outlook) requires authorized calendar integration tools and verified execution receipts.
