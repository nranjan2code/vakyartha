// Explicit local-only voice probe. Synthetic fixtures are independent of the
// tested model; saved audio still needs a listening and live-microphone review.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ollamaBase, speak, transcribe, voiceProviders } from "../sidecar/voice/speech.ts";
import { wav16k } from "../src/voice/dictation.ts";

if (!process.argv.includes("--run-local")) throw new Error("Use --run-local to run free local inference.");
const model = process.argv.find((x) => x.startsWith("--model="))?.slice(8) ?? "lfm3-omni:latest";
const base = ollamaBase({});
const dir = path.resolve(".vak/evaluations/ollama-voice", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const cases = [
  { id: "numbers", text: "The total is forty two dollars and fifty cents. The meeting starts at three thirty." },
  { id: "negation", text: "Please open the settings page. Do not delete any files." },
];
const contract = {
  model, base, cases,
  checks: ["24 kHz mono 16-bit non-silent WAV", "verbatim transcription (case and punctuation ignored)", "silence returns empty text"],
  limits: "Synthetic English only. No real microphone, interruption, multilingual quality or end-to-end conversation claim.",
};
writeFileSync(path.join(dir, "contract.json"), JSON.stringify(contract, null, 2));
const results: Record<string, unknown>[] = [];
async function check(id: string, run: () => Promise<unknown>) {
  const start = performance.now();
  try { results.push({ id, ms: Math.round(performance.now() - start), result: await run() }); }
  catch (e) { results.push({ id, error: String(e) }); }
  // Commit each result so a later timeout cannot erase failed evidence.
  results[results.length - 1]!.ms = Math.round(performance.now() - start);
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
const localFetch: typeof fetch = (input, init) => {
  if (new URL(String(input)).origin !== base) throw new Error("Probe refuses non-local provider traffic");
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) });
};
await check("metadata", async () => {
  const r = await localFetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
  const j = await r.json() as { capabilities?: string[]; voices?: string[]; details?: unknown; model_info?: unknown };
  return { status: r.status, capabilities: j.capabilities, voices: j.voices, details: j.details, model_info: j.model_info };
});
await check("app-discovery", async () => (await voiceProviders({}, localFetch)).find((p) => p.id === "ollama"));
await check("app-speech", async () => {
  const audio = await speak({ provider: "ollama", model, voice: "default", text: cases[0]!.text }, {}, localFetch);
  writeFileSync(path.join(dir, "speech.wav"), audio);
  const v = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let peak = 0;
  for (let i = 44; i + 1 < audio.length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)));
  const pass = v.getUint32(24, true) === 24000 && v.getUint16(22, true) === 1 && v.getUint16(34, true) === 16 && audio.length > 4844 && peak > 100;
  return { pass, bytes: audio.length, seconds: (audio.length - 44) / 48000, peak };
});
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
for (const c of [...cases, { id: "silence", text: "" }]) {
  const file = path.join(dir, `${c.id}.wav`);
  if (c.text) {
    const aiff = path.join(dir, `${c.id}.aiff`);
    execFileSync("/usr/bin/say", ["-v", "Samantha", "-o", aiff, c.text]);
    execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, file]);
  } else writeFileSync(file, wav16k(new Int16Array(32000)));
  const audio = readFileSync(file);
  await check(`endpoint-transcription-${c.id}`, async () => {
    const form = new FormData();
    form.append("model", model); form.append("language", "en"); form.append("response_format", "json");
    form.append("file", new Blob([audio], { type: "audio/wav" }), `${c.id}.wav`);
    const r = await localFetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
    const body = await r.json() as { text?: string };
    return { status: r.status, body, pass: r.ok && typeof body.text === "string" && normal(body.text) === normal(c.text) };
  });
  await check(`app-transcription-${c.id}`, async () => {
    const text = await transcribe({ provider: "ollama", model, language: "en", audio: audio.toString("base64") }, {}, localFetch);
    return { text, pass: normal(text) === normal(c.text) };
  });
}
console.log(JSON.stringify({ evidence: dir, limits: contract.limits }));
if (results.some((r) => r.error || (r.result as { pass?: boolean } | undefined)?.pass === false)) process.exitCode = 1;
