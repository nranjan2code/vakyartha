# Skills Supporting Voice Desk

This document describes how agent skills collaborate with the Voice Desk application. It does not grant ambient authority or bypass user approval gates.

## Collaborating Skills

- **voice-notes**: The primary procedure for translating stream-of-consciousness spoken recordings, voice memos, and brainstorm transcripts into structured notes with executive summaries, decisions, and tasks.
- **interactive-ui**: Teaches reactive UI bindings, interactive checklist updates, and data-bound form controls for editing notes and action tables.
- **surface-design**: The always-on design skill governing responsive 3-tier liquid layouts, clamped container measures, accessible typography, and dual spoken voice feedback.
- **meeting-actions**: Specializes in extracting formal votes, consensus agreements, explicit owner assignments, and unresolved questions from multi-speaker conference transcripts.
- **task-tracker**: Integrates note-derived action items into broader multi-week backlogs, sprint boards, and project roadmaps.
- **summarize & write-email**: Formats unstructured notes into publication-ready briefing memos or executive status emails.

## Execution Rules

- Ordinary user interactions (typing into textareas, creating notes, toggling checkboxes) execute directly via `server.ts` without model invocations.
- Conversational chat turns interact with Voice Desk by loading relevant skills through `use_skill` and updating surface data through verified platform tools (`vak_update`, `vak_render`).
- External tool dispatches (such as creating Jira tickets or sending emails) require explicit user approval.
