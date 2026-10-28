// The Vakyartha app server: @vak/host plus the app's own routes (settings, channels,
// info) and, optionally, the built UI. The desktop sidecar runs it behind a
// token for the Tauri window; the playground runs it open on :5177 for a
// browser, serving the same UI, so both show one interface.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createFetchHandler, type HostRequest, type HostResponse } from "@vak/host";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHost, json, readJson } from "@vak/host";
import { attachmentsRoute } from "./attachments.ts";
import type { Integrations } from "@vak/mcp/client";
import { hardenNetwork, loadEnvFile, ProfileCache, type ProviderEntry, providersFromEnv, pinnedFetch } from "@vak/providers";
import { Channels, CHANNELS } from "./channels.ts";
import { Marketplaces } from "./marketplaces.ts";
import { Skills } from "./skills.ts";
import { MARKETPLACES, type MarketplaceId } from "../shared/marketplaces.ts";
import { integrationCatalog, createIntegrations } from "./integrations.ts";
import { runUsage } from "../shared/finops.ts";
import { Finops } from "./finops.ts";
import { TaskFiles } from "./task-files.ts";
import { fileSecrets, keychainStore, Settings, SettingsError } from "./settings.ts";
import { checkTaskSpending } from "./task-policy.ts";
import { Tasks } from "./tasks.ts";
import { voiceRoutes } from "./voice/index.ts";
import { Media } from "./media/index.ts";
import { isMediaKind } from "../shared/media.ts";
import { sandboxHelper, validateSandboxWorkspace } from "./sandbox-status.ts";
import { generateSkillPackage, suggestSkillElement } from "./skills-copilot.ts";
import { evaluateSkillPrompts } from "./skills-eval.ts";
import { runSkillScript } from "./skills-sandbox.ts";
import type { SkillGenerateRequest, SkillSuggestRequest } from "../shared/skills.ts";
import { SandboxPoolManager } from "./sandbox-pool/pool-manager.ts";
import { AppRegistry } from "./sandbox-pool/app-registry.ts";

export interface AppServerOptions {
  /** Conversations, settings, channels, logs (and profiles/transcripts unless given). */
  dataDir: string;
  /** Extra .env files read after saved settings (developer keys). */
  envFiles?: string[];
  keychainService?: string;
  /** Model profile cache; default <dataDir>/models.json. */
  profilesPath?: string;
  /** Raw model output per session; default <dataDir>/transcripts. */
  transcriptsDir?: string;
  port?: number;
  /**
   * "token": every request needs the bearer token (a webview on another origin).
   * "open": no token, for the UI this server serves itself; the host still
   * refuses other origins, non-JSON bodies and non-loopback Host names.
   */
  access: "token" | "open";
  /** npm for installing integrations: a command or a path to npm-cli.js (the release app bundles one). */
  npm?: string;
  /** Path to vaksb binary for OS-level sandboxing (release app bundles one). */
  sandboxBin?: string;
  /** Discovery transport override for deterministic catalog/lifecycle checks. */
  marketplaceFetch?: typeof fetch;
  marketplaceImageFetch?: typeof pinnedFetch;
  /** Built UI to serve at / (the playground); none: API only. */
  uiDir?: string;
  appName?: string;
  version?: string;
  /** Desktop uses private parent pipes and opens no network listener. */
  transport?: "http" | "stdio";
}

export interface AppServer {
  port: number;
  request(request: Request): Promise<Response>;
  token?: string;
  url: string;
  shutdown(): Promise<void>;
  pool?: SandboxPoolManager;
  apps?: AppRegistry;
}

export async function startAppServer(opts: AppServerOptions): Promise<AppServer> {
  const dataDir = opts.dataDir;
  mkdirSync(path.join(dataDir, "logs"), { recursive: true });

  // A release app has no terminal: engine output goes to logs/engine.log
  // (one previous file kept), as well as stderr for `npm run desktop`.
  const logFile = path.join(dataDir, "logs", "engine.log");
  const voiceDir = path.join(dataDir, "voice");
  function log(line: string): void {
    console.error(line);
    try {
      if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging must never take the engine down */
    }
  }
  process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) => log(`unhandled: ${(err as Error)?.stack ?? err}`));

  const settingsFile = path.join(dataDir, "settings.env");
  const settings = new Settings({
    file: settingsFile,
    secrets: process.platform === "darwin" ? keychainStore(opts.keychainService ?? "com.nranjan2code.vakyartha") : fileSecrets(settingsFile),
  });
  // Settings saved in the app win over a developer's .env.
  try {
    settings.load();
  } catch (err) {
    log(`settings not loaded: ${(err as Error).message}`);
  }
  for (const file of opts.envFiles ?? []) loadEnvFile(file);
  hardenNetwork();

  async function settingsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/api/sandbox" && req.method === "GET") {
      const enabled = process.env.VAK_SANDBOX_ENABLED !== "false";
      const workspace = process.env.VAK_SANDBOX_WORKSPACE ?? "";
      let workspaceError: string | undefined;
      try { if (workspace) validateSandboxWorkspace(workspace); else workspaceError = "Choose a project folder to enable command execution."; }
      catch (error) { workspaceError = (error as Error).message; }
      const execution = integrations!.view().find(i => i.entry.id === "sandbox-execution");
      json(res, 200, {
        enabled, processIsolationEnabled, restartRequired: enabled !== processIsolationEnabled,
        platform: process.platform, helper: await sandboxHelper(sandboxBin),
        workspace: { path: workspace, valid: !workspaceError, error: workspaceError },
        execution: { enabled: execution?.enabled ?? false, status: execution?.status ?? "off", policy: execution?.tools.find(t => t.name === "run_command")?.policy ?? "ask" },
      });
      return true;
    }
    if (url.pathname !== "/api/settings") return false;
    if (req.method === "PUT") {
      const body = await readJson(req);
      try {
        if (body.values && typeof body.values === "object") {
          const changed = settings.save(body.values);
          // A channel restarts when its own token changed (a provider key change applies on its next turn).
          for (const c of CHANNELS) if (c.secrets.some((s) => changed.includes(s.name))) void channels.configure(c.id, {});
        }
      } catch (err) {
        json(res, err instanceof SettingsError ? 400 : 500, { error: (err as Error).message });
        return true;
      }
    } else if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return true;
    }
    json(res, 200, settings.view());
    return true;
  }

  /** UI errors (and debug-build probes) into the engine log: a release window has no console. */
  async function clientLogRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/api/client-log" || req.method !== "POST") return false;
    const body = await readJson(req);
    log(`[ui ${String(body.level ?? "error").slice(0, 10)}] ${String(body.message ?? "").slice(0, 2000)}`);
    json(res, 200, { ok: true });
    return true;
  }

  const attachRoute = attachmentsRoute(path.join(dataDir, "attachments"));
  const voiceRoute = voiceRoutes(voiceDir, log, () => modelProviders());

  /** For the About page: where things are kept. */
  function infoRoute(req: HostRequest, res: HostResponse, url: URL): boolean {
    if (url.pathname !== "/api/info" || req.method !== "GET") return false;
    json(res, 200, { version: opts.version ?? "dev", node: process.version, platform: process.platform, dataDir, logFile, keys: settings.secrets.kind === "keychain" ? "macOS Keychain" : "settings file (owner-only)" });
    return true;
  }

  async function channelsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/api/channels" && req.method === "GET") {
      json(res, 200, channels.view());
      return true;
    }
    const m = /^\/api\/channels\/([\w-]+)$/.exec(url.pathname);
    if (!m || req.method !== "PUT") return false;
    const body = await readJson(req);
    const change: { enabled?: boolean; provider?: string; model?: string } = {};
    if (typeof body.enabled === "boolean") change.enabled = body.enabled;
    if (typeof body.provider === "string") change.provider = body.provider;
    if (typeof body.model === "string") change.model = body.model.trim();
    try {
      await channels.configure(m[1]!, change);
      json(res, 200, channels.view());
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  const skills = new Skills(dataDir, opts.marketplaceFetch);
  const INSTRUCTIONS = () => `You are the assistant inside ${opts.appName ?? "Vakyartha, a desktop app"}.
Today is ${new Date().toISOString().slice(0, 10)}.
${skills.index()}`;

  const profiles = new ProfileCache(opts.profilesPath ?? path.join(dataDir, "models.json"));
  const finops = new Finops(dataDir, log);
  const channels = new Channels({
    env: process.env,
    providers: () => providersFromEnv().map(entry => ({ ...entry, make: options => skills.provider(entry.make(options)) })),
    profiles,
    dataDir,
    log,
  });

  let listening = 0;
  const token = opts.access === "token" ? randomBytes(32).toString("base64url") : undefined;
  // Created after the host (it asks the host for approvals); the host reads it per turn.
  let integrations: Integrations | undefined;
  let marketplaces: Marketplaces;
  let tasks: Tasks | undefined;
  const media = new Media({ dir: path.join(dataDir, "media"), attachmentsDir: path.join(dataDir, "attachments"), voiceDir,
    config: (kind) => integrations?.configuration(`media-${kind}`) ?? { enabled: false, config: {} },
    async publish(job, assets, signal) {
      job.session ??= `media-${job.id}`;
      const surface = `media-${job.id}`;
      const nodes = assets.map((a, index) => ({ id: `asset-${index}`, type: a.type === "text/plain" ? "text" : "media", props: a.type === "text/plain" ? { content: media.readText(a.id) } : { kind: a.type.split("/")[0], src: `media:${a.id}`, title: `${job.kind === "image" ? "Image" : job.kind === "audio" ? "Audio" : "Video"} result`, description: `${job.selection.replace("|", " / ")} · ${(a.bytes / 1_000_000).toFixed(2)} MB`, alt: `${job.kind} result` } }));
      for (let attempt = 0; attempt < 120; attempt++) {
        signal?.throwIfAborted();
        if ((await host.view(job.session)).running) { await delay(250, undefined, { signal }); continue; }
        const result = await host.project({ session: job.session, external: false, args: { surface, title: "Media result", nodes: [{ id: "root", type: "stack", children: nodes.map((n) => n.id) }, ...nodes] } });
        if (result.diagnostics.length) throw new Error("Media surface was not accepted");
        return surface;
      }
      throw new Error("The chat is still busy; files remain saved");
    },
    async projection(job) { return job.session && job.surface ? (await host.view(job.session)).surfaces.find((s) => s.id === job.surface) : undefined; },
  });
  const integrationRevisions = new Map<string, number>();
  /** Model providers for turns and voice answers alike: task spending checks and FinOps see every request. */
  function modelProviders(): ProviderEntry[] {
    // Bind admission checks and provider construction to the same configuration.
    const env = { ...process.env };
    const entries = providersFromEnv(env).map((entry) => ({ ...entry, make: (options: Parameters<typeof entry.make>[0]) => {
      const spending = tasks?.providerSpending(entry.id);
      if (spending) checkTaskSpending(entry, spending, env);
      return entry.make(options);
    } }));
    // Refused requests never reach either the provider or its usage observer.
    return finops.providers(entries).map((entry) => ({ ...entry, make: (options) => {
      const provider = entry.make(options);
      return skills.provider({ ...provider, async *stream(request) {
        await tasks?.beforeModelRequest(entry.id, request.model);
        yield* provider.stream(tasks?.inTask() ? { ...request, maxTokens: Math.min(request.maxTokens ?? 4096, 4096) } : request);
      } });
    } }));
  }
  const host = createHost({
    tools: async ({ session }) => {
      finops.session(session);
      return withSkill((await integrations?.toolsFor(session) ?? []).map((tool) => ({ ...tool, execute: (args, ctx) => media.withSession(session, () => tool.execute(args, ctx)) })));
    },
    providers: () => modelProviders(),
    profiles,
    instructions: INSTRUCTIONS,
    transcripts: opts.transcriptsDir ?? path.join(dataDir, "transcripts"),
    sessionsDir: path.join(dataDir, "sessions"),
    token,
    allowSessionMutation: (session) => !tasks?.owns(session),
    // The webview's origin per platform (macOS/Linux, Windows) and the Vite dev server.
    origins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
    // Outside agents get a link to watch what they projected (only when this server serves the UI).
    viewerUrl: opts.uiDir ? (session) => `http://127.0.0.1:${listening}/?session=${encodeURIComponent(session)}` : undefined,
    routes: async (req, res, url) => (await attachRoute(req, res, url)) || (await media.route(req, res, url)) || (await tasksRoute(req, res, url)) || (await finopsRoute(req, res, url)) || (await skillsRoute(req, res, url)) || (await settingsRoute(req, res, url)) || (await channelsRoute(req, res, url)) || (await integrationsRoute(req, res, url)) || (await clientLogRoute(req, res, url)) || (await voiceRoute(req, res, url)) || (await adminFleetRoute(req, res, url)) || (await appsRoute(req, res, url)) || infoRoute(req, res, url),
    log,
  });

  const pool = new SandboxPoolManager();
  const apps = new AppRegistry({ dataDir, pool, seedBuiltins: true });
  await apps.init();

  const sandboxBin = opts.sandboxBin || "vaksb";
  marketplaces = new Marketplaces(dataDir, integrationCatalog(media, sandboxBin, dataDir), opts.marketplaceFetch, opts.marketplaceImageFetch);
  const processIsolationEnabled = process.env.VAK_SANDBOX_ENABLED !== "false";
  integrations = createIntegrations({ dataDir, observe: (request, result) => tasks?.observeResult(request, result), secrets: settings.secrets, log, approve: (req, emit, signal) => tasks?.inTask() ? tasks.approve(req, emit, signal) : host.approve(req, emit, signal), npm: opts.npm, vakSandbox: { enabled: processIsolationEnabled, binaryPath: sandboxBin } }, media, marketplaces.catalog);
  // Refresh app-owned tool schemas after an upgrade; the integration journal
  // may otherwise retain an older model's controls indefinitely.
  for (const entry of integrations.view().filter((i) => i.enabled && (i.entry.id.startsWith("media-") || i.entry.id === "sandbox-execution"))) {
    if (entry.entry.id === "media-audio") { try { await media.models("audio"); } catch { log("Media voice metadata is unavailable; no generation was attempted."); } }
    await integrations.refresh(entry.entry.id);
  }
  const freeCapabilities = new Set(["time", "web", "files", "memory"]);
  tasks = await Tasks.open({
    files: new TaskFiles(path.join(dataDir, "outputs"), opts.transcriptsDir ?? path.join(dataDir, "transcripts")),
    dir: path.join(dataDir, "tasks"), run: host.run, view: host.view, remove: host.remove,
    tools: async (session) => withSkill(await integrations!.toolsFor(session)), instructions: INSTRUCTIONS,
    observe: (session, work, run) => finops.chat(async () => { finops.session(session); await work(); }, run), warn: log,
    permissionRevision: (server) => integrationRevisions.get(server) ?? 0,
    permitted: (server, tool) => integrations!.view().some((i) => i.entry.id === server && i.enabled && i.status === "ready" && i.tools.some((t) => t.name === tool && t.policy !== "off")),
    ready(provider, model, selected, confirmedFree, spending) {
      const chosen = providersFromEnv().find((p) => p.id === provider && p.available);
      if (!model || !chosen) throw new Error("Choose an available model");
      checkTaskSpending(chosen, spending, process.env);
      const available = integrations!.view();
      for (const id of selected) if (!available.some((i) => i.entry.id === id && i.enabled && i.status === "ready" && (freeCapabilities.has(id) || (i.entry.trust === "custom" && confirmedFree.includes(id))))) throw new Error("Choose a ready free capability, or verify the cost of your own configured server");
    },
  });

  async function tasksRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const outputRun = /^\/api\/tasks\/([\w-]+)\/runs\/([\w-]+)\/output$/.exec(p);
    if (outputRun && (req.method === "POST" || req.method === "GET")) {
      try { json(res, 200, req.method === "GET" ? await tasks!.outputContent(outputRun[1]!, outputRun[2]!) : await tasks!.output(outputRun[1]!, outputRun[2]!, await readJson(req))); }
      catch (error) { json(res, 409, { error: (error as Error).message }); }
      return true;
    }
    // A task's session is controlled through task commands even between runs.
    const sessionId = /^\/api\/sessions\/([^/]+)$/.exec(p)?.[1];
    if (sessionId && req.method !== "GET" && tasks?.owns(decodeURIComponent(sessionId))) {
      json(res, 409, { error: "This conversation belongs to a task; use its task controls" }); return true;
    }
    if (p === "/api/task-capabilities" && req.method === "GET") {
      json(res, 200, integrations!.view().filter((i) => freeCapabilities.has(i.entry.id) || i.entry.trust === "custom").map((i) => ({ id: i.entry.id, name: i.entry.name, summary: i.entry.summary, ready: i.enabled && i.status === "ready", free: freeCapabilities.has(i.entry.id), access: i.entry.access })));
      return true;
    }
    const usage = /^\/api\/tasks\/([\w-]+)\/runs\/([\w-]+)\/usage$/.exec(p);
    if (usage) {
      if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }
      try {
        const task = tasks!.get(usage[1]!);
        if (!task.runHistory.some((run) => run.id === usage[2])) throw new Error("Run not found in this task");
        json(res, 200, runUsage(finops.view(), task.id, usage[2]!));
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
      return true;
    }
    const m = /^\/api\/tasks(?:\/([\w-]+)(?:\/(input|cancel|complete|approve|schedule|review))?)?$/.exec(p);
    if (!m) return false;
    try {
      const [, id, operation] = m;
      if (!id && req.method === "GET") json(res, 200, tasks!.list());
      else if (!id && req.method === "POST") json(res, 201, await tasks!.create(await readJson(req)));
      else if (id && !operation && req.method === "GET") json(res, 200, tasks!.get(id));
      else if (id && operation === "review" && req.method === "GET") json(res, 200, await tasks!.review(id));
      else if (id && !operation && req.method === "DELETE") { await tasks!.remove(id, await readJson(req)); json(res, 200, { ok: true }); }
      else if (id && operation && operation !== "review" && req.method === "POST") {
        const body = await readJson(req);
        const result = operation === "input" ? await tasks!.input(id, body) : operation === "cancel" ? await tasks!.cancel(id) : operation === "complete" ? await tasks!.complete(id, body) : operation === "schedule" ? await tasks!.changeSchedule(id, body) : await tasks!.answer(id, String(body.approval), body.decision);
        json(res, 200, result);
      } else json(res, 405, { error: "method not allowed" });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  function withSkill<T>(tools: T[]): T[] {
    return [...tools, ...skills.tools() as T[]];
  }

  async function skillsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith("/api/skills")) return false;
    try {
      const m = /^\/api\/skills(?:\/(catalog|review|review-file|describe|add|icon|generate|suggest|eval)|\/([a-z0-9-]+)(?:\/(file|proposed-file|package|draft|publish|sandbox-test))?)?$/.exec(p);
      if (!m) json(res, 404, { error: "Unknown skill route" });
      else if (m[1] === "catalog" && req.method === "GET") json(res, 200, await skills.search(url.searchParams.get("repo") ?? ""));
      else if (m[1] === "icon" && req.method === "GET") {
        const image = await skills.icon(url.searchParams.get("repo") ?? "");
        res.writeHead(200, { "content-type": image.type, "content-length": image.bytes.length, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=3600" });
        res.end(image.bytes);
      }
      else if (m[1] === "review" && req.method === "POST") { const b = await readJson(req); json(res, 200, await skills.review(String(b.repo ?? ""), String(b.path ?? ""))); }
      else if (m[1] === "review-file" && req.method === "POST") { const b = await readJson(req); json(res, 200, { text: skills.reviewFile(String(b.fingerprint ?? ""), String(b.path ?? "")) }); }
      else if (m[1] === "describe" && req.method === "POST") { const b = await readJson(req); json(res, 200, await skills.describe(String(b.repo ?? ""), b.paths)); }
      else if (m[1] === "add" && req.method === "POST") { const b = await readJson(req); json(res, 200, { name: skills.add(String(b.fingerprint ?? ""), b.acknowledged === true) }); }
      else if (m[1] === "generate" && req.method === "POST") {
        const b = await readJson(req) as unknown as SkillGenerateRequest;
        const toolsList = integrations ? integrations.view().filter(i => i.enabled && i.status === "ready").flatMap(i => i.tools.filter(t => t.policy !== "off").map(t => t.name)) : [];
        json(res, 200, await generateSkillPackage(b, toolsList));
      }
      else if (m[1] === "suggest" && req.method === "POST") {
        const b = await readJson(req) as unknown as SkillSuggestRequest;
        const toolsList = integrations ? integrations.view().filter(i => i.enabled && i.status === "ready").flatMap(i => i.tools.filter(t => t.policy !== "off").map(t => t.name)) : [];
        json(res, 200, suggestSkillElement(b, skills.view(), toolsList));
      }
      else if (m[1] === "eval" && req.method === "POST") {
        const b = await readJson(req);
        const provs = modelProviders();
        const activeProv = provs[0]?.make({});
        json(res, 200, await evaluateSkillPrompts(skills, String(b.name ?? ""), Array.isArray(b.prompts) ? b.prompts : [], activeProv));
      }
      else if (m[2] && m[3] === "package" && req.method === "GET") json(res, 200, skills.getPackage(m[2]));
      else if (m[2] && m[3] === "package" && req.method === "PUT") {
        const b = await readJson(req);
        json(res, 200, skills.savePackage(m[2], b, typeof b.previous === "string" ? b.previous : undefined));
      }
      else if (m[2] && m[3] === "draft" && req.method === "GET") json(res, 200, skills.getDraft(m[2]));
      else if (m[2] && m[3] === "draft" && req.method === "PUT") {
        const b = await readJson(req);
        json(res, 200, skills.saveDraft(m[2], b));
      }
      else if (m[2] && m[3] === "draft" && req.method === "DELETE") {
        skills.discardDraft(m[2]);
        json(res, 200, { ok: true });
      }
      else if (m[2] && m[3] === "publish" && req.method === "POST") {
        const b = await readJson(req).catch(() => ({}));
        json(res, 200, skills.publishDraft(m[2], b));
      }
      else if (m[2] && m[3] === "sandbox-test" && req.method === "POST") {
        const b = await readJson(req);
        const result = await runSkillScript(skills, m[2], String(b.scriptPath ?? ""), Array.isArray(b.args) ? b.args : [], {
          binaryPath: sandboxBin,
          enabled: () => process.env.VAK_SANDBOX_ENABLED !== "false",
          authorized: () => integrations!.view().some(i => i.entry.id === "sandbox-execution" && i.enabled && i.status === "ready" && i.tools.some(t => t.name === "run_command" && t.policy !== "off")),
          scriptSha256: String(b.scriptSha256 ?? ""),
        });
        log(`Skill rehearsal ${m[2]} ${result.scriptPath ?? "refused"}: exit ${result.exitCode}, sha256 ${result.scriptSha256 ?? "none"}`);
        json(res, 200, result);
      }
      else if (m[2] && m[3] === "file" && req.method === "GET") json(res, 200, skills.fileText(m[2], url.searchParams.get("path") ?? ""));
      else if (m[2] && m[3] === "proposed-file" && req.method === "GET") json(res, 200, { text: skills.proposedBuiltinFile(m[2], url.searchParams.get("fingerprint") ?? "", url.searchParams.get("path") ?? "") });
      else if (!m[1] && !m[2] && req.method === "GET") json(res, 200, skills.view());
      else if (!m[1] && !m[2] && req.method === "POST") { const b = await readJson(req); json(res, 200, skills.save(String(b.text ?? ""))); }
      else if (m[2] && req.method === "PUT") { const b = await readJson(req); if (typeof b.enabled === "boolean") skills.setEnabled(m[2], b.enabled); else if (typeof b.updateFingerprint === "string") skills.updateBuiltin(m[2], b.updateFingerprint, String(b.currentFingerprint ?? "")); else skills.save(String(b.text ?? ""), m[2]); json(res, 200, skills.view()); }
      else if (m[2] && req.method === "DELETE") { skills.remove(m[2]); json(res, 200, skills.view()); }
      else json(res, 405, { error: "method not allowed" });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  async function finopsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/api/finops") return false;
    if (req.method === "GET") json(res, 200, finops.view());
    else if (req.method === "PUT") {
      try { finops.setRate(await readJson(req)); json(res, 200, finops.view()); }
      catch (err) { json(res, 400, { error: (err as Error).message }); }
    } else json(res, 405, { error: "method not allowed" });
    return true;
  }

  async function integrationsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === "/api/marketplaces" && req.method === "GET") { json(res, 200, MARKETPLACES); return true; }
    if (p.startsWith("/api/marketplaces/")) {
      try {
        const match = /^\/api\/marketplaces\/(mcp|github|docker)(?:\/(review|add|icon))?$/.exec(p);
        if (!match) { json(res, 404, { error: "Unknown marketplace" }); return true; }
        const source = match[1] as MarketplaceId;
        if (!match[2] && req.method === "GET") json(res, 200, await marketplaces.search(source, url.searchParams.get("q") ?? "", url.searchParams.get("cursor") ?? ""));
        else if (match[2] === "icon" && req.method === "GET") {
          const image = await marketplaces.icon(source, url.searchParams.get("q") ?? "", url.searchParams.get("cursor") ?? "", url.searchParams.get("key") ?? "");
          res.writeHead(200, { "content-type": image.type, "content-length": image.bytes.length, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=3600" });
          res.end(image.bytes);
        }
        else if (match[2] === "review" && req.method === "POST") {
          const b = await readJson(req);
          json(res, 200, await marketplaces.review(source, String(b.query ?? ""), String(b.cursor ?? ""), String(b.key ?? ""), String(b.option ?? "")));
        } else if (match[2] === "add" && req.method === "POST") {
          const b = await readJson(req);
          json(res, 200, { id: marketplaces.add(String(b.fingerprint ?? ""), b.acknowledged === true) });
        } else json(res, 405, { error: "Method not allowed" });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
      return true;
    }
    if (!p.startsWith("/api/integrations")) return false;
    const m = /^\/api\/integrations(?:\/([\w-]+)(?:\/(install|uninstall|refresh|test|icon))?)?$/.exec(p);
    if (!m) return false;
    const [, id, verb] = m;
    try {
      const list = integrations!;
      if (!id && req.method === "GET") json(res, 200, list.view().map(i => ({ ...i, provenance: marketplaces.provenance(i.entry.id) })));
      else if (id && verb === "icon" && req.method === "GET") {
        const image = await marketplaces.importedIcon(id);
        res.writeHead(200, { "content-type": image.type, "content-length": image.bytes.length, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=3600" });
        res.end(image.bytes);
      }
      else if (id === "custom" && !verb && req.method === "POST") {
        const body = await readJson(req);
        const made = list.addCustom({ name: String(body.name ?? ""), command: body.command, args: Array.isArray(body.args) ? body.args.map(String) : undefined, url: body.url, token: body.token });
        json(res, 200, { id: made, integrations: list.view() });
      } else if (id && verb === "test" && req.method === "POST") {
        const body = await readJson(req);
        json(res, 200, await list.test(id, String(body.tool), (body.args ?? {}) as Record<string, unknown>));
      } else if (id && req.method === "POST" && verb && verb !== "icon") {
        integrationRevisions.set(id, (integrationRevisions.get(id) ?? 0) + 1);
        if (verb === "install") await list.install(id);
        else if (verb === "uninstall") { await list.uninstall(id); marketplaces.remove(id); }
        else await list.refresh(id);
        json(res, 200, list.view());
      } else if (id && !verb && req.method === "PUT") {
        const body = await readJson(req);
        const kind = id.startsWith("media-") ? id.slice(6) : "";
        if (isMediaKind(kind)) {
          if (body.secrets) throw new Error("Media keys are shared from Settings → Providers");
          if (body.config !== undefined) await media.validateConfig(kind, body.config);
        }
        integrationRevisions.set(id, (integrationRevisions.get(id) ?? 0) + 1);
        await list.configure(id, body);
        json(res, 200, list.view());
      } else return false;
    } catch (err) {
      json(res, 400, { error: (err as Error).message, integrations: integrations!.view() });
    }
    return true;
  }

  async function adminFleetRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith("/api/admin")) return false;

    try {
      if (p === "/api/admin/fleet" && req.method === "GET") {
        json(res, 200, pool.getFleetSnapshot());
        return true;
      }
      const hibernateMatch = /^\/api\/admin\/fleet\/slots\/([^/]+)\/hibernate$/.exec(p);
      if (hibernateMatch && req.method === "POST") {
        const slotId = decodeURIComponent(hibernateMatch[1]!);
        await pool.hibernate(slotId);
        json(res, 200, { ok: true, slotId });
        return true;
      }
      if (p === "/api/admin/fleet/restart" && req.method === "POST") {
        await pool.suspendAll();
        json(res, 200, { ok: true });
        return true;
      }
      if (p === "/api/admin/lifecycle/suspend" && req.method === "POST") {
        await pool.suspendAll();
        json(res, 200, { ok: true, status: "suspended" });
        return true;
      }
      if (p === "/api/admin/lifecycle/wake" && req.method === "POST") {
        await pool.wakeAndReconcile();
        json(res, 200, { ok: true, status: "reconciled" });
        return true;
      }
      if (p === "/api/admin/telemetry/stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`data: ${JSON.stringify({ type: "snapshot", data: pool.getFleetSnapshot() })}\n\n`);
        const onMetric = (m: unknown) => {
          try { res.write(`data: ${JSON.stringify({ type: "metric", data: m })}\n\n`); } catch {}
        };
        pool.on("metric", onMetric);
        const timer = setInterval(() => {
          try {
            res.write(`data: ${JSON.stringify({ type: "heartbeat", timestamp: Date.now(), fleet: pool.getFleetSnapshot() })}\n\n`);
          } catch {}
        }, 2000);
        const cleanup = () => {
          clearInterval(timer);
          pool.off("metric", onMetric);
        };
        (req as unknown as { on?: (e: string, fn: () => void) => void }).on?.("close", cleanup);
        res.on("close", cleanup);
        return true;
      }
      if (p === "/api/admin/logs/stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        const onLog = (l: unknown) => {
          try { res.write(`data: ${JSON.stringify(l)}\n\n`); } catch {}
        };
        pool.on("log", onLog);
        const cleanup = () => {
          pool.off("log", onLog);
        };
        (req as unknown as { on?: (e: string, fn: () => void) => void }).on?.("close", cleanup);
        res.on("close", cleanup);
        return true;
      }
      json(res, 404, { error: "Unknown admin endpoint" });
      return true;
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
      return true;
    }
  }

  async function appsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith("/api/apps")) return false;

    try {
      if (p === "/api/apps" && req.method === "GET") {
        json(res, 200, apps.listApps());
        return true;
      }
      if (p === "/api/apps" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") {
          json(res, 400, { error: "Request body must be an object" });
          return true;
        }
        const manifest = ("manifest" in body && typeof body.manifest === "object") ? body.manifest : body;
        const files = ("files" in body && typeof body.files === "object" && body.files !== null) ? body.files as Record<string, string> : undefined;
        const app = await apps.installApp(manifest as any, files);
        json(res, 201, app);
        return true;
      }

      const actionMatch = /^\/api\/apps\/([^/]+)\/action$/.exec(p);
      if (actionMatch && req.method === "POST") {
        const id = decodeURIComponent(actionMatch[1]!);
        const body = await readJson(req);
        const result = await apps.dispatchAction(id, String(body.controlId ?? ""), body.value, body.action ? String(body.action) : undefined);
        json(res, 200, result);
        return true;
      }

      const triggerMatch = /^\/api\/apps\/([^/]+)\/triggers\/([^/]+)\/run$/.exec(p);
      if (triggerMatch && req.method === "POST") {
        const id = decodeURIComponent(triggerMatch[1]!);
        const triggerId = decodeURIComponent(triggerMatch[2]!);
        const result = await apps.runTrigger(id, triggerId);
        json(res, 200, result);
        return true;
      }

      const stateMatch = /^\/api\/apps\/([^/]+)\/state$/.exec(p);
      if (stateMatch && req.method === "GET") {
        const id = decodeURIComponent(stateMatch[1]!);
        const app = apps.getApp(id);
        if (!app) {
          json(res, 404, { error: `App '${id}' not found` });
          return true;
        }
        const stateFile = path.join(dataDir, "apps", id, "state.json");
        if (existsSync(stateFile)) {
          try {
            const parsed = JSON.parse(readFileSync(stateFile, "utf-8"));
            json(res, 200, parsed.state ?? parsed);
            return true;
          } catch {
            json(res, 200, {});
            return true;
          }
        }
        json(res, 200, {});
        return true;
      }

      const appMatch = /^\/api\/apps\/([^/]+)$/.exec(p);
      if (appMatch) {
        const id = decodeURIComponent(appMatch[1]!);
        if (req.method === "GET") {
          const app = apps.getApp(id);
          if (!app) {
            json(res, 404, { error: `App '${id}' not found` });
            return true;
          }
          json(res, 200, app);
          return true;
        }
        if (req.method === "PUT") {
          const body = await readJson(req);
          if (!body || typeof body !== "object") {
            json(res, 400, { error: "Request body must be an object" });
            return true;
          }
          const manifest = ("manifest" in body && typeof body.manifest === "object") ? body.manifest : body;
          const files = ("files" in body && typeof body.files === "object" && body.files !== null) ? body.files as Record<string, string> : undefined;
          const app = await apps.updateApp(id, manifest as any, files);
          json(res, 200, app);
          return true;
        }
        if (req.method === "DELETE") {
          await apps.deleteApp(id);
          json(res, 200, { ok: true, id });
          return true;
        }
      }

      json(res, 405, { error: "Method not allowed" });
      return true;
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return true;
    }
  }

  const handle = async (req: HostRequest, res: HostResponse) => {
    try {
      if (req.method === "POST" && new URL(req.url ?? "/", "http://localhost").pathname === "/api/chat") {
        await finops.chat(async () => { await host.handle(req, res); });
        return;
      }
      if (await host.handle(req, res)) return;
      if (opts.uiDir && req.method === "GET") return await serveUi(opts.uiDir, req, res);
      res.writeHead(404).end("not found");
    } catch (err) {
      log(String((err as Error).stack ?? err));
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  };
  const server = opts.transport === "stdio" ? undefined : createServer((req, res) => void handle(req, res));

  // Only the explicit browser/development adapter opens a listener.
  if (server) await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = server ? (server.address() as { port: number }).port : 0;
  listening = port;
  void channels.startAll();
  return {
    port,
    request: createFetchHandler(handle),
    token,
    url: server ? `http://127.0.0.1:${port}` : "vak://localhost",
    pool,
    apps,
    async shutdown() {
      server?.close();
      await apps.shutdown();
      await pool.shutdown(2000);
      await tasks?.close();
      await media.close();
      await channels.stopAll();
      await integrations?.stopAll();
    },
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** The built UI: hashed assets cached for good, everything else falls back to index.html. */
async function serveUi(root: string, req: HostRequest, res: HostResponse): Promise<void> {
  const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
  let file = path.resolve(root, rel || "index.html");
  if (!file.startsWith(path.resolve(root) + path.sep)) return void res.writeHead(403).end();
  if (rel === "admin" && existsSync(path.join(root, "admin.html"))) {
    file = path.join(root, "admin.html");
  } else if (!existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(root, "index.html");
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    // The page itself may only talk to this server.
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self'",
  });
  res.end(readFileSync(file));
}
