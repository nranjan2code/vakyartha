// Voice: read replies aloud. Speech is for the person, not a tool the model
// calls, so it is not an MCP server: each voice provider is one adapter in
// VOICES below (its key, models, voices and one synthesis call), and adding a
// vendor means adding an entry. Every adapter is asked for raw 16-bit 24 kHz
// mono PCM and the WAV header is written here: Ollama streams WAV with
// placeholder sizes, which a player cannot seek, and Gemini only returns PCM.

import { MAX_RECORDING_BYTES, type VoiceCall, type VoiceTransport } from "./transport.ts";
import { WHISTLE_LANGUAGES, WHISTLE_PACK } from "./whistle.ts";

export { MAX_RECORDING_BYTES };

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
/** Where a provider's model catalog is, and a name to show as an example. */
export interface GetModel { catalog: string; example: string }
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
  /** Models are fetched by the name its catalog gives; absent when it has no catalog. */
  getModel?: GetModel;
  /** Whether it can transcribe at all, once set up. */
  transcribes: boolean;
}

/** `language`: a BCP 47 tag (en-GB) for voices that accept one; the others infer it from the text. */
export interface SpeechRequest { provider: string; model: string; voice: string; text: string; options?: Record<string, unknown>; language?: string }

/** Providers cap one request near 4,096 characters; the UI sends sentences well under it. */
export const MAX_SPEECH_CHARS = 4096;
const RATE = 24_000;

type Env = Record<string, string | undefined>;
/** `env` says which keys exist; the transport is the only way out and holds them. */
interface Ctx { env: Env; voice: VoiceTransport; signal?: AbortSignal }

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
  getModel?: GetModel;
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

async function send(provider: string, ctx: Ctx, call: VoiceCall): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.voice({ ...call, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new SpeechError(`${provider} is not reachable`, 502);
  }
  if (!res.ok) throw await failure(provider, res);
  return res;
}

/** A recording uploaded with its text fields; the answer's transcript. */
async function transcript(provider: string, ctx: Ctx, call: VoiceCall): Promise<string> {
  const res = await send(provider, ctx, call);
  return String(((await res.json()) as { text?: unknown }).text ?? "").trim();
}

/** The key itself stays with the transport; this only asks whether one is set. */
function needKey(a: VoiceAdapter, env: Env): void {
  if (!a.keyVar || !env[a.keyVar]) throw new SpeechError(`Add your ${a.keyLabel ?? a.label} API key in Providers.`);
}

// --- Ollama --------------------------------------------------------------------

// The publisher's speech language list, shared by the audio and omni families.
// Identify the architecture from /api/show so local aliases keep the same limits.
const LFM3_SPEECH_LANGUAGES = ["ar", "da", "de", "el", "en", "fi", "fr", "he", "it", "ja", "ko", "nl", "pl", "pt", "es", "sv", "tr", "zh"];
type OllamaVoiceTag = { name: string; capabilities?: string[] };
async function ollamaVoiceTags(ctx: Ctx): Promise<OllamaVoiceTag[]> {
  const res = await ctx.voice({ operation: "ollama_tags", signal: ctx.signal });
  if (!res.ok) throw await failure("Ollama", res);
  return ((await res.json()) as { models?: OllamaVoiceTag[] }).models ?? [];
}
async function ollamaVoiceInfo(model: string, ctx: Ctx): Promise<{ voices?: string[]; details?: { family?: string }; remote_host?: string; remote_model?: string }> {
  const res = await ctx.voice({ operation: "ollama_show", body: { model }, signal: ctx.signal });
  if (!res.ok) throw await failure("Ollama", res);
  return res.json();
}
const ollama: VoiceAdapter = {
  id: "ollama",
  label: "Ollama",
  publisher: "Ollama · local voice models",
  summary: "Speech that runs on this Mac. Free and private.",
  description: "Choose installed models for read aloud and dictation. Check again after installing a model in Ollama. Local requests stay on this computer.",
  local: true,
  cost: "Free · runs on this Mac",
  getModel: { catalog: "https://ollama.com/search?c=speech", example: "phonon" },
  async list(ctx) {
    let tags: OllamaVoiceTag[];
    try {
      tags = await ollamaVoiceTags(ctx);
    } catch {
      return { models: [], stt: [], reason: "Ollama is not running. Start Ollama, then check again." };
    }
    const relevant = tags.filter(isVoiceModel);
    if (!relevant.length) return { models: [], stt: [], reason: "No voice model yet. Get one below: a speech model reads aloud, an audio model takes dictation." };
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
      const languages = family === "lfm3_audio" || family === "lfm3_omni" ? LFM3_SPEECH_LANGUAGES : undefined;
      const model: VoiceModel = {
        id: m.name,
        label: m.name.replace(/:latest$/, ""),
        // "default" first: it is what the model uses when none is named.
        voices: [{ id: "default", name: "Default" }, ...named(voices.filter((v) => v !== "default"))],
        languages,
      };
      return { model, speech: m.capabilities?.includes("speech"), audio: localAudio && m.capabilities?.includes("audio") };
    }));
    return {
      models: entries.filter((e) => e.speech).map((e) => e.model),
      stt: entries.filter((e) => e.audio).map(({ model: m }) => ({ id: m.id, label: m.label, languages: m.languages })),
    };
  },
  async synth(req, ctx) {
    // Phonon refuses speed and instructions; playback speed is the player's.
    const res = await send("Ollama", ctx, { operation: "ollama_speech", body: { model: req.model, input: req.text, voice: req.voice || "default", response_format: "pcm" } });
    return new Uint8Array(await res.arrayBuffer());
  },
  install(name, ctx) {
    return pullOllamaModel(name, ctx);
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
      return transcript("Ollama", ctx, { operation: "ollama_transcribe", audio, body: {
        model: installed.name, response_format: "json", ...(language ? { language } : {}),
      } });
    },
  },
};

const isVoiceModel = (m: OllamaVoiceTag) => Boolean(m.capabilities?.some((c) => c === "speech" || c === "audio"));
const OLLAMA_NAME = /^[a-z0-9][a-z0-9._-]{0,79}(\/[a-z0-9][a-z0-9._-]{0,79})?(:[A-Za-z0-9._-]{1,64})?$/;

/** Pull a model by its catalog name; Ollama verifies what it downloads, and only speech or audio models are voice's. */
async function pullOllamaModel(name: string, ctx: Ctx): Promise<void> {
  name = name.trim().toLowerCase();
  if (!OLLAMA_NAME.test(name)) throw new SpeechError("Enter a model name from the Ollama catalog, such as phonon or phonon:fr.");
  let res: Response;
  try {
    res = await ctx.voice({ operation: "ollama_pull", body: { model: name } });
  } catch {
    throw new SpeechError("Ollama is not running", 502);
  }
  if (!res.ok) throw await failure("Ollama", res);
  const pulled = (await ollamaVoiceTags(ctx)).find((m) => m.name === name || m.name === `${name}:latest`);
  if (pulled && !isVoiceModel(pulled)) throw new SpeechError(`${pulled.name} is downloaded, but Ollama reports no speech or audio for it, so voice cannot use it.`);
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
  async list(ctx) {
    const { files: _f, ...pack } = WHISTLE_PACK;
    let status: { supported?: boolean; installed?: boolean };
    try { status = await (await ctx.voice({ operation: "whistle_status", signal: ctx.signal })).json(); }
    catch { return { models: [], reason: "Whistle is unavailable." }; }
    if (!status.supported) return { models: [], reason: "Whistle runs on Apple Silicon Macs." };
    const installed = Boolean(status.installed);
    return installed
      ? { models: [], packs: [{ ...pack, installed }], stt: this.transcribe!.models }
      : { models: [], packs: [{ ...pack, installed }], stt: [], reason: "Install the Whistle pack below to dictate on this Mac." };
  },
  async install(pack, ctx) {
    if (pack !== WHISTLE_PACK.id) throw new SpeechError("not a listed voice pack");
    await send("Whistle", ctx, { operation: "whistle_install" });
  },
  transcribe: {
    models: [{ id: "whistle", label: "Whistle", languages: Object.keys(WHISTLE_LANGUAGES) }],
    run(audio, _model, language, ctx) {
      language = language?.split("-")[0];
      if (language && !WHISTLE_LANGUAGES[language]) throw new SpeechError(`Whistle does not transcribe this language. Choose ${Object.values(WHISTLE_LANGUAGES).join(", ")} or "Same as this Mac" in Settings → Voice, or a hosted model.`);
      return transcript("Whistle", ctx, { operation: "whistle_transcribe", audio, body: language ? { language } : {} });
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
      needKey(openai, ctx.env);
      return transcript("OpenAI", ctx, { operation: "openai_transcribe", audio, body: { model, ...(language ? { language: language.split("-")[0]! } : {}), ...(hint ? { prompt: `${hint}.` } : {}) } });
    },
  },
  async synth(req, ctx) {
    needKey(this, ctx.env);
    const res = await send("OpenAI", ctx, { operation: "openai_speech", body: {
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: "pcm",
      ...(instructions(req) ? { instructions: instructions(req) } : {}),
    } });
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
  async list({ env, voice }) {
    const styled = (id: string, label: string): VoiceModel => ({ id, label, voices: named(GEMINI_VOICES), options: [style("Told to the model before the text, e.g. “Say cheerfully”.")] });
    const fallback = { models: [styled("gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS"), styled("gemini-3.8-flash-lite-tts", "Gemini 3.8 Flash-Lite TTS")], stt: [{ id: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe" }, ...GEMINI_STT] };
    if (!env.GEMINI_API_KEY) return fallback;
    // Google retires model names for new keys, so the lists come from the API.
    try {
      const res = await voice({ operation: "gemini_models" });
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
      needKey(gemini, ctx.env);
      const res = await send("Gemini", ctx, { operation: "gemini_generate", target: model, body: {
        contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from(audio).toString("base64") } }, ...(dedicated ? [] : [{ text: ask }])] }],
        ...(dedicated ? {} : { generationConfig: { temperature: 0 } }),
      } });
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; audioTranscription?: { text?: string } }[] } }[] };
      return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.audioTranscription?.text ?? p.text ?? "").join("").trim();
    },
  },
  async synth(req, ctx) {
    needKey(this, ctx.env);
    const res = await send("Gemini", ctx, { operation: "gemini_generate", target: req.model, body: {
      // Gemini takes its style as a spoken direction ahead of the words.
      contents: [{ parts: [{ text: typeof req.options?.style === "string" && req.options.style ? `${req.options.style}: ${req.text}` : req.text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } }, ...(req.language ? { languageCode: req.language } : {}) } },
    } });
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
  async list({ env, voice }) {
    const models = (voices: Voice[]): VoiceModel[] => [
      { id: "eleven_v4", label: "Eleven v4 (expressive narration)", voices, note: "Dialogue API · expressive speech in 90+ languages" },
      { id: "eleven_flash_v2_5", label: "Flash v2.5 (fastest)", voices, options: ELEVEN_OPTIONS },
      { id: "eleven_multilingual_v2", label: "Multilingual v2 (higher quality)", voices, options: ELEVEN_OPTIONS },
    ];
    if (!env.ELEVENLABS_API_KEY) return { models: models([]) };
    try {
      const res = await voice({ operation: "elevenlabs_voices" });
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
      needKey(elevenlabs, ctx.env);
      return transcript("ElevenLabs", ctx, { operation: "elevenlabs_transcribe", audio, body: { model_id: model, ...(language ? { language_code: language.split("-")[0]! } : {}) } });
    },
  },
  async synth(req, ctx) {
    if (req.model === "eleven_v4") {
      if (req.text.length > 2000) throw new SpeechError("Eleven v4 dialogue requests are limited to 2,000 characters here");
      needKey(this, ctx.env);
      const res = await send("ElevenLabs", ctx, { operation: "elevenlabs_dialogue", body: { model_id: req.model, inputs: [{ text: req.text, voice_id: req.voice }], ...(req.language ? { language_code: req.language.split("-")[0] } : {}) } });
      return new Uint8Array(await res.arrayBuffer());
    }
    needKey(this, ctx.env);
    const res = await send("ElevenLabs", ctx, { operation: "elevenlabs_speech", target: req.voice, body: {
      text: req.text,
      model_id: req.model,
      // Only the Flash and Turbo models take a language; it settles words spelled alike.
      ...(req.language && /flash|turbo/.test(req.model) ? { language_code: req.language.split("-")[0] } : {}),
      voice_settings: { stability: num(req.options?.stability, 0.5), similarity_boost: num(req.options?.similarity, 0.75), style: num(req.options?.style, 0) },
    } });
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Local first: a new install reads aloud and dictates for free, and the first that transcribes is dictation's default. */
export const VOICES: VoiceAdapter[] = [ollama, whistle, openai, gemini, elevenlabs];

/** Keys voice providers need that no chat provider already declares (for Settings to store). */
export const VOICE_KEYS = [{ name: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", owner: "elevenlabs" }];

export async function voiceProviders(voice: VoiceTransport, env: Env): Promise<VoiceProviderView[]> {
  return Promise.all(VOICES.map(async (a): Promise<VoiceProviderView> => {
    const { list: _l, synth: _s, install: _i, keyLabel: _k, transcribe, ...info } = a;
    const listed = await a.list({ env, voice });
    const missingKey = a.keyVar && !env[a.keyVar];
    const reason = missingKey ? `Add your ${a.keyLabel ?? a.label} API key.` : listed.reason;
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
export async function installVoicePack(provider: string, pack: string, voice: VoiceTransport, env: Env): Promise<void> {
  const a = VOICES.find((x) => x.id === provider);
  if (!a?.install) throw new SpeechError("this provider has nothing to download");
  await a.install(pack, { env, voice });
}

/** One request's audio as a WAV file. */
export async function speak(req: SpeechRequest, voice: VoiceTransport, env: Env, signal?: AbortSignal): Promise<Uint8Array> {
  const a = VOICES.find((x) => x.id === req.provider);
  if (!a?.synth) throw new SpeechError(a ? "this provider does not read aloud" : "unknown voice provider");
  if (typeof req.model !== "string" || !/^[\w.:/-]{1,100}$/.test(req.model)) throw new SpeechError("invalid voice model");
  if (typeof req.voice !== "string" || req.voice.length > 80) throw new SpeechError("invalid voice");
  if (typeof req.text !== "string" || !req.text.trim()) throw new SpeechError("nothing to read");
  if (req.text.length > MAX_SPEECH_CHARS) throw new SpeechError(`text over ${MAX_SPEECH_CHARS} characters`);
  if (req.language !== undefined && req.language !== null && (typeof req.language !== "string" || !LANGUAGE_TAG.test(req.language))) throw new SpeechError("invalid language");
  return wav(await a.synth({ ...req, language: req.language || undefined, options: checkOptions(req.options) }, { env, voice, signal }));
}

export interface TranscribeRequest { provider: string; model: string; language?: string; audio: string }

/** Dictation: base64 WAV in, text out. */
export async function transcribe(req: TranscribeRequest, voice: VoiceTransport, env: Env, signal?: AbortSignal): Promise<string> {
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
  return a.transcribe.run(audio, req.model, req.language || undefined, { env, voice, signal });
}
