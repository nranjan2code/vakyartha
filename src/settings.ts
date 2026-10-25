// Settings: a full page with a section sidebar. Every change applies as it is
// made (keys when you press Save next to them), so there is no page-wide Save.

import { readSse } from "@vak/core";
import { autostart, inTauri, revealPath, setKeepRunning } from "./backend.ts";
import { $, api, ask, el, engine, prefs } from "./core.ts";
import { choose, current, labelOf, listModels, loadProviders, modelOptions, parseChoice, type ProviderInfo, providers } from "./models.ts";
import { applyAppearance, appearance, MODES, SIZES, THEMES } from "./theme.ts";
import { addOwnPage, integrationPage, marketplace } from "./integrations-page.ts";
import { disposeFinops, finopsPage } from "./finops-page.ts";
import { TASK_LIMITS, parseTaskSummaries } from "../task-contract.ts";
import { group, pill, plainField, row, secretField, segmented, select, type Setting, title, toggle } from "./ui.ts";

interface ChannelInfo { id: string; label: string; enabled: boolean; provider?: string; model?: string; ready: boolean; secrets: string[]; needs: string[]; state: string; detail: string }
interface PlanInfo { generation: string; tier: string; examples: boolean; authoring?: string; maxSteps: number; reasons: string[] }
interface Info { version: string; node: string; platform: string; dataDir: string; logFile: string; keys: string }

type Section = "models" | "providers" | "integrations" | "integrations:add" | `integration:${string}` | "channel:telegram" | "channel:slack" | "channel:discord" | "appearance" | "chats" | "tasks" | "finops" | "general" | "about";

/** Channels whose listeners are not built yet: shown so the place is known, marked as coming. */
const COMING: Record<string, string> = {
  slack: "Slack answers in a workspace through Socket Mode, so no public URL is needed. The Block Kit projector and modal forms are built (@vak/slack); the listener is next.",
  discord: "Discord answers in servers and DMs through the Gateway. The Components V2 projector and paged modal forms are built (@vak/discord); the listener is next.",
};

const NAV: [Section, string, boolean?][] = [
  ["models", "Models"],
  ["providers", "Providers"],
  ["integrations", "Integrations"],
  ["channel:telegram", "Telegram", true],
  ["channel:slack", "Slack", true],
  ["channel:discord", "Discord", true],
  ["appearance", "Appearance"],
  ["chats", "Chats"],
  ["tasks", "Schedule"],
  ["finops", "FinOps"],
  ["general", "General"],
  ["about", "About"],
];

const page = () => $<HTMLElement>("settings");
const content = () => $<HTMLElement>("settings-content");
let section: Section = (prefs.get("settings:section") as Section | null) ?? "models";
let settings: Setting[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
window.addEventListener("vak:finops-refresh", () => { if (settingsOpen() && section === "finops") void show("finops"); });

export function settingsOpen(): boolean {
  return !page().hidden;
}

export async function openSettings(to?: Section, arg?: string): Promise<void> {
  page().hidden = false;
  document.body.classList.add("in-settings");
  await show(to ?? section, arg);
}

export function closeSettings(): void {
  disposeFinops();
  clearInterval(timer);
  page().hidden = true;
  document.body.classList.remove("in-settings");
  window.dispatchEvent(new Event("vak:settings-closed"));
}

function nav(): void {
  const list = $<HTMLElement>("settings-nav-list");
  list.replaceChildren();
  let channels = false;
  for (const [id, label, sub] of NAV) {
    if (sub && !channels) {
      channels = true;
      list.append(el("div", { className: "nav-group", textContent: "Channels" }));
    }
    const soon = id.startsWith("channel:") && COMING[id.slice(8)];
    const current = id === section || (id === "integrations" && section.startsWith("integration"));
    const b = el("button", { type: "button", className: `nav-item${sub ? " sub" : ""}`, "aria-current": String(current) }, label, soon ? el("span", { className: "soon", textContent: "soon" }) : null);
    b.addEventListener("click", () => void show(id));
    list.append(b);
  }
}

async function show(to: Section, arg?: string): Promise<void> {
  disposeFinops();
  clearInterval(timer);
  section = to;
  prefs.set("settings:section", to);
  nav();
  settings = await api<Setting[]>("/api/settings").catch(() => []);
  const integration = to.startsWith("integration:") ? to.slice("integration:".length) : undefined;
  const render: Record<string, () => Promise<HTMLElement[]>> = {
    integrations: () => marketplace((id) => void show(`integration:${id}`), () => void show("integrations:add")),
    "integrations:add": async () => addOwnPage(() => void show("integrations"), (id) => void show(`integration:${id}`)),
    models: () => modelsPage(arg),
    providers: providersPage,
    "channel:telegram": () => channelPage("telegram"),
    "channel:slack": () => comingPage("slack", "Slack"),
    "channel:discord": () => comingPage("discord", "Discord"),
    appearance: appearancePage,
    chats: chatsPage,
    tasks: async () => [
      ...title("Schedule", "Plan work for now or a chosen time. Every surface remains interactive; completion requires your review."),
      group("Timing", row("One-time schedules", "Save a future date and time, pause or resume, or run now from Schedule. Missed times are held for review. Repeating schedules are not enabled yet.", el("span"))),
      group("Spending", row("Model policy", "New tasks default to a local provider on this computer. Model API charges require explicit acknowledgement. Strict monetary ceilings cannot be enforced yet; tool/server charges, compute and hosting are separate.", el("span"))),
      group("Execution", row("Availability", "Work continues while you switch views or hide the window. Keep the app running and the computer awake. Interrupted work requires review before continuation.", el("span")), row("Per-run limits", `${TASK_LIMITS.rounds} model rounds, ${TASK_LIMITS.tools} tool calls and ${TASK_LIMITS.activeMs / 60000} active minutes. Approval waiting has its own five-minute expiry.`, el("span"))),
      group("Access and results", row("Capabilities", "Select ready, free capabilities per task. Configure access in Integrations; no capability is installed or enabled automatically.", el("button", { type: "button", className: "ghost small", textContent: "Open Integrations", onclick: () => void show("integrations") })), row("Review", "A generated interface does not prove that an external action happened. Check the criteria and any operation receipts before marking a task complete.", el("span"))),
    ],
    finops: finopsPage,
    general: generalPage,
    about: aboutPage,
  };
  const parts = integration ? await integrationPage(integration, () => void show("integrations"), () => void show(to)) : await (render[to] ?? render.models!)();
  if (section !== to) return;
  content().replaceChildren(...parts);
  content().scrollTop = 0;
}

// --- Models -----------------------------------------------------------------
function describePlan(p: PlanInfo): string {
  return [p.generation, p.tier === "core" ? "core components" : "full catalog", p.examples ? "worked examples" : "no examples", p.authoring === "inline" ? "inline children" : "flat nodes"].join(" · ");
}

async function modelsPage(focus?: string): Promise<HTMLElement[]> {
  const usable = providers.filter((p) => p.available);
  let provider = providers.find((p) => p.id === focus && p.available)?.id ?? current.provider;
  const providerSel = select(
    providers.map((p) => [p.id, p.available ? p.label : `${p.label} (add a key in Providers)`] as const),
    provider,
    (v) => {
      provider = v;
      void fillModels(prefs.get(`model:${v}`) ?? providers.find((p) => p.id === v)?.defaultModel ?? "");
    },
  );
  for (const o of providerSel.options) o.disabled = !usable.some((p) => p.id === o.value);
  const modelSel = el("select", { "aria-label": "Model" });
  const other = el("input", { type: "text", className: "wide", placeholder: "Type a model id", spellcheck: false, hidden: true, "aria-label": "Model id" });
  const status = el("p", { className: "row-hint" });
  const plan = el("div", { className: "plan" });
  const calibrate = el("button", { type: "button", className: "ghost small", textContent: "Calibrate" });
  const calibration = el("p", { className: "row-hint" });
  const OTHER = "__other";

  const use = (model: string) => {
    if (!model) return;
    choose(provider, model);
    void showPlan();
  };

  async function fillModels(want: string): Promise<void> {
    const p = providers.find((x) => x.id === provider);
    modelSel.replaceChildren(el("option", { value: "", textContent: "Loading models…" }));
    modelSel.disabled = true;
    status.className = "row-hint";
    status.textContent = "";
    const res = p?.available ? await listModels(p) : { models: [] as string[], error: "add its key in Providers" };
    if (p?.id !== provider) return;
    // No pre-selection from the list: it is alphabetical and often starts with
    // models that cannot chat (OpenAI lists babbage-002 first).
    modelSel.replaceChildren(el("option", { value: "", textContent: "Choose a model…" }), ...res.models.map((m) => el("option", { value: m, textContent: m })), el("option", { value: OTHER, textContent: "Other (type a model id)…" }));
    modelSel.disabled = false;
    if (res.error) {
      status.className = "row-hint bad";
      status.textContent = p ? problemText(p, res.error) : res.error;
    } else status.textContent = p?.local ? `${res.models.length} installed` : `${res.models.length} models available with this key`;
    modelSel.value = res.models.includes(want) ? want : want ? OTHER : "";
    other.hidden = modelSel.value !== OTHER;
    other.value = modelSel.value === OTHER ? want : "";
    if (want && provider === current.provider && want === current.model) void showPlan();
  }

  modelSel.addEventListener("change", () => {
    other.hidden = modelSel.value !== OTHER;
    if (modelSel.value === OTHER) other.focus();
    else use(modelSel.value);
  });
  other.addEventListener("keydown", (e) => e.key === "Enter" && use(other.value.trim()));
  other.addEventListener("blur", () => use(other.value.trim()));

  let calls = 0;
  async function showPlan(): Promise<void> {
    plan.replaceChildren(el("span", { className: "row-hint", textContent: "Reading model capabilities…" }));
    try {
      const res = await api<{ plan?: PlanInfo; error?: string; calibrationCalls?: number }>(`/api/profile?provider=${encodeURIComponent(current.provider)}&model=${encodeURIComponent(current.model)}`);
      calls = res.calibrationCalls ?? 0;
      plan.replaceChildren(res.plan ? el("div", {}, el("b", { textContent: describePlan(res.plan) }), el("div", { className: "row-hint", textContent: res.plan.reasons.join("; ") })) : el("span", { className: "row-hint", textContent: `Unavailable: ${res.error ?? "unknown model"}` }));
    } catch (err) {
      plan.replaceChildren(el("span", { className: "row-hint", textContent: (err as Error).message }));
    }
  }

  calibrate.addEventListener("click", async () => {
    const { provider: p, model } = current;
    if (!model) return;
    // Hosted providers bill per call; local runs are free.
    if (!providers.find((x) => x.id === p)?.local && !(await ask(`Calibration makes ${calls} calls to ${model} and spends tokens. Continue?`))) return;
    calibrate.disabled = true;
    let done = 0;
    try {
      const { url, token } = engine();
      const res = await fetch(`${url}/api/calibrate`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: p, model }) });
      for await (const msg of readSse(res.body!)) {
        const data = JSON.parse(msg.data);
        if (msg.event === "start") calibration.textContent = `Calibrating: 0/${data.calls} runs`;
        if (msg.event === "case") calibration.textContent = `Calibrating: ${++done}/${calls} runs`;
        if (msg.event === "done") {
          const results = data.calibration.results as { config: { generation: string; tier: string }; runs: number; complete: number }[];
          calibration.textContent = `Calibrated: ${results.map((r) => `${r.config.generation}/${r.config.tier} ${r.complete}/${r.runs} complete`).join(", ")}`;
          void showPlan();
        }
        if (msg.event === "error") calibration.textContent = `Calibration failed: ${data.message}`;
      }
    } catch (err) {
      calibration.textContent = `Calibration failed: ${(err as Error).message}`;
    } finally {
      calibrate.disabled = false;
    }
  });

  void fillModels(focus && focus !== current.provider ? "" : current.model);
  if (current.model) void showPlan();
  return [
    ...title("Models", "The model new messages go to. The picker under the message box switches between recent ones."),
    group(
      "Model",
      row("Provider", usable.length ? null : "Add a key in Providers, or start Ollama.", providerSel),
      el("div", { className: "row" }, el("div", { className: "row-text" }, el("div", { className: "row-label", textContent: "Model" }), status), el("div", { className: "row-control column" }, modelSel, other)),
    ),
    group("How vak asks this model", el("div", { className: "row stack" }, plan, el("div", { className: "row-actions" }, calibrate, calibration))),
  ];
}

// --- Providers ----------------------------------------------------------------
/** A network error from a local server means it is not running; say that, not "fetch failed". */
function problemText(p: ProviderInfo, error: string): string {
  const name = p.label.replace(/ \(local\)$/, "");
  if (p.local && /fetch failed|ECONNREFUSED|timed? ?out|abort/i.test(error)) return `${name} isn't running. Start it, or check its address.`;
  if (/401|403|unauthori[sz]ed|invalid.*key/i.test(error)) return `${name} rejected the key. Check it and save again.`;
  return `${name}: ${error}`;
}

async function providersPage(): Promise<HTMLElement[]> {
  const refresh = async () => {
    await loadProviders();
    window.dispatchEvent(new Event("vak:providers"));
    await show("providers");
  };
  const card = (p: ProviderInfo): HTMLElement => {
    const own = settings.filter((s) => s.owner === p.id && s.group !== "channel");
    const state = el("span", {});
    const choose = el("button", { type: "button", className: "link", textContent: "Choose a model →", hidden: true });
    choose.addEventListener("click", () => void show("models", p.id));
    const body = el("div", { className: "card-fields" }, ...own.map((s) => (s.secret ? secretField(s, refresh) : plainField(s, refresh))));
    // Only providers with a key (or a local server) are asked for their list.
    if (!p.available) state.replaceChildren(pill(p.keyVar ? "No key" : "Not set"));
    else {
      state.replaceChildren(pill("Checking…"));
      void listModels(p).then((r) => {
        if (r.error) state.replaceChildren(pill(p.local ? "Not running" : "Problem", "bad"));
        else {
          state.replaceChildren(pill(`${r.models.length} ${p.local ? "installed" : "models"}`, "ok"));
          choose.hidden = !r.models.length;
        }
        if (r.error) body.append(el("p", { className: "row-hint bad", textContent: problemText(p, r.error) }));
      });
    }
    return el("div", { className: "card" }, el("div", { className: "card-head" }, el("b", { textContent: p.label }), state, choose), body);
  };
  const local = providers.filter((p) => p.local);
  const custom = providers.filter((p) => p.id === "compatible");
  const labs = providers.filter((p) => !p.local && p.id !== "compatible");
  // Labs with a key first, so the ones in use are at the top.
  labs.sort((a, b) => Number(b.available) - Number(a.available));
  return [
    ...title("Providers", "Keys are kept in the macOS Keychain (elsewhere, a file only you can read) and are never shown again once saved."),
    el("section", { className: "group" }, el("h2", { textContent: "On this computer" }), ...local.map(card)),
    el("section", { className: "group" }, el("h2", { textContent: "Labs and hosts" }), ...labs.map(card)),
    el("section", { className: "group" }, el("h2", { textContent: "Any OpenAI-compatible server" }), ...custom.map(card)),
  ];
}

// --- Channels -----------------------------------------------------------------
function channelState(c: ChannelInfo): HTMLElement {
  if (!c.enabled) return pill("Off");
  if (c.state === "running") return pill("Running", "ok");
  if (c.state === "error") return pill("Problem", "bad");
  return pill(c.state === "starting" ? "Starting" : c.ready ? "Off" : "Needs token");
}

async function channelPage(id: string): Promise<HTMLElement[]> {
  const all = await api<ChannelInfo[]>("/api/channels");
  const c = all.find((x) => x.id === id)!;
  const state = el("span", {}, channelState(c));
  const detail = el("p", { className: "row-hint", textContent: c.enabled ? c.detail : "" });
  const put = (change: Partial<ChannelInfo>) => api<ChannelInfo[]>(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify(change) });
  const models = el("select", { "aria-label": "Model" }, el("option", { value: "", textContent: "Default local model" }), ...modelOptions());
  const chosen = c.provider && c.model ? JSON.stringify([c.provider, c.model]) : "";
  if (chosen && ![...models.options].some((o) => o.value === chosen)) models.append(el("option", { value: chosen, textContent: `${c.model} · ${labelOf(c.provider!)}` }));
  models.value = chosen;
  models.addEventListener("change", () => {
    const [provider, model] = parseChoice(models.value) ?? ["", ""];
    void put({ provider, model });
  });
  const tokens = settings.filter((s) => c.secrets.includes(s.name)).map((s) => secretField(s, () => show(`channel:${id}` as Section)));
  timer = setInterval(async () => {
    try {
      const fresh = (await api<ChannelInfo[]>("/api/channels")).find((x) => x.id === id)!;
      state.replaceChildren(channelState(fresh));
      detail.textContent = fresh.enabled ? fresh.detail : "";
    } catch {
      /* next tick */
    }
  }, 2000);
  return [
    ...title(c.label, "Answer on Telegram while vak runs in the background: the same interfaces, as rich messages with buttons and step-by-step forms."),
    group(
      null,
      row(`Answer on ${c.label}`, null, el("div", { className: "row-actions" }, state, toggle(c.enabled, async (on) => {
        await put({ enabled: on });
      }))),
      el("div", { className: "row stack" }, detail),
    ),
    group("Bot", el("div", { className: "row stack" }, ...tokens, el("p", { className: "row-hint", textContent: "Create a bot with @BotFather in Telegram and paste its token. Only one program can run a bot at a time: stop `npm run telegram` while this is on." }))),
    group("Answers with", row("Model", "A channel runs unattended, so it has its own model. Local models cost nothing per message.", models)),
  ];
}

async function comingPage(id: string, label: string): Promise<HTMLElement[]> {
  return [...title(label), group(null, el("div", { className: "row stack" }, pill("Coming"), el("p", { className: "row-hint", textContent: COMING[id] ?? "" })))];
}

// --- Appearance -----------------------------------------------------------------
function dot(color: string): HTMLElement {
  const i = el("i");
  i.style.background = color;
  return i;
}

async function appearancePage(): Promise<HTMLElement[]> {
  const a = appearance();
  const swatches = el("div", { className: "swatches", role: "radiogroup" });
  for (const [id, label, light, dark] of THEMES) {
    const b = el("button", { type: "button", className: "swatch", "aria-pressed": String(id === a.theme), title: label }, el("span", { className: "chip" }, dot(light), dot(dark)), label);
    b.addEventListener("click", () => {
      for (const x of swatches.children) x.setAttribute("aria-pressed", String(x === b));
      applyAppearance({ theme: id });
    });
    swatches.append(b);
  }
  return [
    ...title("Appearance"),
    group(
      null,
      row("Mode", "System follows your Mac's light or dark setting.", segmented(MODES, a.mode, (mode) => applyAppearance({ mode }))),
      el("div", { className: "row stack" }, el("div", { className: "row-label", textContent: "Theme" }), swatches),
      row("Text size", null, segmented(SIZES, a.size, (size) => applyAppearance({ size }))),
    ),
  ];
}

// --- Chats ----------------------------------------------------------------------
async function chatsPage(): Promise<HTMLElement[]> {
  const opt = (k: string, fallback: string) => prefs.get(`opt:${k}`) ?? fallback;
  const wipe = el("button", { type: "button", className: "danger small", textContent: "Delete all chats" });
  wipe.addEventListener("click", async () => {
    const taskSessions = new Set(parseTaskSummaries(await api<unknown>("/api/tasks")).map((t) => t.session));
    const list = (await api<{ id: string }[]>("/api/sessions")).filter((c) => !taskSessions.has(c.id));
    if (!list.length || !(await ask(`Delete all ${list.length} chats and their interfaces? This can't be undone.`, "Delete all"))) return;
    for (const c of list) await api(`/api/sessions/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    window.dispatchEvent(new CustomEvent("vak:chats-cleared", { detail: list.map((c) => c.id) }));
  });
  return [
    ...title("Chats"),
    group(
      "Conversation",
      row("Context sent to the model", "Long chats sent whole slow down small models and overflow their context. The full chat is always kept.", select([["10", "Last 10 turns"], ["6", "Last 6 turns"], ["20", "Last 20 turns"], ["0", "Whole chat"]], opt("history", "10"), (v) => prefs.set("opt:history", v))),
      row("Show engine notes", "What the engine repaired or sent back to the model, under each reply.", toggle(opt("notes", "false") === "true", (on) => {
        prefs.set("opt:notes", String(on));
        document.body.classList.toggle("notes", on);
      })),
    ),
    group("Stored chats", row("Delete all chats", "Removes ordinary chats and their interfaces. Task conversations are retained.", wipe)),
  ];
}

// --- General --------------------------------------------------------------------
async function generalPage(): Promise<HTMLElement[]> {
  const opt = (k: string, fallback: string) => prefs.get(`opt:${k}`) ?? fallback;
  const app = inTauri
    ? group(
        "App",
        row("Keep running when the window is closed", "vak stays in the menu bar so channels keep answering. Quit from the menu bar icon.", toggle(opt("keep-running", "true") !== "false", async (on) => {
          prefs.set("opt:keep-running", String(on));
          await setKeepRunning(on);
        })),
        row("Open at login", null, toggle(Boolean(await autostart().catch(() => false)), async (on) => void (await autostart(on)))),
      )
    : null;
  return [
    ...title("General"),
    app,
    group(
      "Model behaviour",
      row("Thinking", "Let local models think before answering (Ollama). Slower, sometimes better.", toggle(opt("think", "false") === "true", (on) => prefs.set("opt:think", String(on)))),
      row("Generation", "auto lets the capability plan decide.", select([["auto", "auto"], ["tools", "tools"], ["constrained", "constrained"]], opt("generation", "auto"), (v) => prefs.set("opt:generation", v))),
      row("Tool schema", null, select([["compact", "compact"], ["strict", "strict"]], opt("schema", "compact"), (v) => prefs.set("opt:schema", v))),
      row("Reasoning effort", "For models that take one.", select([["", "default"], ["low", "low"], ["medium", "medium"], ["high", "high"]], opt("effort", ""), (v) => prefs.set("opt:effort", v))),
    ),
  ].filter(Boolean) as HTMLElement[];
}

// --- About ----------------------------------------------------------------------
async function aboutPage(): Promise<HTMLElement[]> {
  const info = await api<Info>("/api/info").catch(() => undefined);
  const reveal = (path: string) => {
    const b = el("button", { type: "button", className: "ghost small", textContent: "Show in Finder" });
    b.addEventListener("click", () => void revealPath(path));
    return inTauri ? b : el("code", { textContent: path });
  };
  const keys = el("div", { className: "shortcuts" }, ...[
    ["⌘N", "New chat"],
    ["⌘,", "Settings"],
    ["⌘B / ⌘\\", "Show or hide the sidebar"],
    ["⌘⌥B", "Show or hide the canvas"],
    ["⌘⇧F", "Canvas full view / split view"],
    ["⌘⇧B", "Cycle canvas layouts"],
    ["Esc", "Stop a reply · close Settings or canvas"],
    ["⇧↩", "New line in a message"],
  ].map(([k, v]) => el("div", {}, el("kbd", { textContent: k! }), el("span", { textContent: v! }))));
  // Inside a block of its own, so it lines up with the page's column.
  const mark = el("div", { className: "about-mark" }, el("img", { src: "/icon.svg", alt: "", width: 72, height: 72 }));
  return [
    mark,
    ...title("About vak", "Ask any model, get an interface. A sibling of Vakyartha: same ink, ivory and saffron."),
    group(
      null,
      row("Version", null, el("span", { textContent: info?.version ?? "?" })),
      row("Engine", null, el("span", { textContent: info ? `Node ${info.node} · ${info.platform}` : "?" })),
      row("API keys stored in", null, el("span", { textContent: info?.keys ?? "?" })),
      info ? row("Data folder", inTauri ? info.dataDir : null, reveal(info.dataDir)) : null,
      info ? row("Engine log", inTauri ? info.logFile : null, reveal(info.logFile)) : null,
    ),
    group("Keyboard", el("div", { className: "row stack" }, keys)),
  ];
}

// --- wiring -----------------------------------------------------------------------
$<HTMLButtonElement>("settings-back").addEventListener("click", closeSettings);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOpen() && !document.querySelector("dialog[open]")) closeSettings();
});
