// Voice in the engine: the one entry point the server and settings use. Speech
// and transcription providers live in speech.ts, the local transcription
// engine in whistle.ts; this adds the HTTP routes the window calls.

import type { HostRequest, HostResponse } from "@vak/host";
import { json, readJson } from "@vak/host";
import type { ProviderEntry } from "@vak/providers";
import { cleanDictationByModel, resolveByModel } from "./resolve.ts";
import { installVoicePack, MAX_RECORDING_BYTES, speak, SpeechError, transcribe, voiceProviders } from "./speech.ts";

export { VOICE_KEYS } from "./speech.ts";

export type Route = (req: HostRequest, res: HostResponse, url: URL) => Promise<boolean>;

/** Voice: the providers, installing a listed local voice pack, one sentence-sized piece of audio, and dictation. */
export function voiceRoutes(voiceDir: string, log: (line: string) => void, providers: () => ProviderEntry[] = () => []): Route {
  return async (req, res, url) => {
    if (url.pathname === "/api/voice/resolve" && req.method === "POST") {
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      try {
        const b = await readJson(req);
        const ok = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
        if (!ok(b.provider, 80) || !ok(b.model, 200) || !ok(b.question, 2000) || !ok(b.said, 1000) || !b.schema || typeof b.schema !== "object") return json(res, 400, { error: "invalid request" }), true;
        json(res, 200, { answer: await resolveByModel(providers(), { provider: b.provider as string, model: b.model as string, question: b.question as string, said: b.said as string, schema: b.schema as never }, abort.signal) });
      } catch (err) {
        if (abort.signal.aborted) return true;
        log(`voice resolve: ${(err as Error).message}`);
        json(res, 502, { error: (err as Error).message });
      }
      return true;
    }
    if (url.pathname === "/api/voice/clean" && req.method === "POST") {
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      try {
        const b = await readJson(req);
        const ok = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
        if (!ok(b.provider, 80) || !ok(b.model, 200) || typeof b.text !== "string") return json(res, 400, { error: "invalid request" }), true;
        const text = await cleanDictationByModel(providers(), { provider: b.provider as string, model: b.model as string, text: b.text as string }, abort.signal);
        json(res, 200, { text });
      } catch (err) {
        if (abort.signal.aborted) return true;
        log(`voice clean: ${(err as Error).message}`);
        json(res, 200, { text: "" });
      }
      return true;
    }
    if (url.pathname === "/api/voice" && req.method === "GET") {
      json(res, 200, await voiceProviders(process.env, fetch, voiceDir));
      return true;
    }
    if (url.pathname === "/api/voice/install" && req.method === "POST") {
      try {
        const body = await readJson(req);
        await installVoicePack(String(body.provider ?? ""), String(body.pack ?? ""), process.env, voiceDir);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, err instanceof SpeechError ? err.status : 500, { error: (err as Error).message });
      }
      return true;
    }
    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      // A recording outgrows readJson's limit, so this body has its own (base64 of the WAV cap).
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_RECORDING_BYTES * 1.4) {
          json(res, 413, { error: "the recording is too long" });
          return true;
        }
      }
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      try {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        const text = await transcribe({ provider: String(body.provider), model: String(body.model), language: typeof body.language === "string" ? body.language : undefined, audio: body.audio as string }, process.env, fetch, abort.signal, voiceDir);
        json(res, 200, { text });
      } catch (err) {
        if (abort.signal.aborted) return true;
        if (!(err instanceof SpeechError)) log(`transcribe: ${(err as Error).message}`);
        json(res, err instanceof SpeechError ? err.status : err instanceof SyntaxError ? 400 : 500, { error: (err as Error).message });
      }
      return true;
    }
    if (url.pathname !== "/api/speech" || req.method !== "POST") return false;
    const body = await readJson(req);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const audio = await speak({ provider: body.provider, model: body.model, voice: body.voice, text: body.text, options: body.options, language: body.language }, process.env, fetch, abort.signal);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length, "cache-control": "no-store" });
      res.end(audio);
    } catch (err) {
      if (abort.signal.aborted) return true;
      if (!(err instanceof SpeechError)) log(`speech: ${(err as Error).message}`);
      json(res, err instanceof SpeechError ? err.status : 500, { error: (err as Error).message });
    }
    return true;
  };
}
