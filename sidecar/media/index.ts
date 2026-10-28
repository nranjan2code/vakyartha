// Media is app-owned capability composition over the existing integration
// lifecycle. Its journal owns jobs/files; integrations.json owns selections.
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { HostRequest, HostResponse } from "@vak/host";
import path from "node:path";
import { json, readJson } from "@vak/host";
import type { BuiltinServer, CatalogEntry } from "@vak/mcp/client";
import type { SurfaceSnapshot } from "@vak/core";
import { MEDIA_KINDS, MEDIA_OPERATIONS, isMediaKind, mediaSelection, operationKind, type MediaAsset, type MediaJob, type MediaKind, type MediaModel, type MediaOperation, type MediaView } from "../../shared/media.ts";
import { voiceProviders } from "../voice/speech.ts";
import { audio } from "./audio.ts";
import { MEDIA_KEYS, MODELS, PROVIDERS, operations, providerViews } from "./catalog.ts";
import { image } from "./image.ts";
import { INPUT_LIMIT, TYPES, base64, download, mediaType, object, text, type Download } from "./io.ts";
import { falResult, lumaResult, type Context, type MediaInput, type MediaRequest, type MediaResult } from "./remote.ts";
import { video } from "./video.ts";
export { MEDIA_KEYS };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const selectionOk = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9-]+\|[\w./:-]{1,160}$/.test(v);
const TERMINAL = new Set(["succeeded", "failed", "unknown", "interrupted"]);
const INPUTS = new Set(["edit_image", "transcribe_audio", "isolate_audio", "animate_image", "edit_video", "reframe_video"]);
const NO_PROMPT = new Set(["transcribe_audio", "isolate_audio", "reframe_video"]);
interface Snapshot { version: 1; assets: MediaAsset[]; jobs: MediaJob[] }
type Config = { enabled: boolean; config: Record<string, unknown> };
export interface MediaOptions {
  dir: string; attachmentsDir: string; voiceDir: string;
  config(kind: MediaKind): Config;
  env?: Record<string, string | undefined>; fetcher?: typeof fetch; download?: Download; pollMs?: number;
  publish?(job: MediaJob, assets: MediaAsset[], signal?: AbortSignal): Promise<string>;
  projection?(job: MediaJob): Promise<SurfaceSnapshot | undefined>;
}
function usageNumbers(value: unknown, depth = 0): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (depth > 2 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 50).flatMap(([k, v]) => { const n = usageNumbers(v, depth + 1); return n === undefined || !/^[a-z][a-z0-9_]{0,60}$/i.test(k) ? [] : [[k, n]]; }));
}
function parseSnapshot(value: unknown): Snapshot {
  const s = object(value);
  if (s.version !== 1 || !Array.isArray(s.assets) || !Array.isArray(s.jobs) || s.assets.length > 1000 || s.jobs.length > 200) throw new Error("Unsupported media journal");
  const assets = s.assets.map((v): MediaAsset => {
    const a = object(v);
    if (typeof a.id !== "string" || !ID.test(a.id) || typeof a.type !== "string" || !(a.type in TYPES || a.type === "text/plain") || typeof a.name !== "string" || a.name.length > 160 || typeof a.created !== "string" || !Number.isFinite(Date.parse(a.created)) || typeof a.bytes !== "number" || !Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > 100_000_000 || (a.source !== undefined && (typeof a.source !== "string" || !ID.test(a.source)))) throw new Error("Invalid media asset record");
    return { id: a.id, type: a.type, name: a.name, bytes: a.bytes, created: a.created, ...(a.source ? { source: a.source as string } : {}) };
  });
  const jobs = s.jobs.map((v): MediaJob => {
    const j = object(v);
    if (typeof j.id !== "string" || !ID.test(j.id) || typeof j.kind !== "string" || !isMediaKind(j.kind) || typeof j.operation !== "string" || operationKind(j.operation) !== j.kind || !selectionOk(j.selection) || typeof j.created !== "string" || !Number.isFinite(Date.parse(j.created)) || !["submitting", "running", ...TERMINAL].includes(String(j.state)) || !Array.isArray(j.inputs) || j.inputs.length > 2 || !j.inputs.every((v) => typeof v === "string" && v.length < 1024) || !Array.isArray(j.assets) || j.assets.length > 4 || !j.assets.every((v) => typeof v === "string" && ID.test(v)) || (j.remoteId !== undefined && (typeof j.remoteId !== "string" || !/^[\w-]{1,160}$/.test(j.remoteId))) || (j.error !== undefined && (typeof j.error !== "string" || j.error.length > 500))) throw new Error("Invalid media job record");
    for (const field of ["session", "surface", "projectionError"]) if (j[field] !== undefined && (typeof j[field] !== "string" || (j[field] as string).length > 500)) throw new Error("Invalid media projection record");
    return { id: j.id, kind: j.kind, operation: j.operation as MediaOperation, selection: j.selection, created: j.created, state: j.state as MediaJob["state"], inputs: j.inputs as string[], assets: j.assets as string[], ...(j.remoteId ? { remoteId: j.remoteId as string } : {}), ...(j.error ? { error: j.error as string } : {}), usage: usageNumbers(j.usage), ...(typeof j.session === "string" ? { session: j.session } : {}), ...(typeof j.surface === "string" ? { surface: j.surface } : {}), ...(typeof j.projectionError === "string" ? { projectionError: j.projectionError } : {}) };
  });
  if (new Set(assets.map((a) => a.id)).size !== assets.length || new Set(jobs.map((j) => j.id)).size !== jobs.length) throw new Error("Duplicate media journal IDs");
  return { version: 1, assets, jobs };
}

export class Media {
  private opts: MediaOptions;
  private saved: Snapshot = { version: 1, assets: [], jobs: [] };
  private active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private failure?: string;
  private closed = false;
  private modelCache: MediaModel[] = [];
  private sessions = new AsyncLocalStorage<string>();
  withSession<T>(session: string, work: () => T): T { return this.sessions.run(session, work); }
  constructor(opts: MediaOptions) {
    this.opts = opts;
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    try {
      const file = path.join(opts.dir, "media.json");
      if (existsSync(file)) this.saved = parseSnapshot(JSON.parse(readFileSync(file, "utf8")));
      for (const job of this.saved.jobs) if (!TERMINAL.has(job.state)) { job.state = job.remoteId ? "interrupted" : "unknown"; job.error = "The app stopped while work was in progress. No generation was resubmitted; provider charges may apply."; }
      this.persist();
    } catch { this.failure = "The media journal could not be loaded. Existing files are preserved; media operations are disabled."; }
  }
  private persist(): void {
    if (this.failure) throw new Error(this.failure);
    const file = path.join(this.opts.dir, "media.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  private env() { return this.opts.env ?? process.env; }
  providers() { return providerViews(this.env()); }
  async models(kind: MediaKind): Promise<MediaModel[]> {
    const staticModels = MODELS.filter((m) => m.operations.some((op) => operationKind(op) === kind));
    if (kind !== "audio") return staticModels;
    // Voice remains the canonical source for speech/transcription models and voices.
    const voices = await voiceProviders(this.env(), this.opts.fetcher ?? fetch, this.opts.voiceDir);
    const models = [...staticModels, ...voices.flatMap((p): MediaModel[] => [
      ...p.models.filter((m) => m.voices.length && !m.note?.startsWith("Deprecated")).map((m): MediaModel => ({ provider: p.id, model: m.id, label: m.label, operations: ["create_speech"], voices: m.voices, local: p.local })),
      ...(p.stt ?? []).filter((m) => (p.id !== "openai" || m.id === "gpt-transcribe") && (p.id !== "elevenlabs" || m.id === "scribe_v2")).map((m): MediaModel => ({ provider: p.id, model: m.id, label: m.label, operations: ["transcribe_audio"], local: p.local })),
    ])];
    this.modelCache = models;
    return models;
  }
  async view(kind: MediaKind): Promise<MediaView> {
    if (this.failure) throw new Error(this.failure);
    const models = await this.models(kind);
    const providers = this.providers();
    for (const m of models) if (!providers.some((p) => p.id === m.provider)) providers.push({ id: m.provider, label: m.provider, available: true });
    return { kind, models, providers, jobs: this.saved.jobs.filter((j) => j.kind === kind).slice().reverse(), assets: this.saved.assets.map((a) => ({ ...a })) };
  }
  async validateConfig(kind: MediaKind, changes: unknown): Promise<void> {
    const next = object(changes);
    const models = await this.models(kind);
    for (const [operation, value] of Object.entries(next)) {
      if (!Object.hasOwn(MEDIA_OPERATIONS[kind], operation) || typeof value !== "string" || (value !== "" && !models.some((m) => mediaSelection(m) === value && m.operations.includes(operation as MediaOperation)))) throw new Error("Choose a listed provider/model for each media tool");
    }
  }
  entries(): CatalogEntry[] {
    return MEDIA_KINDS.map((kind) => ({
      id: `media-${kind}`, name: kind === "image" ? "Images" : kind === "audio" ? "Audio" : "Video", publisher: "vak", trust: "built-in",
      icon: kind === "image" ? "image" : kind === "audio" ? "voice" : "film",
      summary: kind === "image" ? "Make and edit images with the models you choose." : kind === "audio" ? "Create speech, music and sounds; transcribe and clean audio." : "Generate, animate, edit and reframe video.",
      description: `Optional ${kind} tools. Choose a provider and model for each operation. Provider keys are shared with Settings → Providers and Voice. Hosted calls upload the approved inputs and may charge your account. Results are saved here; editing keeps the source.`,
      homepage: "https://github.com/nranjan2code/vakyartha",
      access: ["Only imported media, generated assets and chat attachments named in the call", "Shared provider keys stay in the app", "Hosted work is billed separately from chat tokens; charges may be unknown", "Approval covers submission, bounded status checks and saving results; stopping a wait may not stop provider billing"],
      config: operations(kind).map(([key, label]) => ({ key, label, kind: "text" as const })),
      source: { kind: "builtin", server: () => this.server(kind) },
    }));
  }
  server(kind: MediaKind): BuiltinServer {
    const media = this;
    return {
      get tools() {
        const config = media.opts.config(kind).config;
        return [
          ...operations(kind).filter(([op]) => selectionOk(config[op])).map(([op, label]) => {
            const provider = String(config[op]).split("|")[0];
            const falVideo = kind === "video" && provider === "fal";
            const ratio = kind === "image" ? provider !== "fal" : kind === "video" && op !== "edit_video" && !(falVideo && op === "animate_image");
            return ({
            name: op, title: label, description: `${label} using ${String(config[op]).replace("|", " / ")}. Hosted calls are billed and upload the named inputs. Returns a background job ID; results and previews appear in this integration's Results. Do not repeatedly poll the model.`,
            inputSchema: { type: "object", additionalProperties: false, properties: {
              selection: { type: "string", enum: [config[op]], description: "The configured provider/model. Copy exactly.", default: config[op] },
              ...(!NO_PROMPT.has(op) ? { prompt: { type: "string", maxLength: String(config[op]).endsWith("|eleven_v4") ? 2000 : 4096, description: "What to create or change; narration uses these exact words" } } : {}),
              ...(INPUTS.has(op) ? { input: { type: "string", description: "Imported/generated asset ID, or an absolute chat attachment path" } } : {}),
              ...(op === "edit_image" && provider === "openai" ? { mask: { type: "string", description: "Optional PNG mask asset ID" } } : {}),
              ...(falVideo ? { audio: { type: "boolean", default: false, description: "Generate native sound and English/Chinese speech; off by default" } } : {}),
              ...(falVideo && op === "animate_image" ? { end_frame: { type: "string", description: "Optional final-frame image asset ID" } } : {}),
              ...(op === "create_speech" ? { voice: { type: "string", ...(media.modelCache.find((m) => mediaSelection(m) === config[op])?.voices ? { enum: media.modelCache.find((m) => mediaSelection(m) === config[op])!.voices!.map((v) => v.id) } : {}), description: "Voice ID from the selected voice model" } } : {}),
              ...(["create_speech", "transcribe_audio"].includes(op) ? { language: { type: "string", description: "Optional BCP 47 language tag" } } : {}),
              ...(["create_music", "create_sound_effect", "generate_video", "animate_image"].includes(op) ? { seconds: { type: kind === "video" ? "integer" : "number", ...(kind === "video" ? falVideo ? { minimum: 3, maximum: 15 } : { enum: op === "animate_image" ? [5] : [5, 10] } : { minimum: op === "create_music" ? 3 : 0.5, maximum: 30 }), description: "Output duration in seconds", default: 5 } } : {}),
              ...(ratio ? { ratio: { type: "string", enum: ["1:1", "16:9", "9:16"], description: "Output shape; direct image API uses its nearest supported size" } } : {}),
              ...(kind === "image" && provider === "openai" ? { quality: { type: "string", enum: ["low", "medium", "high"], description: "Rendering quality" }, background: { type: "string", enum: ["opaque", "transparent"], description: "Actual PNG transparency" } } : {}),
            }, required: ["selection", ...(!NO_PROMPT.has(op) ? ["prompt"] : []), ...(INPUTS.has(op) ? ["input"] : []), ...(op === "create_speech" ? ["voice"] : [])] },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, title: label },
          }); }),
          { name: "get_media_job", title: "Read media job", description: "Read saved local job status and output asset IDs. Does not contact the provider.", inputSchema: { type: "object", properties: { job: { type: "string" } }, required: ["job"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
        ];
      },
      async callTool(name, args, signal) {
        try {
          signal?.throwIfAborted();
          if (name === "get_media_job") return { text: JSON.stringify(media.job(kind, text(args.job, 80))), isError: false };
          if (operationKind(name) !== kind) throw new Error("Unknown media tool");
          const job = await media.submit(kind, name as MediaOperation, args, signal);
          return { text: JSON.stringify({ ...job, message: "Started in background. Open Settings → Integrations → " + (kind === "image" ? "Images" : kind === "audio" ? "Audio" : "Video") + " → Results for progress, preview and download. A job ID is not a finished output." }), isError: false };
        } catch (err) { return { text: (err as Error).message, isError: true }; }
      },
    };
  }
  private assertConfigured(kind: MediaKind, op: MediaOperation, selection: string): void {
    if (this.failure) throw new Error(this.failure);
    if (this.closed) throw new Error("Media is stopping");
    const current = this.opts.config(kind);
    if (!current.enabled || current.config[op] !== selection) throw new Error("Media plugin or model selection changed. Review the current settings before trying again.");
  }
  private assetFile(a: MediaAsset): string { return path.join(this.opts.dir, `${a.id}${a.type === "text/plain" ? ".txt" : TYPES[a.type]}`); }
  readText(id: string): string { const a = this.saved.assets.find((a) => a.id === id && a.type === "text/plain"); if (!a) throw new Error("Unknown transcript asset"); return readFileSync(this.assetFile(a), "utf8"); }
  private saveAsset(bytes: Uint8Array, source?: string, plainText = false, name?: string): MediaAsset {
    if (this.saved.assets.length >= 1000) throw new Error("Media library is full; remove unused files first");
    const type = plainText ? "text/plain" : mediaType(bytes);
    const a: MediaAsset = { id: randomUUID(), type, name: name?.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 160) || `Result${plainText ? ".txt" : TYPES[type]}`, bytes: bytes.length, created: new Date().toISOString(), ...(source ? { source } : {}) };
    const file = this.assetFile(a);
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    this.saved.assets.push(a);
    try { this.persist(); } catch (err) { this.saved.assets.pop(); unlinkSync(file); throw err; }
    return a;
  }
  private async input(ref: unknown, prefix: "image" | "audio" | "video"): Promise<MediaInput> {
    const id = text(ref, 1023);
    const asset = this.saved.assets.find((a) => a.id === id);
    let file: string;
    if (asset) {
      const root = await realpath(this.opts.dir);
      file = await realpath(this.assetFile(asset));
      if (!file.startsWith(root + path.sep)) throw new Error("Media asset is outside its private library");
    }
    else {
      const root = await realpath(this.opts.attachmentsDir);
      file = await realpath(id);
      if (!file.startsWith(root + path.sep)) throw new Error("Import this file in the media plugin, or attach it in chat first");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks: Buffer[] = [];
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > INPUT_LIMIT) throw new Error("Media inputs must be files under 20 MB");
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > INPUT_LIMIT) throw new Error("Media input is too large"); chunks.push(chunk); }
    } finally { await handle.close(); }
    const bytes = Buffer.concat(chunks);
    const type = mediaType(bytes);
    if (!type.startsWith(`${prefix}/`)) throw new Error(`This operation needs ${prefix} input`);
    return { bytes, type };
  }
  private async validate(kind: MediaKind, operation: MediaOperation, args: Record<string, unknown>): Promise<MediaRequest> {
    const selection = text(args.selection, 200);
    this.assertConfigured(kind, operation, selection);
    const chosen = (await this.models(kind)).find((m) => mediaSelection(m) === selection && m.operations.includes(operation));
    if (!chosen) throw new Error("Unsupported provider/model for this operation");
    const allowed = new Set(["selection", ...(!NO_PROMPT.has(operation) ? ["prompt"] : []), ...(INPUTS.has(operation) ? ["input"] : []), ...(operation === "edit_image" ? ["mask"] : []), ...(operation === "create_speech" ? ["voice"] : []), ...(["create_speech", "transcribe_audio"].includes(operation) ? ["language"] : []), ...(["create_music", "create_sound_effect", "generate_video", "animate_image"].includes(operation) ? ["seconds"] : []), ...(kind !== "audio" ? ["ratio"] : []), ...(kind === "image" ? ["quality", "background"] : [])]);
    if (chosen.provider === "fal" && kind === "video") { allowed.add("audio"); if (operation === "animate_image") allowed.add("end_frame"); }
    if (Object.keys(args).some((k) => !allowed.has(k))) throw new Error("Unsupported media arguments");
    const ratio = args.ratio ?? "1:1";
    const quality = args.quality ?? "medium";
    const background = args.background ?? "opaque";
    if (typeof ratio !== "string" || !["1:1", "16:9", "9:16"].includes(ratio) || typeof quality !== "string" || !["low", "medium", "high"].includes(quality) || typeof background !== "string" || !["opaque", "transparent"].includes(background)) throw new Error("Unsupported output settings");
    if (chosen.provider !== "openai" && (args.mask !== undefined || args.quality !== undefined || background === "transparent")) throw new Error("This provider does not support mask, quality or transparent-background controls");
    if (chosen.provider === "fal" && kind === "image" && args.ratio !== undefined) throw new Error("This image endpoint uses its default dimensions; omit ratio");
    const seconds = args.seconds ?? 5;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < (operation === "create_sound_effect" ? 0.5 : operation === "create_music" || chosen.provider === "fal" ? 3 : 5) || seconds > 30 || (kind === "video" && (chosen.provider === "fal" ? !Number.isInteger(seconds) || seconds > 15 : ![5, 10].includes(seconds)))) throw new Error("Unsupported duration for this model");
    if (chosen.provider === "luma" && operation === "animate_image" && seconds !== 5) throw new Error("Image-anchored video supports 5 seconds on this model");
    if (args.audio !== undefined && typeof args.audio !== "boolean") throw new Error("Native audio must be on or off");
    if (chosen.provider === "fal" && operation === "animate_image" && args.ratio !== undefined) throw new Error("This image-to-video endpoint takes its shape from the source; omit ratio");
    const input = INPUTS.has(operation) ? await this.input(args.input, operation === "edit_image" || operation === "animate_image" ? "image" : kind === "audio" ? "audio" : "video") : undefined;
    if (operation === "transcribe_audio" && (input!.type !== "audio/wav" || input!.bytes.length > 8_000_000)) throw new Error("Transcription uses the existing voice adapters: choose a WAV file under 8 MB");
    const mask = args.mask === undefined ? undefined : await this.input(args.mask, "image");
    const endFrame = args.end_frame === undefined ? undefined : await this.input(args.end_frame, "image");
    if (mask && mask.type !== "image/png") throw new Error("An edit mask must be PNG");
    const voice = args.voice === undefined ? undefined : text(args.voice, 80);
    if (operation === "create_speech" && !chosen.voices?.some((v) => v.id === voice)) throw new Error("Choose a listed voice for this model");
    if (args.language !== undefined && (typeof args.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(args.language))) throw new Error("Invalid language tag");
    const prompt = NO_PROMPT.has(operation) ? "" : text(args.prompt, chosen.model === "eleven_v4" ? 2000 : 4096);
    return { chosen, operation, prompt, input, mask, endFrame, nativeAudio: args.audio as boolean | undefined, voice, language: args.language as string | undefined, ratio, quality, background, seconds };
  }
  async submit(kind: MediaKind, operation: MediaOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<MediaJob> {
    if (operationKind(operation) !== kind) throw new Error("Wrong media plugin");
    const req = await this.validate(kind, operation, args);
    if (!req.chosen.local) { const provider = this.providers().find((p) => p.id === req.chosen.provider); if (!provider?.available) throw new Error("Add this provider's key in Settings → Providers first"); }
    signal?.throwIfAborted();
    this.assertConfigured(kind, operation, mediaSelection(req.chosen));
    if (this.active.size >= 3) throw new Error("Three media jobs are already active; wait for one to finish");
    if (this.saved.jobs.length >= 200) throw new Error("Media history is full; remove old results first");
    const job: MediaJob = { id: randomUUID(), kind, operation, selection: mediaSelection(req.chosen), created: new Date().toISOString(), state: "submitting", inputs: [args.input, args.mask, args.end_frame].filter((v): v is string => typeof v === "string"), assets: [], ...(this.sessions.getStore() ? { session: this.sessions.getStore() } : {}) };
    this.saved.jobs.push(job); this.persist();
    // This is bounded provider I/O, with no model loop or task dispatcher.
    this.start(job, (ctx) => kind === "image" ? image(req, ctx) : kind === "audio" ? audio(req, ctx, this.opts.voiceDir) : video(req, ctx));
    return structuredClone(job);
  }
  private start(job: MediaJob, run: (ctx: Context) => Promise<MediaResult>): void {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]);
    const env = { ...this.env() };
    const provider = job.selection.split("|")[0];
    const credential = PROVIDERS.find((p) => p.id === provider)?.keyVar;
    const ctx: Context = { env, f: this.opts.fetcher ?? fetch, signal, pollMs: this.opts.pollMs ?? 3000, download: this.opts.download ?? download,
      guard: () => {
        this.assertConfigured(job.kind, job.operation, job.selection);
        if (credential && env[credential] !== this.env()[credential]) throw new Error("Media provider credentials changed. Review settings before resuming.");
      },
      checkpoint: (id) => { job.remoteId = id; job.state = "running"; this.persist(); },
    };
    const work = Promise.resolve().then(async () => {
      try {
        ctx.guard();
        const result = await run(ctx);
        signal.throwIfAborted(); ctx.guard();
        if (result.files.length > 1) throw new Error("Too many media outputs for this operation");
        for (const bytes of result.files) {
          if (!bytes.length || bytes.length > 100_000_000 || !mediaType(bytes).startsWith(`${job.kind}/`)) throw new Error("Invalid media output");
          job.assets.push(this.saveAsset(bytes, job.id).id);
        }
        if (result.text !== undefined) { if (result.text.length > 200_000) throw new Error("Transcript is too large"); job.assets.push(this.saveAsset(Buffer.from(result.text, "utf8"), job.id, true).id); }
        if (!job.assets.length) throw new Error("Provider produced no usable output");
        job.usage = usageNumbers(result.usage); job.state = "succeeded"; delete job.error;
        this.persist();
        try { await this.publish(job, signal); } catch { job.projectionError = "The saved files are ready, but their surface could not be published. Use Show result to retry without generating again."; }
      } catch (err) {
        const rejected = !job.remoteId && /^Media provider returned HTTP 4\d\d$/.test((err as Error).message);
        job.state = rejected || /^Provider reported/.test((err as Error).message) ? "failed" : job.remoteId ? "interrupted" : "unknown";
        // No raw provider error body, input, URL or key is retained here.
        const message = (err as Error).message;
        job.error = /HTTP \d{3}|Unsupported|Invalid|Provider (reported|returned|produced|did)|Media plugin|Choose|too (large|many)|Empty|media output|media response/i.test(message) ? message.slice(0, 300) : "Media work was interrupted. The provider may still be running or may have charged. No generation was retried.";
      } finally {
        this.active.delete(job.id);
        this.persist();
      }
    });
    this.active.set(job.id, { abort, work });
    // Persist failures remain visible through the engine's unhandled-rejection log.
  }
  job(kind: MediaKind, id: string): MediaJob {
    if (this.failure) throw new Error(this.failure);
    const job = this.saved.jobs.find((j) => j.id === id && j.kind === kind);
    if (!job) throw new Error("Unknown media job");
    return structuredClone(job);
  }
  private async publish(job: MediaJob, signal?: AbortSignal): Promise<void> {
    if (!this.opts.publish) return;
    job.surface = await this.opts.publish(job, this.saved.assets.filter((a) => job.assets.includes(a.id)), signal);
    delete job.projectionError;
  }
  async resume(kind: MediaKind, id: string): Promise<void> {
    const old = this.job(kind, id);
    if (this.active.has(id) || !old.remoteId || old.state === "succeeded" || old.state === "failed") throw new Error("This job cannot be resumed");
    this.assertConfigured(kind, old.operation, old.selection);
    if (this.active.size >= 3) throw new Error("Three media jobs are already active");
    const job = this.saved.jobs.find((j) => j.id === id)!;
    const [provider, model] = job.selection.split("|");
    if (provider !== "fal" && provider !== "luma") throw new Error("This provider has no recoverable job ID");
    if (!MODELS.some((m) => mediaSelection(m) === job.selection && m.operations.includes(job.operation))) throw new Error("This model is no longer supported for job recovery");
    job.state = "running"; delete job.error; this.persist();
    this.start(job, (ctx) => provider === "fal" ? falResult(model!, job.remoteId!, ctx) : lumaResult(job.remoteId!, ctx));
  }
  stop(kind: MediaKind, id: string): void {
    this.job(kind, id);
    this.active.get(id)?.abort.abort();
  }
  private removeJob(kind: MediaKind, id: string): void {
    this.job(kind, id);
    if (this.active.has(id)) throw new Error("Stop waiting for this job before removing its record");
    const job = this.saved.jobs.find((j) => j.id === id)!;
    if (job.remoteId && !["succeeded", "failed"].includes(job.state)) throw new Error("Reconcile the provider job before removing its recovery record");
    this.saved.jobs = this.saved.jobs.filter((j) => j.id !== id); this.persist();
  }
  async close(): Promise<void> { this.closed = true; const active = [...this.active.values()]; active.forEach((j) => j.abort.abort()); await Promise.allSettled(active.map((j) => j.work)); }
  async route(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const deletedSession = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (deletedSession && req.method === "DELETE" && !this.failure) {
      const session = decodeURIComponent(deletedSession[1]!);
      for (const job of this.saved.jobs) if (job.session === session) { this.active.get(job.id)?.abort.abort(); delete job.session; delete job.surface; }
      this.persist();
      return false;
    }
    if (!url.pathname.startsWith("/api/media")) return false;
    try {
      if (url.pathname === "/api/media/providers" && req.method === "GET") { json(res, 200, this.providers()); return true; }
      if (this.failure) throw new Error(this.failure);
      const kind = /^\/api\/media\/(image|audio|video)$/.exec(url.pathname)?.[1];
      if (kind && isMediaKind(kind) && req.method === "GET") { json(res, 200, await this.view(kind)); return true; }
      const jobsKind = /^\/api\/media\/(image|audio|video)\/jobs$/.exec(url.pathname)?.[1];
      if (jobsKind && isMediaKind(jobsKind) && req.method === "GET") {
        const jobs = this.saved.jobs.filter((j) => j.kind === jobsKind).slice().reverse();
        const projections: Record<string, SurfaceSnapshot> = {};
        for (const job of jobs.slice(0, 20)) if (job.surface) { const snap = await this.opts.projection?.(job); if (snap) projections[job.id] = snap; }
        json(res, 200, { jobs, assets: this.saved.assets, projections }); return true;
      }
      if (url.pathname === "/api/media/import" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > INPUT_LIMIT * 1.4) throw new Error("Media inputs are limited to 20 MB"); }
        const body = object(JSON.parse(raw));
        const bytes = base64(body.data, INPUT_LIMIT);
        const a = this.saveAsset(bytes, undefined, false, text(body.name, 160));
        json(res, 200, a); return true;
      }
      const assetId = /^\/api\/media\/assets\/([\w-]+)$/.exec(url.pathname)?.[1];
      if (assetId && (req.method === "GET" || req.method === "DELETE")) {
        const a = this.saved.assets.find((a) => a.id === assetId);
        if (!a) { json(res, 404, { error: "Unknown media asset" }); return true; }
        if (req.method === "DELETE") {
          if (this.saved.jobs.some((j) => this.active.has(j.id) && j.inputs.includes(a.id))) throw new Error("This file is used by an active job");
          unlinkSync(this.assetFile(a)); this.saved.assets = this.saved.assets.filter((x) => x.id !== a.id); this.persist(); json(res, 200, { ok: true }); return true;
        }
        const assetFile = path.join(await realpath(this.opts.dir), path.basename(this.assetFile(a)));
        const handle = await open(assetFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile()) { await handle.close(); throw new Error("Media file is not a regular library entry"); }
        const headers = { "content-type": a.type, "content-disposition": `inline; filename="${a.id}${a.type === "text/plain" ? ".txt" : TYPES[a.type]}"`, "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
        let start = 0, end = info.size - 1;
        if (req.headers.range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!m || (start = Number(m[1])) > (end = m[2] ? Number(m[2]) : end) || end >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { await handle.close(); res.writeHead(416, { "content-range": `bytes */${info.size}` }).end(); return true; }
          res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
        } else res.writeHead(200, { ...headers, "content-length": info.size });
        const stream = handle.createReadStream(info.size ? { start, end } : {});
        stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); return true;
      }
      const action = /^\/api\/media\/(image|audio|video)\/jobs\/([\w-]+)\/(resume|stop|remove|publish)$/.exec(url.pathname);
      if (action && isMediaKind(action[1]!) && req.method === "POST") {
        // An explicit UI command; recovery never submits a new generation.
        await readJson(req);
        if (action[3] === "resume") await this.resume(action[1], action[2]!);
        else if (action[3] === "stop") this.stop(action[1], action[2]!);
        else if (action[3] === "publish") { const job = this.saved.jobs.find((j) => j.id === action[2] && j.kind === action[1]); if (!job || job.state !== "succeeded") throw new Error("No completed result to show"); await this.publish(job); this.persist(); }
        else this.removeJob(action[1], action[2]!);
        json(res, 200, { ok: true }); return true;
      }
      json(res, 404, { error: "Unknown media route" });
    } catch (err) { if (!res.headersSent) json(res, 400, { error: (err as Error).message }); }
    return true;
  }
}
