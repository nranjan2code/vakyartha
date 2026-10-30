import { ownsSurfaceEvent } from './surface-ownership.ts';
import { engineFetch } from "./backend.ts";
// Vakyartha UI: chats in a sidebar, a thread of turns, surfaces rendered by
// <vak-surface>. Everything model-related runs in the engine sidecar; this
// side only talks to it over HTTP with the token the shell handed over.
// Kept deliberately quiet: the window is the conversation and a composer with
// a model picker; everything else is on the Settings page.

import { modelMenu } from "./model-menu.ts";
import { type AgentEvent, getAt, projectText, readSse, type SurfaceSnapshot, titleRepeated } from "@vak/core";
import type { SessionSummary, SessionView } from "@vak/host";
import { defineVakElements, renderMarkdown, type VakActionDetail, VakClient, type VakSurfaceElement } from "@vak/web";
import { ArtifactsPage } from "./artifacts-page.ts";
import { AppsPage } from "./apps-page.ts";
import { Canvas } from "./canvas.ts";
import { admitNativeChat, connect, migrateNativeSessions, openExternal, planNativeSessionMigration, setKeepRunning } from "./backend.ts";
import { $, api, ask, engine, prefs, setBackend } from "./core.ts";
import { choose, current, fillPicker, labelOf, loadProviders, modelErrors, parseChoice, providers } from "./models.ts";
import { icon, tile } from "./icons.ts";
import { closest, onContextMenu } from "./menu.ts";
import { closeSettings, openSettings, settingsOpen } from "./settings.ts";
import { closeSkillStudio, isSkillStudioOpen, openSkillStudio } from "./skills-studio.ts";
import type { SkillView } from "../shared/skills.ts";
import { resolveMedia } from "./media.ts";

window.addEventListener("vak:media-chat", (event) => { const id = (event as CustomEvent<unknown>).detail; if (typeof id === "string") { closeSettings(); void openChat(id); } });
import { applyAppearance, surfaceMode } from "./theme.ts";
import { startProviderConsents } from "./provider-consents.ts";
import { TasksPanel } from "./tasks-panel.ts";
import { WorkspacesPanel, type Project, type WorkspaceBinding } from "./workspaces-panel.ts";
import { Drafts } from "./drafts.ts";
import { VoiceApprovals, VoiceDecisions, recentlySaid, cancelDictation, conversationPrefs, conversationState, type ConversationState, startConversation, stopConversation, dictationPrefs, dictationState, lastError, readAloud, replyText, spokenSurface, startDictation, stopDictation, stopReading, textLanguage, voicePrefs, voiceState } from "./voice/index.ts";

applyAppearance();
defineVakElements();

const thread = $<HTMLElement>("thread");
const input = $<HTMLTextAreaElement>("input");
const send = $<HTMLButtonElement>("send");
const modelPick = $<HTMLSelectElement>("model-pick");
const composerFoot = document.createElement("div");
composerFoot.className = "composer-foot";
$<HTMLFormElement>("composer").after(composerFoot);
modelMenu(modelPick, composerFoot);
fillPicker();
const chatsNav = $<HTMLElement>("chats");

let client: VakClient;
// ?session=… opens that chat: the link the MCP server and the bench hand out.
let session = new URLSearchParams(location.search).get("session") ?? prefs.get("session") ?? crypto.randomUUID();
const admittedSessions = new Map<string, Promise<void>>();
function admitSession(id: string): Promise<void> {
  let pending = admittedSessions.get(id);
  if (!pending) {
    pending = admitNativeChat(id).catch((error: unknown) => { admittedSessions.delete(id); throw error; });
    admittedSessions.set(id, pending);
  }
  return pending;
}
const mounted = new Map<string, VakSurfaceElement>();
const remoteVersions = new Map<string, number>();
const canvas = new Canvas(() => session, () => client.store);
const artifacts = new ArtifactsPage(async (id, surface) => {
  if (id !== session) await openChat(id, true);
  if (id !== session) return;
  artifacts.close();
  canvas.open(surface, true);
}, newChat, toggleSidebar);
const appsPage = new AppsPage(
  toggleSidebar,
  () => {
    if (!isSkillStudioOpen() && !settingsOpen() && !tasksPanel.page.visible() && !document.body.classList.contains("in-artifacts")) {
      setTopNavActive("chats");
    }
  }
);
// One turn per chat, several chats at once. The window's stream of a turn is
// `streams`; leaving a chat only detaches it (the engine keeps the turn going and
// the chat's event stream shows it on return). `busy` also holds chats the
// engine reports running that this window did not start or has detached from.
const streams = new Map<string, AbortController>();
const detaching = new WeakSet<AbortController>();
const busy = new Set<string>();
const isRunning = (id: string) => streams.has(id) || busy.has(id);
/** Stop a chat's turn: in the engine (it outlives the window), then the stream. */
function stopRun(id: string): void {
  // The engine releases the turn just after it acknowledges the stop: refresh the list then.
  void api(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }).then(() => setTimeout(() => void loadChats(), 600)).catch(() => {});
  streams.get(id)?.abort();
}
const tasksPanel = new TasksPanel(
  () => session,
  (id) => openChat(id),
  () => {
    artifacts.close(false, false);
    appsPage.close(false);
    if (isSkillStudioOpen()) void closeSkillStudio();
    const st = document.getElementById("skills-studio-page");
    if (st) st.hidden = true;
  },
  toggleSidebar
);
const workspacesPanel = new WorkspacesPanel();
workspacesPanel.init({
  bar: $("chat-workspace-bar"),
  sidebar: $("projects-sidebar"),
  getSession: () => session,
  isTaskSession: (id) => tasksPanel.owns(id),
  onOpenChat: (id) => void openChat(id),
  onNewProjectChat: (projectId, folder) => void newProjectChat(projectId, folder),
  onRefresh: () => loadChats(),
});
const drafts = new Drafts(localStorage, (message) => tasksPanel.error(message));
document.addEventListener("vak-change", (e) => {
  const detail = (e as CustomEvent<{ surface: string; path: string; value: unknown }>).detail;
  if (ownsSurfaceEvent(e, mounted, detail.surface)) drafts.record(detail.surface, detail.path, detail.value);
});
window.addEventListener("pagehide", () => drafts.flush());
window.addEventListener("vak:task-deleted", (e) => {
  const id: unknown = (e as CustomEvent<unknown>).detail;
  if (typeof id !== "string") return;
  drafts.clear(id);
  if (session === id) {
    const scheduleVisible = tasksPanel.page.visible();
    newChat();
    if (scheduleVisible) void tasksPanel.page.openPage();
  }
  void loadChats();
});
function loadSnapshot(snapshot: SurfaceSnapshot): void {
  remoteVersions.set(snapshot.id, snapshot.version);
  client.store.load(drafts.receive(snapshot));
  updateDraftNotice();
}
function updateDraftNotice(): void {
  $("draft-notice").hidden = !drafts.conflicted($<HTMLSelectElement>("canvas-pick").value);
}
$("canvas-pick").addEventListener("change", updateDraftNotice);
for (const [id, keep] of [["draft-keep", true], ["draft-latest", false]] as const) $(id).addEventListener("click", () => {
  const surface = $<HTMLSelectElement>("canvas-pick").value, snapshot = client.store.snapshot(surface);
  if (snapshot) { client.store.load(drafts.resolve(snapshot, keep)); mounted.get(surface)?.refresh(); updateDraftNotice(); }
});
const opt = (k: string, fallback = "") => prefs.get(`opt:${k}`) ?? fallback;

modelPick.addEventListener("change", () => {
  const choice = parseChoice(modelPick.value);
  if (!choice) {
    // "More models…" opens Settings; the picker keeps showing the current model.
    fillPicker();
    return void openSettings("models");
  }
  choose(...choice);
});
window.addEventListener("vak:model", () => updateSend());
window.addEventListener("vak:providers", () => document.getElementById("empty") && showEmpty());
window.addEventListener("vak:chats-cleared", (e) => {
  const ids: unknown = (e as CustomEvent<unknown>).detail;
  if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") drafts.clear(id);
  newChat();
  void loadChats();
});
window.addEventListener("vak:settings-closed", () => {
  void loadLabels();
  if (document.getElementById("empty")) showEmpty();
  input.focus();
});

// --- empty state ------------------------------------------------------------
// A rotating mix of everyday and technical starters; each fills the composer
// so the user can adjust it before sending.
const SAMPLES: [string, string][] = [
  ["Plan my day", "Plan my day: deep work on the report, gym at 6pm, groceries, and a 3pm call. I start at 9."],
  ["Weekend in Lisbon", "Plan a relaxed 2-day weekend in Lisbon for two, with food spots and a rainy-day option."],
  ["Week of dinners", "Plan 5 quick vegetarian dinners for two and give me one shopping list."],
  ["Monthly budget", "Help me build a monthly budget. My take-home pay is "],
  ["Polite reply", "Write a polite email declining a meeting next week and suggesting a later date."],
  ["Explain simply", "Explain how compound interest works, simply, with an example."],
  ["Compare phones", "Compare three mid-range phones for camera, battery and price."],
  ["Fix this error", "Help me fix this error:\n"],
  ["Shell command", "Give me a command to find files larger than 500 MB in my home folder."],
  ["Review my code", "Review this code for bugs:\n"],
  ["Sales dashboard", "Show a sample Q3 sales dashboard: KPIs, monthly revenue chart and top 5 products."],
  ["Signup form", "Make a newsletter signup form with name, email, topics and frequency."],
];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Working late?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function pickSamples(n: number): [string, string][] {
  const pool = [...SAMPLES];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return pool.slice(0, n);
}

function showEmpty(): void {
  const empty = document.createElement("section");
  empty.className = "empty";
  empty.id = "empty";
  empty.innerHTML = '<img class="empty-mark" src="/icon.svg" alt="" width="44" height="44" /><h1></h1><p class="empty-sub">Ask anything, or start from an idea.</p><div class="samples"></div>';
  empty.querySelector("h1")!.textContent = greeting();
  const problem = modelErrors.get(current.provider);
  if (problem) {
    const label = providers.find((p) => p.id === current.provider)?.label ?? current.provider;
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML = '<span></span> <button type="button" class="link">Open Settings</button>';
    hint.querySelector("span")!.textContent =
      current.provider === "ollama" ? "Ollama isn't reachable. Start it, or choose another provider." : `${label} isn't answering (${problem}).`;
    hint.querySelector("button")!.addEventListener("click", () => void openSettings("providers"));
    empty.append(hint);
  }
  for (const [title, prompt] of pickSamples(5)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = title;
    b.title = prompt;
    b.addEventListener("click", () => {
      input.value = prompt;
      input.dispatchEvent(new Event("input"));
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    });
    empty.querySelector(".samples")!.append(b);
  }
  thread.replaceChildren(empty);
}

function showNotice(title: string, detail: string): void {
  const n = document.createElement("div");
  n.className = "notice";
  n.innerHTML = "<b></b><pre></pre>";
  n.querySelector("b")!.textContent = title;
  n.querySelector("pre")!.textContent = detail;
  thread.replaceChildren(n);
}

// --- chats --------------------------------------------------------------------
function groupOf(iso: string): string {
  const day = 86_400_000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const t = Date.parse(iso);
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - day) return "Yesterday";
  if (t >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}

let polling: ReturnType<typeof setTimeout> | undefined;
async function loadChats(): Promise<void> {
  const [list, projects, bindings] = await Promise.all([
    api<SessionSummary[]>("/api/sessions"),
    api<Project[]>("/api/projects").catch(() => []),
    api<WorkspaceBinding[]>("/api/workspaces/bindings").catch(() => []),
  ]);
  artifacts.update(list);
  workspacesPanel.renderSidebar(projects, bindings, list);
  // The engine is the record of what runs; this window's own streams count until they end.
  const wasBusy = busy.has(session);
  busy.clear();
  for (const c of list) if (c.running && !streams.has(c.id)) busy.add(c.id);
  // The open chat's background turn ended before its run_end reached us: redraw it.
  if (wasBusy && !busy.has(session) && outsideTurn && !tasksPanel.owns(session)) void openChat(session, false, true);
  updateSend();
  // While anything runs in the background, refresh so its row settles when it ends.
  clearTimeout(polling);
  if (busy.size) polling = setTimeout(() => void loadChats(), 4000);
  chatsNav.replaceChildren();
  const projectSessionIds = new Set(bindings.filter((b) => b.projectId).map((b) => b.session));
  let group = "";
  for (const c of list) {
    if (tasksPanel.owns(c.id) || projectSessionIds.has(c.id)) continue;
    if (groupOf(c.updated) !== group) {
      group = groupOf(c.updated);
      chatsNav.append(Object.assign(document.createElement("div"), { className: "group", textContent: group }));
    }
    const row = document.createElement("div");
    row.className = `chat${isRunning(c.id) ? " running" : ""}`;
    row.dataset.id = c.id;
    row.setAttribute("aria-current", String(c.id === session));
    row.innerHTML = '<button type="button" class="open"></button><button type="button" class="del" aria-label="Delete chat" title="Delete">×</button>';
    const open = row.querySelector<HTMLButtonElement>(".open")!;
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener("click", () => void openChat(c.id));
    row.querySelector<HTMLButtonElement>(".del")!.addEventListener("click", async () => {
      if (!(await ask(`Delete “${c.title}”?`, "Delete"))) return;
      await admitSession(c.id);
      await api(`/api/sessions/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      admittedSessions.delete(c.id);
      await api(`/api/workspaces/bindings/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => {});
      drafts.clear(c.id);
      if (c.id === session) newChat();
      await loadChats();
    });
    chatsNav.append(row);
  }
}

function clearThread(): void {
  drafts.flush();
  stopReading();
  // Leaving the chat detaches its running turn; the engine finishes it.
  const leaving = streams.get(session);
  if (leaving) {
    detaching.add(leaving);
    busy.add(session);
    leaving.abort();
  }
  canvas.reset();
  mounted.clear();
  remoteVersions.clear();
  for (const s of client.store.list()) client.store.remove({ surface: s.id });
}

function newChat(): void {
  if (isSkillStudioOpen()) void closeSkillStudio(false);
  if (settingsOpen()) closeSettings();
  tasksPanel.page.close();
  artifacts.close();
  appsPage.close();
  setTopNavActive("chats");
  $("workspace").hidden = false;
  clearThread();
  session = crypto.randomUUID();
  void admitSession(session).catch((error: unknown) => report(`chat admission: ${String(error)}`));
  attached = [];
  showAttached();
  drafts.begin(session);
  prefs.set("session", session);
  watch(session);
  showEmpty();
  tasksPanel.selectionChanged();
  void workspacesPanel.updateForSession(session);
  for (const row of chatsNav.querySelectorAll(".chat")) row.setAttribute("aria-current", "false");
  input.focus();
}

async function newProjectChat(projectId: string, folder: string): Promise<void> {
  if (isSkillStudioOpen()) void closeSkillStudio(false);
  if (settingsOpen()) closeSettings();
  tasksPanel.page.close();
  artifacts.close();
  appsPage.close();
  setTopNavActive("chats");
  $("workspace").hidden = false;
  clearThread();
  const newId = crypto.randomUUID();
  session = newId;
  await admitSession(newId);
  attached = [];
  showAttached();
  drafts.begin(session);
  prefs.set("session", session);
  await api(`/api/workspaces/bindings/${encodeURIComponent(newId)}`, {
    method: "POST",
    body: JSON.stringify({ folder, projectId }),
  }).catch(() => {});
  watch(session);
  showEmpty();
  tasksPanel.selectionChanged();
  void workspacesPanel.updateForSession(session);
  void loadChats();
  input.focus();
}

/** Redraw a saved conversation from its timeline and final surfaces. */
async function openChat(id: string, keepLibrary = false, redraw = false): Promise<void> {
  if (isSkillStudioOpen()) void closeSkillStudio(false);
  if (settingsOpen()) closeSettings();
  tasksPanel.page.close();
  if (!keepLibrary) {
    artifacts.close();
    appsPage.close();
  }
  setTopNavActive("chats");
  $("workspace").hidden = false;
  // Returning from a product page must retain live form elements and their controls.
  if (id === session && mounted.size && !redraw) { canvas.restore(); tasksPanel.selectionChanged(); return; }
  clearThread();
  session = id;
  try { await admitSession(id); }
  catch (err) {
    if (session === id) showNotice("This chat could not be opened.", String((err as Error).message ?? err));
    return;
  }
  drafts.begin(session);
  prefs.set("session", id);
  void workspacesPanel.updateForSession(id);
  let view: SessionView;
  try {
    view = await api<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    if (session !== id) return;
    showEmpty();
    updateSend();
    tasksPanel.selectionChanged();
    void loadChats();
    input.focus();
    return;
  }
  if (session !== id) return;
  watch(id);
  for (const snap of view.surfaces) loadSnapshot(snap);
  if (!view.timeline.length) showEmpty();
  else thread.replaceChildren();
  for (const entry of view.timeline) {
    if (entry.kind === "user") userBubble(entry.text);
    else if (entry.kind === "action") pendingSteps.push(entry.action);
    else {
      const turn = newTurn("", false);
      turn.text.replaceChildren(renderMarkdown(entry.text));
      for (const sid of entry.surfaces) {
        const snap = client.store.snapshot(sid);
        if (snap && !mounted.has(sid)) mount(turn, snap, false);
        else if (snap) surfaceUpdated(turn, snap);
      }
      for (const u of entry.used ?? []) usedChip(turn, u.name, u.ok);
      recordVersions(turn, entry.versions ?? []);
      for (const note of entry.notes) if (note.name.startsWith("vak_")) addNote(turn, note.name, note.result);
      setStatus(turn, entry.status, entry.error ? "error" : "done");
      if (entry.limit && entry === view.timeline.at(-1)) limited(turn, entry.limit);
    }
  }
  if (view.running) {
    // Still working (started here earlier, then left): show the reply so far; watch() follows the rest.
    busy.add(id);
    outsideTurn = newTurn("Working…", false);
    outsideTurn.text.dataset.text = view.pending?.text ?? "";
    outsideTurn.text.replaceChildren(renderMarkdown(outsideTurn.text.dataset.text));
    for (const sid of view.pending?.surfaces ?? []) {
      const snap = client.store.snapshot(sid);
      if (snap && !mounted.has(sid)) mount(outsideTurn, snap, false);
    }
    canvas.beginTurn();
  }
  updateSend();
  tidySurfaces();
  canvas.restore();
  tasksPanel.selectionChanged();
  thread.scrollTop = thread.scrollHeight;
  void loadChats();
  input.focus();
}

// --- thread rendering -------------------------------------------------------------
function add(el: HTMLElement, scroll = true): HTMLElement {
  document.getElementById("empty")?.remove();
  thread.append(el);
  if (scroll) el.scrollIntoView({ block: "end", behavior: "smooth" });
  return el;
}

/** The model needs each attachment's path; people only need its name. */
const ATTACHED = /^\[Attached (?:image|audio|video) (.+?): [^\]\n]+\]$/gm;
const shown = (text: string) => text.replace(ATTACHED, "Attached: $1");

function userBubble(sent: string): void {
  const text = shown(sent);
  const m = document.createElement("div");
  m.className = "msg user";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  m.append(b, messageActions([
    copyAction(() => text, "Copy message"),
    action("edit", "Edit as new message", () => {
      input.value = text;
      autosize();
      input.focus();
    }),
  ]));
  add(m, false);
}

// --- message actions --------------------------------------------------------------
// A row of small icon buttons under a message: shown on hover or focus, and
// always on the latest reply.
function action(name: string, label: string, run: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `act act-${name}`;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name, 15));
  b.addEventListener("click", () => run(b));
  return b;
}

/** Copy, then a check mark for a moment so the click is seen. */
function copyAction(text: () => string, label: string): HTMLButtonElement {
  return action("copy", label, (b) => {
    void copy(text()).then(() => {
      b.replaceChildren(icon("check", 15));
      b.title = "Copied";
      setTimeout(() => { b.replaceChildren(icon("copy", 15)); b.title = label; }, 1400);
    });
  });
}

function messageActions(buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "msg-actions";
  row.append(...buttons);
  return row;
}

function eventChip(text: string): void {
  const m = document.createElement("div");
  m.className = "msg event";
  const c = document.createElement("span");
  c.className = "chip";
  c.textContent = text;
  m.append(c);
  add(m, false);
}

// "search_kyoto_hotels" → "Search kyoto hotels"
function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Turn { root: HTMLElement; text: HTMLElement; surfaces: HTMLElement; status: HTMLElement }

function newTurn(label: string, scroll = true): Turn {
  const root = document.createElement("div");
  root.className = "msg assistant";
  const text = document.createElement("div");
  text.className = "text";
  const surfaces = document.createElement("div");
  surfaces.className = "surfaces";
  const status = document.createElement("div");
  status.className = "status";
  status.innerHTML = '<span class="dot"></span><span class="label"></span>';
  status.querySelector(".label")!.textContent = label;
  root.append(text, surfaces, status);
  add(root, scroll);
  const turn = { root, text, surfaces, status };
  for (const a of pendingSteps.splice(0)) addStep(turn, "form", `You: ${humanize(a)}`);
  return turn;
}

/**
 * A turn a budget ended or cut short stays visibly marked (finished statuses
 * otherwise show only on hover) and offers to carry on from its results.
 */
function limited(turn: Turn, limit: "steps" | "tools"): void {
  turn.status.classList.add("limited");
  const go = document.createElement("button");
  go.type = "button";
  go.className = "continue";
  go.textContent = "Continue";
  go.title = limit === "steps" ? "This response stopped at its step limit: carry on from here" : "This response used its tool budget: gather more and finish";
  go.addEventListener("click", () => {
    if (isRunning(session)) return;
    go.remove();
    void runTurn({ continue: true });
  });
  turn.status.append(go);
}

function setStatus(turn: Turn, text: string, state?: "done" | "error"): void {
  turn.status.className = `status ${state ?? ""}`;
  let displayText = text;
  if (text.includes("Provider generation did not finish successfully")) {
    displayText = "Turn was interrupted before completion (Provider stream ended or timed out)";
  }
  turn.status.querySelector(".label")!.textContent = displayText;
  if (state === "done" && !turn.status.querySelector(".msg-actions") && turnText(turn)) {
    const buttons = [copyAction(() => turnText(turn), "Copy reply"), speakButton(turn)];
    const inline = turnSurfaces(turn).filter((id) => canvas.isInline(id));
    if (inline.length) buttons.push(action("maximize", "Open in canvas", () => canvas.open(inline.at(-1)!, true)));
    turn.status.prepend(messageActions(buttons));
  } else if (state === "error" && !turn.status.querySelector(".retry")) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ghost small retry";
    retry.textContent = "Retry turn";
    retry.addEventListener("click", () => {
      retry.remove();
      void runTurn({ continue: true });
    });
    turn.status.append(retry);
  }
  paintSpeak();
}

/** The surfaces a reply produced, in order (their homes stay in the reply while one is in the canvas). */
function turnSurfaces(turn: Turn): string[] {
  return [...turn.surfaces.querySelectorAll<HTMLElement>(".surface-home[data-surface]")].map((h) => h.dataset.surface!).filter((id) => mounted.has(id));
}

/** A reply as text: its prose, then each interface it produced. */
function turnText(turn: Turn): string {
  const parts = [replyText(turn.text)];
  for (const id of turnSurfaces(turn)) {
    const resolved = client.store.resolve(id);
    // Say and copy what is shown: a title the content repeats is not drawn.
    if (resolved) parts.push(projectText(resolved.title && titleRepeated(resolved.title, resolved.root) ? { ...resolved, title: undefined } : resolved));
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** A reply as speech: its prose, then what each interface says, in the reply's language. */
/**
 * A reply as speech. "gist" (conversation mode) keeps each interface to its
 * headlines and says when there is more; when the reply drew on tools, it says
 * so first, so what was found outside is not heard as the app's own word.
 */
function turnSpeech(turn: Turn, as: "gist" | "details" | "screen" = "screen"): string {
  const prose = replyText(turn.text);
  const surfaces = turnSurfaces(turn).flatMap((id) => {
    const resolved = client.store.resolve(id);
    return resolved ? [resolved.title && titleRepeated(resolved.title, resolved.root) ? { ...resolved, title: undefined } : resolved] : [];
  });
  // Prose says the most about the language; an interface alone is judged by its own text.
  const lang = textLanguage(prose) ?? textLanguage(surfaces.map((s) => projectText(s)).join("\n"));
  const more = { left: false };
  const spoken = surfaces.map((s) => { const m = { left: false }; const t = spokenSurface(s, lang, as, m); more.left ||= m.left; return t; });
  const tools = as !== "screen" && turn.root.querySelector(".steps li[data-tool]") ? "Based on what I found:" : "";
  const tail = as === "gist" && more.left ? "Say details for the rest." : "";
  return [tools, prose, ...spoken, tail].filter((p) => p.trim()).join("\n\n");
}

// --- read aloud ---------------------------------------------------------------------
function speakButton(turn: Turn): HTMLButtonElement {
  const b = action("voice", "Read aloud", () => toggleReading(turn.root, () => turnSpeech(turn)));
  b.classList.add("speak");
  return b;
}

function toggleReading(root: HTMLElement, text: () => string): void {
  if (!voicePrefs.enabled) return;
  if (voiceState().target === root) return stopReading();
  void readAloud(text(), root).then(() => {
    if (lastError) eventChip(`Read aloud: ${lastError}`);
  });
}

/** One state for every reply's speaker: hidden when reading aloud is off, stop on the reply being read. */
function paintSpeak(): void {
  const { state, target } = voiceState();
  for (const b of thread.querySelectorAll<HTMLButtonElement>(".status .speak")) {
    const mine = b.closest(".msg") === target;
    b.hidden = !voicePrefs.enabled;
    b.disabled = !voicePrefs.enabled;
    b.replaceChildren(icon(mine ? "stop" : "voice", 15));
    b.classList.toggle("loading", mine && state === "loading");
    b.closest(".status")?.classList.toggle("speaking", mine);
    const label = mine ? "Stop reading" : "Read aloud";
    b.title = label;
    b.setAttribute("aria-label", label);
  }
}
window.addEventListener("vak:voice", paintSpeak);

function addNote(turn: Turn, name: string, result: string): void {
  const d = document.createElement("details");
  d.className = "diag";
  d.innerHTML = "<summary></summary><pre></pre>";
  d.querySelector("summary")!.textContent = `${name}: engine notes (sent back to the model)`;
  d.querySelector("pre")!.textContent = result;
  turn.root.insertBefore(d, turn.status);
}

function mount(turn: Turn, snap: SurfaceSnapshot, scroll = true): void {
  remoteVersions.set(snap.id, snap.version);
  let el = mounted.get(snap.id);
  if (!el) {
    el = document.createElement("vak-surface") as VakSurfaceElement;
    el.mediaResolver = resolveMedia;
    mounted.set(snap.id, el);
    canvas.register(el, snap, turn.surfaces, scroll);
    el.attach(client.store, snap.id);
    surfaceMode(el);
    // A new interface is the answer: bring its top into view (a reply to a
    // click otherwise lands below the fold and looks like nothing happened).
    const shown = el;
    if (scroll && !shown.closest(".canvas")) requestAnimationFrame(() => shown.scrollIntoView({ block: "start", behavior: "smooth" }));
  } else {
    canvas.register(el, snap, turn.surfaces, scroll);
    el.refresh();
  }
}

function updateSend(): void {
  const runningHere = isRunning(session);
  send.classList.toggle("stop", runningHere);
  send.setAttribute("aria-label", runningHere ? "Stop" : "Send");
  send.disabled = !runningHere && ((!input.value.trim() && !attached.length) || !current.model);
}

async function runTurn(req: { message?: string; continue?: boolean; action?: VakActionDetail["action"] & { data: Record<string, unknown> } }): Promise<void> {
  if (isRunning(session)) {
    const note = newTurn("Wait for the current response, or stop it before starting another.");
    setStatus(note, "The current response is still running", "done");
    if (req.action) mounted.get(req.action.surface)?.releaseAction();
    return;
  }
  const ctrl = new AbortController();
  streams.set(session, ctrl);
  canvas.beginTurn(req.action?.surface);
  if (req.action) canvas.actionStatus(req.action.surface, "Running action…");
  // The sidebar marks the chat as running at once (refreshed again when it ends).
  setTimeout(() => void loadChats(), 300);
  updateSend();
  const turnSession = session;
  stopReading();
  // Only the chat's latest turn can be continued.
  for (const b of thread.querySelectorAll(".status .continue")) b.remove();
  const turn = newTurn(req.continue ? "Continuing…" : "Thinking…");
  const started = performance.now();
  // Local models deliver a tool call whole at the end (Ollama does not stream
  // its arguments; 20-50 s on a 4B model), so show that time is passing.
  let phase = "Thinking";
  const ticker = setInterval(() => {
    if (turn.status.classList.contains("done") || turn.status.classList.contains("error")) return;
    const secs = Math.round((performance.now() - started) / 1000);
    if (secs >= 3 && !turn.root.querySelector(".approval:not(.settled)")) setStatus(turn, `${phase}… ${secs}s`);
    // In conversation, silence during long work sounds like nothing is happening.
    if (secs === 8 && conversationState() === "listening" && voiceState().state === "idle") void readAloud(`Still working: ${phase.toLowerCase()}.`, voiceDecisions);
  }, 1000);
  let text = "";
  let frame = 0;
  const { provider, model } = current;

  const onEvent = (e: AgentEvent) => {
    if (session !== turnSession || streams.get(turnSession) !== ctrl) return;
    switch (e.type) {
      case "text_delta":
        text += e.delta;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            turn.text.replaceChildren(renderMarkdown(text));
          });
        }
        break;
      case "tool_start":
        if (e.name === "vak_render" || e.name === "vak_update" || e.name === "vak_submit") canvas.beginWork();
        phase = e.name.startsWith("vak_") ? "Building the interface" : `Using ${toolLabel(e.name)}`;
        setStatus(turn, `${phase}…`);
        break;
      case "approval":
        approvalCard(turn, e);
        break;
      case "approval_done":
        settleApproval(e.id, e.decision);
        break;
      case "surface":
        loadSnapshot(e.snapshot);
        if (mounted.has(e.snapshot.id)) surfaceUpdated(turn, e.snapshot);
        mount(turn, e.snapshot);
        updateDraftNotice();
        break;
      case "surface_removed":
        drafts.remove(e.id);
        canvas.remove(e.id);
        mounted.delete(e.id);
        break;
      case "tool_end":
        if (!e.name.startsWith("vak_")) usedChip(turn, e.name, !e.isError);
        else if (e.isError || e.result !== "ok") addNote(turn, e.name, e.result);
        break;
      case "error":
        if (req.action) canvas.actionStatus(req.action.surface, e.message, true);
        setStatus(turn, e.message, "error");
        break;
      case "run_end":
        if (req.action && !turn.status.classList.contains("error")) canvas.actionStatus(req.action.surface, e.limit ? `Action stopped: ${e.limit} limit` : "Action completed", Boolean(e.limit));
        if (!turn.status.classList.contains("error")) {
          setStatus(turn, `${model} · ${((performance.now() - started) / 1000).toFixed(1)}s${e.limit === "steps" ? " · step limit" : e.limit === "tools" ? " · tool budget" : ""}`, "done");
        }
        if (e.limit) limited(turn, e.limit);
        recordVersions(turn);
        tidySurfaces();
        // Conversation mode always answers aloud, and then asks any choice the reply left.
        if (conversationState() !== "off" && turnSession === session && !turn.status.classList.contains("error")) {
          const ask = voiceDecisions.offer(turnSurfaces(turn));
          // An open canvas shows what is being asked about; focus stays where it is.
          if (ask && voiceDecisions.surface && !$("canvas").hidden) canvas.open(voiceDecisions.surface, false);
          lastSpokenTurn = turn;
          toggleReading(turn.root, () => [turnSpeech(turn, "gist"), ask].filter(Boolean).join("\n\n"));
        } else if (voicePrefs.enabled && voicePrefs.auto && turnSession === session && !turn.status.classList.contains("error")) toggleReading(turn.root, () => turnSpeech(turn));
        break;
    }
  };

  try {
    await client.turn(
      {
        session: turnSession,
        provider,
        model,
        think: opt("think") === "true",
        generation: opt("generation", "auto"),
        effort: opt("effort") || undefined,
        // Long everyday chats would otherwise send every turn and overflow a small model's context.
        history: Number(opt("history", "10")) || undefined,
        maxSteps: Number(prefs.get(`opt:${provider}:maxSteps`) || opt("maxSteps", "0")) || undefined,
        toolRounds: Number(prefs.get(`opt:${provider}:toolRounds`) || opt("toolRounds", "0")) || undefined,
        ...req,
      },
      onEvent,
      ctrl.signal,
    );
  } catch (err) {
    if (detaching.has(ctrl)) return void clearInterval(ticker);
    if (req.action) canvas.actionStatus(req.action.surface, ctrl.signal.aborted ? "Action stopped" : (err as Error).message, !ctrl.signal.aborted);
    if (ctrl.signal.aborted) setStatus(turn, "Stopped", "done");
    else setStatus(turn, (err as Error).message, "error");
  } finally {
    clearInterval(ticker);
    if (streams.get(turnSession) === ctrl) {
      streams.delete(turnSession);
      if (session === turnSession) canvas.endTurn();
    }
    if (detaching.has(ctrl)) {
      updateSend();
      void loadChats();
      return;
    }
    updateSend();
    if (frame) cancelAnimationFrame(frame);
    turn.text.replaceChildren(renderMarkdown(text));
    if (req.action && session === turnSession) mounted.get(req.action.surface)?.releaseAction();
    // The first message names the chat; refresh the list either way (order by recency).
    if (session === turnSession) void loadChats();
  }
}

async function submit(text: string): Promise<void> {
  let t = text.trim();
  if (!t && !attached.length) return;
  const targetSession = session;
  try { await admitSession(targetSession); }
  catch (err) { showNotice("This chat is not available for editing.", String((err as Error).message ?? err)); return; }
  if (session !== targetSession) return;
  if (tasksPanel.owns(session)) {
    void tasksPanel.input(t).then(() => { input.value = ""; autosize(); }).catch((err) => tasksPanel.error((err as Error).message));
    return;
  }
  if (isRunning(session)) return;
  if (!current.model) return void openSettings();
  // The engine reads attachments by path; the model sees where each one is.
  if (attached.length) {
    t = [t || "Help me with the attached media.", ...attached.map((a) => `[Attached ${a.kind} ${a.name}: ${a.path}]`)].join("\n");
    attached = [];
    showAttached();
  }
  userBubble(t);
  input.value = "";
  autosize();
  void runTurn({ message: t });
}

// Only surfaces mounted by this chat/task may use its model continuation.
document.addEventListener("vak-action", (e) => {
  const detail = (e as CustomEvent<VakActionDetail>).detail;
  const { action } = detail;
  if (!ownsSurfaceEvent(e, mounted, action.surface)) return;
  // The surface's data model, plus what the control itself carries (which
  // option of a compare, a button's payload): replacing one with the other lost
  // which item was chosen.
  const data = { ...detail.data, ...action.data };
  if (tasksPanel.owns(session)) {
    const surface = mounted.get(action.surface);
    canvas.actionStatus(action.surface, "Running action…");
    void tasksPanel.input(undefined, { surface: action.surface, source: action.source, data }, remoteVersions.get(action.surface))
      .then(() => canvas.actionStatus(action.surface, "Action submitted"))
      .catch((err) => { canvas.actionStatus(action.surface, (err as Error).message, true); tasksPanel.error((err as Error).message); }).finally(() => surface?.releaseAction());
    return;
  }
  if (!isRunning(session)) pendingSteps.push(action.action);
  void runTurn({ action: { ...action, data } });
});

// Links in model content open in the system browser, never in the app window.
document.addEventListener("click", (e) => {
  const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && Boolean(n.href));
  if (!a || !/^(https:|mailto:)/.test(a.href)) return;
  e.preventDefault();
  void openExternal(a.href);
});

// --- composer and shortcuts ---------------------------------------------------------
function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  updateSend();
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (dictationState().state !== "idle") return void stopDictation();
    void submit(input.value);
  }
});
$<HTMLFormElement>("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  // Enter while dictating finishes the dictation; the next Enter sends.
  if (dictationState().state !== "idle") return void stopDictation();
  if (isRunning(session)) stopRun(session);
  else void submit(input.value);
});
$<HTMLButtonElement>("new-chat").addEventListener("click", newChat);
$<HTMLButtonElement>("open-settings").addEventListener("click", () => void switchNavTab("settings"));
// "New chat" from the tray menu.
window.addEventListener("vak:new-chat", newChat);

$<HTMLButtonElement>("collapse").append(icon("sidebar", 18));
$<HTMLButtonElement>("expand").append(icon("sidebar", 18));
$<HTMLButtonElement>("collapse").addEventListener("click", toggleSidebar);
$<HTMLButtonElement>("expand").addEventListener("click", toggleSidebar);

// --- Persistent App Navigation State ---
type NavTab = "chats" | "artifacts" | "apps" | "work" | "studio" | "settings";

function setTopNavActive(active: NavTab): void {
  $("open-artifacts")?.setAttribute("aria-current", active === "artifacts" ? "page" : "false");
  $("open-apps")?.setAttribute("aria-current", active === "apps" ? "page" : "false");
  $("open-schedule")?.setAttribute("aria-current", active === "work" ? "page" : "false");
  $("open-studio")?.setAttribute("aria-current", active === "studio" ? "page" : "false");
  $("open-settings")?.setAttribute("aria-current", active === "settings" ? "page" : "false");
}

const openStudio = document.getElementById("open-studio");
if (openStudio) {
  openStudio.append(icon("spark", 17), "Studio");
  openStudio.addEventListener("click", () => void switchNavTab("studio"));
}

const topbarSidebarToggle = document.getElementById("topbar-sidebar-toggle");
if (topbarSidebarToggle) {
  topbarSidebarToggle.append(icon("sidebar", 18));
  topbarSidebarToggle.addEventListener("click", toggleSidebar);
}

for (const [id, tab] of [["open-artifacts", "artifacts"], ["open-apps", "apps"], ["open-schedule", "work"]] as const) {
  document.getElementById(id)?.addEventListener("click", () => void switchNavTab(tab));
}

async function switchNavTab(target: NavTab): Promise<void> {
  if (target === "chats") {
    if (isSkillStudioOpen()) await closeSkillStudio();
    if (settingsOpen()) closeSettings();
    if (tasksPanel.page.visible()) tasksPanel.page.close(false, false);
    if (document.body.classList.contains("in-artifacts")) artifacts.close(false, false);
    if (appsPage.visible()) appsPage.close(false);
    $("workspace").hidden = false;
    $("artifacts-page").hidden = true;
    $("apps-page").hidden = true;
    $("schedule-page").hidden = true;
    $("skills-studio-page").hidden = true;
    setTopNavActive("chats");
    input.focus();
    return;
  }

  if (target === "artifacts") {
    if (isSkillStudioOpen()) await closeSkillStudio();
    if (settingsOpen()) closeSettings();
    if (tasksPanel.page.visible()) tasksPanel.page.close(false, false);
    if (appsPage.visible()) appsPage.close(false);
    $("workspace").hidden = true;
    $("apps-page").hidden = true;
    $("schedule-page").hidden = true;
    $("skills-studio-page").hidden = true;
    setTopNavActive("artifacts");
    await artifacts.open();
    return;
  }

  if (target === "apps") {
    if (isSkillStudioOpen()) await closeSkillStudio();
    if (settingsOpen()) closeSettings();
    if (tasksPanel.page.visible()) tasksPanel.page.close(false, false);
    if (document.body.classList.contains("in-artifacts")) artifacts.close(false, false);
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("schedule-page").hidden = true;
    $("skills-studio-page").hidden = true;
    setTopNavActive("apps");
    await appsPage.open();
    return;
  }

  if (target === "work") {
    if (isSkillStudioOpen()) await closeSkillStudio();
    if (settingsOpen()) closeSettings();
    if (document.body.classList.contains("in-artifacts")) artifacts.close(false, false);
    if (appsPage.visible()) appsPage.close(false);
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("apps-page").hidden = true;
    $("skills-studio-page").hidden = true;
    setTopNavActive("work");
    await tasksPanel.page.openPage();
    return;
  }

  if (target === "studio") {
    if (isSkillStudioOpen()) return;
    if (settingsOpen()) closeSettings();
    if (tasksPanel.page.visible()) tasksPanel.page.close(false, false);
    if (document.body.classList.contains("in-artifacts")) artifacts.close(false, false);
    if (appsPage.visible()) appsPage.close(false);
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("apps-page").hidden = true;
    $("schedule-page").hidden = true;
    setTopNavActive("studio");

    await openSkillStudio(
      undefined,
      async () => {
        setTopNavActive("chats");
        $("workspace").hidden = false;
        $("skills-studio-page").hidden = true;
      },
      async () => {}
    );
    return;
  }

  if (target === "settings") {
    if (isSkillStudioOpen()) await closeSkillStudio();
    if (tasksPanel.page.visible()) tasksPanel.page.close(false, false);
    if (document.body.classList.contains("in-artifacts")) artifacts.close(false, false);
    if (appsPage.visible()) appsPage.close(false);
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("apps-page").hidden = true;
    $("schedule-page").hidden = true;
    $("skills-studio-page").hidden = true;
    setTopNavActive("settings");
    await openSettings();
    return;
  }
}

window.addEventListener("vak:settings-opened", () => {
  if (isSkillStudioOpen()) void closeSkillStudio();
  artifacts.close(false, false);
  appsPage.close(false);
  tasksPanel.page.close(false, false);
  $("workspace").hidden = true;
  $("artifacts-page").hidden = true;
  $("apps-page").hidden = true;
  $("schedule-page").hidden = true;
  $("skills-studio-page").hidden = true;
  setTopNavActive("settings");
});
window.addEventListener("vak:settings-closed", () => {
  if (!isSkillStudioOpen() && !tasksPanel.page.visible() && !document.body.classList.contains("in-artifacts") && !appsPage.visible()) {
    $("workspace").hidden = false;
    setTopNavActive("chats");
    if (!thread.childNodes.length || document.getElementById("empty")) showEmpty();
    input.focus();
  }
});

window.addEventListener("vak:artifacts-closed", () => {
  if (!isSkillStudioOpen() && !settingsOpen() && !tasksPanel.page.visible() && !appsPage.visible()) {
    $("workspace").hidden = false;
    setTopNavActive("chats");
    if (!thread.childNodes.length || document.getElementById("empty")) showEmpty();
    input.focus();
  }
});

window.addEventListener("vak:apps-closed", () => {
  if (!isSkillStudioOpen() && !settingsOpen() && !tasksPanel.page.visible() && !document.body.classList.contains("in-artifacts")) {
    $("workspace").hidden = false;
    setTopNavActive("chats");
    if (!thread.childNodes.length || document.getElementById("empty")) showEmpty();
    input.focus();
  }
});
window.addEventListener("vak:run-app", (e) => {
  const appId = (e as CustomEvent<string>).detail;
  if (typeof appId === "string") {
    void (async () => {
      await switchNavTab("apps");
      await appsPage.runApp(appId);
    })();
  }
});

window.addEventListener("vak:schedule-opened", () => {
  if (isSkillStudioOpen()) void closeSkillStudio();
  artifacts.close(false, false);
  appsPage.close(false);
  $("workspace").hidden = true;
  $("artifacts-page").hidden = true;
  $("apps-page").hidden = true;
  $("skills-studio-page").hidden = true;
  setTopNavActive("work");
});
window.addEventListener("vak:schedule-closed", () => {
  if (!isSkillStudioOpen() && !settingsOpen() && !document.body.classList.contains("in-artifacts") && !appsPage.visible()) {
    $("workspace").hidden = false;
    setTopNavActive("chats");
    if (!thread.childNodes.length || document.getElementById("empty")) showEmpty();
    input.focus();
  }
});

window.addEventListener("vak:studio-opened", () => {
  artifacts.close(false, false);
  appsPage.close(false);
  tasksPanel.page.close(false, false);
  $("workspace").hidden = true;
  $("artifacts-page").hidden = true;
  $("apps-page").hidden = true;
  $("schedule-page").hidden = true;
  $("skills-studio-page").hidden = false;
  setTopNavActive("studio");
});
window.addEventListener("vak:studio-closed", () => {
  const st = document.getElementById("skills-studio-page");
  if (st) st.hidden = true;
  if (settingsOpen()) setTopNavActive("settings");
  else if (document.body.classList.contains("in-artifacts")) setTopNavActive("artifacts");
  else if (document.body.classList.contains("in-apps")) setTopNavActive("apps");
  else if (tasksPanel.page.visible()) setTopNavActive("work");
  else {
    $("workspace").hidden = false;
    setTopNavActive("chats");
    if (!thread.childNodes.length || document.getElementById("empty")) showEmpty();
    input.focus();
  }
});

function toggleSidebar(): void {
  if (isSkillStudioOpen() && innerWidth <= 720) {
    document.body.classList.toggle("studio-show-sidebar");
    return;
  }
  if (tasksPanel.page.visible() && innerWidth <= 720) {
    document.body.classList.toggle("schedule-show-sidebar");
    return;
  }
  if (document.body.classList.contains("in-artifacts") && matchMedia("(max-width: 720px)").matches) {
    document.body.classList.toggle("artifacts-show-sidebar");
    return;
  }
  document.body.classList.toggle("collapsed");
  prefs.set("collapsed", String(document.body.classList.contains("collapsed")));
}
document.body.classList.toggle("collapsed", prefs.get("collapsed") === "true");
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  if (e.key === "Escape" && conversationState() !== "off") {
    e.preventDefault();
    stopReading();
    return stopConversation();
  }
  if (e.key === "Escape" && dictationState().state === "listening") {
    e.preventDefault();
    input.value = dictationBase;
    autosize();
    return cancelDictation();
  }
  if (e.key === "Escape" && isRunning(session) && !settingsOpen() && !document.body.classList.contains("in-artifacts") && !tasksPanel.page.visible()) return stopRun(session);
  if (!(e.metaKey || e.ctrlKey)) return;
  const actions: Record<string, () => void> = {
    n: () => (closeSettings(), newChat()),
    ",": () => void (settingsOpen() ? closeSettings() : openSettings()),
    "\\": toggleSidebar,
    d: () => { if (!e.altKey && !settingsOpen()) (e.shiftKey ? toggleConversation : toggleDictation)(); },
    b: () => { if (!e.altKey && !e.shiftKey) toggleSidebar(); },
  };
  if ((e.altKey || e.shiftKey) && e.key.toLowerCase() === "b") return;
  const act = actions[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

// --- attachments ---------------------------------------------------------------------
const attachBtn = $<HTMLButtonElement>("attach");
const attachFile = $<HTMLInputElement>("attach-file");
attachBtn.append(icon("image", 17));
let attached: { name: string; path: string; kind: string }[] = [];

function showAttached(): void {
  composerNote.textContent = attached.length ? `Attached: ${attached.map((a) => a.name).join(", ")}` : "";
  composerNote.hidden = !attached.length;
  send.disabled = !attached.length && !input.value.trim();
}

async function base64(f: File): Promise<string> {
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
  return url.slice(url.indexOf(",") + 1);
}

attachBtn.addEventListener("click", () => attachFile.click());
attachFile.addEventListener("change", async () => {
  for (const f of Array.from(attachFile.files ?? [])) {
    try {
      const r = await api<{ path: string }>(`/api/attachments?session=${encodeURIComponent(session)}`, { method: "POST", body: JSON.stringify({ type: f.type, data: await base64(f) }) });
      attached.push({ name: f.name.replace(/[\r\n\[\]]/g, "_"), path: r.path, kind: /^(audio|video)\//.test(f.type) ? f.type.split("/")[0]! : "image" });
    } catch (err) {
      composerHint((err as Error).message);
    }
  }
  attachFile.value = "";
  showAttached();
});

// --- dictation ------------------------------------------------------------------------
const mic = $<HTMLButtonElement>("mic");
const micTime = $<HTMLElement>("mic-time");
const composerNote = $<HTMLElement>("composer-note");
mic.append(icon("mic", 17));
/** The message box before dictation began; spoken words go after it. */
let dictationBase = "";
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

function composerHint(text: string): void {
  composerNote.textContent = text;
  composerNote.hidden = !text;
  clearTimeout(noteTimer);
  if (text) noteTimer = setTimeout(() => { composerNote.hidden = true; }, 7000);
}

function toggleDictation(): void {
  const { state } = dictationState();
  if (state === "listening") return stopDictation();
  if (state === "transcribing" || !dictationPrefs.enabled) return;
  stopConversation();
  stopReading();
  dictationBase = input.value;
  composerHint("");
  input.focus();
  void startDictation({
    onText(text, final) {
      input.value = dictationBase.trim() ? `${dictationBase.replace(/\s*$/, " ")}${text}` : text;
      autosize();
      input.setSelectionRange(input.value.length, input.value.length);
      if (final && dictationPrefs.send && input.value.trim() && !isRunning(session)) submit(input.value);
    },
    onError(message) {
      composerHint(message);
      report(`dictation (${dictationPrefs.choice?.provider ?? "none"}): ${message}`);
    },
  });
}
mic.addEventListener("click", toggleDictation);

function paintMic(): void {
  const { state, startedAt } = dictationState();
  mic.hidden = !dictationPrefs.enabled;
  mic.classList.toggle("listening", state === "listening");
  mic.classList.toggle("transcribing", state === "transcribing");
  mic.disabled = !dictationPrefs.enabled || state === "transcribing";
  const label = state === "listening" ? "Stop dictation (Enter); Esc discards" : state === "transcribing" ? "Transcribing…" : "Dictate (⌘D)";
  mic.title = label;
  mic.setAttribute("aria-label", label);
  mic.setAttribute("aria-pressed", String(state === "listening"));
  clearInterval(clock);
  micTime.hidden = state === "idle";
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    micTime.textContent = state === "transcribing" ? "Transcribing…" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  if (state === "listening") clock = setInterval(tick, 500);
  if (state === "idle") mic.style.removeProperty("--level");
}
window.addEventListener("vak:dictation", paintMic);
window.addEventListener("vak:dictation-level", () => mic.style.setProperty("--level", dictationState().level.toFixed(2)));
paintMic();

// --- conversation mode -------------------------------------------------------------------
/** The reply last read in conversation, for "details". */
let lastSpokenTurn: Turn | undefined;
const voiceApprovals = new VoiceApprovals({
  async decide(id, decision) {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ decision }) }).catch(() => settleApproval(id, "deny"));
  },
  say(text) { void readAloud(text, voiceApprovals); },
});
const voiceDecisions = new VoiceDecisions({
  store: () => client.store,
  say(text) { void readAloud(text, voiceDecisions); },
  activate: (surface, key) => mounted.get(surface)?.activate(key) ?? false,
  // The chat's own model, as a turn would use it; its answer is checked against the surface before use.
  async model(question, said, schema) {
    if (!current.provider || !current.model) return undefined;
    const r = await api<{ answer?: unknown }>("/api/voice/resolve", { method: "POST", body: JSON.stringify({ provider: current.provider, model: current.model, question, said, schema }) });
    return r.answer;
  },
  // As if typed: the surface shows the value and its draft is kept.
  filled(surface, paths) {
    const el = mounted.get(surface);
    if (!el) return;
    el.refresh();
    const data = client.store.get(surface)?.data;
    for (const path of paths) el.dispatchEvent(new CustomEvent("vak-change", { detail: { surface, path, value: getAt(data, path) }, bubbles: true, composed: true }));
  },
});
const talk = $<HTMLButtonElement>("talk");
const talkStatus = $<HTMLElement>("talk-status");
talk.append(icon("talk", 17));

function toggleConversation(): void {
  if (conversationState() !== "off") return stopConversation();
  if (!conversationPrefs.enabled) return;
  if (dictationState().state !== "idle") cancelDictation();
  composerHint("");
  void startConversation({
    async onUtterance(text) {
      // A tool waiting for an answer hears it first; only these heard words can decide it.
      if (voiceApprovals.waiting && (await voiceApprovals.hear(text))) return;
      if (voiceDecisions.waiting && (await voiceDecisions.hear(text))) return;
      // A turn still running keeps its place; the words wait in the box rather than cutting it off.
      if (isRunning(session)) {
        input.value = input.value.trim() ? `${input.value.replace(/\s*$/, " ")}${text}` : text;
        autosize();
        return composerHint("Still working on the last message; your words are in the message box.");
      }
      submit(text);
    },
    onCommand(command) {
      if (command === "repeat") return void readAloud(recentlySaid(120_000).at(-1) ?? "There is nothing to repeat.", voiceDecisions);
      if (command === "new") return void (voiceDecisions.clear(), newChat());
      if (command === "details") return lastSpokenTurn ? toggleReading(lastSpokenTurn.root, () => turnSpeech(lastSpokenTurn!, "details")) : void readAloud("There is nothing more to read.", voiceDecisions);
      const last = [...thread.querySelectorAll<HTMLElement>(".surface-home[data-surface]")].at(-1)?.dataset.surface;
      if (last) canvas.open(last, true);
      else void readAloud("There is nothing to show yet.", voiceDecisions);
    },
    onError(message) {
      composerHint(message);
      report(`conversation (${dictationPrefs.choice?.provider ?? "none"}): ${message}`);
    },
  });
}
talk.addEventListener("click", toggleConversation);

const TALK_LABEL: Record<ConversationState, string> = {
  off: "Conversation mode (⌘⇧D)",
  listening: "Listening. Esc or \"stop listening\" ends conversation mode",
  hearing: "Hearing you",
  understanding: "Understanding…",
  speaking: "Speaking. Talk to interrupt",
};
function paintTalk(): void {
  const s = conversationState();
  talk.hidden = !conversationPrefs.enabled;
  talk.disabled = !conversationPrefs.enabled;
  talk.classList.toggle("on", s !== "off");
  talk.classList.toggle("hearing", s === "hearing");
  talk.classList.toggle("understanding", s === "understanding");
  talk.title = TALK_LABEL[s];
  talk.setAttribute("aria-label", TALK_LABEL[s]);
  talk.setAttribute("aria-pressed", String(s !== "off"));
  // Announced once per change; "hearing" is left out so a screen reader does not talk over the person.
  if (s !== "hearing") talkStatus.textContent = s === "off" ? "Conversation mode off" : TALK_LABEL[s];
}
window.addEventListener("vak:conversation", paintTalk);
window.addEventListener("vak:conversation", () => { if (conversationState() === "off") { voiceApprovals.clear(); voiceDecisions.clear(); } });
// A click (or a spoken choice, which is one) answers the choice: stop asking about it.
document.addEventListener("vak-action", () => voiceDecisions.clear());
window.addEventListener("vak:voice", paintTalk);
paintTalk();

// --- integrations in the chat ----------------------------------------------------------
// Tool names are "<integration>__<tool>"; the chat shows the integration's own name and icon.
interface IntegrationLabel { name: string; icon: string; tools: Record<string, string> }
let labels: Record<string, IntegrationLabel> = {};

async function loadLabels(): Promise<void> {
  try {
    const list = await api<{ entry: { id: string; name: string; icon: string }; tools: { name: string; title?: string; annotations?: { title?: string } }[] }[]>("/api/integrations");
    labels = Object.fromEntries(list.map((i) => [i.entry.id.replace(/[^a-zA-Z0-9_-]+/g, "_"), { name: i.entry.name, icon: i.entry.icon, tools: Object.fromEntries(i.tools.map((t) => [t.name.replace(/[^a-zA-Z0-9_-]+/g, "_"), t.annotations?.title ?? t.title ?? t.name])) }]));
  } catch {
    /* labels are a nicety */
  }
}

function splitTool(name: string): { server: string; tool: string } {
  const i = name.indexOf("__");
  return i < 0 ? { server: "", tool: name } : { server: name.slice(0, i), tool: name.slice(i + 2) };
}

function toolLabel(name: string): string {
  if (name === "use_skill") return "Loaded skills";
  if (name === "read_skill_file") return "Read skill file";
  const { server, tool } = splitTool(name);
  const l = labels[server];
  if (!l) return name;
  const title = l.tools[tool] ?? tool;
  // "Tavily · Tavily Search" says the name twice; the title alone carries it.
  return title.toLowerCase().includes(l.name.toLowerCase()) ? title : `${l.name} · ${title}`;
}

/**
 * What a turn did on the way (tool calls, the surface action that started it)
 * is working, not conversation: it stays out of the thread, in order, behind a
 * "9 steps" toggle in the reply's footer. Failures show on the toggle itself.
 */
function addStep(turn: Turn, iconName: string, text: string, failed = false): HTMLElement {
  let list = turn.root.querySelector<HTMLElement>(".steps");
  if (!list) {
    list = document.createElement("ol");
    list.className = "steps";
    list.hidden = true;
    turn.root.append(list);
  }
  const li = document.createElement("li");
  li.className = failed ? "failed" : "";
  li.append(icon(iconName, 13), document.createTextNode(failed ? `${text} · failed` : text));
  list.append(li);
  let toggle = turn.status.querySelector<HTMLButtonElement>(".steps-toggle");
  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "steps-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle!.setAttribute("aria-expanded", String(open));
    });
    turn.status.append(toggle);
  }
  const n = list.children.length;
  const bad = list.querySelectorAll(".failed").length;
  toggle.textContent = `${n} step${n === 1 ? "" : "s"}`;
  if (bad) {
    const f = document.createElement("span");
    f.className = "failed";
    f.textContent = ` · ${bad} failed`;
    toggle.append(f);
  }
  return li;
}

/**
 * A surface's card shows once, in the turn that made it; a later turn that
 * changes it records that as one step, which opens it in the canvas.
 */
function surfaceUpdated(turn: Turn, snap: SurfaceSnapshot): void {
  if ([...turn.root.querySelectorAll<HTMLElement>(".steps li")].some((li) => li.dataset.surface === snap.id)) return;
  if (turnSurfaces(turn).includes(snap.id)) return;
  const li = addStep(turn, "canvas", "");
  li.dataset.surface = snap.id;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "link";
  open.textContent = `${snap.title || "Interface"} · changed`;
  // The version this reply left, once it ends; until then, the live one.
  open.addEventListener("click", () => canvas.showVersion(snap.id, li.dataset.version ? Number(li.dataset.version) : undefined));
  li.lastChild!.replaceWith(open);
}

function usedChip(turn: Turn, name: string, ok: boolean): void {
  // Marked so speech can say a reply drew on what tools returned.
  addStep(turn, name === "use_skill" || name === "read_skill_file" ? "book" : labels[splitTool(name).server]?.icon ?? "tool", toolLabel(name), !ok).dataset.tool = name;
}

/**
 * Inline interfaces the conversation has moved past fold to one line: the
 * latest reply's interfaces stay open, and so does any holding unsent input.
 */
function tidySurfaces(): void {
  const turns = [...thread.querySelectorAll<HTMLElement>(".msg.assistant")];
  const last = turns.findLast((t) => t.querySelector(".surface-home, .steps li[data-surface]"));
  const current = new Set([...(last?.querySelectorAll<HTMLElement>(".surface-home[data-surface], .steps li[data-surface]") ?? [])].map((el) => el.dataset.surface!));
  for (const home of thread.querySelectorAll<HTMLElement>(".surface-home.inline[data-surface]")) {
    const id = home.dataset.surface!;
    canvas.fold(id, !current.has(id) && !drafts.pending(id));
  }
}

/**
 * The surfaces a reply made or changed, as it left them: the canvas keeps them
 * as versions, and the reply's "changed" step opens its own. History passes the
 * saved copies; a live turn takes the store's at its end.
 */
function recordVersions(turn: Turn, saved?: SurfaceSnapshot[]): void {
  const changed = [...turn.root.querySelectorAll<HTMLElement>(".steps li[data-surface]")];
  const ids = new Set([...turnSurfaces(turn), ...changed.map((li) => li.dataset.surface!)]);
  for (const id of ids) {
    const snap = saved ? saved.find((v) => v.id === id) : client.store.snapshot(id);
    if (!snap) continue;
    canvas.addVersion(snap);
    for (const li of changed) if (li.dataset.surface === id) li.dataset.version = String(snap.version);
  }
}

// A surface action is answered by the next turn: it becomes that turn's first step.
let pendingSteps: string[] = [];

function formatApprovalBody(e: Extract<AgentEvent, { type: "approval" }>): { body: HTMLElement; subText: string } {
  const container = document.createElement("div");
  container.className = "approval-body";

  const raw = e.args;
  const isObj = raw !== null && typeof raw === "object";
  const hasCommand = isObj && "command" in (raw as Record<string, unknown>) && typeof (raw as Record<string, unknown>).command === "string";
  const hasPaths = isObj && "paths" in (raw as Record<string, unknown>) && Array.isArray((raw as Record<string, unknown>).paths);
  let subText = "The model wants to run this tool with:";

  if (hasCommand) {
    subText = "Command requested by model:";
    const cmdBox = document.createElement("div");
    cmdBox.className = "approval-cmd";
    const line = document.createElement("div");
    line.className = "approval-cmd-line";
    const prompt = document.createElement("span");
    prompt.className = "approval-cmd-prompt";
    prompt.textContent = "$";
    const code = document.createElement("code");
    const cmdStr = String((raw as Record<string, unknown>).command);
    const argv = (raw as Record<string, unknown>).args;
    const argsStr = Array.isArray(argv) ? argv.map(a => String(a).includes(" ") ? `"${a}"` : String(a)).join(" ") : "";
    code.textContent = `${cmdStr} ${argsStr}`.trim();
    line.append(prompt, code);
    cmdBox.append(line);

    const meta = document.createElement("div");
    meta.className = "approval-cmd-meta";
    const cwd = (raw as Record<string, unknown>).workingDirectory;
    if (typeof cwd === "string" && cwd !== ".") {
      const c = document.createElement("span");
      c.textContent = `Directory: ${cwd}`;
      meta.append(c);
    }
    if ((raw as Record<string, unknown>).realmId) {
      const r = document.createElement("span");
      r.textContent = "Isolated Sandbox Copy";
      meta.append(r);
    }
    if (meta.children.length) cmdBox.append(meta);
    container.append(cmdBox);
  } else if (hasPaths) {
    subText = "Workspace changes to apply:";
    const pathsBox = document.createElement("div");
    pathsBox.className = "approval-cmd";
    const title = document.createElement("div");
    title.className = "approval-cmd-meta";
    const paths = (raw as Record<string, unknown>).paths as string[];
    title.textContent = `Target files (${paths.length}):`;
    pathsBox.append(title);
    const list = document.createElement("div");
    list.className = "approval-paths-list";
    for (const p of paths.slice(0, 8)) {
      const item = document.createElement("div");
      item.textContent = `• ${p}`;
      list.append(item);
    }
    if (paths.length > 8) {
      const more = document.createElement("div");
      more.className = "row-hint";
      more.textContent = `… and ${paths.length - 8} more`;
      list.append(more);
    }
    pathsBox.append(list);
    container.append(pathsBox);
  } else if (isObj && Object.keys(raw as object).length === 0) {
    subText = "Setup requested by model:";
    const emptyBox = document.createElement("div");
    emptyBox.className = "approval-cmd-meta";
    emptyBox.textContent = "Initializes an isolated project workspace copy.";
    container.append(emptyBox);
  }

  // Collapsible technical parameters
  if (isObj && Object.keys(raw as object).length > 0) {
    const details = document.createElement("details");
    details.className = "approval-details";
    const summary = document.createElement("summary");
    summary.textContent = "Technical parameters";
    const pre = document.createElement("pre");
    pre.className = "approval-args";
    pre.textContent = JSON.stringify(e.args, null, 2);
    details.append(summary, pre);
    container.append(details);
  } else if (!isObj) {
    const pre = document.createElement("pre");
    pre.className = "approval-args";
    pre.textContent = JSON.stringify(e.args, null, 2);
    container.append(pre);
  }

  return { body: container, subText };
}

/** "May I?" for a tool on Ask: what it is, what it will be given, and three answers. */
function approvalCard(turn: Turn, e: Extract<AgentEvent, { type: "approval" }>): void {
  const l = labels[e.server.replace(/[^a-zA-Z0-9_-]+/g, "_")];
  const card = document.createElement("div");
  card.className = "approval";
  card.dataset.id = e.id;
  const head = document.createElement("div");
  head.className = "approval-head";
  const words = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = `Use ${l?.name ?? e.server}: ${e.title}?`;
  const sub = document.createElement("div");
  sub.className = "approval-sub";
  const { body, subText } = formatApprovalBody(e);
  sub.textContent = subText;
  words.append(b, sub);
  head.append(tile(l?.icon ?? "tool", 32), words);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const answer = (decision: "allow" | "allow-chat" | "deny") => async () => {
    for (const x of actions.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
    await api(`/api/approvals/${encodeURIComponent(e.id)}`, { method: "POST", body: JSON.stringify({ decision }) }).catch(() => settleApproval(e.id, "deny"));
  };
  for (const [label, decision, cls] of [["Deny", "deny", "ghost small"], ["Allow for this chat", "allow-chat", "primary small"], ["Allow once", "allow", "ghost small"]] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", answer(decision));
    actions.append(btn);
  }
  card.append(head, body, actions);
  // Where it happened: before what the model makes of the result.
  turn.root.insertBefore(card, turn.surfaces);
  setStatus(turn, "Waiting for your answer…");
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  actions.querySelector<HTMLButtonElement>(".primary")?.focus();
  if (conversationState() !== "off") voiceApprovals.offer(e, l?.name);
}

function settleApproval(id: string, decision: "allow" | "deny"): void {
  voiceApprovals.settled(id);
  const card = document.querySelector<HTMLElement>(`.approval[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add("settled", decision);
  card.querySelector(".approval-actions")?.replaceChildren(Object.assign(document.createElement("span"), { className: "approval-result", textContent: decision === "allow" ? "Allowed" : "Declined" }));
  card.querySelector(".approval-body")?.remove();
  card.querySelector(".approval-args")?.remove();
}

// --- outside agents --------------------------------------------------------------------
// Surfaces an agent projects into this chat from outside (the MCP server's
// vak_render, a script via /api/project) appear live; their buttons and forms
// go back to that agent, not to the model here.
let watching: AbortController | undefined;
let outsideTurn: Turn | undefined;

function watch(id: string): void {
  watching?.abort();
  const ctrl = new AbortController();
  watching = ctrl;
  outsideTurn = undefined;
  void (async () => {
    for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
      try {
        const { url, token } = engine();
        const res = await engineFetch(`${url}/api/events?session=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
        for await (const msg of readSse(res.body!)) {
          if (session !== id) return;
          const e = JSON.parse(msg.data) as AgentEvent;
          if (e.type === "surface" && mounted.has(e.snapshot.id) && remoteVersions.get(e.snapshot.id) === e.snapshot.version) continue;
          // A scheduled task's run, or this chat's own turn left running in the background.
          const background = !tasksPanel.owns(id) && busy.has(id);
          if (background) {
            if (e.type === "text_delta") {
              outsideTurn ??= newTurn("Working…");
              outsideTurn.text.dataset.text = (outsideTurn.text.dataset.text ?? "") + e.delta;
              outsideTurn.text.replaceChildren(renderMarkdown(outsideTurn.text.dataset.text));
            } else if (e.type === "tool_start" && (e.name === "vak_render" || e.name === "vak_update" || e.name === "vak_submit")) canvas.beginWork();
            else if (e.type === "approval") approvalCard(outsideTurn ??= newTurn("Working…"), e);
            else if (e.type === "approval_done") settleApproval(e.id, e.decision);
            else if (e.type === "run_end") {
              busy.delete(id);
              canvas.endTurn();
              const done = outsideTurn;
              outsideTurn = undefined;
              if (done) recordVersions(done);
              tidySurfaces();
              updateSend();
              void api<SessionView>(`/api/sessions/${encodeURIComponent(id)}`).then((v) => {
                const last = v.timeline.findLast((t) => t.kind === "assistant");
                if (done && last?.kind === "assistant") {
                  setStatus(done, last.status || "Done", last.error ? "error" : "done");
                  if (last.limit) limited(done, last.limit);
                }
              }).catch(() => {});
              void loadChats();
            }
          }
          if (tasksPanel.owns(id)) {
            if (e.type === "plan") { canvas.beginTurn(); outsideTurn = newTurn("Working…"); }
            else if (e.type === "text_delta") {
              outsideTurn ??= newTurn("Working…");
              outsideTurn.text.dataset.text = (outsideTurn.text.dataset.text ?? "") + e.delta;
              outsideTurn.text.replaceChildren(renderMarkdown(outsideTurn.text.dataset.text));
            } else if (e.type === "tool_start" && (e.name === "vak_render" || e.name === "vak_update" || e.name === "vak_submit")) canvas.beginWork();
            else if (e.type === "run_end") {
              canvas.endTurn();
              for (const surface of mounted.values()) surface.releaseAction();
              if (outsideTurn) setStatus(outsideTurn, "Review the task result", "done");
              void tasksPanel.refresh();
            }
          }
          if (e.type === "surface") {
            loadSnapshot(e.snapshot);
            if (mounted.has(e.snapshot.id)) {
              if (outsideTurn) surfaceUpdated(outsideTurn, e.snapshot);
              canvas.register(mounted.get(e.snapshot.id)!, e.snapshot, thread, true);
              mounted.get(e.snapshot.id)!.refresh();
            }
            else {
              outsideTurn ??= newTurn("");
              if (background) setStatus(outsideTurn, "Working…");
              else setStatus(outsideTurn, tasksPanel.owns(id) ? "Working on this task" : "projected by an outside agent", "done");
              mount(outsideTurn, e.snapshot);
            }
            remoteVersions.set(e.snapshot.id, e.snapshot.version);
            updateDraftNotice();
            void loadChats();
          } else if (e.type === "surface_removed") {
            drafts.remove(e.id);
            client.store.remove({ surface: e.id });
            canvas.remove(e.id);
            mounted.delete(e.id);
            void loadChats();
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      // The engine restarted or the connection dropped: reconnect, backing off.
      await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
    }
  })();
}

// --- right-click ---------------------------------------------------------------------
/** Rename a chat in place in the sidebar: Enter saves, Escape cancels. */
function renameChat(row: HTMLElement): void {
  const open = row.querySelector<HTMLButtonElement>(".open")!;
  const field = Object.assign(document.createElement("input"), { className: "rename", value: open.textContent ?? "" });
  open.replaceWith(field);
  field.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const title = field.value.trim();
    if (save && title && title !== open.textContent) await api(`/api/sessions/${encodeURIComponent(row.dataset.id!)}`, { method: "PUT", body: JSON.stringify({ title }) }).catch(() => {});
    await loadChats();
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void finish(true);
    if (e.key === "Escape") void finish(false);
  });
  field.addEventListener("blur", () => void finish(true));
}

const copy = (text: string) => navigator.clipboard.writeText(text);

onContextMenu((_t, path) => {
  const row = closest<HTMLElement>(path, ".chat");
  if (!row?.dataset.id) return;
  const id = row.dataset.id;
  return [
    { label: "Open", run: () => openChat(id) },
    { label: "Rename…", run: () => renameChat(row) },
    "-",
    {
      label: "Delete…",
      danger: true,
      run: async () => {
        if (!(await ask(`Delete “${row.querySelector(".open")?.textContent ?? "this chat"}”?`, "Delete"))) return;
        await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        drafts.clear(id);
        if (id === session) newChat();
        await loadChats();
      },
    },
  ];
});

onContextMenu((_t, path) => {
  const link = closest<HTMLAnchorElement>(path, "a[href]");
  if (!link || !/^(https:|mailto:)/.test(link.href)) return;
  return [
    { label: "Open link in browser", run: () => openExternal(link.href) },
    { label: link.href.startsWith("mailto:") ? "Copy email address" : "Copy link", run: () => copy(link.href.replace(/^mailto:/, "")) },
  ];
});

onContextMenu((_t, path) => {
  const img = closest<HTMLImageElement>(path, "img[src]");
  if (!img || !img.src.startsWith("https:")) return;
  return [
    { label: "Open image in browser", run: () => openExternal(img.src) },
    { label: "Copy image address", run: () => copy(img.src) },
  ];
});

onContextMenu((_t, path) => {
  const bubble = closest<HTMLElement>(path, ".msg.user .bubble");
  if (!bubble) return;
  const text = bubble.textContent ?? "";
  return [
    { label: "Copy message", run: () => copy(text) },
    {
      label: "Edit as new message",
      run: () => {
        input.value = text;
        autosize();
        input.focus();
      },
    },
  ];
});

onContextMenu((_t, path) => {
  const surface = closest<VakSurfaceElement>(path, "vak-surface");
  if (surface) {
    const id = [...mounted].find(([, el]) => el === surface)?.[0];
    const resolved = id ? client.store.resolve(id) : undefined;
    if (!resolved) return;
    return [{ label: "Copy as text", run: () => copy(projectText(resolved)) }];
  }
  const text = closest<HTMLElement>(path, ".msg.assistant .text");
  if (!text?.textContent?.trim()) return;
  const root = text.closest<HTMLElement>(".msg")!;
  const reading = voiceState().target === root;
  return [
    { label: "Copy reply", run: () => copy(text.innerText) },
    ...(voicePrefs.enabled ? [{ label: reading ? "Stop reading" : "Read aloud", run: () => toggleReading(root, () => replyText(text)) }] : []),
  ];
});

// --- errors -------------------------------------------------------------------------
// A release window has no console: errors go to the engine log (About → Engine log).
const report = (message: string) => void api("/api/client-log", { method: "POST", body: JSON.stringify({ level: "error", message }) }).catch(() => {});
window.addEventListener("error", (e) => report(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled: ${String((e.reason as Error)?.stack ?? e.reason)}`));

// --- start -------------------------------------------------------------------------
async function start(): Promise<void> {
  document.body.classList.toggle("notes", opt("notes") === "true");
  void setKeepRunning(opt("keep-running", "true") !== "false");
  fillPicker();
  updateSend();
  try {
    const migration = await planNativeSessionMigration();
    if (migration && migration.session_count > 0 && !migration.already_migrated) {
      const bytes = `${(migration.bytes / 1024).toFixed(1)} KiB`;
      if (await ask(`Copy ${migration.session_count} saved chat${migration.session_count === 1 ? "" : "s"} (${bytes}) into native app storage? The originals stay in place.`, "Copy saved chats")) {
        const receipt = await migrateNativeSessions(migration.source_digest);
        showNotice("Saved chats copied", `${receipt.imported} chat${receipt.imported === 1 ? "" : "s"} copied. Original files remain untouched.`);
      } else {
        session = crypto.randomUUID();
        prefs.set("session", session);
        showNotice("Saved chats not copied", "Your previous chat files remain in the old folder. This window will start a new chat.");
      }
    }
  } catch (err) {
    showNotice("Saved chats need attention", String((err as Error).message ?? err));
    return;
  }
  try {
    setBackend(await connect());
    startProviderConsents();
    await admitSession(session);
  } catch (err) {
    showNotice("The engine is not running.", String((err as Error).message ?? err));
    return;
  }
  const { url, token } = engine();
  client = new VakClient(`${url}/api/chat`, undefined, { authorization: `Bearer ${token}` }, engineFetch);

  // 1. Initial view: render chat and sidebar immediately in parallel
  const hasSavedSession = Boolean(prefs.get("session") || new URLSearchParams(location.search).get("session"));
  const chatPromise = (hasSavedSession
    ? openChat(session)
    : Promise.resolve().then(() => {
        $("workspace").hidden = false;
        showEmpty();
        void workspacesPanel.updateForSession(session);
      })
  ).catch((err) => {
    report(`initial chat load: ${(err as Error).message}`);
    showEmpty();
  });

  const chatsPromise = loadChats().catch((err) => {
    report(`initial loadChats: ${(err as Error).message}`);
  });

  // 2. Load providers, labels, and tasks concurrently in background without blocking initial paint
  const providersPromise = loadProviders().catch((err) => {
    report(`loadProviders: ${(err as Error).message}`);
  });
  const labelsPromise = loadLabels().catch(() => {});
  const tasksPromise = tasksPanel.refresh().catch(() => {});

  await Promise.all([chatPromise, chatsPromise]);

  void providersPromise.then(() => {
    if (!current.model) {
      void openSettings(providers.some((p) => p.available && !p.local) ? "models" : "providers");
    }
  });
}

void start();

window.addEventListener("vak:edit-app", (event) => {
  void openSkillStudio(String((event as CustomEvent).detail), async () => { $("workspace").hidden = false; }, async () => {}, "app");
});

window.addEventListener("vak:build-app", (event) => {
  const { id, sourceSession } = (event as CustomEvent<{ id: string; sourceSession?: string }>).detail;
  void (async () => {
    await switchNavTab("chats");
    if (sourceSession && sourceSession !== session) await openChat(sourceSession, true);
    const request = `Build the executable application for draft ${id} from the intent, sources and logic in this conversation. Read it with read_app_package. Preserve its independent surfaces and canonical data. Implement real async actions and refresh handlers; use declared, governed integration tools for real data. Save complete source with save_app_draft and the current review fingerprints. Do not publish or enable schedules; leave the package ready for Studio rehearsal and review. Identify any missing source, permission or behavior instead of inventing it.`;
    input.value = input.value.trim() ? `${input.value}\n\n${request}` : request;
    input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  })();
});
