// Voice: read replies aloud. Speech is for the person, not a tool the model
// calls, so it is not an MCP server: each voice provider is one adapter in
// VOICES below (its key, models, voices and one synthesis call), and adding a
// vendor means adding an entry. Every adapter is asked for raw 16-bit 24 kHz
// mono PCM and the WAV header is written here: Ollama streams WAV with
// placeholder sizes, which a player cannot seek, and Gemini only returns PCM.

import { installWhistle, runWhistle, WHISTLE_LANGUAGES, WHISTLE_PACK, whistleInstalled, whistleSupported } from "./whistle.ts";

export interface Voice { id: string; name: string }
/** A control a model accepts beyond the voice: a style instruction, or a 0–1 setting. */
export type VoiceOption =
  | { id: string; kind: "text"; label: string; hint: string; presets: string[]; max: number }
  | { id: string; kind: "range"; label: string; hint: string; min: number; max: number; step: number; default: number };
/** `languages`: the base codes a model speaks well; absent means any (hosted multilingual voices). */
export interface VoiceModel { id: string; label: string; voices: Voice[]; note?: string; options?: VoiceOption[]; languages?: string[] }
/** A local model the app can pull for an adapter, from a fixed list (never a name typed in). */
/** A transcription model; `languages`, when set, are the only tags it honours (otherwise any). */
export interface SttModel { id: string; label: string; languages?: string[] }
export interface VoicePack { id: string; label: string; size: string; license: string; installed: boolean; languages?: string[] }

export interface VoiceProviderView {
  id: string;
  label: string;
  publisher: string;
  summary: string;
  description: string;
  icon: string;
  local: boolean;
  /** Shown beside the choice: what reading a reply costs and where the text goes. */
  cost: string;
  keyVar?: string;
  available: boolean;
  /** Why it cannot speak now, and what fixes it. */
  reason?: string;
  models: VoiceModel[];
  packs?: VoicePack[];
  /** Speech-to-text models ready now, when the provider transcribes. */
  stt?: SttModel[];
  /** Whether it can transcribe at all, once set up. */
  transcribes: boolean;
}

/** `language`: a BCP 47 tag (en-GB) for voices that accept one; the others infer it from the text. */
export interface SpeechRequest { provider: string; model: string; voice: string; text: string; options?: Record<string, unknown>; language?: string }

/** Providers cap one request near 4,096 characters; the UI sends sentences well under it. */
export const MAX_SPEECH_CHARS = 4096;
const RATE = 24_000;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
/** `dir` is where local packs live (the engine's data folder/voice). */
interface Ctx { env: Env; f: Fetch; signal?: AbortSignal; dir: string }

interface VoiceAdapter {
  id: string;
  label: string;
  publisher: string;
  summary: string;
  description: string;
  local: boolean;
  cost: string;
  keyVar?: string;
  keyLabel?: string;
  /** Models and voices, or why there are none. */
  list(ctx: Ctx): Promise<{ models: VoiceModel[]; reason?: string; packs?: VoicePack[]; stt?: SttModel[] }>;
  /** One request's PCM; absent for a provider that only transcribes. */
  synth?(req: SpeechRequest, ctx: Ctx): Promise<Uint8Array>;
  /** Install one of the packs it lists. */
  install?(pack: string, ctx: Ctx): Promise<void>;
  /** Dictation: a WAV recording to text. */
  transcribe?: { models: SttModel[]; run(audio: Uint8Array, model: string, language: string | undefined, ctx: Ctx): Promise<string> };
}

export class SpeechError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const named = (ids: string[]): Voice[] => ids.map((id) => ({ id, name: id }));

/** A tag as words for a model told in prose: en-GB → "British English". */
export const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

/** What a regional tag changes in writing, for transcription models that take a hint. */
const WRITING: Record<string, string> = {
  "en-US": "American English spelling",
  "en-GB": "British English spelling",
  "en-IN": "Indian English with British spelling",
  "en-AU": "Australian English spelling",
  "pt-BR": "Brazilian Portuguese",
  "pt-PT": "European Portuguese",
  "zh-CN": "Simplified Chinese characters",
  "zh-TW": "Traditional Chinese characters",
};

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

async function failure(provider: string, res: Response): Promise<SpeechError> {
  let message = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; detail?: { message?: string } | string };
    const e = body.error ?? body.detail;
    message = (typeof e === "string" ? e : e?.message) ?? message;
  } catch {
    /* not JSON */
  }
  return new SpeechError(`${provider}: ${message}`, res.status >= 500 ? 502 : 400);
}

async function post(provider: string, ctx: Ctx, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.f(url, { method: "POST", signal: ctx.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new SpeechError(`${provider} is not reachable`, 502);
  }
  if (!res.ok) throw await failure(provider, res);
  return res;
}

/** A multipart upload of the recording (OpenAI and ElevenLabs take files, not JSON). */
async function upload(provider: string, ctx: Ctx, url: string, headers: Record<string, string>, audio: Uint8Array, fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "speech.wav");
  let res: Response;
  try {
    res = await ctx.f(url, { method: "POST", signal: ctx.signal, headers, body: form });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new SpeechError(`${provider} is not reachable`, 502);
  }
  if (!res.ok) throw await failure(provider, res);
  return String(((await res.json()) as { text?: unknown }).text ?? "").trim();
}

function key(a: VoiceAdapter, env: Env): string {
  const k = a.keyVar ? env[a.keyVar] : undefined;
  if (!k) throw new SpeechError(`Add your ${a.keyLabel ?? a.label} API key in Providers.`);
  return k;
}

// --- Ollama --------------------------------------------------------------------

export function ollamaBase(env: Env): string {
  const host = (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

const NC = "CC BY-NC 4.0 (non-commercial)";
// The publisher's speech language list, shared by the audio and omni families.
// Identify the architecture from /api/show so local aliases keep the same limits.
const LFM3_SPEECH_LANGUAGES = ["ar", "da", "de", "el", "en", "fi", "fr", "he", "it", "ja", "ko", "nl", "pl", "pt", "es", "sv", "tr", "zh"];
type OllamaVoiceTag = { name: string; capabilities?: string[] };
async function ollamaVoiceTags(ctx: Ctx): Promise<OllamaVoiceTag[]> {
  const res = await ctx.f(`${ollamaBase(ctx.env)}/api/tags`, { signal: ctx.signal ?? AbortSignal.timeout(3000) });
  if (!res.ok) throw await failure("Ollama", res);
  return ((await res.json()) as { models?: OllamaVoiceTag[] }).models ?? [];
}
async function ollamaVoiceInfo(model: string, ctx: Ctx): Promise<{ voices?: string[]; details?: { family?: string }; remote_host?: string; remote_model?: string }> {
  const res = await ctx.f(`${ollamaBase(ctx.env)}/api/show`, { method: "POST", signal: ctx.signal ?? AbortSignal.timeout(3000), headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
  if (!res.ok) throw await failure("Ollama", res);
  return res.json();
}
/** The Phonon tags offered for one-click install; sizes from the Ollama library. */
export const OLLAMA_PACKS: Omit<VoicePack, "installed">[] = [
  { id: "phonon:latest", label: "Phonon · English", size: "113 MB", license: "Apache 2.0", languages: ["en"] },
  { id: "phonon:multilingual", label: "Phonon · Five languages", size: "123 MB", license: NC, languages: ["en", "fr", "de", "es", "pt"] },
  { id: "phonon:fr", label: "Phonon · French", size: "123 MB", license: NC, languages: ["fr"] },
  { id: "phonon:de", label: "Phonon · German", size: "123 MB", license: NC, languages: ["de"] },
  { id: "phonon:es", label: "Phonon · Spanish", size: "123 MB", license: NC, languages: ["es"] },
  { id: "phonon:pt", label: "Phonon · Portuguese", size: "123 MB", license: NC, languages: ["pt"] },
];

const ollama: VoiceAdapter = {
  id: "ollama",
  label: "Ollama",
  publisher: "Ollama · local voice models",
  summary: "Speech that runs on this Mac. Free and private.",
  description: "Choose installed models for read aloud and dictation. Refresh after installing a model in Ollama. Local requests stay on this computer.",
  local: true,
  cost: "Free · runs on this Mac",
  async list(ctx) {
    let tags: OllamaVoiceTag[];
    try {
      tags = await ollamaVoiceTags(ctx);
    } catch {
      return { models: [], stt: [], packs: OLLAMA_PACKS.map((p) => ({ ...p, installed: false })), reason: "Ollama is not running. Start Ollama, then refresh." };
    }
    const relevant = tags.filter((m) => m.capabilities?.some((c) => c === "speech" || c === "audio"));
    const installed = new Set(tags.filter((m) => m.capabilities?.includes("speech")).map((m) => m.name));
    const packs = OLLAMA_PACKS.map((p) => ({ ...p, installed: installed.has(p.id) }));
    if (!relevant.length) return { models: [], stt: [], packs, reason: "No voice model is installed yet. Install a voice pack below, or an Ollama model with audio input." };
    const entries = await Promise.all(relevant.map(async (m) => {
      let voices: string[] = [];
      let family: string | undefined;
      let localAudio = false;
      try {
        const info = await ollamaVoiceInfo(m.name, ctx);
        voices = info.voices ?? [];
        family = info.details?.family;
        localAudio = !info.remote_host && !info.remote_model;
      } catch {
        /* listed without voices: "default" still works */
      }
      const pack = OLLAMA_PACKS.find((p) => p.id === m.name);
      const languages = pack?.languages ?? (family === "lfm3_audio" || family === "lfm3_omni" ? LFM3_SPEECH_LANGUAGES : undefined);
      const model: VoiceModel = {
        id: m.name,
        label: pack ? pack.label : m.name.replace(/:latest$/, ""),
        // "default" first: it is what the model uses when none is named.
        voices: [{ id: "default", name: "Default" }, ...named(voices.filter((v) => v !== "default"))],
        note: pack?.license === NC ? "Non-commercial licence" : undefined,
        languages,
      };
      return { model, speech: m.capabilities?.includes("speech"), audio: localAudio && m.capabilities?.includes("audio") };
    }));
    return {
      models: entries.filter((e) => e.speech).map((e) => e.model), packs,
      stt: entries.filter((e) => e.audio).map(({ model: m }) => ({ id: m.id, label: m.label, languages: m.languages })),
    };
  },
  async synth(req, ctx) {
    // Phonon refuses speed and instructions; playback speed is the player's.
    const res = await post("Ollama", ctx, `${ollamaBase(ctx.env)}/v1/audio/speech`, {}, { model: req.model, input: req.text, voice: req.voice || "default", response_format: "pcm" });
    return new Uint8Array(await res.arrayBuffer());
  },
  install(pack, ctx) {
    return pullOllamaPack(pack, ctx.env, ctx.f);
  },
  transcribe: {
    models: [],
    async run(audio, model, language, ctx) {
      // Require a locally installed audio model; never let this path proxy a
      // cloud model or turn a mistyped selection into an implicit download.
      let tags: OllamaVoiceTag[];
      try { tags = await ollamaVoiceTags(ctx); }
      catch (err) {
        if (ctx.signal?.aborted) throw err;
        throw new SpeechError("Ollama is not reachable", 502);
      }
      const installed = tags.find((m) => m.name === model || m.name === `${model}:latest`);
      if (!installed?.capabilities?.includes("audio")) throw new SpeechError("Choose an installed Ollama model with audio input for dictation.");
      const info = await ollamaVoiceInfo(installed.name, ctx);
      if (info.remote_host || info.remote_model) throw new SpeechError("Ollama dictation requires a local model; cloud-proxied models are not supported.");
      return upload("Ollama", ctx, `${ollamaBase(ctx.env)}/v1/audio/transcriptions`, {}, audio, {
        model: installed.name, response_format: "json", ...(language ? { language } : {}),
      });
    },
  },
};

/** Pull one pack from the fixed list; Ollama verifies what it downloads. */
export async function pullOllamaPack(model: string, env: Env, f: Fetch = fetch): Promise<void> {
  if (!OLLAMA_PACKS.some((p) => p.id === model)) throw new SpeechError("not a listed voice pack");
  let res: Response;
  try {
    res = await f(`${ollamaBase(env)}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }) });
  } catch {
    throw new SpeechError("Ollama is not running", 502);
  }
  if (!res.ok) throw await failure("Ollama", res);
}

// --- Whistle (Cactus Compute) -------------------------------------------------------

const whistle: VoiceAdapter = {
  id: "whistle",
  label: "Whistle",
  publisher: "Cactus Compute",
  summary: "Dictation that runs on this Mac. Free and private.",
  description: `Whistle is a small speech-to-text model that runs on this Mac's processor, so recordings never leave this computer. It transcribes ${Object.values(WHISTLE_LANGUAGES).join(", ")}. It only listens: it does not read replies aloud.`,
  local: true,
  cost: "Free · runs on this Mac",
  async list({ dir }) {
    if (!whistleSupported()) return { models: [], reason: "Whistle runs on Apple Silicon Macs." };
    const { files: _f, ...pack } = WHISTLE_PACK;
    const installed = await whistleInstalled(dir);
    return installed
      ? { models: [], packs: [{ ...pack, installed }], stt: this.transcribe!.models }
      : { models: [], packs: [{ ...pack, installed }], stt: [], reason: "Install the Whistle pack below to dictate on this Mac." };
  },
  install(pack, { dir, f }) {
    if (pack !== WHISTLE_PACK.id) throw new SpeechError("not a listed voice pack");
    return installWhistle(dir, f).catch((err: Error) => { throw new SpeechError(err.message, 502); });
  },
  transcribe: {
    models: [{ id: "whistle", label: "Whistle", languages: Object.keys(WHISTLE_LANGUAGES) }],
    async run(audio, _model, language, { dir, signal }) {
      language = language?.split("-")[0];
      if (language && !WHISTLE_LANGUAGES[language]) throw new SpeechError(`Whistle does not transcribe this language. Choose ${Object.values(WHISTLE_LANGUAGES).join(", ")} or "Same as this Mac" in Settings → Voice, or a hosted model.`);
      if (!(await whistleInstalled(dir))) throw new SpeechError("Install the Whistle pack in Providers → Whistle.");
      return runWhistle(dir, audio, language, signal);
    },
  },
};

const STYLE_PRESETS = ["Warm and friendly", "Calm, measured narrator", "Cheerful and upbeat", "Clear newsreader", "Soft and gentle", "Confident presenter"];
const style = (hint: string): VoiceOption => ({ id: "style", kind: "text", label: "Style", hint, presets: STYLE_PRESETS, max: 300 });

// --- OpenAI -----------------------------------------------------------------------

/** The style line, plus the accent when a region is known; only the GPT speech models take instructions. */
function instructions(req: SpeechRequest): string {
  if (!req.model.startsWith("gpt-")) return "";
  const style = typeof req.options?.style === "string" ? req.options.style : "";
  const accent = req.language?.includes("-") ? `Speak ${languageName(req.language)}.` : "";
  return [style, accent].filter(Boolean).join(" ");
}

const OPENAI_CLASSIC = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const openai: VoiceAdapter = {
  id: "openai",
  label: "OpenAI",
  publisher: "OpenAI",
  summary: "Hosted voices, steady and clear.",
  description: "OpenAI's speech models. Each reply read aloud is sent to OpenAI and billed per character to your key.",
  local: false,
  cost: "Paid per character · text is sent to OpenAI",
  keyVar: "OPENAI_API_KEY",
  async list() {
    return {
      models: [
        { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", note: "Deprecated · shuts down 6 January 2027", voices: named(OPENAI_VOICES), options: [style("How the voice should sound: tone, pace, personality.")] },
        { id: "tts-1", label: "TTS-1 (fast)", note: "Deprecated · shuts down 6 January 2027", voices: named(OPENAI_CLASSIC) },
        { id: "tts-1-hd", label: "TTS-1 HD (higher quality)", note: "Deprecated · shuts down 6 January 2027", voices: named(OPENAI_CLASSIC) },
      ],
    };
  },
  transcribe: {
    models: [
      { id: "gpt-transcribe", label: "GPT Transcribe (latest)" },
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe (most accurate)" },
      { id: "whisper-1", label: "Whisper" },
    ],
    run(audio, model, language, ctx) {
      // OpenAI takes the bare language; the region's spelling or script goes in the prompt.
      const hint = language ? WRITING[language] : undefined;
      return upload("OpenAI", ctx, "https://api.openai.com/v1/audio/transcriptions", { authorization: `Bearer ${key(openai, ctx.env)}` }, audio, { model, ...(language ? { language: language.split("-")[0]! } : {}), ...(hint ? { prompt: `${hint}.` } : {}) });
    },
  },
  async synth(req, ctx) {
    const res = await post("OpenAI", ctx, "https://api.openai.com/v1/audio/speech", { authorization: `Bearer ${key(this, ctx.env)}` }, {
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: "pcm",
      ...(instructions(req) ? { instructions: instructions(req) } : {}),
    });
    return new Uint8Array(await res.arrayBuffer());
  },
};

// --- Google Gemini ------------------------------------------------------------------

const GEMINI_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];
/** Aliases Google keeps current; used until the API lists its dedicated transcription models. */
const GEMINI_STT = [{ id: "gemini-flash-latest", label: "Gemini Flash (latest)" }, { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (latest)" }];

const gemini: VoiceAdapter = {
  id: "gemini",
  label: "Google Gemini",
  publisher: "Google",
  summary: "Hosted voices in many languages.",
  description: "Gemini's speech models. Each reply read aloud is sent to Google and billed per token to your key.",
  local: false,
  cost: "Paid per token · text is sent to Google",
  keyVar: "GEMINI_API_KEY",
  async list({ env, f }) {
    const styled = (id: string, label: string): VoiceModel => ({ id, label, voices: named(GEMINI_VOICES), options: [style("Told to the model before the text, e.g. “Say cheerfully”.")] });
    const fallback = { models: [styled("gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS"), styled("gemini-3.8-flash-lite-tts", "Gemini 3.8 Flash-Lite TTS")], stt: [{ id: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe" }, ...GEMINI_STT] };
    if (!env.GEMINI_API_KEY) return fallback;
    // Google retires model names for new keys, so the lists come from the API.
    try {
      const res = await f("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_API_KEY }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ...fallback, reason: (await failure("Gemini", res)).message };
      const all = (((await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }).models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName ?? m.name }));
      const newest = (a: { id: string }, b: { id: string }) => b.id.localeCompare(a.id, undefined, { numeric: true });
      const tts = all.filter((m) => /^gemini-[\w.-]*-tts(-[\w]+)?$/.test(m.id)).sort(newest);
      const stt = [...all.filter((m) => /^gemini-[\w.]+-transcribe$/.test(m.id)).sort(newest), ...all.filter((m) => /^gemini-(flash|flash-lite)-latest$/.test(m.id))];
      return { models: tts.length ? tts.map((m) => styled(m.id, m.label)) : fallback.models, stt: stt.length ? stt : fallback.stt };
    } catch {
      return { ...fallback, reason: "Google Gemini is not reachable." };
    }
  },
  transcribe: {
    models: GEMINI_STT,
    async run(audio, model, language, ctx) {
      // A dedicated "-transcribe" model takes the audio alone and answers with audioTranscription;
      // a general model needs to be told to transcribe and answers with text.
      const dedicated = model.endsWith("-transcribe");
      const ask = `Transcribe this recording exactly as spoken${language ? ` in ${WRITING[language] ?? languageName(language)} (${language})` : ""}. Reply with the transcript only, no notes. If nothing is said, reply with nothing.`;
      const res = await post("Gemini", ctx, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key(gemini, ctx.env) }, {
        contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from(audio).toString("base64") } }, ...(dedicated ? [] : [{ text: ask }])] }],
        ...(dedicated ? {} : { generationConfig: { temperature: 0 } }),
      });
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; audioTranscription?: { text?: string } }[] } }[] };
      return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.audioTranscription?.text ?? p.text ?? "").join("").trim();
    },
  },
  async synth(req, ctx) {
    const res = await post("Gemini", ctx, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, { "x-goog-api-key": key(this, ctx.env) }, {
      // Gemini takes its style as a spoken direction ahead of the words.
      contents: [{ parts: [{ text: typeof req.options?.style === "string" && req.options.style ? `${req.options.style}: ${req.text}` : req.text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } }, ...(req.language ? { languageCode: req.language } : {}) } },
    });
    const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new SpeechError("Gemini returned no audio", 502);
    return Buffer.from(data, "base64");
  },
};

// --- ElevenLabs ---------------------------------------------------------------------

const ELEVEN_OPTIONS: VoiceOption[] = [
  { id: "stability", kind: "range", label: "Stability", hint: "Lower is more expressive; higher is steadier.", min: 0, max: 1, step: 0.05, default: 0.5 },
  { id: "similarity", kind: "range", label: "Similarity", hint: "How closely to keep to the original voice.", min: 0, max: 1, step: 0.05, default: 0.75 },
  { id: "style", kind: "range", label: "Style exaggeration", hint: "Adds the voice's character; slower when above 0.", min: 0, max: 1, step: 0.05, default: 0 },
];

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

const elevenlabs: VoiceAdapter = {
  id: "elevenlabs",
  label: "ElevenLabs",
  publisher: "ElevenLabs",
  summary: "Expressive hosted voices, including your own.",
  description: "ElevenLabs speech models with the voices in your ElevenLabs library. Each reply read aloud is sent to ElevenLabs and billed in characters to your plan.",
  local: false,
  cost: "Paid per character · text is sent to ElevenLabs",
  keyVar: "ELEVENLABS_API_KEY",
  keyLabel: "ElevenLabs",
  async list({ env, f }) {
    const models = (voices: Voice[]): VoiceModel[] => [
      { id: "eleven_v4", label: "Eleven v4 (expressive narration)", voices, note: "Dialogue API · expressive speech in 90+ languages" },
      { id: "eleven_flash_v2_5", label: "Flash v2.5 (fastest)", voices, options: ELEVEN_OPTIONS },
      { id: "eleven_multilingual_v2", label: "Multilingual v2 (higher quality)", voices, options: ELEVEN_OPTIONS },
    ];
    if (!env.ELEVENLABS_API_KEY) return { models: models([]) };
    try {
      const res = await f("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { models: models([]), reason: (await failure("ElevenLabs", res)).message };
      const body = (await res.json()) as { voices?: { voice_id: string; name: string }[] };
      return { models: models((body.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }))) };
    } catch {
      return { models: models([]), reason: "ElevenLabs is not reachable." };
    }
  },
  transcribe: {
    models: [{ id: "scribe_v2", label: "Scribe v2" }, { id: "scribe_v1", label: "Scribe v1 (legacy)" }],
    run(audio, model, language, ctx) {
      return upload("ElevenLabs", ctx, "https://api.elevenlabs.io/v1/speech-to-text", { "xi-api-key": key(elevenlabs, ctx.env) }, audio, { model_id: model, ...(language ? { language_code: language.split("-")[0]! } : {}) });
    },
  },
  async synth(req, ctx) {
    if (req.model === "eleven_v4") {
      if (req.text.length > 2000) throw new SpeechError("Eleven v4 dialogue requests are limited to 2,000 characters here");
      const res = await post("ElevenLabs", ctx, "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=pcm_24000", { "xi-api-key": key(this, ctx.env) }, { model_id: req.model, inputs: [{ text: req.text, voice_id: req.voice }], ...(req.language ? { language_code: req.language.split("-")[0] } : {}) });
      return new Uint8Array(await res.arrayBuffer());
    }
    const res = await post("ElevenLabs", ctx, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=pcm_24000`, { "xi-api-key": key(this, ctx.env) }, {
      text: req.text,
      model_id: req.model,
      // Only the Flash and Turbo models take a language; it settles words spelled alike.
      ...(req.language && /flash|turbo/.test(req.model) ? { language_code: req.language.split("-")[0] } : {}),
      voice_settings: { stability: num(req.options?.stability, 0.5), similarity_boost: num(req.options?.similarity, 0.75), style: num(req.options?.style, 0) },
    });
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Local first: a new install reads aloud and dictates for free, and the first that transcribes is dictation's default. */
export const VOICES: VoiceAdapter[] = [ollama, whistle, openai, gemini, elevenlabs];

/** Keys voice providers need that no chat provider already declares (for Settings to store). */
export const VOICE_KEYS = [{ name: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", owner: "elevenlabs" }];

export async function voiceProviders(env: Env, f: Fetch = fetch, dir = ""): Promise<VoiceProviderView[]> {
  return Promise.all(VOICES.map(async (a): Promise<VoiceProviderView> => {
    const { list: _l, synth: _s, install: _i, keyLabel: _k, transcribe, ...info } = a;
    const listed = await a.list({ env, f, dir });
    const missingKey = a.keyVar && !env[a.keyVar];
    const reason = missingKey ? `Add your ${a.keyLabel ?? a.label} API key below.` : listed.reason;
    // A provider can be ready for dictation even without a speech-output model.
    const available = !reason && (listed.models.some((m) => m.voices.length > 0) || Boolean(listed.stt?.length));
    return { ...info, icon: "voice", available, reason, models: listed.models, packs: listed.packs, stt: listed.stt ?? transcribe?.models, transcribes: Boolean(transcribe) };
  }));
}

/** A 44-byte RIFF header with the true sizes, so any player can seek. */
export function wav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Options as the adapters expect them: short text or a number in 0–1; anything else is dropped. */
function checkOptions(raw: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{1,20}$/.test(k)) continue;
    if (typeof v === "string" && v.trim()) {
      if (v.length > 300 || /[\r\n]/.test(v)) throw new SpeechError(`${k} must be one short line`);
      out[k] = v.trim();
    } else if (typeof v === "number" && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}

/** Install a pack a provider lists (never a name typed in: each adapter checks its own list). */
export async function installVoicePack(provider: string, pack: string, env: Env, dir: string, f: Fetch = fetch): Promise<void> {
  const a = VOICES.find((x) => x.id === provider);
  if (!a?.install) throw new SpeechError("this provider has no packs");
  await a.install(pack, { env, f, dir });
}

/** One request's audio as a WAV file. */
export async function speak(req: SpeechRequest, env: Env, f: Fetch = fetch, signal?: AbortSignal): Promise<Uint8Array> {
  const a = VOICES.find((x) => x.id === req.provider);
  if (!a?.synth) throw new SpeechError(a ? "this provider does not read aloud" : "unknown voice provider");
  if (typeof req.model !== "string" || !/^[\w.:/-]{1,100}$/.test(req.model)) throw new SpeechError("invalid voice model");
  if (typeof req.voice !== "string" || req.voice.length > 80) throw new SpeechError("invalid voice");
  if (typeof req.text !== "string" || !req.text.trim()) throw new SpeechError("nothing to read");
  if (req.text.length > MAX_SPEECH_CHARS) throw new SpeechError(`text over ${MAX_SPEECH_CHARS} characters`);
  if (req.language !== undefined && req.language !== null && (typeof req.language !== "string" || !LANGUAGE_TAG.test(req.language))) throw new SpeechError("invalid language");
  return wav(await a.synth({ ...req, language: req.language || undefined, options: checkOptions(req.options) }, { env, f, signal, dir: "" }));
}

/** A recording's size limit: about four minutes of 16 kHz mono WAV. */
export const MAX_RECORDING_BYTES = 8_000_000;

export interface TranscribeRequest { provider: string; model: string; language?: string; audio: string }

/** Dictation: base64 WAV in, text out. */
export async function transcribe(req: TranscribeRequest, env: Env, f: Fetch = fetch, signal?: AbortSignal, dir = ""): Promise<string> {
  const a = VOICES.find((x) => x.id === req.provider);
  if (!a?.transcribe) throw new SpeechError("this provider does not transcribe");
  // Gemini's models come from its API, so a well-formed name is enough here.
  if (typeof req.model !== "string" || !/^[\w.:-]{1,100}$/.test(req.model)) throw new SpeechError("invalid transcription model");
  if (req.language !== undefined && req.language !== "" && (typeof req.language !== "string" || !LANGUAGE_TAG.test(req.language))) throw new SpeechError("invalid language");
  if (typeof req.audio !== "string") throw new SpeechError("no recording");
  const audio = new Uint8Array(Buffer.from(req.audio, "base64"));
  if (audio.length > MAX_RECORDING_BYTES) throw new SpeechError("the recording is too long");
  if (audio.length < 44 || Buffer.from(audio.subarray(0, 4)).toString() !== "RIFF" || Buffer.from(audio.subarray(8, 12)).toString() !== "WAVE") throw new SpeechError("the recording is not a WAV file");
  // The whole tag: each adapter gives its model as much of it as the model honours.
  return a.transcribe.run(audio, req.model, req.language || undefined, { env, f, signal, dir });
}
