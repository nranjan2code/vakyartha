import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Media } from "../sidecar/media/index.ts";
import { base64, mediaType } from "../sidecar/media/io.ts";
import { createIntegrations } from "../sidecar/integrations.ts";
import { SETTINGS, Settings, fileSecrets } from "../sidecar/settings.ts";
import { mediaSelection, type MediaKind } from "../shared/media.ts";
import { VoiceDecisions } from "../src/voice/decisions.ts";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { spokenSurface } from "../src/voice/speech-text.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(24)]);
const pick = "openai|gpt-image-2.5-flare";
function setup(options: { fetcher?: typeof fetch; download?: (url: string, signal: AbortSignal) => Promise<Buffer>; env?: Record<string, string | undefined> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-media-"));
  mkdirSync(path.join(dir, "attachments")); mkdirSync(path.join(dir, "logs"));
  const configs = new Map<MediaKind, { enabled: boolean; config: Record<string, unknown> }>([["image", { enabled: true, config: { generate_image: pick, edit_image: pick } }], ["audio", { enabled: true, config: {} }], ["video", { enabled: true, config: {} }]]);
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return options.fetcher ? options.fetcher(url, init) : Response.json({ data: [{ b64_json: PNG.toString("base64") }], usage: { input_tokens: 12, output_tokens: 30 } });
  }) as typeof fetch;
  const media = new Media({ dir: path.join(dir, "media"), attachmentsDir: path.join(dir, "attachments"), voiceDir: path.join(dir, "voice"), config: (kind) => configs.get(kind)!, env: options.env ?? { OPENAI_API_KEY: "test-key" }, fetcher: f, download: options.download, pollMs: 1 });
  return { dir, media, calls, configs, f };
}
async function done(media: Media, kind: MediaKind, id: string) {
  for (let i = 0; i < 200; i++) { const j = media.job(kind, id); if (!["submitting", "running"].includes(j.state)) return j; await delay(5); }
  throw new Error("Job did not finish");
}

test("media plugins are independent, off by default, and use existing approval policy", async () => {
  const { dir, media, calls, configs } = setup();
  const decisions: unknown[] = [];
  const integrations = createIntegrations({ dataDir: dir, secrets: fileSecrets(path.join(dir, "settings.env")), approve: async (req) => { decisions.push(req); return "deny"; } }, media);
  assert.deepEqual(integrations.view().filter((i) => i.enabled).map((i) => i.entry.id), ["time"]);
  assert.deepEqual(media.entries().map((e) => e.id), ["media-image", "media-audio", "media-video"]);
  assert.ok(media.entries().every((e) => !e.config.some((f) => f.kind === "secret")));
  await integrations.configure("media-image", { config: { generate_image: pick }, enabled: true });
  configs.set("image", { enabled: true, config: { generate_image: pick } });
  const tools = await integrations.toolsFor("chat");
  const tool = tools.find((t) => t.spec.name.includes("generate_image"))!;
  const denied = await tool.execute({ selection: pick, prompt: "A bird" }, {});
  assert.ok(typeof denied === "object" && denied.isError);
  assert.match(denied.text, /declined/);
  assert.equal(decisions.length, 1); assert.equal(calls.length, 0);
  assert.equal(integrations.view().find((v) => v.entry.id === "media-audio")!.enabled, false);
  await media.close();
});

test("shared provider keys have one settings entry and never appear in media metadata", async () => {
  const { media, dir } = setup();
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "FAL_KEY", "LUMA_AGENTS_API_KEY"]) assert.equal(SETTINGS.filter((s) => s.name === name).length, 1);
  const file = path.join(dir, "settings.env");
  const env: Record<string, string | undefined> = {};
  const settings = new Settings({ file, secrets: fileSecrets(file), env });
  settings.save({ FAL_KEY: "shared-fal", LUMA_AGENTS_API_KEY: "shared-luma" });
  assert.equal(env.FAL_KEY, "shared-fal");
  assert.ok(!JSON.stringify(settings.view()).includes("shared-fal"));
  assert.ok(!JSON.stringify(await media.view("image")).includes("test-key"));
  await media.close();
});

test("image output is a private durable file with numeric usage and no provider URL", async () => {
  const { media, dir, calls } = setup();
  const j = await media.withSession("chat-source", () => media.submit("image", "generate_image", { selection: pick, prompt: "A bird", background: "transparent" }));
  const result = await done(media, "image", j.id);
  assert.equal(result.state, "succeeded"); assert.equal(result.session, "chat-source"); assert.equal(result.assets.length, 1);
  const asset = (await media.view("image")).assets[0]!;
  assert.equal(asset.source, j.id); assert.equal(asset.type, "image/png");
  assert.deepEqual(readFileSync(path.join(dir, "media", `${asset.id}.png`)), PNG);
  const payload = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(payload.model, "gpt-image-2.5-flare"); assert.equal(payload.background, "transparent");
  assert.equal(calls[0]!.init!.redirect, "error");
  const journal = readFileSync(path.join(dir, "media", "media.json"), "utf8");
  assert.doesNotMatch(journal, /test-key|A bird|https:/);
  await media.close();
});

test("wrong provider/model, stale approval, unknown parameters and unsupported capabilities fail before dispatch", async () => {
  const { media, calls, configs } = setup();
  await assert.rejects(media.submit("image", "generate_image", { selection: "openai|arbitrary-model", prompt: "x" }), /selection changed/);
  await assert.rejects(media.submit("image", "generate_image", { selection: pick, prompt: "x", url: "https://example.com" }), /Unsupported media arguments/);
  await assert.rejects(media.submit("image", "generate_image", { selection: pick, prompt: "x", ratio: ["1:1"] }), /Unsupported output/);
  configs.set("image", { enabled: false, config: { generate_image: pick } });
  await assert.rejects(media.submit("image", "generate_image", { selection: pick, prompt: "x" }), /selection changed/);
  configs.set("image", { enabled: true, config: { generate_image: "gemini|gemini-nano-banana-2.1" } });
  await assert.rejects(media.submit("image", "generate_image", { selection: "gemini|gemini-nano-banana-2.1", prompt: "x", background: "transparent" }), /does not support/);
  assert.equal(calls.length, 0); await media.close();
});

test("edits read only scoped attachments and preserve their source", async () => {
  const { media, dir, calls } = setup();
  const outside = path.join(dir, "outside.png"); writeFileSync(outside, PNG);
  await assert.rejects(media.submit("image", "edit_image", { selection: pick, prompt: "blue", input: outside }), /Import this file/);
  symlinkSync(outside, path.join(dir, "attachments", "link.png"));
  await assert.rejects(media.submit("image", "edit_image", { selection: pick, prompt: "blue", input: path.join(dir, "attachments", "link.png") }), /Import this file/);
  const source = path.join(dir, "attachments", "image.png"); writeFileSync(source, PNG);
  const j = await media.submit("image", "edit_image", { selection: pick, prompt: "blue", input: source });
  assert.equal((await done(media, "image", j.id)).state, "succeeded");
  assert.deepEqual(readFileSync(source), PNG);
  assert.ok(calls[0]!.init!.body instanceof FormData);
  assert.equal((calls[0]!.init!.body as FormData).get("model"), "gpt-image-2.5-flare");
  await media.close();
});

test("async video stores its remote identity, uses the current model schema and downloads without API credentials", async () => {
  const downloaded: string[] = [];
  const { media, configs, calls } = setup({ env: { FAL_KEY: "fal-secret" }, download: async (url) => { downloaded.push(url); return MP4; }, fetcher: (async (url: string | URL | Request) => {
    if (String(url).endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (String(url).includes("/requests/")) return Response.json({ video: { url: "https://cdn.example/video.mp4" } });
    return Response.json({ request_id: "remote-123", status_url: "https://evil.example/ignored" });
  }) as typeof fetch });
  const selection = "fal|fal-ai/kling-video/v3/pro/text-to-video";
  configs.set("video", { enabled: true, config: { generate_video: selection } });
  const j = await media.submit("video", "generate_video", { selection, prompt: "A garden", seconds: 5, ratio: "16:9" });
  const result = await done(media, "video", j.id);
  assert.equal(result.state, "succeeded"); assert.equal(result.remoteId, "remote-123");
  assert.deepEqual(downloaded, ["https://cdn.example/video.mp4"]);
  assert.equal(calls[1]!.url, "https://queue.fal.run/fal-ai/kling-video/requests/remote-123/status");
  const args = JSON.parse(String(calls[0]!.init!.body)); assert.equal(args.duration, "5"); assert.equal(args.generate_audio, false); assert.equal(args.num_frames, undefined);
  await media.close();
});

test("restart preserves uncertain jobs and resume only polls the original provider job", async () => {
  const s = setup({ env: { FAL_KEY: "test" }, fetcher: (async (url, init) => String(url).endsWith("text-to-video") ? Response.json({ request_id: "known-job" }) : new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }))) as typeof fetch });
  const selection = "fal|fal-ai/kling-video/v3/pro/text-to-video";
  s.configs.set("video", { enabled: true, config: { generate_video: selection } });
  const j = await s.media.submit("video", "generate_video", { selection, prompt: "Garden" });
  for (let i = 0; i < 100 && !s.media.job("video", j.id).remoteId; i++) await delay(2);
  await s.media.close();
  const requests: string[] = [];
  const reloaded = new Media({ dir: path.join(s.dir, "media"), attachmentsDir: path.join(s.dir, "attachments"), voiceDir: "", config: (k) => s.configs.get(k)!, env: { FAL_KEY: "test" }, pollMs: 1, fetcher: (async (url) => { requests.push(String(url)); return Response.json(String(url).endsWith("/status") ? { status: "COMPLETED" } : { video: { url: "https://cdn.example/result" } }); }) as typeof fetch, download: async () => MP4 });
  assert.equal(reloaded.job("video", j.id).state, "interrupted"); assert.equal(requests.length, 0);
  await reloaded.resume("video", j.id); assert.equal((await done(reloaded, "video", j.id)).state, "succeeded");
  assert.ok(requests.every((u) => u.includes("/requests/known-job")));
  await reloaded.close();
});

test("malformed response and rejected submission do not claim success or retry generation", async () => {
  const s = setup({ fetcher: (async () => new Response("rejected", { status: 401 })) as typeof fetch });
  const j = await s.media.submit("image", "generate_image", { selection: pick, prompt: "x" });
  assert.equal((await done(s.media, "image", j.id)).state, "failed"); assert.equal(s.calls.length, 1);
  await s.media.close();
  const malformed = setup({ fetcher: (async () => Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })) as typeof fetch });
  const bad = await malformed.media.submit("image", "generate_image", { selection: pick, prompt: "x" });
  assert.notEqual((await done(malformed.media, "image", bad.id)).state, "succeeded");
  assert.equal((await malformed.media.view("image")).assets.length, 0); await malformed.media.close();
});

test("media import, authenticated resource route shape, range and deletion use opaque asset IDs", async () => {
  const { media } = setup();
  const server = createServer((req, res) => { void media.route(req, res, new URL(req.url!, "http://localhost")); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const imported = await (await fetch(`${url}/api/media/import`, { method: "POST", body: JSON.stringify({ name: "reference.png", data: PNG.toString("base64") }) })).json() as { id: string };
    const res = await fetch(`${url}/api/media/assets/${imported.id}`, { headers: { range: "bytes=0-7" } });
    assert.equal(res.status, 206); assert.equal(res.headers.get("x-content-type-options"), "nosniff"); assert.equal((await res.arrayBuffer()).byteLength, 8);
    assert.equal((await fetch(`${url}/api/media/assets/${imported.id}`, { headers: { range: "bytes=100000-" } })).status, 416);
    assert.equal((await fetch(`${url}/api/media/assets/${imported.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${url}/api/media/assets/${imported.id}`)).status, 404);
  } finally { server.closeAllConnections(); server.close(); await media.close(); }
});

test("media voices use canonical adapters; deprecated new speech choices are excluded", async () => {
  const { media } = setup({ env: {}, fetcher: (async () => Response.json({ models: [] })) as typeof fetch });
  const models = await media.models("audio");
  assert.ok(models.some((m) => m.model === "gemini-3.8-flash-tts"));
  assert.ok(!models.some((m) => m.provider === "openai" && m.operations.includes("create_speech")));
  assert.ok(!models.some((m) => m.model === "scribe_v1"));
  await media.validateConfig("image", { generate_image: pick });
  await assert.rejects(media.validateConfig("image", { generate_image: "openai|unknown" }), /listed/);
  assert.equal(mediaSelection({ provider: "luma", model: "ray-3.2" }), "luma|ray-3.2");
  await media.close();
});

test("media has dedicated spoken summaries and deterministic local voice playback", async () => {
  const store = new SurfaceStore(basicCatalog);
  store.render({ surface: "result", title: "Result", nodes: [{ id: "root", type: "media", props: { kind: "video", src: "media:opaque", title: "Garden", description: "Five seconds", transcript: "Do not read automatically" } }] });
  assert.doesNotMatch(spokenSurface(store.resolve("result")!, "en", "gist"), /media:|Do not read/);
  assert.match(spokenSurface(store.resolve("result")!, "en", "details"), /Do not read automatically/);
  const activated: string[] = [];
  const decisions = new VoiceDecisions({ store: () => store, say: () => {}, activate: (_s, key) => { activated.push(key); return true; } });
  assert.equal(await decisions.hear("play Garden"), true); assert.deepEqual(activated, ["root#media-play"]);
  decisions.offer(["result"]); assert.equal(await decisions.hear("pause"), true); assert.equal(activated.at(-1), "root#media-pause");
});

test("media parsers refuse mismatched signatures and noncanonical base64", () => {
  assert.equal(mediaType(PNG), "image/png"); assert.equal(mediaType(MP4), "video/mp4");
  assert.throws(() => mediaType(Buffer.from("<svg>")), /Unsupported/);
  assert.throws(() => base64("not base64"), /Invalid/);
});

test("configured model schemas expose only supported controls and validate conditional durations", async () => {
  const { media, configs, calls } = setup();
  configs.set("image", { enabled: true, config: { generate_image: "gemini|gemini-nano-banana-2.1" } });
  const properties = media.server("image").tools.find((t) => t.name === "generate_image")!.inputSchema.properties as Record<string, unknown>;
  assert.ok(properties.ratio); assert.equal(properties.background, undefined); assert.equal(properties.quality, undefined);
  configs.set("video", { enabled: true, config: { animate_image: "luma|ray-3.2" } });
  const seconds = (media.server("video").tools.find((t) => t.name === "animate_image")!.inputSchema.properties as Record<string, { enum?: number[] }>).seconds;
  assert.deepEqual(seconds!.enum, [5]);
  await assert.rejects(media.submit("video", "animate_image", { selection: "luma|ray-3.2", prompt: "x", input: "missing", seconds: 10 }), /5 seconds/);
  assert.equal(calls.length, 0); await media.close();
});

test("current expressive narration uses the canonical dialogue endpoint and language", async () => {
  const { media, configs, calls } = setup({ env: { ELEVENLABS_API_KEY: "shared-voice-key" }, fetcher: (async (url) => {
    if (String(url).endsWith("/v1/voices")) return Response.json({ voices: [{ voice_id: "narrator", name: "Narrator" }] });
    if (String(url).includes("text-to-dialogue")) return new Response(new Uint8Array([0, 0, 1, 0]));
    return Response.json({ models: [] });
  }) as typeof fetch });
  configs.set("audio", { enabled: true, config: { create_speech: "elevenlabs|eleven_v4" } });
  const job = await media.submit("audio", "create_speech", { selection: "elevenlabs|eleven_v4", prompt: "Hello", voice: "narrator", language: "hi-IN" });
  assert.equal((await done(media, "audio", job.id)).state, "succeeded");
  const request = calls.find((c) => c.url.includes("text-to-dialogue"))!;
  const body = JSON.parse(String(request.init!.body));
  assert.equal(body.model_id, "eleven_v4"); assert.equal(body.inputs[0].voice_id, "narrator"); assert.equal(body.language_code, "hi");
  await media.close();
});
