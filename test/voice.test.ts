import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS } from "../sidecar/settings.ts";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installVoicePack, MAX_SPEECH_CHARS, pullOllamaPack, speak, SpeechError, transcribe, voiceProviders, wav } from "../sidecar/voice/speech.ts";
import { WHISTLE_PACK, whistleDir, whistleSupported } from "../sidecar/voice/whistle.ts";
import { dictationLanguage, dictationPrefs, downsample, mergeResults, wav16k } from "../src/voice/dictation.ts";
import { voiceMaster } from "../src/voice/master.ts";
import { speakable, speechChunks, speechLocale, spokenSurface, textLanguage } from "../src/voice/speech-text.ts";
import type { ResolvedNode, ResolvedSurface } from "@vak/core";
import { type VoiceProvider, voiceFor, voicePrefs } from "../src/voice/read-aloud.ts";

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

test("numbers, signs and abbreviations are said, not split at a dot", () => {
  const en = speakable("The index rose +0.39% to 24,812.5 today, e.g. after a -1.2% dip; it costs $4.50 vs. ₹1,200 at 3 p.m. 🙂", "en");
  assert.equal(en, "The index rose plus 0 point 3 9 percent to 24,812 point 5 today, for example, after a minus 1 point 2 percent dip; it costs 4 dollars 50 versus 1,200 rupees at 3 PM");
  assert.deepEqual(speechChunks("Up +0.39% today. Down 1.25% yesterday.", "en"), ["Up plus 0 point 3 9 percent today. Down 1 point 2 5 percent yesterday."]);
  // French keeps its own decimal comma and gets its own words; an unknown language only loses markup.
  assert.equal(speakable("Le CAC est en hausse de +0,39 % aujourd'hui", "fr"), "Le CAC est en hausse de plus 0,39 pour cent aujourd'hui");
  assert.equal(speakable("**+0.39%** → live", undefined), "+0.39%, live");
  assert.equal(speakable("e\u0301te\u0301", "fr"), "été");
});

test("a reply's language is told by its script or its common words, and unknown when unsure", () => {
  assert.equal(textLanguage("The market is open and the prices are rising for this week."), "en");
  assert.equal(textLanguage("Le marché est ouvert et les prix sont en hausse pour la semaine."), "fr");
  assert.equal(textLanguage("Der Markt ist heute offen und die Preise sind für die Woche gestiegen."), "de");
  assert.equal(textLanguage("आज बाज़ार खुला है और कीमतें बढ़ रही हैं"), "hi");
  assert.equal(textLanguage("Nifty 50 +0.39%"), undefined);
  assert.equal(speechLocale("en", ["fr-FR", "en-GB", "en"]), "en-GB");
  assert.equal(speechLocale("de", ["en-GB"]), "de");
  assert.equal(speechLocale(undefined, ["en-GB"]), undefined);
});

const node = (type: string, props: Record<string, unknown>, children: ResolvedNode[] = []): ResolvedNode => ({ key: type, id: type, type, props, children });

test("an interface is said as content: no component names, controls or actions", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ stock: `S${i}`, price: `${i}.5`, change: "+0.39%" }));
  const surface = {
    id: "s", title: "Market snapshot",
    root: node("stack", {}, [
      node("card", { title: "Nifty 50", subtitle: "closing", badge: "live", body: "Index rose +0.39% today." }),
      node("stat", { label: "Change", value: "24,812.5", delta: "+0.39%" }),
      node("table", { columns: [{ key: "stock", label: "Stock" }, { key: "price", label: "Price" }, { key: "change", label: "Change" }], rows }),
      node("select", { label: "Period", options: ["1D", "1W"] }),
      node("button", { label: "Refresh", action: "refresh_quotes" }),
      node("chart", { kind: "line", labels: ["Mon", "Wed"], series: [{ name: "Nifty", values: [24700.1, 24812.5] }] }),
      node("alert", { tone: "warning", title: "Delayed", body: "Prices lag by 15 minutes." }),
    ]),
  } as unknown as ResolvedSurface;
  const said = spokenSurface(surface, "en");
  assert.doesNotMatch(said, /\[|Card|Button|Select|Refresh|refresh_quotes|1D|→|\|/);
  assert.match(said, /^Market snapshot\.\nNifty 50, closing, live\.\nIndex rose \+0\.39% today\.\nChange, 24,812\.5, up 0\.39%\.\nS0: Price 0\.5, Change \+0\.39%\./);
  assert.match(said, /And 2 more rows\.\nNifty, Mon to Wed: from 24700\.1 to 24812\.5\.\nWarning: Delayed\.\nPrices lag by 15 minutes\.$/);
  assert.doesNotMatch(spokenSurface(surface, "de"), /\b(And|up|Warning)\b/);
  assert.doesNotMatch(spokenSurface(surface), /And 2 more|up 0|Warning/);
});

test("a reply is read by a voice that speaks its language, never a billed one nobody chose", () => {
  const voice = (id: string, languages?: string[], voices = ["default", "Zoey"]) => ({ id, label: id, voices: voices.map((v) => ({ id: v, name: v })), languages });
  const provider = (id: string, local: boolean, models: ReturnType<typeof voice>[], packs: VoiceProvider["packs"] = []): VoiceProvider =>
    ({ id, label: id, publisher: "", summary: "", description: "", icon: "voice", local, cost: "", available: true, models, packs, transcribes: false });
  const english = { provider: "ollama", model: "phonon:latest", voice: "Zoey" };
  const packs = [{ id: "phonon:fr", label: "Phonon · French", size: "", license: "", installed: false, languages: ["fr"] }];
  const onlyEnglish = [provider("ollama", true, [voice("phonon:latest", ["en"])], packs), provider("openai", false, [voice("tts-1")])];
  assert.deepEqual(voiceFor(onlyEnglish, english, "en"), { choice: english });
  assert.deepEqual(voiceFor(onlyEnglish, english, undefined), { choice: english });
  const fr = voiceFor(onlyEnglish, english, "fr");
  assert.deepEqual(fr.choice, english);
  assert.match(fr.missing!, /No French voice is installed.*Install Phonon · French/);
  // The single-language pack wins over the multilingual one, and the voice name carries over when it exists.
  const both = [provider("ollama", true, [voice("phonon:latest", ["en"]), voice("phonon:multilingual", ["en", "fr", "de", "es", "pt"]), voice("phonon:fr", ["fr"], ["default"])])];
  assert.deepEqual(voiceFor(both, english, "fr"), { choice: { provider: "ollama", model: "phonon:fr", voice: "default", options: undefined } });
  assert.equal(voiceFor(both, english, "de").choice.model, "phonon:multilingual");
  assert.equal(voiceFor(both, english, "de").choice.voice, "Zoey");
  // A hosted multilingual voice is kept as chosen.
  const hosted = { provider: "openai", model: "tts-1", voice: "nova" };
  assert.deepEqual(voiceFor(onlyEnglish, hosted, "fr"), { choice: hosted });
});

test("dictation gives a model the most exact language it honours", () => {
  assert.equal(dictationLanguage("en-GB"), "en-GB");
  assert.equal(dictationLanguage("en-GB", ["en", "de"]), "en");
  assert.equal(dictationLanguage("hi-IN", ["en", "de"]), undefined);
  assert.equal(dictationLanguage("", ["en"]), undefined);
});

test("Ollama lists installed speech models with their voices, default first", async () => {
  const { f } = fake({
    "/api/tags": () => Response.json({ models: [{ name: "phonon:latest", capabilities: ["speech"] }, { name: "qwen3.5:4b-mlx", capabilities: ["completion"] }] }),
    "/api/show": () => Response.json({ voices: ["Zoey", "default", "Easton"] }),
  });
  const [ollama, , openai, gemini, eleven] = await voiceProviders({}, f);
  assert.equal(ollama!.available, true);
  assert.deepEqual(ollama!.models.map((m) => m.id), ["phonon:latest"]);
  assert.deepEqual(ollama!.models[0]!.languages, ["en"]);
  assert.deepEqual(ollama!.packs!.find((p) => p.id === "phonon:multilingual")!.languages, ["en", "fr", "de", "es", "pt"]);
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
  assert.deepEqual(list.map((p) => p.available), [false, false, true, true, true]);
  assert.deepEqual(list[4]!.models[0]!.voices, [{ id: "abc", name: "Rachel" }]);
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
  assert.equal(form.get("prompt"), "American English spelling.");
  assert.equal((form.get("file") as File).type, "audio/wav");
  assert.equal(await transcribe({ provider: "elevenlabs", model: "scribe_v1", audio: recording }, env, f), "hello");
  assert.equal((calls[1]!.init!.body as FormData).get("model_id"), "scribe_v1");
  assert.equal(await transcribe({ provider: "gemini", model: "gemini-3.5-transcribe", audio: recording }, env, f), "dedicated");
  assert.equal((body(calls[2]!) as { contents: { parts: unknown[] }[] }).contents[0]!.parts.length, 1);
  assert.equal(await transcribe({ provider: "gemini", model: "gemini-flash-latest", audio: recording }, env, f), "general");
  assert.equal((body(calls[3]!) as { contents: { parts: unknown[] }[] }).contents[0]!.parts.length, 2);
  await transcribe({ provider: "gemini", model: "gemini-flash-latest", language: "en-GB", audio: recording }, env, f);
  assert.match(JSON.stringify(body(calls[4]!)), /in British English spelling \(en-GB\)/);
  await transcribe({ provider: "openai", model: "whisper-1", language: "zh-CN", audio: recording }, env, f);
  assert.equal((calls[5]!.init!.body as FormData).get("language"), "zh");
  assert.equal((calls[5]!.init!.body as FormData).get("prompt"), "Simplified Chinese characters.");
});

test("read aloud tells a voice the language where the model takes one", async () => {
  const { f, calls } = fake({ "/v1/audio/speech": pcm, ":generateContent": () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: "AAA=" } }] } }] }), "api.elevenlabs.io": pcm });
  const env = { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" };
  await speak({ provider: "openai", model: "gpt-4o-mini-tts", voice: "nova", text: "Watch it live", language: "en-GB", options: { style: "Calm" } }, env, f);
  assert.equal(body(calls[0]!).instructions, "Calm Speak British English.");
  await speak({ provider: "openai", model: "tts-1", voice: "nova", text: "hi", language: "en-GB" }, env, f);
  assert.equal(body(calls[1]!).instructions, undefined);
  await speak({ provider: "gemini", model: "gemini-2.5-flash-preview-tts", voice: "Kore", text: "hi", language: "en-IN" }, env, f);
  assert.equal((body(calls[2]!) as { generationConfig: { speechConfig: { languageCode?: string } } }).generationConfig.speechConfig.languageCode, "en-IN");
  await speak({ provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "abc", text: "hi", language: "fr-FR" }, env, f);
  assert.equal(body(calls[3]!).language_code, "fr");
  await assert.rejects(speak({ provider: "openai", model: "tts-1", voice: "nova", text: "hi", language: "british!" }, env, f), /invalid language/);
});

const appleSilicon = { skip: !whistleSupported() && "Whistle runs on Apple Silicon Macs" };

test("Whistle only listens, and asks for its pack before dictation can use it", appleSilicon, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-voice-"));
  const w = (await voiceProviders({}, fake({}).f, dir)).find((p) => p.id === "whistle")!;
  assert.equal(w.local, true);
  assert.equal(w.transcribes, true);
  assert.equal(w.available, false);
  assert.deepEqual(w.stt, []);
  assert.deepEqual(w.models, []);
  assert.deepEqual(w.packs!.map((p) => [p.id, p.installed]), [[WHISTLE_PACK.id, false]]);
  assert.match(w.reason!, /Install the Whistle pack/);
  await assert.rejects(speak({ provider: "whistle", model: "whistle", voice: "x", text: "hi" }, {}), /does not read aloud/);
});

test("the Whistle pack installs only its pinned files, checked by SHA-256", appleSilicon, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-voice-"));
  const { f, calls } = fake({ "huggingface.co": () => new Response(new Uint8Array(WHISTLE_PACK.files[0]!.bytes)) });
  await assert.rejects(installVoicePack("whistle", "whistle@latest", {}, dir, f), /not a listed/);
  await assert.rejects(installVoicePack("openai", "x", {}, dir, f), /no packs/);
  await assert.rejects(installVoicePack("whistle", WHISTLE_PACK.id, {}, dir, f), /does not match its pinned checksum/);
  assert.ok(calls.every((c) => /^https:\/\/huggingface\.co\/Cactus-Compute\/[\w]+\/resolve\/[0-9a-f]{40}\//.test(c.url)));
  assert.equal(existsSync(whistleDir(dir)), false);
  assert.equal(existsSync(`${whistleDir(dir)}.part`), false);
});

test("Whistle refuses a language it was not trained on, and a missing pack, before running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-voice-"));
  const ok = Buffer.from(wav16k(new Int16Array(10))).toString("base64");
  await assert.rejects(transcribe({ provider: "whistle", model: "whistle", language: "hi-IN", audio: ok }, {}, fake({}).f, undefined, dir), /does not transcribe this language/);
  await assert.rejects(transcribe({ provider: "whistle", model: "whistle", language: "en-IN", audio: ok }, {}, fake({}).f, undefined, dir), /Install the Whistle pack/);
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

test("the master switch turns read aloud and dictation off and keeps their own settings", () => {
  const store = new Map<string, string>();
  const events: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, window: g.window };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  g.window = { dispatchEvent: (e: Event) => events.push(e.type) };
  try {
    assert.equal(voiceMaster.on, true, "on by default, so nothing changes for existing installs");
    assert.equal(voicePrefs.enabled, true);
    assert.equal(dictationPrefs.enabled, true);
    voiceMaster.on = false;
    assert.deepEqual(events, ["vak:voice", "vak:dictation"]);
    assert.equal(voicePrefs.enabled, false);
    assert.equal(dictationPrefs.enabled, false);
    assert.equal(voicePrefs.own, true);
    assert.equal(dictationPrefs.own, true);
    dictationPrefs.enabled = false;
    voiceMaster.on = true;
    assert.equal(voicePrefs.enabled, true);
    assert.equal(dictationPrefs.enabled, false, "a setting turned off beneath the switch stays off");
  } finally {
    Object.assign(g, saved);
  }
});

test("end of speech follows the noise floor, and interrupting the app takes more", async () => {
  const { Endpointer } = await import("../src/voice/endpoint.ts");
  const e = new Endpointer();
  const run = (level: number, ms: number, speaking = false) => {
    const out: string[] = [];
    for (let t = 0; t < ms; t += 40) { const ev = e.feed(level, 40, speaking); if (ev) out.push(ev); }
    return out;
  };
  assert.deepEqual(run(0.004, 2000), [], "a quiet room is silence");
  assert.deepEqual(run(0.08, 80), [], "a click is too short to be speech");
  assert.deepEqual(run(0.004, 400), []);
  assert.deepEqual(run(0.08, 1000), ["start"]);
  assert.deepEqual(run(0.004, 400), [], "a pause between words does not end the sentence");
  assert.deepEqual(run(0.08, 400), []);
  assert.deepEqual(run(0.004, 900), ["end"]);
  // A steady fan raises the floor; a level that was speech in a quiet room is then not.
  const fan = new Endpointer();
  for (let t = 0; t < 30_000; t += 40) fan.feed(0.004 + (t > 1000 ? 0.012 : 0), 40, false);
  assert.equal(fan.feed(0.03, 40, false), undefined);
  // While the app speaks, echo at a speech-like level for a moment is not an interruption.
  const app = new Endpointer();
  for (let t = 0; t < 2000; t += 40) app.feed(0.004, 40, true);
  const loud = (ms: number) => {
    const out: string[] = [];
    for (let t = 0; t < ms; t += 40) { const ev = app.feed(0.08, 40, true); if (ev) out.push(ev); }
    return out;
  };
  assert.deepEqual(loud(200), []);
  assert.deepEqual(loud(200), ["start"], "a deliberate interruption is heard");
});

test("only a whole sentence ends or hushes conversation mode", async () => {
  const { modeCommand } = await import("../src/voice/commands.ts");
  assert.equal(modeCommand("Stop listening."), "end");
  assert.equal(modeCommand("Goodbye!"), "end");
  assert.equal(modeCommand("That's all"), "end");
  assert.equal(modeCommand("stop"), "hush");
  assert.equal(modeCommand("Stop the server on port 80"), undefined);
  assert.equal(modeCommand("say goodbye to Ada for me"), undefined);
});
