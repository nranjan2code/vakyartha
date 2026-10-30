# Voice Desk & Note Taker

Voice Desk is an interactive local workbench and cognitive note-taking workspace built for the Vakyartha platform. It turns unstructured spoken thoughts, meeting discussions, and brainstorming sessions into clean, structured notes, formal decision records, and actionable checklists.

## Core Features

- **Smart Speech Dictation**: Works seamlessly with Vakyartha's in-composer dictation and local voice engine. Natural speech disfluencies, stuttered repetitions, hesitation markers ("um", "ah", "humm"), and mid-sentence backtrackings are automatically normalized without altering first-person intent.
- **Dual Visual and Spoken Projections**: Built on Projection's liquid layout framework (`<vak-surface>`). Every note and decision can be viewed on the dynamic Canvas or read aloud through local voice synthesis (`readAloud`).
- **Interactive Checklists**: Live action item management with clickable tasks, explicit owners, and statuses. Toggling tasks and updating records happens with zero model latency directly inside the sandboxed app worker.
- **Hybrid Input**: Users can dictate via microphone (⌘D), edit notes directly in multi-line textareas, add tags, or create new action items manually.
- **Privacy & Local Persistence**: All notes, transcripts, and actions persist locally in `<data>/app-state/voice-desk.json`. Network access is isolated and zero external requests are made during note editing.

## Usage and Interface

1. **Workbench Surface**: Provides a 4-column metric overview (Total Notes, Pending Actions, Decisions, Categorized Tags), a split note explorer and editor, interactive action tables, and an audio transcript drawer.
2. **Action Register Surface**: Aggregates all open and completed deliverables across all notes into a searchable, sortable register.
3. **Exporting**: Notes can be exported directly to standard Markdown and downloaded to the local filesystem using the native platform export command.
