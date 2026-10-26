import { setTimeout as delay } from "node:timers/promises";
import type { MediaModel, MediaOperation } from "../../shared/media.ts";
import { base64, bounded, jsonResponse, object, type Download } from "./io.ts";

export interface MediaInput { bytes: Buffer; type: string }
export interface MediaRequest { operation: MediaOperation; chosen: MediaModel; prompt: string; input?: MediaInput; mask?: MediaInput; endFrame?: MediaInput; nativeAudio?: boolean; voice?: string; language?: string; ratio: string; seconds: number; quality: string; background: string }
export interface MediaResult { files: Uint8Array[]; text?: string; usage?: unknown }
export interface Context {
  env: Record<string, string | undefined>; f: typeof fetch; signal: AbortSignal; download: Download;
  checkpoint(id: string): void; guard(): void; pollMs: number;
}
export function key(provider: string, ctx: Context): string {
  const name = ({ openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", elevenlabs: "ELEVENLABS_API_KEY", fal: "FAL_KEY", luma: "LUMA_AGENTS_API_KEY" } as Record<string, string>)[provider];
  const value = name && ctx.env[name];
  if (!value) throw new Error(`Add the ${provider} key in Settings → Providers`);
  return value;
}
export async function request(ctx: Context, url: string, init: RequestInit = {}): Promise<Response> {
  ctx.guard(); ctx.signal.throwIfAborted();
  // API origins are adapter-owned. Never follow a redirect with credentials.
  return ctx.f(url, { ...init, redirect: "error", signal: ctx.signal });
}
export async function post(ctx: Context, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  return jsonResponse(await request(ctx, url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }));
}
export async function binary(ctx: Context, url: string, headers: Record<string, string>, body: BodyInit): Promise<MediaResult> {
  const res = await request(ctx, url, { method: "POST", headers, body });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Media provider returned HTTP ${res.status}`); }
  return { files: [await bounded(res)] };
}
export const dataUri = (input: MediaInput) => `data:${input.type};base64,${input.bytes.toString("base64")}`;
export function remoteId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error("Provider did not return a valid job ID; submission outcome is unknown");
  return value;
}
async function fetchFiles(ctx: Context, urls: unknown[]): Promise<Uint8Array[]> {
  if (!urls.length || urls.length > 4) throw new Error("Provider returned no files or too many files");
  const files: Uint8Array[] = [];
  for (const url of urls) {
    ctx.guard();
    if (typeof url !== "string") throw new Error("Provider returned an invalid output reference");
    if (url.startsWith("data:")) files.push(base64(url.slice(url.indexOf(",") + 1)));
    else files.push(await ctx.download(url, ctx.signal));
  }
  return files;
}
export async function falResult(model: string, id: string, ctx: Context): Promise<MediaResult> {
  const root = model.split("/").slice(0, 2).join("/");
  const base = `https://queue.fal.run/${root}/requests/${remoteId(id)}`;
  const headers = { authorization: `Key ${key("fal", ctx)}` };
  for (;;) {
    const status = await jsonResponse(await request(ctx, `${base}/status`, { headers }));
    if (status.status === "COMPLETED") break;
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new Error("Provider returned an unsupported job state");
    await delay(ctx.pollMs, undefined, { signal: ctx.signal });
  }
  const result = await jsonResponse(await request(ctx, base, { headers }));
  const urls = Array.isArray(result.images) ? result.images.map((v) => object(v).url) : result.video ? [object(result.video).url] : [];
  return { files: await fetchFiles(ctx, urls), usage: result.metrics };
}
export async function falRun(req: MediaRequest, ctx: Context): Promise<MediaResult> {
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (req.operation === "generate_image" || req.operation === "edit_image") {
    body.output_format = "png";
    if (req.input) body.image_urls = [dataUri(req.input)];
  } else {
    body.duration = String(req.seconds); body.generate_audio = req.nativeAudio ?? false;
    if (req.input) body.start_image_url = dataUri(req.input);
    else body.aspect_ratio = req.ratio;
    if (req.endFrame) body.end_image_url = dataUri(req.endFrame);
  }
  const result = await post(ctx, `https://queue.fal.run/${req.chosen.model}`, { authorization: `Key ${key("fal", ctx)}` }, body);
  const id = remoteId(result.request_id);
  ctx.checkpoint(id);
  return falResult(req.chosen.model, id, ctx);
}
export async function lumaResult(id: string, ctx: Context): Promise<MediaResult> {
  for (;;) {
    const result = await jsonResponse(await request(ctx, `https://agents.lumalabs.ai/v1/generations/${remoteId(id)}`, { headers: { authorization: `Bearer ${key("luma", ctx)}` } }));
    if (result.state === "failed") throw new Error("Provider reported that media generation failed");
    if (result.state === "completed") {
      if (!Array.isArray(result.output)) throw new Error("Provider returned no output references");
      return { files: await fetchFiles(ctx, result.output.map((v) => object(v).url)), usage: result.usage };
    }
    if (!["queued", "dreaming", "processing", "pending", "running"].includes(String(result.state))) throw new Error("Provider returned an unsupported job state");
    await delay(ctx.pollMs, undefined, { signal: ctx.signal });
  }
}
export async function lumaRun(req: MediaRequest, ctx: Context): Promise<MediaResult> {
  const editing = req.operation === "edit_video";
  const reframe = req.operation === "reframe_video";
  const video: Record<string, unknown> = { resolution: "720p" };
  if (!editing && !reframe) video.duration = `${req.seconds}s`;
  if (editing) video.edit = { auto_controls: true };
  if (req.operation === "animate_image" && req.input) video.start_frame = { data: req.input.bytes.toString("base64"), media_type: req.input.type };
  const body = {
    model: req.chosen.model, type: editing ? "video_edit" : reframe ? "video_reframe" : "video", prompt: req.prompt,
    ...(!editing ? { aspect_ratio: req.ratio } : {}), video,
    ...((editing || reframe) && req.input ? { source: { data: req.input.bytes.toString("base64"), media_type: req.input.type } } : {}),
  };
  const result = await post(ctx, "https://agents.lumalabs.ai/v1/generations", { authorization: `Bearer ${key("luma", ctx)}` }, body);
  const id = remoteId(result.id); ctx.checkpoint(id);
  return lumaResult(id, ctx);
}
