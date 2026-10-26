// Read aloud: the chosen voice, and one player for the whole window. Pieces of
// a reply are fetched one ahead of playback, so a long reply starts speaking
// after its first sentence. Anything that reads aloud hears "vak:voice".

import { engine, prefs } from "./core.ts";
import { speechChunks } from "./speech-text.ts";

export interface Voice { id: string; name: string }
export type VoiceOption =
  | { id: string; kind: "text"; label: string; hint: string; presets: string[]; max: number }
  | { id: string; kind: "range"; label: string; hint: string; min: number; max: number; step: number; default: number };
export interface VoiceModel { id: string; label: string; voices: Voice[]; note?: string; options?: VoiceOption[] }
export interface VoicePack { id: string; label: string; size: string; license: string; installed: boolean }
export interface VoiceProvider {
  id: string; label: string; publisher: string; summary: string; description: string; icon: string;
  local: boolean; cost: string; keyVar?: string; available: boolean; reason?: string; models: VoiceModel[]; packs?: VoicePack[]; stt?: { id: string; label: string }[]; transcribes: boolean;
}

/** `options`: values for the model's declared options (style, stability…). */
export interface VoiceChoice { provider: string; model: string; voice: string; options?: Record<string, string | number> }

export const SPEEDS = [["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]] as const;

export const voicePrefs = {
  get enabled(): boolean { return prefs.get("voice:enabled") !== "false"; },
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

export type VoiceState = "idle" | "loading" | "playing";
let state: VoiceState = "idle";
let target: unknown;
let audio: HTMLAudioElement | undefined;
let run = 0;
let abort: AbortController | undefined;
export let lastError = "";

export const voiceState = () => ({ state, target });
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

function fetchPiece(c: VoiceChoice, text: string, signal: AbortSignal): Promise<Blob> {
  const p = requestPiece(c, text, signal);
  // Fetched ahead: a failure surfaces when its turn to play comes, or never if stopped first.
  p.catch(() => {});
  return p;
}

async function requestPiece(c: VoiceChoice, text: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(`${engine().url}/api/speech`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${engine().token}` },
    body: JSON.stringify({ ...c, text }),
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
  const pieces = speechChunks(text);
  if (!pieces.length) return;
  target = owner;
  lastError = "";
  announce("loading");
  const ctrl = new AbortController();
  abort = ctrl;
  try {
    const c = choice ?? resolveChoice(await loadVoices());
    if (!c) throw new Error("No voice is ready. Set one up in Integrations → Voice.");
    let next = fetchPiece(c, pieces[0]!, ctrl.signal);
    for (let i = 0; i < pieces.length; i++) {
      const blob = await next;
      if (run !== mine) return;
      if (i + 1 < pieces.length) next = fetchPiece(c, pieces[i + 1]!, ctrl.signal);
      await playPiece(blob, mine);
      if (run !== mine) return;
    }
  } catch (err) {
    if (run !== mine || ctrl.signal.aborted) return;
    lastError = (err as Error).message;
  }
  if (run === mine) {
    target = undefined;
    abort = undefined;
    announce("idle");
  }
}
