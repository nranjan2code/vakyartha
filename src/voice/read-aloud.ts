// Read aloud: the chosen voice, and one player for the whole window. Pieces of
// a reply are fetched one ahead of playback, so a long reply starts speaking
// after its first sentence. Anything that reads aloud hears "vak:voice".

import { engine, prefs } from "../core.ts";
import { voiceMaster } from "./master.ts";
import { speechChunks, speechLocale, textLanguage } from "./speech-text.ts";

export interface Voice { id: string; name: string }
export type VoiceOption =
  | { id: string; kind: "text"; label: string; hint: string; presets: string[]; max: number }
  | { id: string; kind: "range"; label: string; hint: string; min: number; max: number; step: number; default: number };
export interface VoiceModel { id: string; label: string; voices: Voice[]; note?: string; options?: VoiceOption[]; languages?: string[] }
export interface SttModel { id: string; label: string; languages?: string[] }
export interface VoicePack { id: string; label: string; size: string; license: string; installed: boolean; languages?: string[] }
export interface VoiceProvider {
  id: string; label: string; publisher: string; summary: string; description: string; icon: string;
  local: boolean; cost: string; keyVar?: string; available: boolean; reason?: string; models: VoiceModel[]; packs?: VoicePack[]; stt?: SttModel[]; transcribes: boolean;
}

/** `options`: values for the model's declared options (style, stability…). */
export interface VoiceChoice { provider: string; model: string; voice: string; options?: Record<string, string | number> }

export const SPEEDS = [["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]] as const;

export const voicePrefs = {
  /** The person's own setting; `enabled` is also off under the master switch. */
  get own(): boolean { return prefs.get("voice:enabled") !== "false"; },
  get enabled(): boolean { return voiceMaster.on && this.own; },
  set enabled(v: boolean) { prefs.set("voice:enabled", String(v)); window.dispatchEvent(new Event("vak:voice")); },
  get auto(): boolean { return prefs.get("voice:auto") === "true"; },
  set auto(v: boolean) { prefs.set("voice:auto", String(v)); },
  get speed(): string { return prefs.get("voice:speed") ?? "1"; },
  set speed(v: string) { prefs.set("voice:speed", v); if (audio) applySpeed(audio); },
  get choice(): VoiceChoice | undefined {
    try {
      const c = JSON.parse(prefs.get("voice:choice") ?? "null") as VoiceChoice | null;
      return c && typeof c.provider === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  },
  set choice(c: VoiceChoice | undefined) { prefs.set("voice:choice", JSON.stringify(c ?? null)); window.dispatchEvent(new Event("vak:voice")); },
};

/** The saved choice when it can still speak, else the first voice that can (local first). */
export function resolveChoice(list: VoiceProvider[], want = voicePrefs.choice): VoiceChoice | undefined {
  const p = list.find((x) => x.id === want?.provider && x.available);
  const m = p?.models.find((x) => x.id === want?.model && x.voices.length);
  if (p && m) return { provider: p.id, model: m.id, voice: m.voices.find((v) => v.id === want?.voice)?.id ?? m.voices[0]!.id, options: want?.options };
  for (const q of list.filter((x) => x.available)) {
    const n = q.models.find((x) => x.voices.length);
    if (n) return { provider: q.id, model: n.id, voice: n.voices[0]!.id };
  }
  return undefined;
}

const languageWord = (lang: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
};

/**
 * The voice for a reply in `lang`: the chosen one when it speaks that language;
 * otherwise an installed voice that does, from the same provider first and then
 * from free local providers, never a billed one the person did not choose. A
 * single-language pack comes before a multilingual one. `missing` names the
 * pack to install when nothing fits, and the chosen voice reads anyway.
 */
export function voiceFor(list: VoiceProvider[], c: VoiceChoice, lang?: string): { choice: VoiceChoice; missing?: string } {
  const p = list.find((x) => x.id === c.provider);
  const m = p?.models.find((x) => x.id === c.model);
  if (!lang || !p || !m?.languages || m.languages.includes(lang)) return { choice: c };
  const fits = (q: VoiceProvider) => q.models.filter((x) => x.voices.length && x.languages?.includes(lang)).sort((a, b) => a.languages!.length - b.languages!.length);
  for (const q of [p, ...list.filter((x) => x.local && x.id !== p.id)].filter((x) => x.available)) {
    const n = fits(q)[0];
    if (n) return { choice: { provider: q.id, model: n.id, voice: n.voices.find((v) => v.id === c.voice)?.id ?? n.voices[0]!.id, options: q.id === c.provider ? c.options : undefined } };
  }
  const pack = list.filter((x) => x.local).flatMap((x) => x.packs ?? []).filter((k) => !k.installed && k.languages?.includes(lang)).sort((a, b) => a.languages!.length - b.languages!.length)[0];
  return { choice: c, missing: pack ? `No ${languageWord(lang)} voice is installed, so the reply was read in ${m.label}. Install ${pack.label} in Integrations → Voice.` : `No ${languageWord(lang)} voice is set up, so the reply was read in ${m.label}.` };
}

export type VoiceState = "idle" | "loading" | "playing";
let state: VoiceState = "idle";
let target: unknown;
let audio: HTMLAudioElement | undefined;
let run = 0;
let abort: AbortController | undefined;
export let lastError = "";

export const voiceState = () => ({ state, target });

/** What was said lately, so conversation mode can tell our own voice heard back from the person (commands.ts isEcho). */
const said: { text: string; at: number }[] = [];
export function recentlySaid(ms = 15_000): string[] {
  const since = Date.now() - ms;
  return said.filter((s) => s.at >= since).map((s) => s.text);
}
const announce = (s: VoiceState) => { state = s; window.dispatchEvent(new Event("vak:voice")); };

function applySpeed(a: HTMLAudioElement): void {
  a.playbackRate = Number(voicePrefs.speed) || 1;
  // Faster speech keeps its pitch instead of sounding sped up.
  a.preservesPitch = true;
  (a as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
}

/** The reply's prose: code blocks, interfaces and notes are not read. */
export function replyText(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const x of copy.querySelectorAll("pre, vak-surface, .surfaces, details, button, svg")) x.remove();
  const blocks = [...copy.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th")].filter((b) => !b.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th"));
  return (blocks.length ? blocks.map((b) => b.textContent ?? "").join("\n") : copy.textContent ?? "").trim();
}

let cachedProviders: Promise<VoiceProvider[]> | undefined;
export function loadVoices(fresh = false): Promise<VoiceProvider[]> {
  if (fresh || !cachedProviders) {
    cachedProviders = fetch(`${engine().url}/api/voice`, { headers: { authorization: `Bearer ${engine().token}` } }).then((r) => r.json() as Promise<VoiceProvider[]>);
    cachedProviders.catch(() => { cachedProviders = undefined; });
  }
  return cachedProviders;
}

function fetchPiece(c: VoiceChoice, text: string, language: string | undefined, signal: AbortSignal): Promise<Blob> {
  const p = requestPiece(c, text, language, signal);
  // Fetched ahead: a failure surfaces when its turn to play comes, or never if stopped first.
  p.catch(() => {});
  return p;
}

async function requestPiece(c: VoiceChoice, text: string, language: string | undefined, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(`${engine().url}/api/speech`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${engine().token}` },
    // The language lets a voice that accepts one pick the accent and the reading of words spelled alike (live, read, record).
    body: JSON.stringify({ ...c, text, language }),
  });
  if (!res.ok) {
    let message = `speech failed (${res.status})`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.blob();
}

function playPiece(blob: Blob, mine: number): Promise<void> {
  const url = URL.createObjectURL(blob);
  return new Promise<void>((resolve, reject) => {
    const a = new Audio(url);
    audio = a;
    applySpeed(a);
    a.addEventListener("ended", () => resolve(), { once: true });
    a.addEventListener("pause", () => { if (run !== mine) resolve(); }, { once: true });
    a.addEventListener("error", () => reject(new Error("this audio could not be played")), { once: true });
    a.play().then(() => { if (run === mine) announce("playing"); }, reject);
  }).finally(() => URL.revokeObjectURL(url));
}

export function stopReading(): void {
  run++;
  abort?.abort();
  abort = undefined;
  audio?.pause();
  audio = undefined;
  target = undefined;
  if (state !== "idle") announce("idle");
}

/** Read text aloud with the chosen voice; `owner` names what is reading (a reply), so its button can show it. */
export async function readAloud(text: string, owner: unknown, choice?: VoiceChoice): Promise<void> {
  stopReading();
  const mine = run;
  const lang = textLanguage(text);
  const language = speechLocale(lang);
  const pieces = speechChunks(text, lang);
  if (!pieces.length) return;
  target = owner;
  said.push({ text, at: Date.now() });
  if (said.length > 8) said.shift();
  lastError = "";
  let note = "";
  announce("loading");
  const ctrl = new AbortController();
  abort = ctrl;
  try {
    const list = await loadVoices();
    const chosen = choice ?? resolveChoice(list);
    if (!chosen) throw new Error("No voice is ready. Set one up in Integrations → Voice.");
    // A preview names its voice on purpose; a reply is read by a voice that speaks its language.
    const { choice: c, missing } = choice ? { choice } : voiceFor(list, chosen, lang);
    note = missing ?? "";
    let next = fetchPiece(c, pieces[0]!, language, ctrl.signal);
    for (let i = 0; i < pieces.length; i++) {
      const blob = await next;
      if (run !== mine) return;
      if (i + 1 < pieces.length) next = fetchPiece(c, pieces[i + 1]!, language, ctrl.signal);
      await playPiece(blob, mine);
      if (run !== mine) return;
    }
  } catch (err) {
    if (run !== mine || ctrl.signal.aborted) return;
    lastError = (err as Error).message;
  }
  if (run === mine) {
    // Said once the reply has been read, so the person knows why it sounded off and what fixes it.
    if (!lastError && note) lastError = note;
    target = undefined;
    abort = undefined;
    announce("idle");
  }
}
