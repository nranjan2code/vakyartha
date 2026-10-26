// Isolated, model-free UI fixture. Every provider request is intercepted;
// unknown external requests fail. It never loads development/user data.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { SETTINGS } from "../sidecar/settings.ts";
import { wav } from "../sidecar/voice/speech.ts";

const video = readFileSync(process.argv[2] ?? "/tmp/vakyartha-media-smoke.mp4");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const pcm = new Uint8Array(24_000);
const view = new DataView(pcm.buffer);
for (let i = 0; i < pcm.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(i * Math.PI * 2 * 440 / 24_000) * 3000), true);
for (const setting of SETTINGS) delete process.env[setting.name];
process.env.OPENAI_API_KEY = "media-smoke-fixture";
process.env.ELEVENLABS_API_KEY = "media-smoke-fixture";
process.env.FAL_KEY = "media-smoke-fixture";
process.env.GEMINI_API_KEY = "media-smoke-fixture";
process.env.LUMA_AGENTS_API_KEY = "media-smoke-fixture";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["127.0.0.1", "localhost"].includes(url.hostname)) {
    if (url.port === "11434") return Response.json(url.pathname === "/api/tags" ? { models: [] } : {});
    return realFetch(input, init);
  }
  if (url.hostname === "api.openai.com") {
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    if (url.pathname.startsWith("/v1/images/")) return Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { output_tokens: 1 } });
  }
  if (url.hostname === "generativelanguage.googleapis.com" && url.pathname.endsWith("/models")) return Response.json({ models: [{ name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] }] });
  if (url.hostname === "api.elevenlabs.io") {
    if (url.pathname === "/v1/voices") return Response.json({ voices: [{ voice_id: "fixture-voice", name: "Fixture narrator" }] });
    if (url.pathname === "/v1/text-to-dialogue") return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
    if (url.pathname === "/v1/sound-generation") return new Response(new Uint8Array(wav(pcm)), { headers: { "content-type": "audio/wav" } });
  }
  if (url.hostname === "queue.fal.run") {
    if (url.pathname.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.pathname.includes("/requests/")) return Response.json({ video: { url: `data:video/mp4;base64,${video.toString("base64")}` } });
    return Response.json({ request_id: "fixture-video" });
  }
  throw new Error(`Outbound request disabled in media smoke: ${url.hostname}`);
}) as typeof fetch;
const dir = mkdtempSync(path.join(tmpdir(), "vak-media-smoke-"));
const app = await startAppServer({ dataDir: dir, keychainService: `vakyartha.media-smoke.${Date.now()}`, access: "open", port: 0, uiDir: path.resolve("dist") });
const api = async (route: string, body?: unknown) => {
  const res = await realFetch(`${app.url}${route}`, body === undefined ? {} : { method: route.endsWith("/test") ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(JSON.stringify(data)); return data;
};
const selections = { image: ["generate_image", "openai|gpt-image-2.5-flare"], audio: ["create_speech", "elevenlabs|eleven_v4"], video: ["generate_video", "fal|fal-ai/kling-video/v3/pro/text-to-video"] };
for (const [kind, [operation, selection]] of Object.entries(selections)) {
  await api(`/api/integrations/media-${kind}`, { enabled: true, config: { [operation!]: selection } });
  await api(`/api/integrations/media-${kind}/test`, { tool: operation, args: { selection, prompt: "Fixture media", ...(kind === "audio" ? { voice: "fixture-voice" } : {}) } });
}
await new Promise((r) => setTimeout(r, 500));
const jobs = Object.fromEntries(await Promise.all(Object.keys(selections).map(async (kind) => [kind, await api(`/api/media/${kind}/jobs`)])));
const fixture = { url: app.url, dir, jobs };
writeFileSync("/tmp/vakyartha-media-smoke.json", JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ url: app.url, dir, fixture: "/tmp/vakyartha-media-smoke.json" }));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void app.shutdown().then(() => process.exit()); });
