// Vakyartha UI: chats in a sidebar, a thread of turns, surfaces rendered by
// <vak-surface>. Everything model-related runs in the engine sidecar; this
// side only talks to it over HTTP with the token the shell handed over.
// Kept deliberately quiet: the window is the conversation and a composer with
// a model picker; everything else is on the Settings page.

import { type AgentEvent, projectText, readSse, type SurfaceSnapshot, titleRepeated } from "@vak/core";
import type { SessionSummary, SessionView } from "@vak/host";
import { defineVakElements, renderMarkdown, type VakActionDetail, VakClient, type VakSurfaceElement } from "@vak/web";
import { ArtifactsPage } from "./artifacts-page.ts";
import { Canvas } from "./canvas.ts";
import { connect, openExternal, setKeepRunning } from "./backend.ts";
import { $, api, ask, engine, prefs, setBackend } from "./core.ts";
import { choose, current, fillPicker, loadProviders, modelErrors, parseChoice, providers } from "./models.ts";
import { icon, tile } from "./icons.ts";
import { closest, onContextMenu } from "./menu.ts";
import { closeSettings, openSettings, settingsOpen } from "./settings.ts";
import { applyAppearance, surfaceMode } from "./theme.ts";
import { TasksPanel } from "./tasks-panel.ts";
import { Drafts } from "./drafts.ts";
import { VoiceApprovals, cancelDictation, conversationPrefs, conversationState, type ConversationState, startConversation, stopConversation, dictationPrefs, dictationState, lastError, readAloud, replyText, spokenSurface, startDictation, stopDictation, stopReading, textLanguage, voicePrefs, voiceState } from "./voice/index.ts";

applyAppearance();
defineVakElements();

const thread = $<HTMLElement>("thread");
const input = $<HTMLTextAreaElement>("input");
const send = $<HTMLButtonElement>("send");
const modelPick = $<HTMLSelectElement>("model-pick");
const chatsNav = $<HTMLElement>("chats");

let client: VakClient;
// ?session=… opens that chat: the link the MCP server and the bench hand out.
let session = new URLSearchParams(location.search).get("session") ?? prefs.get("session") ?? crypto.randomUUID();
const mounted = new Map<string, VakSurfaceElement>();
const remoteVersions = new Map<string, number>();
const canvas = new Canvas(() => session, () => client.store);
const artifacts = new ArtifactsPage(async (id, surface) => {
  if (id !== session) await openChat(id, true);
  if (id !== session) return;
  artifacts.close();
  canvas.open(surface, true);
}, newChat, toggleSidebar);
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
const tasksPanel = new TasksPanel(() => session, (id) => openChat(id), () => artifacts.close(), toggleSidebar);
document.getElementById("open-artifacts")!.addEventListener("click", () => tasksPanel.page.close(), { capture: true });
const drafts = new Drafts(localStorage, (message) => tasksPanel.error(message));
document.addEventListener("vak-change", (e) => {
  const detail = (e as CustomEvent<{ surface: string; path: string; value: unknown }>).detail;
  drafts.record(detail.surface, detail.path, detail.value);
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
const SAMPLES: [string, string][] = [
  ["Compare hotels", "Compare three hotels in Kyoto for a week in November and let me book one"],
  ["Sales dashboard", "Show a Q3 sales dashboard: KPIs, a monthly revenue chart and top 5 products"],
  ["Workout plan", "Plan a 5-day beginner workout routine, one tab per day"],
  ["Signup form", "Make a newsletter signup form with name, email, topics and frequency"],
];

function showEmpty(): void {
  const empty = document.createElement("section");
  empty.className = "empty";
  empty.id = "empty";
  empty.innerHTML = '<img class="empty-mark" src="/icon.svg" alt="" width="64" height="64" /><h1>What can I show you?</h1><div class="samples"></div>';
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
  for (const [title, prompt] of SAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = title;
    b.title = prompt;
    b.addEventListener("click", () => submit(prompt));
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
  const list = await api<SessionSummary[]>("/api/sessions");
  artifacts.update(list);
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
  let group = "";
  for (const c of list) {
    if (tasksPanel.owns(c.id)) continue;
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
      await api(`/api/sessions/${encodeURIComponent(c.id)}`, { method: "DELETE" });
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
  tasksPanel.page.close();
  artifacts.close();
  clearThread();
  session = crypto.randomUUID();
  drafts.begin(session);
  prefs.set("session", session);
  watch(session);
  showEmpty();
  tasksPanel.selectionChanged();
  for (const row of chatsNav.querySelectorAll(".chat")) row.setAttribute("aria-current", "false");
  input.focus();
}

/** Redraw a saved conversation from its timeline and final surfaces. */
async function openChat(id: string, keepLibrary = false, redraw = false): Promise<void> {
  tasksPanel.page.close();
  if (!keepLibrary) artifacts.close();
  // Returning from a product page must retain live form elements and their controls.
  if (id === session && mounted.size && !redraw) { canvas.restore(); tasksPanel.selectionChanged(); return; }
  clearThread();
  session = id;
  drafts.begin(session);
  prefs.set("session", id);
  const view = await api<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
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
  await loadChats();
  input.focus();
}

// --- thread rendering -------------------------------------------------------------
function add(el: HTMLElement, scroll = true): HTMLElement {
  document.getElementById("empty")?.remove();
  thread.append(el);
  if (scroll) el.scrollIntoView({ block: "end", behavior: "smooth" });
  return el;
}

function userBubble(text: string): void {
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
  turn.status.querySelector(".label")!.textContent = text;
  if (state === "done" && !turn.status.querySelector(".msg-actions") && turnText(turn)) {
    const buttons = [copyAction(() => turnText(turn), "Copy reply"), speakButton(turn)];
    const inline = turnSurfaces(turn).filter((id) => canvas.isInline(id));
    if (inline.length) buttons.push(action("maximize", "Open in canvas", () => canvas.open(inline.at(-1)!, true)));
    turn.status.prepend(messageActions(buttons));
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
function turnSpeech(turn: Turn): string {
  const prose = replyText(turn.text);
  const surfaces = turnSurfaces(turn).flatMap((id) => {
    const resolved = client.store.resolve(id);
    return resolved ? [resolved.title && titleRepeated(resolved.title, resolved.root) ? { ...resolved, title: undefined } : resolved] : [];
  });
  // Prose says the most about the language; an interface alone is judged by its own text.
  const lang = textLanguage(prose) ?? textLanguage(surfaces.map((s) => projectText(s)).join("\n"));
  return [prose, ...surfaces.map((s) => spokenSurface(s, lang))].filter((p) => p.trim()).join("\n\n");
}

// --- read aloud ---------------------------------------------------------------------
function speakButton(turn: Turn): HTMLButtonElement {
  const b = action("voice", "Read aloud", () => toggleReading(turn.root, () => turnSpeech(turn)));
  b.classList.add("speak");
  return b;
}

function toggleReading(root: HTMLElement, text: () => string): void {
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
  send.disabled = !runningHere && (!input.value.trim() || !current.model);
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
  canvas.beginTurn();
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
        if (e.name === "vak_render" || e.name === "vak_update") canvas.beginWork();
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
        setStatus(turn, e.message, "error");
        break;
      case "run_end":
        if (!turn.status.classList.contains("error")) {
          setStatus(turn, `${model} · ${((performance.now() - started) / 1000).toFixed(1)}s${e.limit === "steps" ? " · step limit" : e.limit === "tools" ? " · tool budget" : ""}`, "done");
        }
        if (e.limit) limited(turn, e.limit);
        recordVersions(turn);
        tidySurfaces();
        // Conversation mode always answers aloud: that is the point of it.
        if (voicePrefs.enabled && (voicePrefs.auto || conversationState() !== "off") && turnSession === session && !turn.status.classList.contains("error")) toggleReading(turn.root, () => turnSpeech(turn));
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
        schemaMode: opt("schema", "compact"),
        generation: opt("generation", "auto"),
        effort: opt("effort") || undefined,
        // Long everyday chats would otherwise send every turn and overflow a small model's context.
        history: Number(opt("history", "10")) || undefined,
        ...req,
      },
      onEvent,
      ctrl.signal,
    );
  } catch (err) {
    if (detaching.has(ctrl)) return void clearInterval(ticker);
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

function submit(text: string): void {
  const t = text.trim();
  if (!t) return;
  if (tasksPanel.owns(session)) {
    void tasksPanel.input(t).then(() => { input.value = ""; autosize(); }).catch((err) => tasksPanel.error((err as Error).message));
    return;
  }
  if (isRunning(session)) return;
  if (!current.model) return void openSettings();
  userBubble(t);
  input.value = "";
  autosize();
  void runTurn({ message: t });
}

// UI actions from any surface go back to the model.
document.addEventListener("vak-action", (e) => {
  const detail = (e as CustomEvent<VakActionDetail>).detail;
  const { action } = detail;
  // The surface's data model, plus what the control itself carries (which
  // option of a compare, a button's payload): replacing one with the other lost
  // which item was chosen.
  const data = { ...detail.data, ...action.data };
  if (tasksPanel.owns(session)) {
    const surface = mounted.get(action.surface);
    void tasksPanel.input(undefined, { surface: action.surface, source: action.source, data }, remoteVersions.get(action.surface))
      .catch((err) => tasksPanel.error((err as Error).message)).finally(() => surface?.releaseAction());
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
    submit(input.value);
  }
});
$<HTMLFormElement>("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  // Enter while dictating finishes the dictation; the next Enter sends.
  if (dictationState().state !== "idle") return void stopDictation();
  if (isRunning(session)) stopRun(session);
  else submit(input.value);
});
$<HTMLButtonElement>("new-chat").addEventListener("click", newChat);
$<HTMLButtonElement>("open-settings").addEventListener("click", () => void openSettings());
// "New chat" from the tray menu.
window.addEventListener("vak:new-chat", newChat);

$<HTMLButtonElement>("collapse").append(icon("sidebar", 18));
$<HTMLButtonElement>("expand").append(icon("sidebar", 18));
$<HTMLButtonElement>("collapse").addEventListener("click", toggleSidebar);
$<HTMLButtonElement>("expand").addEventListener("click", toggleSidebar);

function toggleSidebar(): void {
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
  mic.disabled = state === "transcribing";
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
const voiceApprovals = new VoiceApprovals({
  async decide(id, decision) {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ decision }) }).catch(() => settleApproval(id, "deny"));
  },
  say(text) { void readAloud(text, voiceApprovals); },
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
      // A turn still running keeps its place; the words wait in the box rather than cutting it off.
      if (isRunning(session)) {
        input.value = input.value.trim() ? `${input.value.replace(/\s*$/, " ")}${text}` : text;
        autosize();
        return composerHint("Still working on the last message; your words are in the message box.");
      }
      submit(text);
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
window.addEventListener("vak:conversation", () => { if (conversationState() === "off") voiceApprovals.clear(); });
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
  addStep(turn, labels[splitTool(name).server]?.icon ?? "tool", toolLabel(name), !ok);
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
  sub.textContent = "The model wants to run this tool with:";
  words.append(b, sub);
  head.append(tile(l?.icon ?? "tool", 32), words);
  const args = document.createElement("pre");
  args.className = "approval-args";
  const text = JSON.stringify(e.args, null, 2);
  args.textContent = text;
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const answer = (decision: "allow" | "allow-chat" | "deny") => async () => {
    for (const x of actions.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
    await api(`/api/approvals/${encodeURIComponent(e.id)}`, { method: "POST", body: JSON.stringify({ decision }) }).catch(() => settleApproval(e.id, "deny"));
  };
  for (const [label, decision, cls] of [["Deny", "deny", "ghost small"], ["Allow for this chat", "allow-chat", "ghost small"], ["Allow once", "allow", "primary small"]] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", answer(decision));
    actions.append(btn);
  }
  card.append(head, args, actions);
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
        const res = await fetch(`${url}/api/events?session=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
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
            } else if (e.type === "tool_start" && (e.name === "vak_render" || e.name === "vak_update")) canvas.beginWork();
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
            } else if (e.type === "tool_start" && (e.name === "vak_render" || e.name === "vak_update")) canvas.beginWork();
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
  updateSend();
  try {
    setBackend(await connect());
  } catch (err) {
    showNotice("The engine is not running.", String((err as Error).message ?? err));
    return;
  }
  const { url, token } = engine();
  client = new VakClient(`${url}/api/chat`, undefined, { authorization: `Bearer ${token}` });
  try {
    await loadProviders();
    await loadLabels();
    await tasksPanel.refresh();
    await openChat(session);
  } catch (err) {
    showNotice("Could not reach the engine.", (err as Error).message);
    return;
  }
  // First run with nothing usable: Settings is the only next step.
  if (!current.model) void openSettings(providers.some((p) => p.available && !p.local) ? "models" : "providers");
}

void start();
