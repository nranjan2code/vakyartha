import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS } from "../sidecar/settings.ts";
import { MAX_SPEECH_CHARS, pullOllamaPack, speak, SpeechError, transcribe, voiceProviders, wav } from "../sidecar/voice.ts";
import { downsample, mergeResults, wav16k } from "../src/dictation.ts";
import { speakable, speechChunks } from "../src/speech-text.ts";

interface Call { url: string; init?: RequestInit }
function fake(routes: Record<string, (init?: RequestInit) => Response>): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) throw new TypeError("fetch failed");
    return hit[1](init);
  }) as typeof fetch;
  return { f, calls };
}
const pcm = () => new Response(new Uint8Array([1, 0, 2, 0]));
const body = (c: Call) => JSON.parse(String(c.init?.body)) as Record<string, unknown>;

test("wav writes a 24 kHz mono 16-bit header with the true sizes", () => {
  const out = wav(new Uint8Array(10));
  const v = new DataView(out.buffer);
  assert.equal(Buffer.from(out.slice(0, 4)).toString(), "RIFF");
  assert.equal(v.getUint32(4, true), 46);
  assert.equal(v.getUint32(24, true), 24_000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 10);
  assert.equal(out.length, 54);
});

test("speech chunks start short, follow sentences and stay under the limit", () => {
  const text = `Hello there. ${"This is a longer sentence that keeps going. ".repeat(20)}See https://example.com/x for more.`;
  const chunks = speechChunks(text);
  assert.ok(chunks[0]!.length <= 160);
  assert.ok(chunks.every((c) => c.length <= 420 && c.length > 0));
  assert.ok(chunks.at(-1)!.includes("See link for more."));
  assert.deepEqual(speechChunks("```\n\n---\n"), []);
  assert.equal(speakable("**bold** and `code`"), "bold and code");
  assert.ok(speechChunks("x".repeat(5000)).every((c) => c.length <= 420));
});

test("Ollama lists installed speech models with their voices, default first", async () => {
  const { f } = fake({
    "/api/tags": () => Response.json({ models: [{ name: "phonon:latest", capabilities: ["speech"] }, { name: "qwen3.5:4b-mlx", capabilities: ["completion"] }] }),
    "/api/show": () => Response.json({ voices: ["Zoey", "default", "Easton"] }),
  });
  const [ollama, openai, gemini, eleven] = await voiceProviders({}, f);
  assert.equal(ollama!.available, true);
  assert.deepEqual(ollama!.models.map((m) => m.id), ["phonon:latest"]);
  assert.deepEqual(ollama!.models[0]!.voices.map((v) => v.id), ["default", "Zoey", "Easton"]);
  assert.equal(ollama!.packs!.find((p) => p.id === "phonon:latest")!.installed, true);
  assert.equal(ollama!.packs!.find((p) => p.id === "phonon:fr")!.installed, false);
  for (const p of [openai, gemini, eleven]) assert.equal(p!.available, false);
  assert.match(openai!.reason!, /API key/);
});

test("Ollama without a speech model, or not running, says what to do", async () => {
  const none = await voiceProviders({}, fake({ "/api/tags": () => Response.json({ models: [] }) }).f);
  assert.match(none[0]!.reason!, /voice pack/);
  const down = await voiceProviders({}, fake({}).f);
  assert.match(down[0]!.reason!, /not running/);
  assert.equal(down[0]!.available, false);
});

test("hosted providers become available with a key; ElevenLabs lists the library's voices", async () => {
  const { f, calls } = fake({ "/api/tags": () => Response.json({ models: [] }), "api.elevenlabs.io/v1/voices": () => Response.json({ voices: [{ voice_id: "abc", name: "Rachel" }] }), "/v1beta/models?": () => Response.json({ models: [] }) });
  const list = await voiceProviders({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "k", ELEVENLABS_API_KEY: "e" }, f);
  assert.deepEqual(list.map((p) => p.available), [false, true, true, true]);
  assert.deepEqual(list[3]!.models[0]!.voices, [{ id: "abc", name: "Rachel" }]);
  assert.equal((calls.find((c) => c.url.includes("elevenlabs"))!.init!.headers as Record<string, string>)["xi-api-key"], "e");
});

test("each provider is asked for raw PCM and gets a WAV back", async () => {
  const { f, calls } = fake({
    "127.0.0.1:11434/v1/audio/speech": pcm,
    "api.openai.com/v1/audio/speech": pcm,
    "api.elevenlabs.io/v1/text-to-speech/abc": pcm,
    "generativelanguage.googleapis.com": () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([1, 0]).toString("base64") } }] } }] }),
  });
  const env = { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" };
  const ollama = await speak({ provider: "ollama", model: "phonon:latest", voice: "Zoey", text: "Hi." }, env, f);
  assert.equal(ollama.length, 48);
  assert.deepEqual(body(calls[0]!), { model: "phonon:latest", input: "Hi.", voice: "Zoey", response_format: "pcm" });
  await speak({ provider: "openai", model: "tts-1", voice: "nova", text: "Hi." }, env, f);
  assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization, "Bearer o");
  assert.equal(body(calls[1]!).response_format, "pcm");
  const g = await speak({ provider: "gemini", model: "gemini-2.5-flash-preview-tts", voice: "Kore", text: "Hi." }, env, f);
  assert.equal(g.length, 46);
  assert.equal((calls[2]!.init!.headers as Record<string, string>)["x-goog-api-key"], "g");
  await speak({ provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "abc", text: "Hi." }, env, f);
  assert.match(calls[3]!.url, /output_format=pcm_24000/);
});

test("speech requests are validated before anything is sent", async () => {
  const { f, calls } = fake({});
  const bad = [
    { provider: "nope", model: "m", voice: "v", text: "t" },
    { provider: "ollama", model: "m; rm", voice: "v", text: "t" },
    { provider: "ollama", model: "m", voice: "v", text: " " },
    { provider: "ollama", model: "m", voice: "v", text: "x".repeat(MAX_SPEECH_CHARS + 1) },
  ];
  for (const r of bad) await assert.rejects(speak(r, {}, f), SpeechError);
  await assert.rejects(speak({ provider: "openai", model: "tts-1", voice: "nova", text: "hi" }, {}, f), /API key/);
  assert.equal(calls.length, 0);
});

test("a provider's error message reaches the person", async () => {
  const { f } = fake({ "/v1/audio/speech": () => Response.json({ error: { message: 'voice "x" not found' } }, { status: 400 }) });
  await assert.rejects(speak({ provider: "ollama", model: "phonon", voice: "x", text: "hi" }, {}, f), /Ollama: voice "x" not found/);
});

test("only listed voice packs can be pulled", async () => {
  const { f, calls } = fake({ "/api/pull": () => Response.json({ status: "success" }) });
  await assert.rejects(pullOllamaPack("evil:latest", {}, f), /not a listed/);
  await pullOllamaPack("phonon:fr", {}, f);
  assert.deepEqual(body(calls[0]!), { model: "phonon:fr", stream: false });
});

test("the ElevenLabs key is a stored secret", () => {
  const s = SETTINGS.find((x) => x.name === "ELEVENLABS_API_KEY");
  assert.equal(s?.secret, true);
  assert.equal(s?.group, "voice");
});

test("style and sound options reach each provider in its own form", async () => {
  const { f, calls } = fake({
    "127.0.0.1:11434/v1/audio/speech": pcm,
    "api.openai.com": pcm,
    "api.elevenlabs.io": pcm,
    "generativelanguage.googleapis.com": () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: "AQA=" } }] } }] }),
  });
  const env = { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" };
  const options = { style: "Calm narrator", stability: 0.3, bogus_key: "x", similarity: 7 };
  await speak({ provider: "ollama", model: "phonon", voice: "Zoey", text: "Hi.", options }, env, f);
  assert.equal("instructions" in body(calls[0]!), false);
  await speak({ provider: "openai", model: "gpt-4o-mini-tts", voice: "nova", text: "Hi.", options }, env, f);
  assert.equal(body(calls[1]!).instructions, "Calm narrator");
  await speak({ provider: "gemini", model: "gemini-2.5-flash-preview-tts", voice: "Kore", text: "Hi.", options }, env, f);
  assert.equal((body(calls[2]!) as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text, "Calm narrator: Hi.");
  await speak({ provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "abc", text: "Hi.", options }, env, f);
  // A text style is not ElevenLabs' numeric style, and an out-of-range similarity is dropped.
  assert.deepEqual(body(calls[3]!).voice_settings, { stability: 0.3, similarity_boost: 0.75, style: 0 });
  await assert.rejects(speak({ provider: "openai", model: "tts-1", voice: "nova", text: "Hi.", options: { style: "a\nb" } }, env, f), /one short line/);
});

test("models declare the controls they accept", async () => {
  const list = await voiceProviders({ OPENAI_API_KEY: "o" }, fake({ "/api/tags": () => Response.json({ models: [] }) }).f);
  const openai = list.find((p) => p.id === "openai")!;
  assert.deepEqual(openai.models.find((m) => m.id === "gpt-4o-mini-tts")!.options!.map((o) => o.id), ["style"]);
  assert.equal(openai.models.find((m) => m.id === "tts-1-hd")!.options, undefined);
  assert.deepEqual(list.find((p) => p.id === "elevenlabs")!.models[0]!.options!.map((o) => o.id), ["stability", "similarity", "style"]);
});

const GEMINI_MODELS = {
  models: [
    { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash-tts", displayName: "Gemini 3.8 Flash TTS", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-transcribe", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-transcribe-live", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
  ],
};

test("Gemini's speech and transcription models come from its API, newest first", async () => {
  const { f } = fake({ "/api/tags": () => Response.json({ models: [] }), "/v1beta/models?": () => Response.json(GEMINI_MODELS) });
  const g = (await voiceProviders({ GEMINI_API_KEY: "g" }, f)).find((p) => p.id === "gemini")!;
  assert.deepEqual(g.models.map((m) => m.id), ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"]);
  assert.deepEqual(g.stt!.map((m) => m.id), ["gemini-3.5-transcribe", "gemini-flash-latest"]);
  const keyless = (await voiceProviders({}, f)).find((p) => p.id === "gemini")!;
  assert.ok(keyless.stt!.length > 0);
  assert.equal((await voiceProviders({}, f)).find((p) => p.id === "ollama")!.stt, undefined);
});

test("dictation reaches each provider in its own form", async () => {
  const recording = Buffer.from(wav16k(new Int16Array(16000))).toString("base64");
  const { f, calls } = fake({
    "api.openai.com/v1/audio/transcriptions": () => Response.json({ text: " book a table " }),
    "api.elevenlabs.io/v1/speech-to-text": () => Response.json({ text: "hello" }),
    "gemini-3.5-transcribe:generateContent": () => Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text: "dedicated" } }] } }] }),
    "gemini-flash-latest:generateContent": () => Response.json({ candidates: [{ content: { parts: [{ text: "general" }] } }] }),
  });
  const env = { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" };
  assert.equal(await transcribe({ provider: "openai", model: "gpt-4o-mini-transcribe", language: "en-US", audio: recording }, env, f), "book a table");
  const form = calls[0]!.init!.body as FormData;
  assert.equal(form.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(form.get("language"), "en");
  assert.equal((form.get("file") as File).type, "audio/wav");
  assert.equal(await transcribe({ provider: "elevenlabs", model: "scribe_v1", audio: recording }, env, f), "hello");
  assert.equal((calls[1]!.init!.body as FormData).get("model_id"), "scribe_v1");
  assert.equal(await transcribe({ provider: "gemini", model: "gemini-3.5-transcribe", audio: recording }, env, f), "dedicated");
  assert.equal((body(calls[2]!) as { contents: { parts: unknown[] }[] }).contents[0]!.parts.length, 1);
  assert.equal(await transcribe({ provider: "gemini", model: "gemini-flash-latest", audio: recording }, env, f), "general");
  assert.equal((body(calls[3]!) as { contents: { parts: unknown[] }[] }).contents[0]!.parts.length, 2);
});

test("dictation input is checked before anything is sent", async () => {
  const { f, calls } = fake({});
  const ok = Buffer.from(wav16k(new Int16Array(10))).toString("base64");
  await assert.rejects(transcribe({ provider: "ollama", model: "phonon", audio: ok }, {}, f), /does not transcribe/);
  await assert.rejects(transcribe({ provider: "openai", model: "a b", audio: ok }, {}, f), /invalid transcription model/);
  await assert.rejects(transcribe({ provider: "openai", model: "whisper-1", language: "english!", audio: ok }, {}, f), /invalid language/);
  await assert.rejects(transcribe({ provider: "openai", model: "whisper-1", audio: Buffer.from("not audio at all, really").toString("base64") }, {}, f), /not a WAV/);
  await assert.rejects(transcribe({ provider: "openai", model: "whisper-1", audio: ok }, {}, f), /API key/);
  assert.equal(calls.length, 0);
});

test("recordings are downsampled to 16 kHz mono WAV", () => {
  const second = new Float32Array(48000).fill(0.5);
  const pcm = downsample([second.subarray(0, 20000), second.subarray(20000)], 48000);
  assert.equal(pcm.length, 16000);
  assert.ok(Math.abs(pcm[100]! - 0.5 * 0x7fff) < 2);
  const file = wav16k(pcm);
  const v = new DataView(file.buffer);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 32000);
});

test("dictation results join once, whether phrases arrive separately or repeated", () => {
  // Chrome: one result per phrase.
  assert.equal(mergeResults(["Hello how are you", " and what is the time"]), "Hello how are you and what is the time");
  // Safari: the same phrase again, or the whole utterance so far.
  assert.equal(mergeResults(["Hello how are you", "Hello how are you"]), "Hello how are you");
  assert.equal(mergeResults(["Hello how", "Hello how are you?"]), "Hello how are you?");
  assert.equal(mergeResults(["Hello how are you", "Hello, how are you."]), "Hello, how are you.");
  assert.equal(mergeResults(["", "  "]), "");
});
