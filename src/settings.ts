import { vaultPresence, engineFetch } from "./backend.ts";
// Settings: a full page with a section sidebar. Every change applies as it is
// made (keys when you press Save next to them), so there is no page-wide Save.

import { readSse } from "@vak/core";
import { autostart, inTauri, openAdminConsole, revealPath, setKeepRunning } from "./backend.ts";
import { $, api, ask, el, engine, prefs } from "./core.ts";
import { choose, current, labelOf, listModels, loadProviders, modelOptions, modelsOf, parseChoice, type ProviderInfo, providers } from "./models.ts";
import { applyAppearance, appearance, MODES, SIZES, THEMES } from "./theme.ts";
import { icon } from "./icons.ts";
import { pagedNodes } from "./pagination.ts";
import { skillsPage } from "./skills-page.ts";
import { addOwnPage, integrationPage, marketplace } from "./integrations-page.ts";
import { disposeFinops, finopsPage } from "./finops-page.ts";
import { TASK_LIMITS, parseTaskSummaries } from "../shared/task-contract.ts";
import { loadVoices, voicePage, voiceSection, voiceSettingsPage } from "./voice/index.ts";
import { group, pill, plainField, row, secretField, segmented, select, type Setting, title, toggle } from "./ui.ts";
import { getDecisionConfig, saveDecisionConfig, type DecisionConfig } from "./decision/index.ts";
import { disposeMediaPage } from "./media-page.ts";
import { sandboxPage } from "./sandbox-page.ts";
import type { MediaProvider } from "../shared/media.ts";

interface ChannelInfo { id: string; label: string; enabled: boolean; provider?: string; model?: string; ready: boolean; secrets: string[]; needs: string[]; state: string; detail: string }
interface PlanInfo { generation: string; tier: string; examples: boolean; authoring?: string; maxSteps: number; reasons: string[] }
interface Info { version: string; node: string; platform: string; dataDir: string; logFile: string; keys: string }

type Section = "models" | "providers" | "integrations" | "skills" | "sandbox" | "integrations:add" | `integration:${string}` | "channel:telegram" | "channel:slack" | "channel:discord" | "voice" | `voice:${string}` | "appearance" | "chats" | "tasks" | "finops" | "general" | "about";

/** Channels whose listeners are not built yet: shown so the place is known, marked as coming. */
const COMING: Record<string, string> = {
  slack: "Slack answers in a workspace through Socket Mode, so no public URL is needed. The Block Kit projector and modal forms are built (@vak/slack); the listener is next.",
  discord: "Discord answers in servers and DMs through the Gateway. The Components V2 projector and paged modal forms are built (@vak/discord); the listener is next.",
};

/** Section, label, icon, and its group, in the order things are usually set up. */
const NAV: [Section, string, string, string?][] = [
  ["models", "Models", "cpu", "Models"],
  ["providers", "Providers", "key", "Models"],
  ["integrations", "Integrations", "plug", "Capabilities"],
  ["skills", "Skills", "spark", "Capabilities"],
  ["sandbox", "Sandbox", "shield", "Capabilities"],
  ["channel:telegram", "Telegram", "send", "Channels"],
  ["channel:slack", "Slack", "bubble", "Channels"],
  ["channel:discord", "Discord", "bubble", "Channels"],
  ["tasks", "Work & schedule", "calendar", "Work"],
  ["chats", "Chats", "bubble", "Work"],
  ["finops", "FinOps", "chart", "Work"],
  ["general", "General", "sliders", "App"],
  ["appearance", "Appearance", "palette", "App"],
  ["voice", "Voice", "voice", "App"],
  ["about", "About", "info"],
];

const page = () => $<HTMLElement>("settings");
const content = () => $<HTMLElement>("settings-content");
let section: Section = (prefs.get("settings:section") as Section | null) ?? "models";
let settings: Setting[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
window.addEventListener("vak:media-providers", () => void show("providers"));

export function settingsOpen(): boolean {
  return !page().hidden;
}

export async function openSettings(to?: Section, arg?: string): Promise<void> {
  page().hidden = false;
  document.body.classList.add("in-settings");
  window.dispatchEvent(new Event("vak:settings-opened"));
  await show(to ?? section, arg);
}

export function closeSettings(): void {
  disposeMediaPage();
  disposeFinops();
  clearInterval(timer);
  page().hidden = true;
  document.body.classList.remove("in-settings");
  const ws = document.getElementById("workspace");
  if (ws && !document.querySelector(".artifacts-page:not([hidden]), .apps-page:not([hidden]), .schedule-page:not([hidden]), .skills-studio-page:not([hidden])")) {
    ws.hidden = false;
  }
  window.dispatchEvent(new Event("vak:settings-closed"));
}

/** Where an opened provider page was reached from, so Back and the sidebar follow the person. */
let providerOrigin: Section = "providers";

function nav(): void {
  const list = $<HTMLElement>("settings-nav-list");
  list.replaceChildren();
  let heading: string | undefined;
  for (const [id, label, glyph, sub] of NAV) {
    if (sub !== heading) list.append(sub ? el("div", { className: "nav-group", textContent: sub }) : el("div", { className: "nav-gap" }));
    heading = sub;
    const soon = id.startsWith("channel:") && COMING[id.slice(8)];
    const current = id === section || (id === "integrations" && section.startsWith("integration")) || (id === providerOrigin && section.startsWith("voice:"));
    const b = el("button", { type: "button", className: "nav-item", "aria-current": String(current) }, el("span", { className: "nav-label" }, icon(glyph, 16), label), soon ? el("span", { className: "soon", textContent: "soon" }) : null);
    b.addEventListener("click", () => void show(id));
    list.append(b);
  }
}

async function show(to: Section, arg?: string): Promise<void> {
  disposeMediaPage();
  disposeFinops();
  clearInterval(timer);
  if (to.startsWith("voice:") && arg) providerOrigin = arg as Section;
  else if (!to.startsWith("voice:")) providerOrigin = "providers";
  section = to;
  prefs.set("settings:section", to);
  nav();
  content().replaceChildren(el("p", { className: "row-hint", role: "status", textContent: "Loading settings…" }));
  try {
    settings = await api<Setting[]>("/api/settings");
    if (inTauri) {
      const presence = await vaultPresence(settings.filter((setting) => setting.secret).map((setting) => setting.name));
      settings = settings.map((setting) => setting.secret ? { ...setting, set: presence[setting.name] === true } : setting);
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ presence }) }).catch(() => {});
    }
    const integration = to.startsWith("integration:") ? to.slice("integration:".length) : undefined;
    const render: Record<string, () => Promise<HTMLElement[]>> = {
      integrations: async () => marketplace((id) => void show(`integration:${id}`), () => void show("integrations:add")),
      skills: () => skillsPage(arg, () => void show("sandbox")),
      sandbox: async () => sandboxPage(() => void show("integration:sandbox-execution"), () => void show("skills", "sandbox")),
      voice: () => voiceSettingsPage((id) => void show(`voice:${id}`, "voice")),
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
        group("Execution", row("Availability", "Work continues while you switch views or hide the window. Keep the app running and the computer awake. Interrupted work requires review before continuation.", el("span")), row("Per-run limits", `${TASK_LIMITS.rounds} model requests, ${TASK_LIMITS.tools} tool calls and ${TASK_LIMITS.activeMs / 60000} active minutes. Approval waiting has its own five-minute expiry. Each task also has shared run/request/tool/time limits; continuations and restarts do not reset them.`, el("span"))),
        group("Access and results", row("Capabilities", "Select ready, free capabilities per task. Configure access in Integrations; no capability is installed or enabled automatically.", el("button", { type: "button", className: "ghost small", textContent: "Open Integrations", onclick: () => void show("integrations") })), row("Review", "A generated interface does not prove that an external action happened. Check the criteria and any operation receipts before marking a task complete.", el("span"))),
      ],
      finops: finopsPage,
      general: generalPage,
      about: aboutPage,
    };
    const voiceId = to.startsWith("voice:") ? to.slice("voice:".length) : undefined;
    const parts = voiceId ? await voicePage(voiceId, settings, { label: providerOrigin === "voice" ? "Voice" : "All providers", go: () => void show(providerOrigin) }, () => void show(to, providerOrigin), () => void show("voice")) : integration ? await integrationPage(integration, () => void show("integrations"), () => void show(to)) : await (render[to] ?? render.models!)();
    if (section !== to) return;
    content().replaceChildren(...parts);
    content().scrollTop = 0;
  } catch (error) {
    if (section !== to) return;
    content().replaceChildren(...title("Settings unavailable", "Your settings could not be loaded."), el("p", { className: "settings-feedback bad", role: "alert", textContent: (error as Error).message }), el("button", { type: "button", className: "primary small", textContent: "Try again", onclick: () => void show(to, arg) }));
  }
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
      updateLimits();
      void fillModels(prefs.get(`model:${v}`) ?? providers.find((p) => p.id === v)?.defaultModel ?? "").then(() => {
        // A preselected local model is already displayed, so choosing it again
        // does not fire change. Commit the visible choice when switching providers.
        if (provider === v && modelSel.value && modelSel.value !== OTHER) use(modelSel.value);
      });
    },
  );
  for (const o of providerSel.options) o.disabled = !usable.some((p) => p.id === o.value);
  const modelSel = el("select", { "aria-label": "Model" });
  const modelSearch = el("input", { type: "search", placeholder: "Search models…", "aria-label": "Search models", disabled: true });
  const modelMatches = el("span", { className: "row-hint", role: "status" });
  let offeredModels: string[] = [];
  const other = el("input", { type: "text", className: "wide", placeholder: "Type a model id", spellcheck: false, hidden: true, "aria-label": "Model id" });
  const status = el("p", { className: "row-hint" });
  const plan = el("div", { className: "plan" });
  const calibrate = el("button", { type: "button", className: "ghost small", textContent: "Calibrate" });
  const calibration = el("p", { className: "row-hint" });
  const OTHER = "__other";
  const limitsGroup = el("div", { className: "group" });
  function updateLimits(): void {
    const pLabel = providers.find((p) => p.id === provider)?.label ?? provider;
    limitsGroup.replaceChildren(
      el("div", { className: "group-title", textContent: `Execution limits (${pLabel})` }),
      row("Step limit", "Bounds non-tool rounds (answers, canvas authoring, repair).", select([["", "Inherit general setting"], ["6", "6 steps"], ["8", "8 steps"], ["12", "12 steps"], ["16", "16 steps"], ["24", "24 steps"], ["32", "32 steps"], ["unlimited", "Unlimited (run until completed)"]], prefs.get(`opt:${provider}:maxSteps`) ?? "", (v) => v ? prefs.set(`opt:${provider}:maxSteps`, v) : prefs.remove(`opt:${provider}:maxSteps`))),
      row("Tool budget", "Bounds external MCP tool rounds per turn.", select([["", "Inherit general setting"], ["6", "6 rounds"], ["10", "10 rounds"], ["12", "12 rounds"], ["16", "16 rounds"], ["24", "24 rounds"], ["unlimited", "Unlimited (no tool limit)"]], prefs.get(`opt:${provider}:toolRounds`) ?? "", (v) => v ? prefs.set(`opt:${provider}:toolRounds`, v) : prefs.remove(`opt:${provider}:toolRounds`))),
    );
  }
  updateLimits();

  const use = (model: string) => {
    if (!model) return;
    choose(provider, model);
    void showPlan();
  };

  function filterModels(want: string): void {
    const query = modelSearch.value.toLowerCase().trim();
    const matches = offeredModels.filter(name => name.toLowerCase().includes(query));
    const visible = want && want !== OTHER && offeredModels.includes(want) && !matches.includes(want) ? [want, ...matches] : matches;
    modelSel.replaceChildren(el("option", { value: "", textContent: "Choose a model…" }), ...visible.map(m => el("option", { value: m, textContent: m })), el("option", { value: OTHER, textContent: "Other (type a model id)…" }));
    modelSel.value = offeredModels.includes(want) ? want : want ? OTHER : "";
    modelMatches.textContent = query ? `${matches.length} matching models${visible.length > matches.length ? " · current selection retained" : ""}` : "";
  }
  modelSearch.oninput = () => filterModels(modelSel.value);

  async function fillModels(want: string): Promise<void> {
    const p = providers.find((x) => x.id === provider);
    modelSel.replaceChildren(el("option", { value: "", textContent: "Loading models…" }));
    modelSel.disabled = true;
    status.className = "row-hint";
    status.textContent = "";
    const cached = p ? modelsOf.get(p.id) : undefined;
    const res = cached && cached.length > 0
      ? { models: cached }
      : p?.available
        ? await listModels(p)
        : { models: [] as string[], error: "add its key in Providers" };
    if (p?.id !== provider) return;
    // No pre-selection from the list: it is alphabetical and often starts with
    // models that cannot chat (OpenAI lists babbage-002 first).
    offeredModels = res.models; modelSearch.value = ""; modelSearch.disabled = false; filterModels(want);
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
      const res = await engineFetch(`${url}/api/calibrate`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: p, model }) });
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

  const decisionGroup = el("div", { className: "group" });
  function updateDecisionUi(): void {
    const cfg = getDecisionConfig();
    const providerOptions: [string, string][] = [
      ["ollama", "Local Ollama"],
      ["typesafe", "TypeSafe AI"],
      ["openai", "OpenAI"],
      ["openrouter", "OpenRouter"],
      ["heuristic", "Built-in Fast Heuristics (0ms)"],
    ];

    const detected = modelsOf.get(cfg.providerId) ?? [];
    let modelOptionsList: [string, string][] = detected.map((m) => [m, m]);

    if (cfg.modelId && !modelOptionsList.some(([v]) => v === cfg.modelId)) {
      modelOptionsList.unshift([cfg.modelId, cfg.modelId]);
    }

    const activeProvider = providers.find((p) => p.id === cfg.providerId);
    if (activeProvider && activeProvider.available && detected.length === 0) {
      void listModels(activeProvider).then((res) => {
        if (res.models.length > 0 && cfg.providerId === getDecisionConfig().providerId) {
          updateDecisionUi();
        }
      });
    }

    const providerSelect = select(providerOptions, cfg.providerId, (v) => {
      saveDecisionConfig({ providerId: v as DecisionConfig["providerId"] });
      updateDecisionUi();
    });

    const modelSelect = select(modelOptionsList, cfg.modelId, (v) => {
      saveDecisionConfig({ modelId: v });
    });

    decisionGroup.replaceChildren(
      el("div", { className: "group-title", textContent: "Decision & Turn Optimization" }),
      row(
        "Dynamic turn shaping",
        "Uses local decision models to classify intent and strip unneeded context, tools, and grammar on greetings and casual turns.",
        toggle(cfg.enabled, (on) => {
          saveDecisionConfig({ enabled: on });
          updateDecisionUi();
        }),
      ),
      ...(cfg.enabled
        ? [
            row("Decision provider", "Engine used to score user intent in milliseconds.", providerSelect),
            ...(cfg.providerId !== "heuristic" ? [row("Decision model", cfg.providerId === "ollama" ? "Installed local model with decision capabilities." : cfg.providerId === "openai" ? "Fast OpenAI model using strict structured outputs." : "Hosted decision model on OpenRouter.", modelSelect)] : []),
            row(
              "Prune MCP tools",
              "Strip external tool schemas when no tools are needed, keeping the primary model focused.",
              toggle(cfg.pruneTools, (on) => saveDecisionConfig({ pruneTools: on })),
            ),
            row(
              "Strip greeting history",
              "Omit past conversation turns on simple salutations ('Hi', 'Thanks') to drop token count from ~15k to ~50.",
              toggle(cfg.stripSalutations, (on) => saveDecisionConfig({ stripSalutations: on })),
            ),
            row(
              "Context assembly optimization",
              "Shape multi-turn context dynamically based on turn intent rather than sending a static last-N turns sliding window.",
              toggle(cfg.optimizeContext, (on) => saveDecisionConfig({ optimizeContext: on })),
            ),
          ]
        : []),
    );
  }
  updateDecisionUi();

  void fillModels(focus && focus !== current.provider ? "" : current.model);
  if (current.model) void showPlan();
  return [
    ...title("Models", "Choose the model for new messages."),
    group(
      "Model",
      row("Provider", usable.length ? null : "Add a key in Providers, or start Ollama.", providerSel),
      el("div", { className: "row" }, el("div", { className: "row-text" }, el("div", { className: "row-label", textContent: "Model" }), status), el("div", { className: "row-control column" }, modelSearch, modelMatches, modelSel, other)),
    ),
    group("How vak asks this model", el("div", { className: "row stack" }, plan, el("div", { className: "row-actions" }, calibrate, calibration))),
    limitsGroup,
    decisionGroup,
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
  const voiceProviders = await loadVoices(true).catch(() => []);
  const voiceSetup = (id: string) => el("button", { type: "button", className: "link", textContent: "Voice setup", onclick: () => void show(`voice:${id}`) });
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
    return el("details", { className: "provider-row" },
      el("summary", {}, el("span", { className: "provider-name", textContent: p.label }), state),
      body,
      el("div", { className: "provider-actions" }, choose, voiceProviders.some((v) => v.id === p.id) ? voiceSetup(p.id) : null),
    );
  };
  const local = providers.filter((p) => p.local);
  const custom = providers.filter((p) => p.id === "compatible");
  const labs = providers.filter((p) => !p.local && p.id !== "compatible");
  // Labs with a key first, so the ones in use are at the top.
  labs.sort((a, b) => Number(b.available) - Number(a.available));
  const media = (await api<MediaProvider[]>("/api/media/providers")).filter((p) => !providers.some((chat) => chat.id === p.id));
  return [
    ...title("Providers", "Manage connections and keys. Choose models in Models and speech settings in Voice."),
    el("section", { className: "group" }, el("h2", { textContent: "On this computer" }), pagedNodes(local.map(card), "Local providers", true)),
    el("section", { className: "group" }, el("h2", { textContent: "Labs and hosts" }), pagedNodes(labs.filter((p) => p.available).map(card), "Connected providers", true),
      el("details", { className: "provider-more" }, el("summary", { textContent: "More providers" }), pagedNodes(labs.filter((p) => !p.available).map(card), "More providers", true))),
    el("section", { className: "group" }, el("h2", { textContent: "Media and voice" }), ...media.map((p) => el("details", { className: "provider-row" },
      el("summary", {}, el("span", { className: "provider-name", textContent: p.label }), pill(p.available ? "Key saved" : "Needs key", p.available ? "ok" : "")),
      el("div", { className: "card-fields" }, ...settings.filter((s) => s.name === p.keyVar).map((s) => secretField(s, refresh))),
      voiceProviders.some((v) => v.id === p.id) ? el("div", { className: "provider-actions" }, voiceSetup(p.id)) : null))),
    ...await voiceSection((id) => void show(`voice:${id}`), [...providers.map((p) => p.id), ...media.map((p) => p.id)]),
    el("section", { className: "group" }, el("h2", { textContent: "Any OpenAI-compatible server" }), pagedNodes(custom.map(card), "Custom providers", true)),
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
      "Mini-Cloud Platform",
      row(
        "Admin & Observability Console",
        "Inspect sandboxed worker pool slots, real-time memory RSS gauges, streaming logs, and hosted dynamic applications.",
        el("button", {
          type: "button",
          className: "primary small",
          textContent: "Open Console",
          onclick: () => void openAdminConsole(),
        })
      )
    ),
    group(
      "Model behaviour",
      row("Thinking", "Let local models think before answering (Ollama). Slower, sometimes better.", toggle(opt("think", "false") === "true", (on) => prefs.set("opt:think", String(on)))),
      row("Generation", "auto lets the capability plan decide.", select([["auto", "auto"], ["tools", "tools"], ["constrained", "constrained"]], opt("generation", "auto"), (v) => prefs.set("opt:generation", v))),
      row("Reasoning effort", "For models that take one.", select([["", "default"], ["low", "low"], ["medium", "medium"], ["high", "high"]], opt("effort", ""), (v) => prefs.set("opt:effort", v))),
      row("Step limit", "Default step limit across all providers. Bounds answers, canvas authoring and repairs. Auto uses the model capability plan (8–12 steps).", select([["0", "Auto (Plan default)"], ["6", "6 steps"], ["8", "8 steps"], ["12", "12 steps"], ["16", "16 steps"], ["24", "24 steps"], ["32", "32 steps"], ["unlimited", "Unlimited (run until completed)"]], opt("maxSteps", "0"), (v) => prefs.set("opt:maxSteps", v))),
      row("Tool budget", "Default tool budget across all providers. Bounds external MCP tool calls per turn. Auto uses 12 rounds.", select([["0", "Auto (12 rounds)"], ["6", "6 rounds"], ["10", "10 rounds"], ["12", "12 rounds"], ["16", "16 rounds"], ["24", "24 rounds"], ["unlimited", "Unlimited (no tool limit)"]], opt("toolRounds", "0"), (v) => prefs.set("opt:toolRounds", v))),
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
    ...title("About Vakyartha", "Ask any model, get an interface."),
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
