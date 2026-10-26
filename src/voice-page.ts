// Voice in Integrations (a card per voice provider, and its page: key, local
// voice packs, model and voice with a preview) and Settings → Voice (how
// reading aloud behaves). Choosing a voice is per window, like the theme.

import { api, el } from "./core.ts";
import { tile } from "./icons.ts";
import { group, pill, row, secretField, segmented, select, type Setting, title, toggle } from "./ui.ts";
import { dictationPrefs, systemDictation } from "./dictation.ts";
import { type VoiceOption, lastError, loadVoices, readAloud, resolveChoice, SPEEDS, stopReading, voicePrefs, voiceState, type VoiceChoice, type VoiceProvider } from "./voice.ts";

const inUse = (p: VoiceProvider) => voicePrefs.choice?.provider === p.id && resolveChoice([p]) !== undefined;

function status(p: VoiceProvider): HTMLElement {
  if (inUse(p)) return pill("In use", "ok");
  return p.available ? pill("Ready") : pill("Needs setup", "bad");
}

const sample = (voice: string) => `Hello, this is ${voice}. This is how replies will sound when Vakyartha reads them aloud.`;

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

/** The Voice category under the integrations grid. */
export async function voiceSection(open: (id: string) => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true).catch(() => [] as VoiceProvider[]);
  const grid = el("div", { className: "market" }, ...list.map((p) => {
    const card = el("button", { type: "button", className: "market-card" }, tile(p.icon, 40), el("div", { className: "market-text" }, el("div", { className: "market-name" }, p.label), el("div", { className: "market-pub" }, p.publisher), el("div", { className: "market-sum" }, p.summary)), el("div", { className: "market-foot" }, pill(p.local ? "On this Mac" : "Hosted"), status(p)));
    card.addEventListener("click", () => open(p.id));
    return card;
  }));
  return [el("h2", { className: "market-heading", textContent: "Voice" }), el("p", { className: "row-hint market-sub", textContent: "Read replies aloud. Pick a provider, set it up once, then choose a voice." }), grid];
}

/** One voice provider: setup, voice packs, model and voice, and making it the one that reads. */
export async function voicePage(id: string, settings: Setting[], back: () => void, reload: () => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true);
  const p = list.find((x) => x.id === id);
  if (!p) return [...title("Not found")];
  const note = el("p", { className: "row-hint bad" });
  const backLink = el("button", { type: "button", className: "link", textContent: "‹ All integrations" });
  backLink.addEventListener("click", back);
  const head = el("div", { className: "int-head" }, tile(p.icon, 56), el("div", {}, el("h1", { textContent: p.label }), el("div", { className: "int-meta" }, el("span", { textContent: p.publisher }), pill(p.local ? "On this Mac" : "Hosted"), status(p))));
  const parts: HTMLElement[] = [backLink, head, el("p", { className: "lead", textContent: p.description })];

  const setup: HTMLElement[] = [];
  const keySetting = p.keyVar ? settings.find((s) => s.name === p.keyVar) : undefined;
  if (keySetting) setup.push(row(keySetting.label, keySetting.group === "voice" ? "Kept in the macOS Keychain." : "Shared with this provider's chat models in Providers.", secretField(keySetting, reload)));
  for (const pack of p.packs ?? []) {
    let control: HTMLElement;
    if (pack.installed) control = pill("Installed", "ok");
    else {
      const b = el("button", { type: "button", className: "ghost small", textContent: `Install · ${pack.size}` });
      b.addEventListener("click", () => {
        b.disabled = true;
        b.textContent = "Installing…";
        note.textContent = "";
        api("/api/voice/ollama/pull", { method: "POST", body: JSON.stringify({ model: pack.id }) }).then(reload, (err: Error) => {
          note.textContent = err.message;
          b.disabled = false;
          b.textContent = `Install · ${pack.size}`;
        });
      });
      control = b;
    }
    setup.push(row(`Phonon · ${pack.label}`, `${pack.id} · ${pack.license}`, control));
  }
  if (p.reason) setup.unshift(el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: p.reason })));
  if (setup.length) parts.push(group(p.packs ? "Voice packs" : "Setup", ...setup));

  if (p.available) {
    const saved = voicePrefs.choice?.provider === p.id ? voicePrefs.choice : undefined;
    let c = resolveChoice([p], saved ?? { provider: p.id, model: "", voice: "" })!;
    const model = () => p.models.find((m) => m.id === c.model)!;
    const voiceBox = el("span");
    const optionRows = el("div", { className: "rows" });
    const modelHint = el("span", { className: "row-hint" });
    const use = el("button", { type: "button", className: "primary small" });
    const paintUse = () => {
      const same = voicePrefs.choice && JSON.stringify(voicePrefs.choice) === JSON.stringify(c);
      use.textContent = same ? "In use" : "Use for read aloud";
      use.disabled = Boolean(same);
    };
    const paintVoices = () => {
      voiceBox.replaceChildren(select(model().voices.map((v) => [v.id, v.name] as const), c.voice, (v) => { c = { ...c, voice: v }; paintUse(); }));
      modelHint.textContent = model().note ?? "";
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
      if (!opts.length) optionRows.replaceChildren(el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: p.local ? "Phonon has no style controls: each voice has its own character. Speed is set in Settings → Voice." : "This model has no style controls. Speed is set in Settings → Voice." })));
    };
    use.addEventListener("click", () => { voicePrefs.choice = c; reload(); });
    paintVoices();
    paintUse();
    const preview = previewButton(() => sample(model().voices.find((v) => v.id === c.voice)?.name ?? "your voice"), () => c, note);
    parts.push(group(
      "Voice",
      row("Model", null, el("span", {}, select(p.models.filter((m) => m.voices.length).map((m) => [m.id, m.label] as const), c.model, (m) => {
        c = { provider: p.id, model: m, voice: p.models.find((x) => x.id === m)!.voices[0]!.id, options: c.options };
        paintVoices();
        paintUse();
      }), modelHint)),
      row("Voice", p.cost, el("span", { className: "row-actions" }, voiceBox, preview)),
    ));
    parts.push(el("section", { className: "group" }, el("h2", { textContent: "Sound" }), optionRows));
    parts.push(el("div", { className: "row-actions voice-use" }, use));
  }
  parts.push(group("Speech to text", el("div", { className: "row stack" }, el("p", {
    className: "row-hint",
    textContent: p.stt?.length
      ? `Dictation can use ${p.stt.map((m) => m.label).join(", ")}. Choose it in Settings → Voice. ${p.local ? "" : "Recordings are sent to " + p.publisher + " and billed."}`
      : `${p.label} has no transcription model yet. Dictation uses this Mac's speech recognition or a hosted provider.`,
  }))));
  parts.push(note);
  return parts;
}

/** Settings → Voice: whether and how replies are read; the voice itself is chosen in Integrations. */
export async function voiceSettingsPage(openProvider: (id: string) => void): Promise<HTMLElement[]> {
  const list = await loadVoices(true).catch(() => [] as VoiceProvider[]);
  const c = resolveChoice(list);
  const p = list.find((x) => x.id === c?.provider);
  const m = p?.models.find((x) => x.id === c?.model);
  const v = m?.voices.find((x) => x.id === c?.voice);
  const note = el("p", { className: "row-hint bad" });
  const change = el("button", { type: "button", className: "ghost small", textContent: c ? "Change…" : "Set up a voice" });
  change.addEventListener("click", () => openProvider(c?.provider ?? list[0]?.id ?? "ollama"));
  const current = c && p && m ? `${v?.name ?? c.voice} · ${m.label} · ${p.label}` : "No voice is ready yet.";
  const controls = el("span", { className: "row-actions" }, change);
  if (c) controls.prepend(previewButton(() => sample(v?.name ?? "your voice"), () => c, note));
  return [
    ...title("Voice", "Hear replies read aloud and dictate messages. On this Mac it is free; a hosted provider receives the text or recording and bills for it."),
    group(
      "Read aloud",
      row("Read-aloud button", "Show a speaker on each reply. Right-click a reply for the same.", toggle(voicePrefs.enabled, (on) => { voicePrefs.enabled = on; })),
      row("Read new replies automatically", "Only while the chat is open. Hosted voices charge for every reply read.", toggle(voicePrefs.auto, (on) => { voicePrefs.auto = on; })),
      row("Speed", null, segmented(SPEEDS, voicePrefs.speed as (typeof SPEEDS)[number][0], (s) => { voicePrefs.speed = s; })),
    ),
    dictationGroup(list),
    group("Voice", row("Current voice", current, controls), el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: p ? p.cost : "Install a free voice pack under Integrations → Voice → Ollama." }))),
    note,
  ];
}

const LANGUAGES: [string, string][] = [["", "Same as this Mac"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-IN", "English (India)"], ["hi-IN", "Hindi"], ["fr-FR", "French"], ["de-DE", "German"], ["es-ES", "Spanish"], ["pt-BR", "Portuguese"], ["it-IT", "Italian"], ["ja-JP", "Japanese"], ["zh-CN", "Chinese"]];

/** Settings → Voice → Dictation: the mic, which model transcribes, its language. */
function dictationGroup(list: VoiceProvider[]): HTMLElement {
  const options: [string, string][] = [];
  if (systemDictation) options.push([JSON.stringify({ provider: "system", model: "" }), "This Mac · free"]);
  for (const p of list) {
    if (!p.stt || (p.keyVar && p.reason?.includes("API key"))) continue;
    for (const m of p.stt) options.push([JSON.stringify({ provider: p.id, model: m.id }), `${m.label} · ${p.label}`]);
  }
  const chosen = dictationPrefs.choice;
  let hint: Element | null = null;
  const describe = (provider?: string) => {
    if (!hint) return;
    hint.textContent = provider === "system" ? "Free. Words appear as you speak (macOS speech recognition)." : provider ? "Sent to the provider when you stop; billed per minute." : "Add a hosted provider's key in Integrations → Voice to dictate.";
  };
  const pick = options.length
    ? select(options, chosen ? JSON.stringify({ provider: chosen.provider, model: chosen.model }) : options[0]![0], (v) => { const c = JSON.parse(v) as { provider: string; model: string }; dictationPrefs.choice = c; describe(c.provider); })
    : el("span", { className: "row-hint", textContent: "None ready" });
  const which = row("Transcribe with", " ", pick);
  hint = which.querySelector(".row-hint");
  describe(chosen?.provider);
  return group(
    "Dictation",
    row("Microphone button", "Speak instead of typing: ⌘D or the mic in the message box. Enter stops; Esc discards.", toggle(dictationPrefs.enabled, (on) => { dictationPrefs.enabled = on; })),
    which,
    row("Language", null, select(LANGUAGES, dictationPrefs.language, (v) => { dictationPrefs.language = v; })),
    row("Send when dictation ends", "Otherwise the words wait in the message box for you to edit.", toggle(dictationPrefs.send, (on) => { dictationPrefs.send = on; })),
  );
}
