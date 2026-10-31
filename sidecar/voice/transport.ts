// Voice's only way out. Each operation names what to do, never where: in the
// desktop app Rust owns every destination, key and upload (src-tauri/src/voice.rs)
// and runs Whistle; `npm run web` uses directVoice below with the same table.

import { installWhistle, runWhistle, whistleInstalled, whistleSupported } from "./whistle.ts";

export type VoiceOperation =
  | "ollama_tags" | "ollama_show" | "ollama_speech" | "ollama_transcribe" | "ollama_pull"
  | "openai_speech" | "openai_transcribe"
  | "gemini_models" | "gemini_generate"
  | "elevenlabs_voices" | "elevenlabs_speech" | "elevenlabs_dialogue" | "elevenlabs_transcribe"
  | "whistle_status" | "whistle_install" | "whistle_transcribe";

/** `body`: JSON for the provider, or the upload's text fields when `audio` is a recording. `target`: a model or voice in the path. */
export interface VoiceCall { operation: VoiceOperation; body?: Record<string, unknown>; target?: string; audio?: Uint8Array; signal?: AbortSignal }
/** An HTTP-shaped answer; Whistle answers JSON ({supported, installed}, {ok}, {text} or {error}). */
export type VoiceTransport = (call: VoiceCall) => Promise<Response>;

/** A recording's size limit: about four minutes of 16 kHz mono WAV. */
export const MAX_RECORDING_BYTES = 8_000_000;

type Env = Record<string, string | undefined>;

export function ollamaBase(env: Env): string {
  const host = (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

const ROUTES: Record<Exclude<VoiceOperation, `whistle_${string}`>, { url: (env: Env, target?: string) => string; get?: true; key?: [string, string, string] }> = {
  ollama_tags: { url: (env) => `${ollamaBase(env)}/api/tags`, get: true },
  ollama_show: { url: (env) => `${ollamaBase(env)}/api/show` },
  ollama_speech: { url: (env) => `${ollamaBase(env)}/v1/audio/speech` },
  ollama_transcribe: { url: (env) => `${ollamaBase(env)}/v1/audio/transcriptions` },
  ollama_pull: { url: (env) => `${ollamaBase(env)}/api/pull` },
  openai_speech: { url: () => "https://api.openai.com/v1/audio/speech", key: ["OPENAI_API_KEY", "authorization", "Bearer "] },
  openai_transcribe: { url: () => "https://api.openai.com/v1/audio/transcriptions", key: ["OPENAI_API_KEY", "authorization", "Bearer "] },
  gemini_models: { url: () => "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", get: true, key: ["GEMINI_API_KEY", "x-goog-api-key", ""] },
  gemini_generate: { url: (_, t) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(t ?? "")}:generateContent`, key: ["GEMINI_API_KEY", "x-goog-api-key", ""] },
  elevenlabs_voices: { url: () => "https://api.elevenlabs.io/v1/voices", get: true, key: ["ELEVENLABS_API_KEY", "xi-api-key", ""] },
  elevenlabs_speech: { url: (_, t) => `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(t ?? "")}?output_format=pcm_24000`, key: ["ELEVENLABS_API_KEY", "xi-api-key", ""] },
  elevenlabs_dialogue: { url: () => "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=pcm_24000", key: ["ELEVENLABS_API_KEY", "xi-api-key", ""] },
  elevenlabs_transcribe: { url: () => "https://api.elevenlabs.io/v1/speech-to-text", key: ["ELEVENLABS_API_KEY", "xi-api-key", ""] },
};

const answer = (body: unknown, status = 200) => Response.json(body, { status });

/** The browser development server's transport: plain HTTP with keys from its environment, Whistle run in-process. */
export function directVoice(env: Env, f: typeof fetch = fetch, dir = ""): VoiceTransport {
  return async ({ operation, body, target, audio, signal }) => {
    if (operation === "whistle_status") return answer({ supported: whistleSupported(), installed: whistleSupported() && await whistleInstalled(dir) });
    if (operation === "whistle_install") return installWhistle(dir, f).then(() => answer({ ok: true }), (err: Error) => answer({ error: err.message }, 502));
    if (operation === "whistle_transcribe") {
      if (!(await whistleInstalled(dir))) return answer({ error: "Install the Whistle pack in Providers → Whistle." }, 400);
      return runWhistle(dir, audio!, typeof body?.language === "string" ? body.language : undefined, signal).then((text) => answer({ text }), (err: Error) => answer({ error: err.message }, 502));
    }
    const route = ROUTES[operation];
    const headers: Record<string, string> = {};
    if (route.key) {
      const value = env[route.key[0]];
      if (!value) throw new Error(`${route.key[0]} is not set`);
      headers[route.key[1]] = `${route.key[2]}${value}`;
    }
    let payload: BodyInit | undefined;
    if (audio) {
      const form = new FormData();
      for (const [k, v] of Object.entries(body ?? {})) form.append(k, String(v));
      form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "speech.wav");
      payload = form;
    } else if (!route.get) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(operation === "ollama_pull" ? { model: body?.model, stream: false } : body ?? {});
    }
    return f(route.url(env, target), { method: route.get ? "GET" : "POST", headers, body: payload, signal: signal ?? (route.get ? AbortSignal.timeout(5000) : undefined) });
  };
}
