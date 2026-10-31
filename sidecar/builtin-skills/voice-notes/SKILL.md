---
name: voice-notes
description: Turn spoken audio transcripts, voice dictations, and brainstorming brain dumps into structured notes, executive summaries, decisions, and interactive action items.
license: MIT
compatibility: Voice note and dictation distillation in chat and Canvas surfaces.
metadata:
  author: nranjan2code
  version: "1.0"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Voice Notes & Speech Distillation

Framework for transforming raw, rambling voice dictations, audio transcripts, and stream-of-consciousness brainstorms into polished, structured notes, decision logs, and actionable checklists.

## Overview & Chaining

- **Purpose**: Use this skill when the user dictates or provides a spoken brain dump, asks to organize meeting thoughts, or requests a structured note from voice input. For notes they want to keep and revisit, point them to Apps → Voice Desk, which stores notes and action items locally; you do not operate that app.
- **Skill chaining**:
  - Load `interactive-ui` when generating an interactive checklist with live checkboxes, owner filters, or note editing forms.
  - The required `surface-design` skill governs 3-tier liquid layouts, metric strips, container query clamping, and spoken audio summaries.
  - Load `meeting-actions` when processing multi-participant discussions with formal resolutions, motions, or consensus points.
  - Load `task-tracker` when extracted action items need to be merged into a multi-week team backlog or sprint roadmap.
  - Load `write-email` or `summarize` when the user wants an executive memo or email draft derived from their voice notes.

## Disfluency Normalization Principles

When processing verbatim transcription:
1. **Remove conversational noise**:
   - Strip hesitation tokens and filler phrases (*"um"*, *"uh"*, *"humm"*, *"like"*, *"you know"*, *"if and but"*, *"so yeah"*).
   - Eliminate stuttered repetitions (*"I I was thinking"* -> *"I was thinking"*).
2. **Resolve mid-stream backtrackings**:
   - When the speaker changes their mind (*"Let's schedule for Tuesday... wait no, Wednesday at 3"*), resolve directly to the corrected statement (*"Schedule for Wednesday at 3:00 PM"*).
3. **Preserve speaker intent & voice**:
   - Maintain first-person voice (*"I decided"* / *"We agreed"*).
   - Do not hallucinate, elaborate, or speculate beyond the speaker's stated thoughts.

## Automatic Structural Formatting

Apply appropriate structural formatting based on spoken cues:
- **Paragraph Separation**: Format distinct topics or conversational shifts into clean, readable paragraphs with double spacing.
- **Bullet & Numbered Lists**: Automatically transform spoken enumerations, sequences of steps, or lists of items (*"first... second..."*, *"a few things: X, Y, Z"*) into standard markdown bullets (`- `) or ordered numbers (`1. `).
- **Data & Comparison Tables**: When the speaker describes structured attributes, metrics, or entities (e.g. server specs, comparative prices, dates, team allocations), format them into clean markdown tables or Projection `table` components rather than run-on prose.
- **Interactive Task Registers**: Structure deliverable items with interactive checkboxes bound to canonical state pointers via `interactive-ui`.

## Core Taxonomy

Structure voice notes into clean, distinct sections:

1. **Executive Synthesis**:
   - A crisp 1–2 sentence summary of the core thesis, objective, or announcement.
2. **Key Takeaways & Observations**:
   - Categorized bullet points capturing core ideas, technical details, or observations.
3. **Decisions Made**:
   - Explicit agreements, architectural choices, or accepted proposals with stated rationales.
4. **Action Items & Deliverables**:
   - Every action item must feature:
     - **Action**: An imperative verb phrase (*"Refactor dictation adapter"*).
     - **Owner**: The explicitly named individual. If unspecified, mark as `Unassigned`.
     - **Due Date**: Explicit target deadline, if mentioned.
5. **Tags & Categorization**:
   - Relevant hashtags for organizing and filtering notes (e.g. `#architecture`, `#meetings`, `#strategy`).
6. **Verbatim transcript (only when asked)**:
   - Keep it in a collapsed `accordion`, never as the main content.

## Dual Spoken & Visual Projection

- **Visual Surface**: Lead with the synthesis, then takeaways, decisions and an action checklist. No metric strips or decorative cards for a short note; follow `surface-design` density rules.
- **Spoken Summary**: Provide a concise 1-sentence audible briefing via TTS (*"Saved note on 'Q4 Strategy' with 2 action items assigned to you."*).
- **Integrity Guarantee**: Never invent deadlines, assignees, or factual claims not present in the speaker's audio.
