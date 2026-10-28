import { engineFetch } from "../backend.ts";
// Dictation: speak instead of typing. "system" is the speech recognition built
// into the window's WebKit (free, words appear as they are said); any other
// provider (Whistle on this Mac, or a hosted one) gets a 16 kHz mono WAV
// recording when you stop. Anything showing
// dictation hears "vak:dictation".

import { engine, prefs } from "../core.ts";
import { voiceMaster } from "./master.ts";

export interface DictationChoice { provider: string; model: string }

/**
 * The tag a model is given: the chosen language (or this Mac's), as exactly as
 * the model honours it. A model that only knows "en" gets "en", never a region it
 * would ignore; one that does not know the language at all detects it.
 */
export function dictationLanguage(wanted: string, supported?: readonly string[]): string | undefined {
  if (!wanted) return undefined;
  if (!supported) return wanted;
  const base = wanted.split("-")[0]!;
  return supported.find((t) => t === wanted) ?? supported.find((t) => t === base);
}
export type DictationState = "idle" | "listening" | "transcribing";

/** About four minutes: under the engine's recording limit. */
const MAX_MS = 230_000;
const RATE = 16_000;

interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;
const Recognizer = (globalThis as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition
  ?? (globalThis as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;
// The app window's WebKit has the recognizer but it ends without results (2026-10-26,
// macOS with speech recognition allowed), so only a browser offers it.
export const systemDictation = Boolean(Recognizer) && !("__TAURI_INTERNALS__" in globalThis);

export const dictationPrefs = {
  /** The person's own setting; `enabled` is also off under the master switch. */
  get own(): boolean { return prefs.get("dictation:enabled") !== "false"; },
  get enabled(): boolean { return voiceMaster.on && this.own; },
  set enabled(v: boolean) { prefs.set("dictation:enabled", String(v)); if (!v) cancelDictation(); window.dispatchEvent(new Event("vak:dictation")); },
  get send(): boolean { return prefs.get("dictation:send") === "true"; },
  set send(v: boolean) { prefs.set("dictation:send", String(v)); },
  /** "" follows the system language. */
  get language(): string { return prefs.get("dictation:language") ?? ""; },
  set language(v: string) { prefs.set("dictation:language", v); },
  /** Free and on this Mac unless a hosted model was chosen. */
  get choice(): DictationChoice | undefined {
    try {
      const c = JSON.parse(prefs.get("dictation:choice") ?? "null") as DictationChoice | null;
      if (c && typeof c.provider === "string" && (c.provider !== "system" || systemDictation)) return c;
    } catch {
      /* fall through */
    }
    return systemDictation ? { provider: "system", model: "" } : undefined;
  },
  set choice(c: DictationChoice | undefined) { prefs.set("dictation:choice", JSON.stringify(c ?? null)); },
};

let state: DictationState = "idle";
let captureGeneration = 0;
let startedAt = 0;
let level = 0;
let finish: (() => void) | undefined;
let cancelNow: (() => void) | undefined;

export const dictationState = () => ({ state, startedAt, level });
const announce = (s: DictationState) => { state = s; window.dispatchEvent(new Event("vak:dictation")); };

export interface DictationHandlers {
  /** The words so far; `final` once nothing more will change. */
  onText(text: string, final: boolean): void;
  onError(message: string): void;
}

/** Stop listening and use what was said. */
export function stopDictation(): void { finish?.(); }
/** Stop listening and drop it. */
export function cancelDictation(): void { captureGeneration++; cancelNow?.(); }

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone or speech recognition access is off. Allow Vakyartha in System Settings → Privacy & Security.",
  "service-not-allowed": "Speech recognition is turned off. Turn on Dictation in System Settings → Keyboard, or choose a hosted model in Settings → Voice.",
  "no-speech": "Nothing was heard.",
  "audio-capture": "No microphone was found.",
  network: "System speech recognition could not reach its service. Try again, or choose a hosted model in Settings → Voice.",
};

export async function startDictation(h: DictationHandlers): Promise<void> {
  if (!dictationPrefs.enabled || state !== "idle") return;
  const generation = captureGeneration;
  const c = dictationPrefs.choice ?? (await firstReady());
  if (!dictationPrefs.enabled || generation !== captureGeneration) return;
  if (!c) return h.onError("Dictation needs a transcription model here: install Whistle (free, on this Mac) or add an OpenAI or Gemini key in Providers.");
  if (c.provider === "system") return listenSystem(h);
  return record(c, h, generation);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * One transcript from a recognizer's result list. Chrome gives each phrase once;
 * Safari also repeats an earlier phrase, or the whole utterance so far, as a
 * new result. A phrase that grows the text replaces it, one already in it is
 * skipped, and only new words are added.
 */
export function mergeResults(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const a = norm(out), b = norm(part);
    if (!a || b.startsWith(a)) out = part;
    else if (!a.includes(b)) out = `${out} ${part}`;
  }
  return out;
}

/** With no choice made and no system recognizer: the first provider ready to transcribe (local ones come first). */
async function firstReady(): Promise<DictationChoice | undefined> {
  const { loadVoices } = await import("./read-aloud.ts");
  const list = await loadVoices().catch(() => []);
  const p = list.find((x) => x.stt?.length && !(x.keyVar && x.reason?.includes("API key")));
  return p ? { provider: p.id, model: p.stt![0]!.id } : undefined;
}

function listenSystem(h: DictationHandlers): void {
  if (!Recognizer) return h.onError("This window has no speech recognition. Choose a hosted model in Settings → Voice.");
  const rec = new Recognizer();
  rec.lang = dictationPrefs.language || navigator.language;
  rec.continuous = true;
  rec.interimResults = true;
  let text = "";
  let cancelled = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  rec.onresult = (e) => {
    const parts: string[] = [];
    for (let i = 0; i < e.results.length; i++) parts.push(e.results[i]![0].transcript);
    text = mergeResults(parts);
    h.onText(text, false);
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    failed = true;
    if (e.error !== "no-speech" || !text) h.onError(RECOGNITION_ERRORS[e.error] ?? `Speech recognition failed (${e.error}).`);
  };
  rec.onend = () => {
    clearTimeout(timer);
    finish = cancelNow = undefined;
    if (!cancelled && text) h.onText(text, true);
    // The app window's recognizer can end without a word or an error; say so rather than nothing.
    else if (!cancelled && !failed) h.onError("No speech was recognized. If this keeps happening, choose a hosted model in Settings → Voice → Dictation.");
    announce("idle");
  };
  finish = () => rec.stop();
  cancelNow = () => { cancelled = true; rec.abort(); };
  timer = setTimeout(() => rec.stop(), MAX_MS);
  startedAt = Date.now();
  rec.start();
  announce("listening");
}

/** Average down to 16 kHz: speech needs no more, and it keeps uploads small. */
export function downsample(chunks: Float32Array[], from: number): Int16Array {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  const ratio = from / RATE;
  const out = new Int16Array(Math.floor(all.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = start; k < end; k++) sum += all[k]!;
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function wav16k(samples: Int16Array): Uint8Array {
  const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + data.length, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A recording's words, from the chosen model in the dictation language. Shorter than 0.3 s is nothing. */
export async function transcribeWav(c: DictationChoice, audio: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (audio.length < 44 + RATE * 2 * 0.3) throw new Error("Nothing was heard.");
  const { loadVoices } = await import("./read-aloud.ts");
  const model = (await loadVoices().catch(() => [])).find((p) => p.id === c.provider)?.stt?.find((m) => m.id === c.model);
  const language = dictationLanguage(dictationPrefs.language || navigator.language, model?.languages);
  const res = await engineFetch(`${engine().url}/api/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${engine().token}` },
    body: JSON.stringify({ provider: c.provider, model: c.model, language, audio: base64(audio) }),
    signal,
  });
  const body = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `transcription failed (${res.status})`);
  return body.text?.trim() ?? "";
}

/** A model that takes recordings: the chosen one, else the first ready. The system recognizer streams instead, so it is never this. */
export async function recordingChoice(): Promise<DictationChoice | undefined> {
  const c = dictationPrefs.choice;
  return c && c.provider !== "system" ? c : firstReady();
}

async function record(c: DictationChoice, h: DictationHandlers, generation: number): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) return h.onError("This window cannot use the microphone.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    if (generation !== captureGeneration) return;
    return h.onError(RECOGNITION_ERRORS["not-allowed"]!);
  }
  if (!dictationPrefs.enabled || generation !== captureGeneration) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor needs no worklet module, which this page's CSP would refuse.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(d));
    let sum = 0;
    for (let i = 0; i < d.length; i += 16) sum += d[i]! * d[i]!;
    level = Math.min(1, Math.sqrt(sum / (d.length / 16)) * 4);
    window.dispatchEvent(new Event("vak:dictation-level"));
  };
  source.connect(proc);
  proc.connect(ctx.destination);
  const release = () => {
    clearTimeout(timer);
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
    finish = cancelNow = undefined;
    level = 0;
  };
  cancelNow = () => { release(); announce("idle"); };
  finish = async () => {
    const rate = ctx.sampleRate;
    release();
    const abort = new AbortController();
    cancelNow = () => { abort.abort(); cancelNow = undefined; announce("idle"); };
    announce("transcribing");
    try {
      const text = await transcribeWav(c, wav16k(downsample(chunks, rate)), abort.signal);
      if (abort.signal.aborted || generation !== captureGeneration) return;
      if (text) h.onText(text, true);
      else h.onError("Nothing was heard.");
    } catch (err) {
      if (abort.signal.aborted || generation !== captureGeneration) return;
      h.onError((err as Error).message);
    }
    cancelNow = undefined;
    announce("idle");
  };
  const timer = setTimeout(() => void finish?.(), MAX_MS);
  startedAt = Date.now();
  announce("listening");
}
