// Voice in the engine: the one entry point the server and settings use. Speech
// and transcription providers live in speech.ts, the local transcription
// engine in whistle.ts; this adds the HTTP routes the window calls.

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readJson } from "@vak/host";
import { installVoicePack, MAX_RECORDING_BYTES, speak, SpeechError, transcribe, voiceProviders } from "./speech.ts";

export { VOICE_KEYS } from "./speech.ts";

export type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

/** Voice: the providers, installing a listed local voice pack, one sentence-sized piece of audio, and dictation. */
export function voiceRoutes(voiceDir: string, log: (line: string) => void): Route {
  return async (req, res, url) => {
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
