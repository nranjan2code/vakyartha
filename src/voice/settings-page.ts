// Voice in Integrations (a card per voice provider, and its page: key, local
// voice packs, model and voice with a preview) and Settings → Voice (how
// reading aloud behaves). Choosing a voice is per window, like the theme.

import { api, el } from "../core.ts";
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

/** Discovered capabilities come first; optional downloads are secondary setup. */
export async function voicePage(id: string, settings: Setting[], back: () => void, reload: () => void, openVoiceSettings: () => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true);
  const p = list.find((x) => x.id === id);
  if (!p) return [...title("Not found")];
  const note = el("p", { className: "row-hint bad" });
  const backLink = el("button", { type: "button", className: "link", textContent: "‹ All providers" });
  backLink.addEventListener("click", back);
  const head = el("div", { className: "int-head" }, tile(p.icon, 56), el("div", {}, el("h1", { textContent: p.label }), el("div", { className: "int-meta" }, el("span", { textContent: p.publisher }), pill(p.local ? "On this Mac" : "Hosted"), status(p))));
  const parts: HTMLElement[] = [backLink, head, el("p", { className: "lead", textContent: p.description })];

  const setup: HTMLElement[] = [];
  const keySetting = p.keyVar ? settings.find((s) => s.name === p.keyVar) : undefined;
  if (keySetting) setup.push(row(keySetting.label, keySetting.group === "voice" ? "Kept in the macOS Keychain." : "Shared with this provider's chat models in Providers.", secretField(keySetting, reload)));
  if (p.reason) setup.unshift(el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: p.reason })));
  if (setup.length) parts.push(group("Setup", ...setup));

  if (p.local) {
    const refresh = el("button", { type: "button", className: "ghost small", textContent: "Refresh models" });
    refresh.addEventListener("click", () => { stopReading(); reload(); });
    const count = new Set([...p.models.map((m) => m.id), ...(p.stt ?? []).map((m) => m.id)]).size;
    parts.push(el("div", { className: "voice-discovery" }, el("p", { className: "row-hint", textContent: `${count} model${count === 1 ? "" : "s"} available · ${p.models.length} read aloud · ${p.stt?.length ?? 0} dictation` }), refresh));
  }

  const packRows: HTMLElement[] = [];
  for (const pack of p.packs ?? []) {
    let control: HTMLElement;
    if (pack.installed) control = pill("Installed", "ok");
    else {
      const b = el("button", { type: "button", className: "ghost small", textContent: `Install · ${pack.size}` });
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
      control = b;
    }
    packRows.push(row(pack.label, `${pack.id} · ${pack.license}`, control));
  }

  if (p.transcribes || p.models.length) {
    const link = el("button", { type: "button", className: "link", textContent: "Open Voice settings" });
    link.addEventListener("click", openVoiceSettings);
    parts.push(el("p", { className: "row-hint" },
      "Choose read-aloud and dictation models in Settings → Voice. ",
      link,
    ));
  }
  if (packRows.length) {
    const ready = p.models.length > 0 || Boolean(p.stt?.length);
    parts.push(el("details", { className: "voice-downloads", open: !ready },
      el("summary", {}, el("span", { textContent: "Download voice packs" }), el("span", { className: "row-hint", textContent: "Optional · additional models and languages" })),
      el("p", { className: "row-hint", textContent: p.id === "ollama" ? "These packs are optional. Models installed separately in Ollama are discovered above when you refresh." : "Install a pack to make its models available above." }),
      group(null, ...packRows),
    ));
  }
  parts.push(note);
  return parts;
}

/** One read-aloud choice across providers, owned by Settings → Voice. */
function readAloudGroup(list: VoiceProvider[], openProvider: (id: string) => void): HTMLElement[] {
  const ready = list.filter((p) => p.available && p.models.some((m) => m.voices.length));
  const initial = resolveChoice(ready);
  if (!initial) return [group("Read aloud", row("No voice is ready", "Set up a voice provider, then refresh this page.", el("button", { type: "button", className: "ghost small", textContent: "Set up a provider", onclick: () => openProvider("ollama") })))];
  let c: VoiceChoice = initial;
  const provider = () => ready.find((p) => p.id === c.provider)!;
  const note = el("p", { className: "row-hint bad" });
  const model = () => provider().models.find((m) => m.id === c.model)!;
  const voiceBox = el("span", { className: "voice-choice" });
  const optionRows = el("div", { className: "voice-options" });
  const modelHint = el("span", { className: "row-hint" });
  const use = el("button", { type: "button", className: "primary small" });
  const paintUse = () => {
    const same = voicePrefs.choice && JSON.stringify(voicePrefs.choice) === JSON.stringify(c);
    use.textContent = same ? "In use" : "Use for read aloud";
    use.disabled = Boolean(same);
  };
  const paintVoices = () => {
    const voiceSelect = select(model().voices.map((v) => [v.id, voiceName(v.name)] as const), c.voice, (v) => { stopReading(); c = { ...c, voice: v }; paintUse(); });
    voiceSelect.setAttribute("aria-label", "Read-aloud voice");
    voiceBox.replaceChildren(voiceSelect);
    modelHint.textContent = [
      provider().cost,
      `${model().voices.length} voice${model().voices.length === 1 ? "" : "s"}`,
      model().languages ? `${model().languages!.length} language${model().languages!.length === 1 ? "" : "s"}` : "Language coverage not reported",
      model().note,
    ].filter(Boolean).join(" · ");
    const opts = model().options ?? [];
    // Keep only values this model declares, of the kind it declares (OpenAI's style is text, ElevenLabs' a number).
    const kept = Object.fromEntries(opts.flatMap((o) => { const v = c.options?.[o.id]; return v !== undefined && typeof v === (o.kind === "text" ? "string" : "number") ? [[o.id, v]] : []; }));
    c = { ...c, options: Object.keys(kept).length ? kept : undefined };
    optionRows.replaceChildren(...opts.map((o) => row(o.label, o.hint, optionControl(o, c.options?.[o.id], (v) => {
      const next = { ...c.options };
      if (v === undefined) delete next[o.id];
      else next[o.id] = v;
      c = { ...c, options: next };
      paintUse();
    }))));
    optionRows.hidden = !opts.length;
  };
  use.addEventListener("click", () => { voicePrefs.choice = c; paintUse(); });
  paintVoices();
  paintUse();
  const preview = previewButton(() => sample(voiceName(model().voices.find((v) => v.id === c.voice)?.name ?? "your voice")), () => c, note);
  const modelSelect = select(ready.flatMap((p) => p.models.filter((m) => m.voices.length).map((m) => [JSON.stringify({ provider: p.id, model: m.id }), `${m.label} · ${p.label}`] as const)), JSON.stringify({ provider: c.provider, model: c.model }), (value) => {
    stopReading();
    const next = JSON.parse(value) as { provider: string; model: string };
    const m = ready.find((p) => p.id === next.provider)!.models.find((m) => m.id === next.model)!;
    c = { ...next, voice: m.voices.find((v) => v.id === c.voice)?.id ?? m.voices[0]!.id };
    paintVoices();
    paintUse();
  });
  modelSelect.setAttribute("aria-label", "Read-aloud model");
  return [group(
    "Read aloud",
    row("Model", "Reads replies and interface content aloud.", el("span", { className: "voice-model-control" }, modelSelect, modelHint)),
    row("Voice", null, el("span", { className: "row-actions voice-preview" }, voiceBox, preview)),
    optionRows,
    el("div", { className: "row voice-apply" }, use),
  ), note];
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
    dictationGroup(list),
    group(
      "Conversation",
      row("Conversation button", "Talk and listen without touching anything: ⌘⇧D or the waves in the message box. Replies are read aloud; speak over one to stop it. Say \"stop listening\" or press Esc to end. Uses the dictation model and the current voice.", toggle(conversationPrefs.own, (on) => { conversationPrefs.enabled = on; })),
    ),
    group("Provider setup", row("Connections and downloads", "Manage provider keys, local models and optional voice packs in Providers.", el("button", { type: "button", className: "ghost small", textContent: "Manage voice providers", onclick: () => openProvider(voicePrefs.choice?.provider ?? "ollama") }))),
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
function dictationGroup(list: VoiceProvider[]): HTMLElement {
  const options: [string, string][] = [];
  if (systemDictation) options.push([JSON.stringify({ provider: "system", model: "" }), "This Mac · free"]);
  for (const p of list) {
    if (!p.stt || (p.keyVar && p.reason?.includes("API key"))) continue;
    for (const m of p.stt) options.push([JSON.stringify({ provider: p.id, model: m.id }), `${m.label === p.label ? m.label : `${m.label} · ${p.label}`}${p.local ? " · free" : ""}`]);
  }
  const chosen = dictationPrefs.choice;
  let hint: Element | null = null;
  const describe = (provider?: string) => {
    if (!hint) return;
    const local = list.find((p) => p.id === provider)?.local;
    hint.textContent = provider === "system" ? "Free. Words appear as you speak (macOS speech recognition)."
      : local ? "Free. Transcribed on this Mac when you stop; the recording never leaves it."
      : provider ? "Sent to the provider when you stop; billed per minute."
      : "Install Whistle, or add a hosted provider's key, in Providers to dictate.";
  };
  const languageBox = el("span");
  /** Only the languages this model honours; a saved choice it cannot honour narrows to one it can, or to this Mac's. */
  const paintLanguages = (c?: { provider: string; model: string }) => {
    const supported = list.find((p) => p.id === c?.provider)?.stt?.find((m) => m.id === c?.model)?.languages;
    const saved = dictationPrefs.language;
    if (saved && dictationLanguage(saved, supported) !== saved) dictationPrefs.language = dictationLanguage(saved, supported) ?? "";
    languageBox.replaceChildren(select(languageOptions(supported), dictationPrefs.language, (v) => { dictationPrefs.language = v; }));
  };
  const first = options[0] ? (JSON.parse(options[0][0]) as { provider: string; model: string }) : undefined;
  paintLanguages(chosen ?? first);
  const pick = options.length
    ? select(options, chosen ? JSON.stringify({ provider: chosen.provider, model: chosen.model }) : options[0]![0], (v) => { const c = JSON.parse(v) as { provider: string; model: string }; dictationPrefs.choice = c; describe(c.provider); paintLanguages(c); })
    : el("span", { className: "row-hint", textContent: "None ready" });
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
