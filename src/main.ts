// vak desktop UI: chats in a sidebar, a thread of turns, surfaces rendered by
// <vak-surface>. Everything model-related runs in the engine sidecar; this
// side only talks to it over HTTP with the token the shell handed over.
// Kept deliberately quiet: the window is the conversation and a composer with
// a model picker; everything else lives in Settings.

import { type AgentEvent, readSse, type SurfaceSnapshot } from "@vak/core";
import type { SessionSummary, SessionView } from "@vak/host";
import { defineVakElements, renderMarkdown, type VakActionDetail, VakClient, type VakSurfaceElement } from "@vak/web";
import { type Backend, connect, openExternal } from "./backend.ts";

defineVakElements();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const thread = $<HTMLElement>("thread");
const input = $<HTMLTextAreaElement>("input");
const send = $<HTMLButtonElement>("send");
const modelPick = $<HTMLSelectElement>("model-pick");
const chatsNav = $<HTMLElement>("chats");

const prefs = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`vak:${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`vak:${k}`, v);
    } catch {
      /* storage unavailable */
    }
  },
};

let backend: Backend;
let client: VakClient;
let session = prefs.get("session") ?? crypto.randomUUID();
const mounted = new Map<string, VakSurfaceElement>();
let running: AbortController | undefined;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${backend.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${backend.token}`, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok && res.status !== 502) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** A small yes/no sheet; window.confirm is not available in every webview. */
function ask(text: string, ok = "Continue"): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("ask");
  $<HTMLElement>("ask-text").textContent = text;
  $<HTMLButtonElement>("ask-ok").textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
}

// --- model choice ---------------------------------------------------------------
// One current provider + model, picked in the composer or typed in Settings.
interface ProviderInfo { id: string; label: string; available: boolean; reason?: string; defaultModel?: string }
let providers: ProviderInfo[] = [];
const modelsOf = new Map<string, string[]>();
const current = { provider: prefs.get("provider") ?? "", model: "" };

function choose(provider: string, model: string): void {
  current.provider = provider;
  current.model = model;
  prefs.set("provider", provider);
  if (model) prefs.set(`model:${provider}`, model);
  fillPicker();
  updateSend();
}

async function listModels(p: ProviderInfo): Promise<{ models: string[]; default?: string }> {
  try {
    return await api<{ models: string[]; default?: string }>(`/api/models?provider=${encodeURIComponent(p.id)}`);
  } catch {
    return { models: [], default: p.defaultModel };
  }
}

async function loadProviders(): Promise<void> {
  providers = await api<ProviderInfo[]>("/api/providers");
  const available = providers.filter((p) => p.available);
  const listed = await Promise.all(available.map(listModels));
  modelsOf.clear();
  available.forEach((p, i) => modelsOf.set(p.id, listed[i]!.models));
  const provider = available.find((p) => p.id === current.provider) ?? available[0];
  if (!provider) return choose("", "");
  const i = available.indexOf(provider);
  choose(provider.id, prefs.get(`model:${provider.id}`) ?? listed[i]!.default ?? listed[i]!.models[0] ?? "");
}

function fillPicker(): void {
  modelPick.replaceChildren();
  for (const p of providers.filter((x) => x.available)) {
    const group = document.createElement("optgroup");
    group.label = p.label;
    const models = [...(modelsOf.get(p.id) ?? [])];
    const remembered = prefs.get(`model:${p.id}`);
    for (const m of [remembered, p.id === current.provider ? current.model : null]) if (m && !models.includes(m)) models.unshift(m);
    for (const m of models) group.append(Object.assign(document.createElement("option"), { value: JSON.stringify([p.id, m]), textContent: m }));
    if (models.length) modelPick.append(group);
  }
  if (!modelPick.options.length) modelPick.append(Object.assign(document.createElement("option"), { value: "", textContent: "Choose a model in Settings" }));
  modelPick.value = JSON.stringify([current.provider, current.model]);
}

modelPick.addEventListener("change", () => {
  if (!modelPick.value) return void openSettings();
  const [provider, model] = JSON.parse(modelPick.value) as [string, string];
  choose(provider, model);
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

// --- settings -------------------------------------------------------------------
interface Setting { name: string; label: string; secret: boolean; placeholder?: string; set: boolean; value?: string }
interface PlanInfo { generation: string; tier: string; examples: boolean; authoring?: string; maxSteps: number; reasons: string[] }
const settingsDialog = $<HTMLDialogElement>("settings");
const providerSel = $<HTMLSelectElement>("provider");
const modelInput = $<HTMLInputElement>("model");
const planText = $<HTMLElement>("plan-text");
const calibrateBtn = $<HTMLButtonElement>("calibrate");
let shownSettings: Setting[] = [];
const cleared = new Set<string>();
let planTimer: ReturnType<typeof setTimeout> | undefined;
let calibrationCalls = 0;

function loadOptions(): void {
  $<HTMLInputElement>("think").checked = prefs.get("opt:think") === "true";
  $<HTMLInputElement>("show-notes").checked = prefs.get("opt:notes") === "true";
  document.body.classList.toggle("notes", prefs.get("opt:notes") === "true");
  for (const k of ["generation", "schema", "effort"] as const) {
    const v = prefs.get(`opt:${k}`);
    if (v !== null) $<HTMLSelectElement>(k).value = v;
  }
}

function fillModelSettings(): void {
  providerSel.replaceChildren(
    ...providers.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.available ? p.label : `${p.label} (needs a key below)`;
      o.disabled = !p.available;
      return o;
    }),
  );
  providerSel.value = current.provider;
  fillModelList();
  modelInput.value = current.model;
}

function fillModelList(): void {
  $<HTMLDataListElement>("models").replaceChildren(...(modelsOf.get(providerSel.value) ?? []).map((m) => Object.assign(document.createElement("option"), { value: m })));
}

providerSel.addEventListener("change", () => {
  fillModelList();
  const p = providers.find((x) => x.id === providerSel.value);
  modelInput.value = prefs.get(`model:${providerSel.value}`) ?? p?.defaultModel ?? modelsOf.get(providerSel.value)?.[0] ?? "";
  void loadPlan();
});
modelInput.addEventListener("input", () => {
  clearTimeout(planTimer);
  planTimer = setTimeout(loadPlan, 400);
});

function describePlan(p: PlanInfo): string {
  return [p.generation, p.tier === "core" ? "core components" : "full catalog", p.examples ? "worked examples" : "no examples", p.authoring === "inline" ? "inline children" : "flat nodes"].join(" · ");
}

async function loadPlan(): Promise<void> {
  const provider = providerSel.value;
  const model = modelInput.value.trim();
  planText.replaceChildren();
  calibrateBtn.hidden = !model;
  if (!model) return void (planText.textContent = "Choose a model to see how vak will ask it for UI.");
  planText.textContent = "Reading model capabilities…";
  try {
    const res = await api<{ plan?: PlanInfo; error?: string; calibrationCalls?: number }>(`/api/profile?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`);
    if (providerSel.value !== provider || modelInput.value.trim() !== model) return;
    calibrationCalls = res.calibrationCalls ?? 0;
    showPlan(res.plan, res.error);
  } catch (err) {
    showPlan(undefined, (err as Error).message);
  }
}

function showPlan(p: PlanInfo | undefined, error?: string): void {
  planText.replaceChildren();
  if (!p) return void (planText.textContent = `Unavailable: ${error ?? "unknown model"}`);
  const b = document.createElement("b");
  b.textContent = describePlan(p);
  planText.append(b, document.createElement("br"), document.createTextNode(p.reasons.join("; ")));
}

calibrateBtn.addEventListener("click", async () => {
  const provider = providerSel.value;
  const model = modelInput.value.trim();
  if (!model) return;
  // Hosted providers bill per call; local Ollama runs are free.
  if (provider !== "ollama" && !(await ask(`Calibration makes ${calibrationCalls} calls to ${model} and spends tokens. Continue?`))) return;
  const out = $<HTMLElement>("calibration");
  out.hidden = false;
  calibrateBtn.disabled = true;
  let done = 0;
  try {
    const res = await fetch(`${backend.url}/api/calibrate`, { method: "POST", headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" }, body: JSON.stringify({ provider, model }) });
    for await (const msg of readSse(res.body!)) {
      const data = JSON.parse(msg.data);
      if (msg.event === "start") out.textContent = `Calibrating: 0/${data.calls} runs`;
      if (msg.event === "case") out.textContent = `Calibrating: ${++done}/${calibrationCalls} runs`;
      if (msg.event === "done") {
        const results = data.calibration.results as { config: { generation: string; tier: string }; runs: number; complete: number }[];
        out.textContent = `Calibrated: ${results.map((r) => `${r.config.generation}/${r.config.tier} ${r.complete}/${r.runs} complete`).join(", ")}`;
        showPlan(data.plan as PlanInfo);
      }
      if (msg.event === "error") out.textContent = `Calibration failed: ${data.message}`;
    }
  } catch (err) {
    out.textContent = `Calibration failed: ${(err as Error).message}`;
  } finally {
    calibrateBtn.disabled = false;
  }
});

async function openSettings(): Promise<void> {
  if (settingsDialog.open) return;
  cleared.clear();
  $<HTMLElement>("settings-error").hidden = true;
  $<HTMLElement>("calibration").hidden = true;
  shownSettings = await api<Setting[]>("/api/settings");
  const box = $<HTMLElement>("provider-settings");
  box.replaceChildren();
  for (const s of shownSettings) {
    const row = document.createElement("div");
    row.className = "field-row";
    row.innerHTML = '<label class="ctl"><span></span><input autocomplete="off" spellcheck="false" /></label>';
    row.querySelector("span")!.textContent = s.label;
    const field = row.querySelector("input")!;
    field.name = s.name;
    field.type = s.secret ? "password" : "text";
    if (s.secret) {
      field.placeholder = s.set ? "•••••••• saved" : "not set";
      if (s.set) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "ghost small";
        clear.textContent = "Remove";
        clear.addEventListener("click", () => {
          cleared.add(s.name);
          field.value = "";
          field.placeholder = "removed on save";
          clear.disabled = true;
        });
        row.append(clear);
      }
    } else {
      field.value = s.value ?? "";
      field.placeholder = s.placeholder ?? "";
    }
    box.append(row);
  }
  loadOptions();
  fillModelSettings();
  void loadPlan();
  settingsDialog.showModal();
}

$<HTMLFormElement>("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values: Record<string, string | null> = {};
  for (const s of shownSettings) {
    const v = settingsDialog.querySelector<HTMLInputElement>(`input[name="${s.name}"]`)!.value.trim();
    // An empty secret field keeps the saved key; Remove is the only way to delete one.
    if (s.secret) {
      if (v) values[s.name] = v;
      else if (cleared.has(s.name)) values[s.name] = null;
    } else if (v !== (s.value ?? "")) values[s.name] = v || null;
  }
  try {
    if (Object.keys(values).length) await api("/api/settings", { method: "PUT", body: JSON.stringify({ values }) });
    prefs.set("opt:think", String($<HTMLInputElement>("think").checked));
    prefs.set("opt:notes", String($<HTMLInputElement>("show-notes").checked));
    for (const k of ["generation", "schema", "effort"] as const) prefs.set(`opt:${k}`, $<HTMLSelectElement>(k).value);
    loadOptions();
    const provider = providerSel.value;
    const model = modelInput.value.trim();
    settingsDialog.close();
    await loadProviders();
    if (providers.some((p) => p.id === provider && p.available)) choose(provider, model);
  } catch (err) {
    const el = $<HTMLElement>("settings-error");
    el.textContent = (err as Error).message;
    el.hidden = false;
  }
});
$<HTMLButtonElement>("settings-cancel").addEventListener("click", () => settingsDialog.close());
$<HTMLButtonElement>("open-settings").addEventListener("click", () => void openSettings());

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
        think: $<HTMLInputElement>("think").checked,
        schemaMode: $<HTMLSelectElement>("schema").value,
        generation: $<HTMLSelectElement>("generation").value,
        effort: $<HTMLSelectElement>("effort").value || undefined,
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

function toggleSidebar(): void {
  document.body.classList.toggle("collapsed");
  prefs.set("collapsed", String(document.body.classList.contains("collapsed")));
}
document.body.classList.toggle("collapsed", prefs.get("collapsed") === "true");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && running && !settingsDialog.open) return running.abort();
  if (!(e.metaKey || e.ctrlKey)) return;
  const actions: Record<string, () => void> = { n: newChat, ",": () => void openSettings(), "\\": toggleSidebar };
  const act = actions[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

// --- start -------------------------------------------------------------------------
async function start(): Promise<void> {
  loadOptions();
  updateSend();
  try {
    backend = await connect();
  } catch (err) {
    showNotice("The engine is not running.", String((err as Error).message ?? err));
    return;
  }
  client = new VakClient(`${backend.url}/api/chat`, undefined, { authorization: `Bearer ${backend.token}` });
  try {
    await loadProviders();
    await openChat(session);
  } catch (err) {
    showNotice("Could not reach the engine.", (err as Error).message);
    return;
  }
  // First run with nothing usable: Settings is the only next step.
  if (!current.model) void openSettings();
}

void start();
