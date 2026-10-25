// vak desktop UI: chats in a sidebar, a thread of turns, surfaces rendered by
// <vak-surface>. Everything model-related runs in the engine sidecar; this
// side only talks to it over HTTP with the token the shell handed over.
// Kept deliberately quiet: the window is the conversation and a composer with
// a model picker; everything else is on the Settings page.

import { type AgentEvent, projectText, type SurfaceSnapshot } from "@vak/core";
import type { SessionSummary, SessionView } from "@vak/host";
import { defineVakElements, renderMarkdown, type VakActionDetail, VakClient, type VakSurfaceElement } from "@vak/web";
import { connect, openExternal, setKeepRunning } from "./backend.ts";
import { $, api, ask, engine, prefs, setBackend } from "./core.ts";
import { choose, current, fillPicker, loadProviders, modelErrors, parseChoice, providers } from "./models.ts";
import { closest, onContextMenu } from "./menu.ts";
import { closeSettings, openSettings, settingsOpen } from "./settings.ts";
import { applyAppearance, surfaceMode } from "./theme.ts";

applyAppearance();
defineVakElements();

const thread = $<HTMLElement>("thread");
const input = $<HTMLTextAreaElement>("input");
const send = $<HTMLButtonElement>("send");
const modelPick = $<HTMLSelectElement>("model-pick");
const chatsNav = $<HTMLElement>("chats");

let client: VakClient;
let session = prefs.get("session") ?? crypto.randomUUID();
const mounted = new Map<string, VakSurfaceElement>();
let running: AbortController | undefined;
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
window.addEventListener("vak:chats-cleared", () => {
  newChat();
  void loadChats();
});
window.addEventListener("vak:settings-closed", () => {
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
  empty.innerHTML = '<h1>What can I show you?</h1><div class="samples"></div>';
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

async function loadChats(): Promise<void> {
  const list = await api<SessionSummary[]>("/api/sessions");
  chatsNav.replaceChildren();
  let group = "";
  for (const c of list) {
    if (groupOf(c.updated) !== group) {
      group = groupOf(c.updated);
      chatsNav.append(Object.assign(document.createElement("div"), { className: "group", textContent: group }));
    }
    const row = document.createElement("div");
    row.className = "chat";
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
      if (c.id === session) newChat();
      await loadChats();
    });
    chatsNav.append(row);
  }
}

function clearThread(): void {
  running?.abort();
  mounted.clear();
  for (const s of client.store.list()) client.store.remove({ surface: s.id });
}

function newChat(): void {
  clearThread();
  session = crypto.randomUUID();
  prefs.set("session", session);
  showEmpty();
  for (const row of chatsNav.querySelectorAll(".chat")) row.setAttribute("aria-current", "false");
  input.focus();
}

/** Redraw a saved conversation from its timeline and final surfaces. */
async function openChat(id: string): Promise<void> {
  clearThread();
  session = id;
  prefs.set("session", id);
  const view = await api<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  if (session !== id) return;
  for (const snap of view.surfaces) client.store.load(snap);
  if (!view.timeline.length) showEmpty();
  else thread.replaceChildren();
  for (const entry of view.timeline) {
    if (entry.kind === "user") userBubble(entry.text);
    else if (entry.kind === "action") eventChip(entry.action);
    else {
      const turn = newTurn("", false);
      turn.text.replaceChildren(renderMarkdown(entry.text));
      for (const sid of entry.surfaces) {
        const snap = client.store.snapshot(sid);
        if (snap && !mounted.has(sid)) mount(turn, snap, false);
      }
      for (const note of entry.notes) addNote(turn, note.name, note.result);
      setStatus(turn, entry.status, entry.error ? "error" : "done");
    }
  }
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
  m.append(b);
  add(m, false);
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
  return { root, text, surfaces, status };
}

function setStatus(turn: Turn, text: string, state?: "done" | "error"): void {
  turn.status.className = `status ${state ?? ""}`;
  turn.status.querySelector(".label")!.textContent = text;
}

function addNote(turn: Turn, name: string, result: string): void {
  const d = document.createElement("details");
  d.className = "diag";
  d.innerHTML = "<summary></summary><pre></pre>";
  d.querySelector("summary")!.textContent = `${name}: engine notes (sent back to the model)`;
  d.querySelector("pre")!.textContent = result;
  turn.root.insertBefore(d, turn.status);
}

function mount(turn: Turn, snap: SurfaceSnapshot, scroll = true): void {
  let el = mounted.get(snap.id);
  if (!el) {
    el = document.createElement("vak-surface") as VakSurfaceElement;
    mounted.set(snap.id, el);
    turn.surfaces.append(el);
    el.attach(client.store, snap.id);
    surfaceMode(el);
    // A new interface is the answer: bring its top into view (a reply to a
    // click otherwise lands below the fold and looks like nothing happened).
    const shown = el;
    if (scroll) requestAnimationFrame(() => shown.scrollIntoView({ block: "start", behavior: "smooth" }));
  } else el.refresh();
}

function updateSend(): void {
  send.classList.toggle("stop", Boolean(running));
  send.setAttribute("aria-label", running ? "Stop" : "Send");
  send.disabled = !running && (!input.value.trim() || !current.model);
}

async function runTurn(req: { message?: string; action?: VakActionDetail["action"] & { data: Record<string, unknown> } }): Promise<void> {
  running?.abort();
  const ctrl = new AbortController();
  running = ctrl;
  updateSend();
  const turnSession = session;
  const turn = newTurn("Thinking…");
  const started = performance.now();
  let text = "";
  let frame = 0;
  const { provider, model } = current;

  const onEvent = (e: AgentEvent) => {
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
        setStatus(turn, e.name.startsWith("vak_") ? "Building the interface…" : `Running ${e.name}…`);
        break;
      case "surface":
        mount(turn, e.snapshot);
        break;
      case "surface_removed":
        mounted.get(e.id)?.remove();
        mounted.delete(e.id);
        break;
      case "tool_end":
        if (e.isError || e.result !== "ok") addNote(turn, e.name, e.result);
        break;
      case "error":
        setStatus(turn, e.message, "error");
        break;
      case "run_end":
        if (!turn.status.classList.contains("error")) {
          setStatus(turn, `${model} · ${((performance.now() - started) / 1000).toFixed(1)}s${e.stop === "max_steps" ? " · step limit" : ""}`, "done");
        }
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
    if (ctrl.signal.aborted) setStatus(turn, "Stopped", "done");
    else setStatus(turn, (err as Error).message, "error");
  } finally {
    if (running === ctrl) running = undefined;
    updateSend();
    if (frame) cancelAnimationFrame(frame);
    turn.text.replaceChildren(renderMarkdown(text));
    // The first message names the chat; refresh the list either way (order by recency).
    if (session === turnSession) void loadChats();
  }
}

function submit(text: string): void {
  const t = text.trim();
  if (!t) return;
  if (!current.model) return void openSettings();
  userBubble(t);
  input.value = "";
  autosize();
  void runTurn({ message: t });
}

// UI actions from any surface go back to the model.
document.addEventListener("vak-action", (e) => {
  const { action, data } = (e as CustomEvent<VakActionDetail>).detail;
  eventChip(action.action);
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
    submit(input.value);
  }
});
$<HTMLFormElement>("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (running) running.abort();
  else submit(input.value);
});
$<HTMLButtonElement>("new-chat").addEventListener("click", newChat);
$<HTMLButtonElement>("open-settings").addEventListener("click", () => void openSettings());
// "New chat" from the tray menu.
window.addEventListener("vak:new-chat", newChat);

function toggleSidebar(): void {
  document.body.classList.toggle("collapsed");
  prefs.set("collapsed", String(document.body.classList.contains("collapsed")));
}
document.body.classList.toggle("collapsed", prefs.get("collapsed") === "true");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && running && !settingsOpen()) return running.abort();
  if (!(e.metaKey || e.ctrlKey)) return;
  const actions: Record<string, () => void> = {
    n: () => (closeSettings(), newChat()),
    ",": () => void (settingsOpen() ? closeSettings() : openSettings()),
    "\\": toggleSidebar,
  };
  const act = actions[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

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
  if (text?.textContent?.trim()) return [{ label: "Copy reply", run: () => copy(text.innerText) }];
});

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
    await openChat(session);
  } catch (err) {
    showNotice("Could not reach the engine.", (err as Error).message);
    return;
  }
  // First run with nothing usable: Settings is the only next step.
  if (!current.model) void openSettings(providers.some((p) => p.available && !p.local) ? "models" : "providers");
}

void start();
