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
export interface VoiceModel { id: string; label: string; voices: Voice[]; note?: string; options?: VoiceOption[] }
/** A local model the app can pull for an adapter, from a fixed list (never a name typed in). */
export interface VoicePack { id: string; label: string; size: string; license: string; installed: boolean }

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
  stt?: { id: string; label: string }[];
  /** Whether it can transcribe at all, once set up. */
  transcribes: boolean;
}

export interface SpeechRequest { provider: string; model: string; voice: string; text: string; options?: Record<string, unknown> }

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
  list(ctx: Ctx): Promise<{ models: VoiceModel[]; reason?: string; packs?: VoicePack[]; stt?: { id: string; label: string }[] }>;
  /** One request's PCM; absent for a provider that only transcribes. */
  synth?(req: SpeechRequest, ctx: Ctx): Promise<Uint8Array>;
  /** Install one of the packs it lists. */
  install?(pack: string, ctx: Ctx): Promise<void>;
  /** Dictation: a WAV recording to text. */
  transcribe?: { models: { id: string; label: string }[]; run(audio: Uint8Array, model: string, language: string | undefined, ctx: Ctx): Promise<string> };
}

export class SpeechError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const named = (ids: string[]): Voice[] => ids.map((id) => ({ id, name: id }));

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
  if (!k) throw new SpeechError(`Add your ${a.keyLabel ?? a.label} API key on its Voice page in Integrations.`);
  return k;
}

// --- Ollama (Phonon) ------------------------------------------------------------

export function ollamaBase(env: Env): string {
  const host = (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

const NC = "CC BY-NC 4.0 (non-commercial)";
/** The Phonon tags offered for one-click install; sizes from the Ollama library. */
export const OLLAMA_PACKS: Omit<VoicePack, "installed">[] = [
  { id: "phonon:latest", label: "Phonon · English", size: "113 MB", license: "Apache 2.0" },
  { id: "phonon:multilingual", label: "Phonon · Five languages", size: "123 MB", license: NC },
  { id: "phonon:fr", label: "Phonon · French", size: "123 MB", license: NC },
  { id: "phonon:de", label: "Phonon · German", size: "123 MB", license: NC },
  { id: "phonon:es", label: "Phonon · Spanish", size: "123 MB", license: NC },
  { id: "phonon:pt", label: "Phonon · Portuguese", size: "123 MB", license: NC },
];

const ollama: VoiceAdapter = {
  id: "ollama",
  label: "Ollama",
  publisher: "Ollama · Phonon by Gradium",
  summary: "Speech that runs on this Mac. Free and private.",
  description: "Phonon text-to-speech models run in Ollama on Apple Silicon (Ollama 0.40.9 or later). Text never leaves this computer. Install a voice pack below; English includes 38 voices.",
  local: true,
  cost: "Free · runs on this Mac",
  async list({ env, f }) {
    let tags: { models?: { name: string; capabilities?: string[] }[] };
    try {
      tags = (await (await f(`${ollamaBase(env)}/api/tags`, { signal: AbortSignal.timeout(3000) })).json()) as typeof tags;
    } catch {
      return { models: [], packs: OLLAMA_PACKS.map((p) => ({ ...p, installed: false })), reason: "Ollama is not running. Start Ollama, then refresh." };
    }
    const speech = (tags.models ?? []).filter((m) => m.capabilities?.includes("speech"));
    const installed = new Set(speech.map((m) => m.name));
    const packs = OLLAMA_PACKS.map((p) => ({ ...p, installed: installed.has(p.id) }));
    if (!speech.length) return { models: [], packs, reason: "No speech model is installed yet. Install a voice pack below." };
    const models = await Promise.all(speech.map(async (m): Promise<VoiceModel> => {
      let voices: string[] = [];
      try {
        const res = await f(`${ollamaBase(env)}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.name }) });
        voices = ((await res.json()) as { voices?: string[] }).voices ?? [];
      } catch {
        /* listed without voices: "default" still works */
      }
      const pack = OLLAMA_PACKS.find((p) => p.id === m.name);
      return {
        id: m.name,
        label: pack ? pack.label : m.name.replace(/:latest$/, ""),
        // "default" first: it is what the model uses when none is named.
        voices: [{ id: "default", name: "Default" }, ...named(voices.filter((v) => v !== "default"))],
        note: pack?.license === NC ? "Non-commercial licence" : undefined,
      };
    }));
    return { models, packs };
  },
  async synth(req, ctx) {
    // Phonon refuses speed and instructions; playback speed is the player's.
    const res = await post("Ollama", ctx, `${ollamaBase(ctx.env)}/v1/audio/speech`, {}, { model: req.model, input: req.text, voice: req.voice || "default", response_format: "pcm" });
    return new Uint8Array(await res.arrayBuffer());
  },
  install(pack, ctx) {
    return pullOllamaPack(pack, ctx.env, ctx.f);
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
    models: [{ id: "whistle", label: "Whistle" }],
    async run(audio, _model, language, { dir, signal }) {
      if (language && !WHISTLE_LANGUAGES[language]) throw new SpeechError(`Whistle does not transcribe this language. Choose ${Object.values(WHISTLE_LANGUAGES).join(", ")} or "Same as this Mac" in Settings → Voice, or a hosted model.`);
      if (!(await whistleInstalled(dir))) throw new SpeechError("Install the Whistle pack in Integrations → Voice → Whistle.");
      return runWhistle(dir, audio, language, signal);
    },
  },
};

const STYLE_PRESETS = ["Warm and friendly", "Calm, measured narrator", "Cheerful and upbeat", "Clear newsreader", "Soft and gentle", "Confident presenter"];
const style = (hint: string): VoiceOption => ({ id: "style", kind: "text", label: "Style", hint, presets: STYLE_PRESETS, max: 300 });

// --- OpenAI -----------------------------------------------------------------------

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
        { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", voices: named(OPENAI_VOICES), options: [style("How the voice should sound: tone, pace, personality.")] },
        { id: "tts-1", label: "TTS-1 (fast)", voices: named(OPENAI_CLASSIC) },
        { id: "tts-1-hd", label: "TTS-1 HD (higher quality)", voices: named(OPENAI_CLASSIC) },
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
      return upload("OpenAI", ctx, "https://api.openai.com/v1/audio/transcriptions", { authorization: `Bearer ${key(openai, ctx.env)}` }, audio, { model, ...(language ? { language } : {}) });
    },
  },
  async synth(req, ctx) {
    const res = await post("OpenAI", ctx, "https://api.openai.com/v1/audio/speech", { authorization: `Bearer ${key(this, ctx.env)}` }, {
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: "pcm",
      ...(typeof req.options?.style === "string" && req.options.style ? { instructions: req.options.style } : {}),
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
    const fallback = { models: [styled("gemini-2.5-flash-preview-tts", "Gemini 2.5 Flash TTS")], stt: GEMINI_STT };
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
      const ask = `Transcribe this recording exactly as spoken${language ? ` (language: ${language})` : ""}. Reply with the transcript only, no notes. If nothing is said, reply with nothing.`;
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
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } } } },
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
    models: [{ id: "scribe_v1", label: "Scribe" }],
    run(audio, model, language, ctx) {
      return upload("ElevenLabs", ctx, "https://api.elevenlabs.io/v1/speech-to-text", { "xi-api-key": key(elevenlabs, ctx.env) }, audio, { model_id: model, ...(language ? { language_code: language } : {}) });
    },
  },
  async synth(req, ctx) {
    const res = await post("ElevenLabs", ctx, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=pcm_24000`, { "xi-api-key": key(this, ctx.env) }, {
      text: req.text,
      model_id: req.model,
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
    // Ready when it can read aloud or, for a listener only, transcribe.
    const available = !reason && (listed.models.some((m) => m.voices.length > 0) || (!a.synth && Boolean(listed.stt?.length)));
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
  return wav(await a.synth({ ...req, options: checkOptions(req.options) }, { env, f, signal, dir: "" }));
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
  if (req.language !== undefined && req.language !== "" && (typeof req.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(req.language))) throw new SpeechError("invalid language");
  if (typeof req.audio !== "string") throw new SpeechError("no recording");
  const audio = new Uint8Array(Buffer.from(req.audio, "base64"));
  if (audio.length > MAX_RECORDING_BYTES) throw new SpeechError("the recording is too long");
  if (audio.length < 44 || Buffer.from(audio.subarray(0, 4)).toString() !== "RIFF" || Buffer.from(audio.subarray(8, 12)).toString() !== "WAVE") throw new SpeechError("the recording is not a WAV file");
  return a.transcribe.run(audio, req.model, req.language?.split("-")[0] || undefined, { env, f, signal, dir });
}
