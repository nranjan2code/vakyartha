import { speak, transcribe } from "../voice/speech.ts";
import type { VoiceTransport } from "../voice/transport.ts";
import { binary, key, type Context, type MediaRequest, type MediaResult } from "./remote.ts";

export async function audio(req: MediaRequest, ctx: Context, voice: VoiceTransport): Promise<MediaResult> {
  if (req.operation === "create_speech") {
    ctx.guard();
    return { files: [await speak({ provider: req.chosen.provider, model: req.chosen.model, voice: req.voice!, text: req.prompt, language: req.language }, voice, ctx.env, ctx.signal)] };
  }
  if (req.operation === "transcribe_audio") {
    ctx.guard();
    return { files: [], text: await transcribe({ provider: req.chosen.provider, model: req.chosen.model, audio: req.input!.bytes.toString("base64"), language: req.language }, voice, ctx.env, ctx.signal) };
  }
  const headers = { "xi-api-key": key("elevenlabs", ctx) };
  if (req.operation === "isolate_audio") {
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(req.input!.bytes)], { type: req.input!.type }), "input");
    return binary(ctx, "https://api.elevenlabs.io/v1/audio-isolation", headers, form);
  }
  if (req.operation === "create_music") return binary(ctx, "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", { ...headers, "content-type": "application/json" }, JSON.stringify({ prompt: req.prompt, model_id: req.chosen.model, music_length_ms: req.seconds * 1000 }));
  if (req.operation === "create_sound_effect") return binary(ctx, "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", { ...headers, "content-type": "application/json" }, JSON.stringify({ text: req.prompt, model_id: req.chosen.model, duration_seconds: req.seconds }));
  throw new Error("Unsupported audio operation");
}
