---
name: meeting-actions
description: Turn meeting notes or a supplied transcript into decisions, action items and unresolved questions; use summarize for a general summary.
license: MIT
compatibility: Works with text notes, meeting transcripts, audio transcription summaries, and action registers.
metadata:
  author: nranjan2code
  version: "1.2"
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

## Meeting Action Canvas

When rendering an interactive meeting review canvas:
1. **Meeting Header**:
   - Title, meeting date, attendees, and meeting purpose.
2. **Decisions Card**:
   - High-contrast card listing formal agreements.
3. **Action Register Table**:
   - Render a structured table using `interactive-ui` with columns: `Task`, `Owner`, `Due Date`, `Status` (with bound checkboxes).
4. **Draft Follow-up Message**:
   - Provide a concise email/message draft ready for the user to copy or send to attendees.

## External Tool Boundaries

- **Draft status**: Generating minutes and action items produces local review text.
- **External dispatch**: Creating tickets in Jira, sending Slack/Telegram messages, or updating Google Calendar requires matching integration tools and user approvals.
