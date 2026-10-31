// Voice in Integrations (a card per voice provider, and its page: key, local
// voice packs, model and voice with a preview) and Settings → Voice (how
// reading aloud behaves). Choosing a voice is per window, like the theme.

import { api, el } from "../core.ts";
import { openExternal } from "../backend.ts";
import { tile } from "../icons.ts";
import { group, pill, row, secretField, segmented, select, type Setting, title, toggle } from "../ui.ts";
import { cancelDictation, dictationLanguage, dictationPrefs, systemDictation } from "./dictation.ts";
import { voiceMaster } from "./master.ts";
import { conversationPrefs, stopConversation } from "./conversation.ts";
import { type VoiceOption, lastError, loadVoices, readAloud, resolveChoice, SPEEDS, stopReading, voicePrefs, voiceState, type VoiceChoice, type VoiceProvider } from "./read-aloud.ts";

const inUse = (p: VoiceProvider) =>
  (voicePrefs.choice?.provider === p.id && p.models.some((m) => m.id === voicePrefs.choice?.model && m.voices.some((v) => v.id === voicePrefs.choice?.voice))) ||
  (dictationPrefs.choice?.provider === p.id && Boolean(p.stt?.some((m) => m.id === dictationPrefs.choice?.model)));

function status(p: VoiceProvider): HTMLElement {
  if (inUse(p)) return pill("In use", "ok");
  return p.available ? pill("Ready") : pill("Needs setup", "bad");
}

const sample = (voice: string) => `Hello, this is ${voice}. This is how replies will sound when Vakyartha reads them aloud.`;
const voiceName = (name: string) => /^[a-z]+(?:-[a-z]+)+$/.test(name) ? name.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ") : name;

/** A play button that turns into stop while its own sample is reading. */
function previewButton(text: () => string, choice: () => VoiceChoice | undefined, note: HTMLElement): HTMLButtonElement {
  const b = el("button", { type: "button", className: "ghost small", textContent: "Preview" });
  const paint = () => {
    const s = voiceState();
    b.textContent = s.target === b ? (s.state === "loading" ? "Loading…" : "Stop") : "Preview";
  };
  window.addEventListener("vak:voice", paint);
  b.addEventListener("click", async () => {
    if (voiceState().target === b) return stopReading();
    const c = choice();
    if (!c) return;
    note.textContent = "";
    await readAloud(text(), b, c);
    note.textContent = lastError;
    if (!b.isConnected) window.removeEventListener("vak:voice", paint);
  });
  return b;
}

/** A model's own controls: a style line with presets, or a 0–1 slider. */
function optionControl(o: VoiceOption, value: string | number | undefined, onChange: (v: string | number | undefined) => void): HTMLElement {
  if (o.kind === "text") {
    const listId = `voice-presets-${o.id}`;
    const input = el("input", { type: "text", maxLength: o.max, value: typeof value === "string" ? value : "", placeholder: o.presets[0] ?? "", "aria-label": o.label });
    input.setAttribute("list", listId);
    input.addEventListener("change", () => onChange(input.value.replace(/\s+/g, " ").trim() || undefined));
    return el("span", { className: "voice-style" }, input, el("datalist", { id: listId }, ...o.presets.map((p) => el("option", { value: p }))));
  }
  const n = typeof value === "number" ? value : o.default;
  const range = el("input", { type: "range", min: String(o.min), max: String(o.max), step: String(o.step), value: String(n), "aria-label": o.label });
  const shown = el("span", { className: "mono voice-value", textContent: n.toFixed(2) });
  range.addEventListener("input", () => { shown.textContent = Number(range.value).toFixed(2); });
  range.addEventListener("change", () => onChange(Number(range.value)));
  return el("span", { className: "row-actions" }, range, shown);
}

/** Setup for providers without a connection card elsewhere on Providers. */
export async function voiceSection(open: (id: string) => void, exclude: string[] = []): Promise<HTMLElement[]> {
  const list = (await loadVoices().catch(() => [] as VoiceProvider[])).filter((p) => !exclude.includes(p.id));
  if (!list.length) return [];
  return [el("section", { className: "group" }, el("h2", { textContent: "Voice providers" }), ...list.map((p) =>
    el("details", { className: "provider-row" },
      el("summary", {}, el("span", { className: "provider-name", textContent: p.label }), status(p)),
      el("p", { className: "row-hint", textContent: p.summary }),
      el("div", { className: "provider-actions" }, el("button", { type: "button", className: "link", textContent: "Voice setup", onclick: () => open(p.id) })),
    )))];
}

/** What a provider offers, as one line: its read-aloud and dictation model counts. */
function offers(p: VoiceProvider): string {
  const parts = [p.models.length ? `${plural(p.models.length, "read-aloud model")}` : "", p.stt?.length ? `${plural(p.stt.length, "dictation model")}` : ""].filter(Boolean);
  return parts.join(" · ") || "No models yet";
}

/** One provider's page, the same for every provider: state, setup, downloads, then what it offers. */
export async function voicePage(id: string, settings: Setting[], back: { label: string; go: () => void }, reload: () => void, openVoiceSettings: () => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true);
  const p = list.find((x) => x.id === id);
  if (!p) return [...title("Not found")];
  const note = el("p", { className: "row-hint bad", role: "status" });
  const backLink = el("button", { type: "button", className: "link", textContent: `‹ ${back.label}` });
  backLink.addEventListener("click", back.go);
  const head = el("div", { className: "int-head" }, tile(p.icon, 56), el("div", {}, el("h1", { textContent: p.label }), el("div", { className: "int-meta" }, el("span", { textContent: p.publisher }), pill(p.local ? "On this Mac" : "Hosted"), status(p))));
  const parts: HTMLElement[] = [backLink, head, el("p", { className: "lead", textContent: p.description })];

  const refresh = el("button", { type: "button", className: "ghost small", textContent: "Check again" });
  refresh.addEventListener("click", () => { stopReading(); reload(); });
  const state = p.available ? row("Ready", `${p.cost} · ${offers(p)}`, refresh) : row("Not ready yet", p.reason ?? "Finish setup below.", refresh);
  const keySetting = p.keyVar ? settings.find((s) => s.name === p.keyVar) : undefined;
  parts.push(group("Status", state, keySetting ? row(keySetting.label, keySetting.group === "voice" ? "Stored in this computer's credential vault." : "Shared with this provider's chat models.", secretField(keySetting, reload)) : null));

  const packs = p.packs ?? [];
  if (packs.length) {
    const rows = packs.map((pack) => {
      if (pack.installed) return row(pack.label, `${pack.size} · ${pack.license}`, pill("Installed", "ok"));
      const b = el("button", { type: "button", className: p.available ? "ghost small" : "primary small", textContent: `Install · ${pack.size}` });
      b.addEventListener("click", () => {
        b.disabled = true;
        b.textContent = "Installing…";
        note.textContent = "";
        api("/api/voice/install", { method: "POST", body: JSON.stringify({ provider: p.id, pack: pack.id }) }).then(reload, (err: Error) => {
          note.textContent = err.message;
          b.disabled = false;
          b.textContent = `Install · ${pack.size}`;
        });
      });
      return row(pack.label, `${pack.license}${pack.languages ? ` · ${pack.languages.length === 1 ? "one language" : plural(pack.languages.length, "language")}` : ""}`, b);
    });
    parts.push(group(!p.available ? "Download to get started" : packs.every((pack) => pack.installed) ? "Downloads" : "More to download", ...rows));
  }

  if (p.getModel) {
    const { catalog, example } = p.getModel;
    const name = el("input", { type: "text", placeholder: example, spellcheck: false, autocomplete: "off", "aria-label": "Model name" });
    const get = el("button", { type: "button", className: p.available ? "ghost small" : "primary small", textContent: "Download", disabled: true });
    name.addEventListener("input", () => { get.disabled = !name.value.trim(); });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter" && !get.disabled) get.click(); });
    get.addEventListener("click", () => {
      get.disabled = name.disabled = true;
      get.textContent = "Downloading…";
      note.textContent = "";
      api("/api/voice/install", { method: "POST", body: JSON.stringify({ provider: p.id, pack: name.value }) }).then(reload, (err: Error) => {
        note.textContent = err.message;
        get.disabled = name.disabled = false;
        get.textContent = "Download";
      });
    });
    const browse = el("button", { type: "button", className: "link", textContent: `Browse ${p.label}'s voice models` });
    browse.addEventListener("click", () => void openExternal(catalog));
    parts.push(group("Get a model",
      row("Model name", "Speech models read aloud; audio models take dictation.", el("span", { className: "row-actions" }, name, get)),
      el("div", { className: "row" }, el("span", { className: "row-hint" }, "Copy a name from the catalog. ", browse)),
    ));
  }

  const modelRows = [
    ...p.models.map((m) => row(m.label, ["Reads aloud", plural(m.voices.length, "voice"), m.note].filter(Boolean).join(" · "), m.id === voicePrefs.choice?.model && p.id === voicePrefs.choice?.provider ? pill("In use", "ok") : undefined)),
    ...(p.stt ?? []).map((m) => row(m.label, ["Dictation", m.languages ? plural(m.languages.length, "language") : "Any language"].join(" · "), m.id === dictationPrefs.choice?.model && p.id === dictationPrefs.choice?.provider ? pill("In use", "ok") : undefined)),
  ];
  if (modelRows.length) {
    const choose = el("button", { type: "button", className: "ghost small", textContent: "Choose in Voice settings" });
    choose.addEventListener("click", openVoiceSettings);
    parts.push(group("Models", ...modelRows, row("Which model reads and listens", "Picked in Settings → Voice, across all providers.", choose)));
  }
  parts.push(note);
  return parts;
}

/** Choices grouped by where they run, as each provider reports it. */
const ON_THIS_MAC = "On this Mac · free";
function byPlace<T>(list: VoiceProvider[], entries: (p: VoiceProvider) => T[]): { label: string; options: T[] }[] {
  return [
    { label: ON_THIS_MAC, options: list.filter((p) => p.local).flatMap(entries) },
    { label: "Hosted · paid", options: list.filter((p) => !p.local).flatMap(entries) },
  ].filter((g) => g.options.length);
}

const choiceLabel = (model: string, p: VoiceProvider) => model === p.label ? model : `${model} · ${p.label}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where a provider that is not ready gets set up: the first local one, else the first listed. */
const setupTarget = (list: VoiceProvider[]) => (list.find((p) => p.local && !p.available) ?? list.find((p) => !p.available) ?? list[0])?.id;

/** One read-aloud choice across providers; every change applies at once. */
function readAloudGroup(list: VoiceProvider[], openProvider: (id: string) => void): HTMLElement[] {
  const ready = list.filter((p) => p.available && p.models.some((m) => m.voices.length));
  const initial = resolveChoice(ready);
  const target = setupTarget(list);
  if (!initial) return [group("Read aloud", row("No voice is ready", "Set up a voice source below, then come back here.", target ? el("button", { type: "button", className: "ghost small", textContent: "Set up a voice", onclick: () => openProvider(target) }) : undefined))];
  let c: VoiceChoice = initial;
  if (JSON.stringify(voicePrefs.choice) !== JSON.stringify(c)) voicePrefs.choice = c;
  const provider = () => ready.find((p) => p.id === c.provider)!;
  const model = () => provider().models.find((m) => m.id === c.model)!;
  const note = el("p", { className: "row-hint bad" });
  const voiceBox = el("span", { className: "voice-choice" });
  const optionRows = el("div", { className: "voice-options" });
  const modelRow = row("Model", " ");
  const modelHint = modelRow.querySelector<HTMLElement>(".row-hint")!;
  const caution = el("div", { className: "row-hint caution" });
  modelHint.after(caution);
  const apply = (next: VoiceChoice) => { c = next; voicePrefs.choice = c; };
  const paintModel = () => {
    const m = model();
    const languages = m.languages ? (m.languages.length <= 3 ? m.languages.map((l) => new Intl.DisplayNames(undefined, { type: "language" }).of(l) ?? l).join(", ") : plural(m.languages.length, "language")) : "";
    modelHint.textContent = [provider().cost, plural(m.voices.length, "voice"), languages].filter(Boolean).join(" · ");
    caution.textContent = m.note ?? "";
    caution.hidden = !m.note;
    const voiceSelect = select(m.voices.map((v) => [v.id, voiceName(v.name)] as const), c.voice, (v) => { stopReading(); apply({ ...c, voice: v }); });
    voiceSelect.setAttribute("aria-label", "Read-aloud voice");
    voiceBox.replaceChildren(voiceSelect);
    const opts = m.options ?? [];
    // Keep only values this model declares, of the kind it declares (a style line is text, a setting a number).
    const kept = Object.fromEntries(opts.flatMap((o) => { const v = c.options?.[o.id]; return v !== undefined && typeof v === (o.kind === "text" ? "string" : "number") ? [[o.id, v]] : []; }));
    apply({ ...c, options: Object.keys(kept).length ? kept : undefined });
    optionRows.replaceChildren(...opts.map((o) => row(o.label, o.hint, optionControl(o, c.options?.[o.id], (v) => {
      const next = { ...c.options };
      if (v === undefined) delete next[o.id];
      else next[o.id] = v;
      apply({ ...c, options: Object.keys(next).length ? next : undefined });
    }))));
    optionRows.hidden = !opts.length;
  };
  const key = (p: string, m: string) => JSON.stringify({ provider: p, model: m });
  const modelSelect = select(byPlace(ready, (p) => p.models.filter((m) => m.voices.length).map((m) => [key(p.id, m.id), choiceLabel(m.label, p)] as const)), key(c.provider, c.model), (value) => {
    stopReading();
    const next = JSON.parse(value) as { provider: string; model: string };
    const m = ready.find((p) => p.id === next.provider)!.models.find((m) => m.id === next.model)!;
    apply({ ...next, voice: m.voices.find((v) => v.id === c.voice)?.id ?? m.voices[0]!.id, options: c.options });
    paintModel();
  });
  modelSelect.setAttribute("aria-label", "Read-aloud model");
  modelRow.querySelector(".row-control")!.append(modelSelect);
  paintModel();
  const preview = previewButton(() => sample(voiceName(model().voices.find((v) => v.id === c.voice)?.name ?? "your voice")), () => c, note);
  return [group(
    "Read aloud",
    modelRow,
    row("Voice", null, el("span", { className: "row-actions voice-preview" }, voiceBox, preview)),
    optionRows,
  ), note];
}

/** Every voice source with its state; one not ready says why and opens its setup. */
function sourcesGroup(list: VoiceProvider[], openProvider: (id: string) => void): HTMLElement {
  const uses = (p: VoiceProvider) => [p.models.length ? "read aloud" : "", p.stt?.length ? "dictation" : ""].filter(Boolean).join(" and ");
  return group("Voice sources", ...list.map((p) => {
    const hint = p.available ? `${p.local ? "On this Mac" : "Hosted"} · ${uses(p) || "ready"}` : p.reason ?? p.summary;
    return row(p.label, hint, el("span", { className: "row-actions" }, status(p), el("button", { type: "button", className: "ghost small", textContent: p.available ? "Manage" : "Set up", onclick: () => openProvider(p.id) })));
  }));
}

/** Turning voice off stops anything speaking or listening at once. */
export function setVoiceOn(on: boolean): void {
  if (!on) {
    stopReading();
    cancelDictation();
    stopConversation();
  }
  voiceMaster.on = on;
}

/** Settings → Voice: whether and how replies are read; read aloud, dictation and conversation choices live here. */
export async function voiceSettingsPage(openProvider: (id: string) => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true).catch(() => [] as VoiceProvider[]);
  const rest = el("div", { hidden: !voiceMaster.on });
  rest.append(
    ...readAloudGroup(list, openProvider),
    group(
      "Playback",
      row("Read-aloud button", "Show a speaker on each reply. Right-click a reply for the same.", toggle(voicePrefs.own, (on) => { voicePrefs.enabled = on; })),
      row("Read new replies automatically", "Only while the chat is open. Hosted voices charge for every reply read.", toggle(voicePrefs.auto, (on) => { voicePrefs.auto = on; })),
      row("Speed", null, segmented(SPEEDS, voicePrefs.speed as (typeof SPEEDS)[number][0], (s) => { voicePrefs.speed = s; })),
    ),
    dictationGroup(list, openProvider),
    group(
      "Conversation",
      row("Conversation button", "Talk and listen without touching anything: ⌘⇧D or the waves in the message box. Replies are read aloud; speak over one to stop it. Say \"stop listening\" or press Esc to end. Uses the dictation model and the current voice.", toggle(conversationPrefs.own, (on) => { conversationPrefs.enabled = on; })),
    ),
    sourcesGroup(list, openProvider),
  );
  return [
    ...title("Voice", "Hear replies read aloud and dictate messages. On this Mac it is free; a hosted provider receives the text or recording and bills for it."),
    group("Voice", row("Use voice", "Off: no microphone, nothing read aloud and nothing sent to a voice provider. Your settings below are kept.", toggle(voiceMaster.on, (on) => { setVoiceOn(on); rest.hidden = !on; }))),
    rest,
  ];
}

const LANGUAGES: [string, string][] = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-IN", "English (India)"], ["hi-IN", "Hindi"], ["fr-FR", "French"], ["de-DE", "German"], ["es-ES", "Spanish"], ["pt-BR", "Portuguese (Brazil)"], ["it-IT", "Italian"], ["ja-JP", "Japanese"], ["zh-CN", "Chinese (Simplified)"]];

/** The languages a model honours, named in the person's own language; any model without a list takes the full set. */
function languageOptions(supported?: readonly string[]): [string, string][] {
  const names = (() => { try { return new Intl.DisplayNames(undefined, { type: "language" }); } catch { return undefined; } })();
  const list = supported ? supported.map((t) => [t, names?.of(t) ?? t] as [string, string]) : LANGUAGES;
  return [["", "Same as this Mac"], ...list];
}

/** Settings → Voice → Dictation: the mic, which model transcribes, its language. */
function dictationGroup(list: VoiceProvider[], openProvider: (id: string) => void): HTMLElement {
  const ready = list.filter((p) => p.available && p.stt?.length);
  const key = (provider: string, model: string) => JSON.stringify({ provider, model });
  const groups = byPlace(ready, (p) => p.stt!.map((m) => [key(p.id, m.id), choiceLabel(m.label, p)] as const));
  // The window's own recognizer is this Mac's, and needs no provider.
  if (systemDictation) {
    const own = [key("system", ""), "This Mac's speech recognition"] as const;
    const local = groups.find((g) => g.label === ON_THIS_MAC);
    if (local) local.options.unshift(own);
    else groups.unshift({ label: ON_THIS_MAC, options: [own] });
  }
  const options = groups.flatMap((g) => g.options);
  const saved = dictationPrefs.choice;
  const chosen = saved && options.some(([v]) => v === key(saved.provider, saved.model)) ? saved : options[0] ? JSON.parse(options[0][0]) as { provider: string; model: string } : undefined;
  if (chosen && JSON.stringify(saved) !== JSON.stringify(chosen)) dictationPrefs.choice = chosen;
  let hint: Element | null = null;
  const describe = (provider?: string) => {
    if (!hint) return;
    const p = list.find((x) => x.id === provider);
    hint.textContent = provider === "system" ? "Free. Words appear as you speak."
      : p?.local ? "Free. Transcribed on this Mac when you stop; the recording never leaves it."
      : p ? `Sent to ${p.label} when you stop and billed to your key.`
      : "Set up a voice source below to dictate.";
  };
  const languageBox = el("span");
  /** Only the languages this model honours; a saved choice it cannot honour narrows to one it can, or to this Mac's. */
  const paintLanguages = (c?: { provider: string; model: string }) => {
    const supported = list.find((p) => p.id === c?.provider)?.stt?.find((m) => m.id === c?.model)?.languages;
    const saved = dictationPrefs.language;
    if (saved && dictationLanguage(saved, supported) !== saved) dictationPrefs.language = dictationLanguage(saved, supported) ?? "";
    languageBox.replaceChildren(select(languageOptions(supported), dictationPrefs.language, (v) => { dictationPrefs.language = v; }));
  };
  const target = setupTarget(list);
  paintLanguages(chosen);
  const pick = chosen
    ? select(groups, key(chosen.provider, chosen.model), (v) => { const c = JSON.parse(v) as { provider: string; model: string }; dictationPrefs.choice = c; describe(c.provider); paintLanguages(c); })
    : el("button", { type: "button", className: "ghost small", textContent: "Set up dictation", disabled: !target, onclick: () => target && openProvider(target) });
  const which = row("Transcribe with", " ", pick);
  hint = which.querySelector(".row-hint");
  describe(chosen?.provider);
  return group(
    "Dictation",
    row("Microphone button", "Speak instead of typing: ⌘D or the mic in the message box. Enter stops; Esc discards.", toggle(dictationPrefs.own, (on) => { dictationPrefs.enabled = on; })),
    which,
    row("Language", "Only the languages the chosen model transcribes. A regional choice sets spelling where the model supports it.", languageBox),
    row("Clean speech with chat model", "Remove hesitation, fillers ('um', 'ah') and false starts using the active model.", toggle(dictationPrefs.clean, (on) => { dictationPrefs.clean = on; })),
    row("Send when dictation ends", "Otherwise the words wait in the message box for you to edit.", toggle(dictationPrefs.send, (on) => { dictationPrefs.send = on; })),
  );
}
