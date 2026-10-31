// Voice Desk: notes you speak or type, with action items. The notes in
// `context.state` are the only data owner; `view()` derives both surfaces and
// their spoken text from them on every run. Dictation and reading aloud are
// the host's `voice.dictate` / `voice.read` actions, so nothing here records
// audio, calls a model or reaches the network.

export interface ActionItem { id: string; text: string; done: boolean }
export interface Note { id: string; title: string; body: string; tags: string[]; actions: ActionItem[]; created: string; updated: string }
export interface State { notes?: Note[]; openId?: string; seq?: number; confirmDelete?: boolean; newAction?: string; capture?: string }

interface Node { id: string; type: string; props?: Record<string, unknown>; children?: string[] | { each: string; template: string } }
interface Update { surface: string; nodes: Node[]; data: { op: "replace"; path: "/"; value: Record<string, unknown> }[] }
export interface Context { state: State; surfaces?: Record<string, unknown>; now?: () => Date }

const MAX_NOTES = 500;
const MAX_BODY = 20_000;
const MAX_LINE = 300;

// --- canonical state ---------------------------------------------------------------

const text = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").slice(0, max);
const line = (v: unknown, max = MAX_LINE) => text(v, max).replace(/\s+/g, " ").trim();
/** Tags as typed ("#work, ideas") to a clean list: lower case, no #, no repeats. */
export const tagsFrom = (v: unknown) => [...new Set((Array.isArray(v) ? v.join(" ") : text(v, 400)).split(/[\s,]+/).map((t) => t.replace(/^#+/, "").toLowerCase()).filter((t) => /^[\p{L}\p{N}_-]{1,32}$/u.test(t)))].slice(0, 12);

/** State arrives as untrusted JSON: keep only well-formed notes and fields. */
export function normalize(s: State): State {
  const notes = (Array.isArray(s.notes) ? s.notes : []).slice(0, MAX_NOTES).flatMap((raw): Note[] => {
    const n = raw as Partial<Note> & Record<string, unknown>;
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) return [];
    const actions = (Array.isArray(n.actions) ? n.actions : []).flatMap((a): ActionItem[] => {
      const x = a as Partial<ActionItem> & Record<string, unknown>;
      const t = line(x?.text ?? x?.task);
      return x && typeof x.id === "string" && t ? [{ id: x.id, text: t, done: x.done === true || x.status === "Done" }] : [];
    });
    const stamp = typeof n.updated === "string" ? n.updated : typeof n.updatedAt === "string" ? n.updatedAt : new Date(0).toISOString();
    return [{ id: n.id, title: line(n.title), body: text(n.body ?? n.content, MAX_BODY), tags: tagsFrom(n.tags), actions, created: typeof n.created === "string" ? n.created : stamp, updated: stamp }];
  });
  const openId = notes.some((n) => n.id === s.openId) ? s.openId : notes[0]?.id;
  return { notes, openId, seq: Number.isInteger(s.seq) ? s.seq : notes.length, confirmDelete: s.confirmDelete === true && Boolean(openId), newAction: line(s.newAction), capture: text(s.capture, MAX_BODY) };
}

const nextId = (s: State, kind: string) => `${kind}-${(s.seq = (s.seq ?? 0) + 1)}`;
const open = (s: State) => s.notes!.find((n) => n.id === s.openId);
/** A note without a title is named by its first words. */
export const titleOf = (n: Note) => n.title || line(n.body.split("\n").find((l) => l.trim()) ?? "", 60) || "Untitled note";

// --- actions ---------------------------------------------------------------------

const FIELDS: Record<string, (n: Note, v: unknown) => void> = {
  "/note/title": (n, v) => { n.title = line(v, 120); },
  "/note/body": (n, v) => { n.body = text(v, MAX_BODY); },
  "/note/tags": (n, v) => { n.tags = tagsFrom(v); },
};

export async function handleAction(controlId: string, value: unknown, context: Context, action?: string) {
  const s = (context.state = normalize(context.state));
  const now = (context.now?.() ?? new Date()).toISOString();
  const note = open(s);
  const payloadId = (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") ? (value as { id: string }).id : undefined;
  const touch = (n: Note) => { n.updated = now; };
  let focusSurface: string | undefined;

  if (!action) {
    // A bound field: the open note's fields save as they change.
    const done = controlId.match(/^\/note\/actions\/(\d+)\/done$/);
    const openDone = controlId.match(/^\/open\/(\d+)\/done$/);
    if (FIELDS[controlId] && note) { FIELDS[controlId](note, value); touch(note); }
    else if (done && note?.actions[Number(done[1])]) { note.actions[Number(done[1])]!.done = value === true; touch(note); }
    else if (openDone) {
      const ref = openActions(s)[Number(openDone[1])];
      if (ref) { ref.action.done = value === true; touch(ref.note); }
    }
    else if (controlId === "/newAction") s.newAction = line(value);
    else if (controlId === "/capture") s.capture = text(value, MAX_BODY);
    else if (controlId === "/note/confirm" || controlId === "/spoken/note" || controlId === "/spoken/actions") { /* derived, not stored */ }
    else throw new Error(`Unknown Voice Desk field: ${controlId}`);
  } else if (action === "save_capture") {
    // Whatever was spoken or typed into the capture box becomes a note, opened for editing.
    const body = (s.capture ?? "").trim();
    if (!body) throw new Error("Speak or type something first");
    if (s.notes!.length >= MAX_NOTES) throw new Error(`Voice Desk keeps up to ${MAX_NOTES} notes; delete some first`);
    const n: Note = { id: nextId(s, "note"), title: "", body, tags: [], actions: [], created: now, updated: now };
    s.capture = "";
    s.notes!.unshift(n);
    s.openId = n.id;
    s.confirmDelete = false;
    focusSurface = "desk";
  } else if (action === "open_note") {
    if (!s.notes!.some((n) => n.id === payloadId)) throw new Error("That note no longer exists");
    s.openId = payloadId;
    s.confirmDelete = false;
    focusSurface = "desk";
  } else if (action === "add_action") {
    if (!note) throw new Error("Open a note first");
    if (!s.newAction) throw new Error("Type the action item first");
    note.actions.push({ id: nextId(s, "act"), text: s.newAction, done: false });
    s.newAction = "";
    touch(note);
  } else if (action === "remove_action") {
    if (!note) throw new Error("Open a note first");
    note.actions = note.actions.filter((a) => a.id !== payloadId);
    touch(note);
  } else if (action === "ask_delete") {
    s.confirmDelete = Boolean(note);
  } else if (action === "cancel_delete") {
    s.confirmDelete = false;
  } else if (action === "delete_note") {
    if (!note) throw new Error("Open a note first");
    s.notes = s.notes!.filter((n) => n.id !== note.id);
    s.openId = s.notes[0]?.id;
    s.confirmDelete = false;
  } else {
    throw new Error(`Unknown Voice Desk action: ${action}`);
  }
  return { updates: view(s, now), ...(focusSurface ? { focusSurface } : {}) };
}

// --- derived views -----------------------------------------------------------------

function openActions(s: State) {
  return s.notes!.flatMap((note) => note.actions.filter((a) => !a.done).map((action) => ({ note, action })));
}

const day = (iso: string, now: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return "";
  return iso.slice(0, 10) === now.slice(0, 10) ? `Today ${iso.slice(11, 16)}` : iso.slice(0, 10);
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const excerpt = (n: Note) => line(n.body, 140) + (n.body.length > 140 ? "…" : "");
const spokenTitle = (n: Note) => titleOf(n).replace(/[.:;!?]+$/, "");
const replaceAll = (value: Record<string, unknown>) => [{ op: "replace" as const, path: "/" as const, value }];

/** Both surfaces from the canonical notes. Each emits only the nodes that apply
 * now, and its spoken text comes from the same data as what is shown. */
export function view(input: State, now = new Date().toISOString()): Update[] {
  const s = normalize(input);
  return [deskSurface(s, now), actionsSurface(s)];
}

function deskSurface(s: State, now: string): Update {
  const notes = s.notes!;
  const note = open(s);
  const nodes: Node[] = [
    { id: "root", type: "stack", props: { gap: "lg" }, children: ["capture", notes.length ? "work" : "no-notes"] },
    // Capture first: speaking and typing are equal ways in, with nothing to choose beforehand.
    { id: "capture", type: "section", props: { title: "New note", description: "Dictate (⌘D) or type, or both, then save. It opens below for editing." }, children: ["capture-text", "capture-bar"] },
    { id: "capture-text", type: "textarea", props: { label: "What is on your mind?", bind: "/capture", placeholder: "Speak or type…" } },
    { id: "capture-bar", type: "stack", props: { direction: "horizontal", wrap: true, gap: "sm" }, children: ["capture-dictate", "capture-save"] },
    { id: "capture-dictate", type: "button", props: { label: "Dictate", action: "voice.dictate", payload: { into: "capture-text" }, style: "secondary" } },
    { id: "capture-save", type: "button", props: { label: "Save note", action: "save_capture", style: "primary" } },
    ...(notes.length ? [
      { id: "work", type: "split", props: { ratio: "1:2", gap: "lg" }, children: ["list", "editor"] },
      { id: "list", type: "section", props: { title: "{/listTitle}" }, children: ["cards"] },
      // One template per note record in /notes; the records are the data, not the nodes.
      { id: "cards", type: "grid", props: { columns: 1, gap: "sm", searchable: true, pageSize: 8 }, children: { each: "/notes", template: "note-card" } },
      { id: "note-card", type: "card", props: { title: "{title}", subtitle: "{meta}", body: "{excerpt}", badge: "{tags}", tone: "{tone}" }, children: ["note-open"] },
      { id: "note-open", type: "button", props: { label: "Open", action: "open_note", payload: { id: "{id}" }, style: "link", visibleIf: "{canOpen}" } },
      ...(note ? editorNodes(note.actions.length > 0, Boolean(s.confirmDelete)) : []),
    ] : [{ id: "no-notes", type: "text", props: { content: "Saved notes appear here, with their action items as a checklist.", variant: "caption" } }]),
  ];
  const left = note?.actions.filter((a) => !a.done) ?? [];
  const data = {
    capture: s.capture ?? "",
    listTitle: plural(notes.length, "note"),
    notes: notes.map((n) => {
      const current = n.id === s.openId;
      const open = n.actions.filter((a) => !a.done).length;
      return {
        id: n.id, title: titleOf(n), excerpt: excerpt(n) || "Empty note",
        meta: [current ? "Open" : "", day(n.updated, now), open ? plural(open, "open item") : ""].filter(Boolean).join(" · "),
        tags: n.tags.map((t) => `#${t}`).join(" "), tone: current ? "info" : "neutral", canOpen: !current,
      };
    }),
    ...(note ? {
      newAction: s.newAction ?? "",
      note: {
        title: note.title, body: note.body, tags: note.tags.join(", "),
        actions: note.actions.map((a) => ({ id: a.id, text: a.text, done: a.done })),
        actionSummary: note.actions.length ? `${plural(left.length, "open item")} of ${note.actions.length}` : "None yet. Add the next steps you mention.",
        savedAt: `Saved · ${day(note.updated, now) || "just now"}`,
      },
      spoken: { note: [note.title ? spokenTitle(note) : "", note.body, left.length ? `Open action items: ${left.map((a) => a.text).join("; ")}.` : ""].filter(Boolean).join("\n\n") || "This note is empty." },
    } : {}),
  };
  return { surface: "desk", nodes, data: replaceAll(data) };
}

/** The open note's editor: voice, fields, its checklist from /note/actions, and a two-step delete. */
function editorNodes(hasItems: boolean, confirmDelete: boolean): Node[] {
  return [
    { id: "editor", type: "stack", props: { gap: "md" }, children: ["voice-bar", "title", "body", "tags", "actions", confirmDelete ? "confirm" : "ask-delete"] },
    { id: "voice-bar", type: "stack", props: { direction: "horizontal", wrap: true, gap: "sm", align: "center" }, children: ["dictate", "read", "saved"] },
    { id: "dictate", type: "button", props: { label: "Dictate more", action: "voice.dictate", payload: { into: "body" }, style: "secondary" } },
    { id: "read", type: "button", props: { label: "Read aloud", action: "voice.read", payload: { text: "/spoken/note" }, style: "secondary" } },
    { id: "saved", type: "text", props: { content: "{/note/savedAt}", variant: "caption" } },
    { id: "title", type: "input", props: { label: "Title", bind: "/note/title", placeholder: "Named from its first line if left empty" } },
    { id: "body", type: "textarea", props: { label: "Note", bind: "/note/body", placeholder: "Speak or type. Each line can be a thought." } },
    { id: "tags", type: "input", props: { label: "Tags", bind: "/note/tags", placeholder: "work, ideas" } },
    { id: "actions", type: "section", props: { title: "Action items", description: "{/note/actionSummary}" }, children: hasItems ? ["checklist", "add-bar"] : ["add-bar"] },
    ...(hasItems ? [
      { id: "checklist", type: "stack", props: { gap: "sm" }, children: { each: "/note/actions", template: "item" } },
      { id: "item", type: "stack", props: { direction: "horizontal", align: "center", gap: "sm" }, children: ["item-done", "item-drop"] },
      { id: "item-done", type: "checkbox", props: { label: "{text}", bind: "done" } },
      { id: "item-drop", type: "button", props: { label: "Remove", action: "remove_action", payload: { id: "{id}" }, style: "link" } },
    ] : []),
    { id: "add-bar", type: "stack", props: { direction: "horizontal", align: "end", gap: "sm" }, children: ["new-action", "add-action"] },
    { id: "new-action", type: "input", props: { label: "New action item", bind: "/newAction", placeholder: "Send the draft to the team" } },
    { id: "add-action", type: "button", props: { label: "Add", action: "add_action", style: "secondary" } },
    ...(confirmDelete ? [
      { id: "confirm", type: "card", props: { title: "Delete this note?", body: "Its text and action items are removed for good.", tone: "danger" }, children: ["confirm-bar"] },
      { id: "confirm-bar", type: "stack", props: { direction: "horizontal", gap: "sm" }, children: ["delete-yes", "delete-no"] },
      { id: "delete-yes", type: "button", props: { label: "Delete note", action: "delete_note", style: "danger" } },
      { id: "delete-no", type: "button", props: { label: "Keep it", action: "cancel_delete", style: "secondary" } },
    ] : [{ id: "ask-delete", type: "button", props: { label: "Delete note", action: "ask_delete", style: "link" } }]),
  ];
}

/** Every open action item from /open; ticking one here ticks it in its note. */
function actionsSurface(s: State): Update {
  const pending = openActions(s);
  const notesWith = new Set(pending.map((p) => p.note.id)).size;
  const nodes: Node[] = [
    { id: "root", type: "stack", props: { gap: "md" }, children: ["tasks-bar", pending.length ? "tasks" : "tasks-empty"] },
    { id: "tasks-bar", type: "stack", props: { direction: "horizontal", wrap: true, gap: "sm", align: "center" }, children: pending.length ? ["tasks-count", "tasks-read"] : ["tasks-count"] },
    { id: "tasks-count", type: "text", props: { content: "{/summary}" } },
    ...(pending.length ? [
      { id: "tasks-read", type: "button", props: { label: "Read aloud", action: "voice.read", payload: { text: "/spoken/actions" }, style: "secondary" } },
      { id: "tasks", type: "stack", props: { gap: "sm" }, children: { each: "/open", template: "todo" } },
      { id: "todo", type: "stack", props: { direction: "horizontal", align: "center", gap: "sm", wrap: true }, children: ["todo-done", "todo-note"] },
      { id: "todo-done", type: "checkbox", props: { label: "{text}", bind: "done" } },
      { id: "todo-note", type: "button", props: { label: "{note}", action: "open_note", payload: { id: "{noteId}" }, style: "link" } },
    ] : [{ id: "tasks-empty", type: "text", props: { content: "Action items you add to notes appear here until they are done.", variant: "caption" } }]),
  ];
  const data = {
    summary: pending.length ? `${plural(pending.length, "open item")} across ${plural(notesWith, "note")}` : "Nothing open.",
    open: pending.map((p) => ({ text: p.action.text, note: titleOf(p.note), noteId: p.note.id, done: false })),
    spoken: { actions: pending.length ? `You have ${plural(pending.length, "open action item")}. ${s.notes!.filter((n) => n.actions.some((a) => !a.done)).map((n) => `${spokenTitle(n)}: ${pending.filter((p) => p.note.id === n.id).map((p) => p.action.text).join("; ")}.`).join(" ")}` : "Nothing is open." },
  };
  return { surface: "actions", nodes, data: replaceAll(data) };
}

const TITLES: Record<string, string> = { desk: "Notes", actions: "Action items" };
/** The shipped surface.json: every view of a new, empty app. */
export const surfaceFile = () => view({}).map((u) => ({ id: u.surface, title: TITLES[u.surface], data: u.data[0]!.value, nodes: u.nodes }));
