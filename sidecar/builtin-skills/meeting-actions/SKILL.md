---
name: meeting-actions
description: Turn meeting notes or a supplied transcript into decisions, action items and unresolved questions; use summarize for a general summary.
license: MIT
compatibility: Works with text notes, meeting transcripts, audio transcription summaries, and action registers.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Meeting Minutes & Action Item Extraction

Framework for distilling unstructured meeting notes, transcripts and discussion logs into clear decisions, assigned action items and open questions.

## Overview & Chaining

- **Purpose**: Use this skill when asked to extract action items from a meeting, draft meeting minutes, record formal decisions, or prepare post-meeting follow-ups.
- **Skill chaining**:
  - Load `interactive-ui` when generating an interactive action register with checkboxes, owner filters and status updates.
  - The required `surface-design` skill governs table layout, decision cards and spoken summaries.
  - Use `summarize` when the user wants a narrative summary of a document or meeting without an action item focus.
  - Load `task-tracker` when the extracted actions need to be folded into a broader multi-week project backlog.

## Core Extraction Taxonomy

Structure meeting outcomes into four distinct categories:

1. **Agreed Decisions**:
   - Document formal choices, approved proposals, architectural decisions or strategic directions agreed upon by the group.
   - Note the stated rationale and any key alternatives considered and rejected.
2. **Action Items**:
   - Capture specific tasks generated during the discussion.
   - Every action item must clearly state:
     - **Action**: A clear imperative verb phrase defining the deliverable.
     - **Owner**: The specific named individual responsible.
     - **Due Date**: The explicit target completion deadline.
3. **Open Questions & Deferred Topics**:
   - Record issues that were discussed but left unresolved due to missing data, lack of authority, or time constraints.
   - Note who is assigned to investigate each open question and when the group will reconvene.
4. **General Information & Context**:
   - Briefly summarize informational updates shared that do not require specific action.

## Action Item Rigor & Integrity

- **Explicit ownership**: Only assign action items to people explicitly named in the notes or transcript. Never guess or invent assignees. If ownership was unclear, mark as `Unassigned / Needs Owner`.
- **Date precision**: Preserve stated deadlines. Clearly distinguish the **meeting date** from the **due date** of a deliverable. Do not invent due dates if none were stated.
- **Capture dissent**: Preserve notable reservations, dissent or conditional agreements that could affect the execution of a decision.

## Adaptive Meeting Action Canvas Layout

Never output a flat single-column page that stretches short notes across 100% of a wide canvas. Structure the canvas adaptively:

1. **Meeting Header & Outcomes Strip**:
   - Lead with a concise summary stating meeting title, date, attendees and primary accomplishment.
   - Follow with a fluid `grid` (`props: { columns: 3, minItemWidth: "sm" }`) showing Total Actions, High Priority Deliverables, and Open Questions.
2. **Adaptive Decision & Action Tier**:
   - **Agreed Decisions**: Present in a clean `section` (`props: { title: "Agreed Decisions & Rationale" }`) or paired 2-column `grid` alongside open questions.
   - **Action Register Table**: Render a structured table below in a clean `section` (`props: { title: "Assigned Action Items" }`). Table uses `maxWidth: "full"` with columns: `Deliverable`, `Owner`, `Due Date`, `Priority`, and bound completion checkboxes (`bind: "/actions/0/done"`).
3. **Draft Follow-up Message**:
   - Provide a pre-formatted follow-up note inside a clamped container (`maxWidth: "md"`, 720px) ready for review or export.

## Style & Theming Guide

- **Semantic Tones**: Use `tone: "success"` for ratified agreements; `tone: "warning"` for open questions requiring research; `tone: "danger"` for blocked deliverables. Never hardcode hex colors or inline CSS.
- **Dual Projection**: Lead with a concise 1–2 sentence finding stating meeting date, top strategic decision made, and count of assigned follow-up items. Spoken gist mode reads this first sentence in isolation.

## External Tool Boundaries

- **Draft status**: Generating minutes and action items produces local review text.
- **External dispatch**: Creating tickets in Jira, sending Slack/Telegram messages, or updating Google Calendar requires matching integration tools and user approvals.
