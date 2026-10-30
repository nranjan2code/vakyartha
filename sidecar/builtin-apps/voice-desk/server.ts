export interface ActionItem {
  id: string;
  noteId: string;
  noteTitle: string;
  task: string;
  owner: string;
  status: "To Do" | "Done";
}

export interface DecisionItem {
  id: string;
  noteId: string;
  decision: string;
  date: string;
}

export interface Note {
  id: string;
  title: string;
  tags: string;
  content: string;
  rawTranscript: string;
  updatedAt: string;
  actions: ActionItem[];
  decisions: DecisionItem[];
}

export interface State {
  notes?: Note[];
  activeId?: string;
  activeTitle?: string;
  activeTags?: string;
  activeContent?: string;
  activeRaw?: string;
  newNoteTitle?: string;
  newActionText?: string;
  newActionOwner?: string;
  statusMessage?: string;
}

export interface Context {
  state: State;
  surfaces: Record<string, unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function init(s: State): void {
  if (!s.notes || !Array.isArray(s.notes) || s.notes.length === 0) {
    const welcomeNote: Note = {
      id: "note-1",
      title: "Welcome to Voice Desk",
      tags: "#voice #notes",
      content: "Welcome to Voice Desk.\n\nSpeak naturally via dictation (⌘D) or type your thoughts directly. Verbal fillers ('um', 'ah') and self-corrections are cleaned up using the active model.",
      rawTranscript: "Uh, hello and welcome to Voice Desk. You can, um, speak your thoughts or type them.",
      updatedAt: "2026-10-30",
      actions: [
        {
          id: "act-1",
          noteId: "note-1",
          noteTitle: "Welcome to Voice Desk",
          task: "Try dictating a note with ⌘D",
          owner: "You",
          status: "To Do",
        },
        {
          id: "act-2",
          noteId: "note-1",
          noteTitle: "Welcome to Voice Desk",
          task: "Type edits in the note content editor",
          owner: "You",
          status: "Done",
        },
      ],
      decisions: [
        {
          id: "dec-1",
          noteId: "note-1",
          decision: "Voice Desk stores notes locally with zero network leakage",
          date: "2026-10-30",
        },
      ],
    };
    s.notes = [welcomeNote];
    s.activeId = welcomeNote.id;
    s.activeTitle = welcomeNote.title;
    s.activeTags = welcomeNote.tags;
    s.activeContent = welcomeNote.content;
    s.activeRaw = welcomeNote.rawTranscript;
  }
  s.activeId ??= s.notes[0]?.id;
  const active = s.notes.find((n) => n.id === s.activeId) ?? s.notes[0];
  if (active) {
    s.activeTitle ??= active.title;
    s.activeTags ??= active.tags;
    s.activeContent ??= active.content;
    s.activeRaw ??= active.rawTranscript;
  }
  s.newNoteTitle ??= "";
  s.newActionText ??= "";
  s.newActionOwner ??= "";
  s.statusMessage ??= "Ready. Dictate with ⌘D or edit notes below.";
}

export function project(c: Context) {
  init(c.state);
  const s = c.state;
  const notes = s.notes!;
  const active = notes.find((n) => n.id === s.activeId) ?? notes[0]!;

  const allActions = notes.flatMap((n) => n.actions);
  const allDecisions = notes.flatMap((n) => n.decisions);
  const tagSet = new Set(
    notes.flatMap((n) => n.tags.split(/\s+/).filter((t) => t.startsWith("#"))),
  );

  const workbenchData = {
    noteCount: String(notes.length),
    actionCount: String(allActions.filter((a) => a.status === "To Do").length),
    decisionCount: String(allDecisions.length),
    tagCount: String(tagSet.size),
    statusMessage: s.statusMessage ?? "Ready.",
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      updatedAt: n.updatedAt,
    })),
    activeTitle: s.activeTitle ?? active.title,
    activeTags: s.activeTags ?? active.tags,
    activeContent: s.activeContent ?? active.content,
    activeRaw: active.rawTranscript,
    newNoteTitle: s.newNoteTitle ?? "",
    newActionText: s.newActionText ?? "",
    newActionOwner: s.newActionOwner ?? "",
    actions: active.actions.map((a) => ({
      id: a.id,
      task: a.task,
      owner: a.owner,
      status: a.status,
    })),
    decisions: active.decisions,
  };

  const openCount = allActions.filter((a) => a.status === "To Do").length;
  const doneCount = allActions.filter((a) => a.status === "Done").length;

  const actionsData = {
    totalCount: String(allActions.length),
    openCount: String(openCount),
    doneCount: String(doneCount),
    allActions: allActions.map((a) => ({
      id: a.id,
      noteTitle: a.noteTitle,
      task: a.task,
      owner: a.owner,
      status: a.status,
    })),
    coverage: `Central register of ${allActions.length} action items across ${notes.length} Voice Desk notes.`,
  };

  return {
    updates: [
      { surface: "workbench", data: workbenchData },
      { surface: "actions", data: actionsData },
    ],
  };
}

export async function handleAction(
  id: string,
  value: unknown,
  c: Context,
  action?: string,
) {
  init(c.state);
  const s = c.state;
  const notes = s.notes!;
  const today = new Date().toISOString().slice(0, 10);

  // Form field bindings
  if (id === "/activeTitle") {
    s.activeTitle = String(value ?? "");
    return project(c);
  }
  if (id === "/activeTags") {
    s.activeTags = String(value ?? "");
    return project(c);
  }
  if (id === "/activeContent") {
    s.activeContent = String(value ?? "");
    return project(c);
  }
  if (id === "/newNoteTitle") {
    s.newNoteTitle = String(value ?? "");
    return project(c);
  }
  if (id === "/newActionText") {
    s.newActionText = String(value ?? "");
    return project(c);
  }
  if (id === "/newActionOwner") {
    s.newActionOwner = String(value ?? "");
    return project(c);
  }

  // Action dispatches
  if (action === "create_note" || id === "create_note") {
    const title = (s.newNoteTitle || "").trim() || "Untitled Note";
    const newNote: Note = {
      id: `note-${Date.now()}`,
      title,
      tags: "#note",
      content: "",
      rawTranscript: "",
      updatedAt: today,
      actions: [],
      decisions: [],
    };
    notes.unshift(newNote);
    s.activeId = newNote.id;
    s.activeTitle = newNote.title;
    s.activeTags = newNote.tags;
    s.activeContent = newNote.content;
    s.activeRaw = newNote.rawTranscript;
    s.newNoteTitle = "";
    s.statusMessage = `Created note "${title}".`;
    return project(c);
  }

  if (action === "save_note" || id === "save_note") {
    const active = notes.find((n) => n.id === s.activeId);
    if (active) {
      active.title = (s.activeTitle ?? active.title).trim() || "Untitled Note";
      active.tags = (s.activeTags ?? active.tags).trim();
      active.content = s.activeContent ?? active.content;
      active.updatedAt = today;
      // Sync noteTitle in active actions
      for (const a of active.actions) a.noteTitle = active.title;
      s.statusMessage = `Saved changes to "${active.title}".`;
    }
    return project(c);
  }

  if (action === "delete_note" || id === "delete_note") {
    if (notes.length <= 1) {
      s.statusMessage = "Cannot delete the only remaining note.";
      return project(c);
    }
    const idx = notes.findIndex((n) => n.id === s.activeId);
    if (idx !== -1) {
      const removed = notes.splice(idx, 1)[0]!;
      const next = notes[Math.max(0, idx - 1)]!;
      s.activeId = next.id;
      s.activeTitle = next.title;
      s.activeTags = next.tags;
      s.activeContent = next.content;
      s.activeRaw = next.rawTranscript;
      s.statusMessage = `Deleted note "${removed.title}".`;
    }
    return project(c);
  }

  if (action === "add_action" || id === "add_action") {
    const active = notes.find((n) => n.id === s.activeId);
    const task = (s.newActionText || "").trim();
    if (!task) {
      s.statusMessage = "Provide a task description to add an action.";
      return project(c);
    }
    if (active) {
      const owner = (s.newActionOwner || "").trim() || "You";
      active.actions.push({
        id: `act-${Date.now()}`,
        noteId: active.id,
        noteTitle: active.title,
        task,
        owner,
        status: "To Do",
      });
      s.newActionText = "";
      s.newActionOwner = "";
      s.statusMessage = `Added action item to "${active.title}".`;
    }
    return project(c);
  }

  if (action === "export_markdown" || id === "export_markdown") {
    const active = notes.find((n) => n.id === s.activeId);
    if (active) {
      s.statusMessage = `Note "${active.title}" ready for export (${active.content.length} chars, ${active.actions.length} tasks).`;
    }
    return project(c);
  }

  throw new Error(`Unknown Voice Desk action: ${action || id}`);
}
