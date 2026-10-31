import { AppToolResults } from "./app-tool-results.ts";
// The Vakyartha app server: @vak/host plus the app's own routes (settings, channels,
// info) and, optionally, the built UI. The desktop sidecar runs it behind a
// token for the Tauri window; the playground runs it open on :5177 for a
// browser, serving the same UI, so both show one interface.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createFetchHandler, type HostCandidateCommitRequest, type HostCandidateCommitReceipt, type HostRequest, type HostResponse, type HostSessionStore } from "@vak/host";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHost, json, readJson } from "@vak/host";
import { attachmentsRoute } from "./attachments.ts";
import { toolName, type Integrations } from "@vak/mcp/client";
import { hardenNetwork, loadEnvFile, ProfileCache, type ProviderEntry, type Provider, type AgentTool, type ProviderTransport, providersFromEnv, pinnedFetch, openai } from "@vak/providers";
import { Channels, CHANNELS } from "./channels.ts";
import { Marketplaces } from "./marketplaces.ts";
import { Skills } from "./skills.ts";
import { MARKETPLACES, type MarketplaceId } from "../shared/marketplaces.ts";
import { integrationCatalog, createIntegrations } from "./integrations.ts";
import { runUsage } from "../shared/finops.ts";
import { Finops } from "./finops.ts";
import { TaskFiles } from "./task-files.ts";
import { fileSecrets, keychainStore, nativeSecrets, Settings, SettingsError } from "./settings.ts";
import { checkTaskSpending } from "./task-policy.ts";
import { Tasks } from "./tasks.ts";
import { voiceRoutes } from "./voice/index.ts";
import { Media } from "./media/index.ts";
import { mediaType } from "./media/io.ts";
import { isMediaKind, type MediaAsset } from "../shared/media.ts";
import { sandboxHelper } from "./sandbox-status.ts";
import { generateSkillPackage, suggestSkillElement } from "./skills-copilot.ts";
import { evaluateSkillPrompts } from "./skills-eval.ts";
import { runSkillScript } from "./skills-sandbox.ts";
import type { SkillGenerateRequest, SkillSuggestRequest } from "../shared/skills.ts";
import { SandboxPoolManager } from "./sandbox-pool/pool-manager.ts";
import { AppRegistry } from "./sandbox-pool/app-registry.ts";
import { runScratch, sandboxSession } from "./sandbox-execution.ts";
import type { SandboxCall } from "./desktop-transport.ts";
import type { StdioProcess, StdioTransport } from "@vak/mcp/client";
import { withProviderTransport } from "./provider-transport.ts";
import { fitTurnControls } from "./turn-controls.ts";

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
  /** Desktop may supply the supervised native broker transport for all model providers. */
  providerTransport?: ProviderTransport;
  /** Desktop: the worker has no network; integration HTTPS goes through the native egress gate. */
  egressTransport?: typeof fetch;
  /** Desktop: command runs, Realms and folder bindings are native; absent in web mode. */
  sandbox?: SandboxCall;
  /** Desktop: Rust hosts local MCP servers and runs their pinned installs. */
  launchServer?: (t: StdioTransport) => StdioProcess;
  installPackage?: (npmArgs: string[], target: string) => Promise<void>;
  /** Native sole-writer boundary for a completed candidate. */
  candidateCommit?: (request: HostCandidateCommitRequest) => Promise<HostCandidateCommitReceipt>;
  /** Native sole-writer boundary for desktop chat snapshots. */
  nativeSessionStore?: HostSessionStore;
  /** Native capacity lease manager for desktop workloads. */
  capacityLease?: {
    reserve(requestId: string, rootId: string, amounts: Record<string, number>): Promise<{ id: number; request_id: string; root_id: string; amounts: Record<string, number> }>;
    release(lease: { id: number; request_id: string; root_id: string; amounts: Record<string, number> }): Promise<void>;
  };
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

export function typesafeProviderEntry(env: Record<string, string | undefined>): ProviderEntry {
  const key = env.TYPESAFE_API_KEY;
  const baseUrl = (env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1").replace(/\/+$/, "");
  return {
    id: "typesafe",
    label: "TypeSafe AI",
    available: Boolean(key),
    keyVar: "TYPESAFE_API_KEY",
    reason: key ? undefined : "add its key in Providers",
    make: options => {
      const p = openai({
        id: "typesafe",
        baseUrl,
        apiKey: key,
        transport: options?.transport,
        maxTokensParam: "max_tokens",
      });
      return {
        ...p,
        async listModels(signal) {
          try {
            const transport = options?.transport;
            if (transport) {
              const res = await transport("typesafe", `${baseUrl}/models`, {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: signal ?? AbortSignal.timeout(8000),
              }, { operationId: randomUUID(), attempt: 0 });
              if (!res.ok) {
                const err = await res.text().catch(() => "");
                throw new Error(`TypeSafe AI returned HTTP ${res.status}: ${err || res.statusText}`);
              }
              const body = (await res.json()) as { models?: Array<{ name?: string; id?: string } | string>; data?: Array<{ name?: string; id?: string } | string> } | Array<{ name?: string; id?: string } | string>;
              const list = Array.isArray(body) ? body : (body.models ?? body.data ?? []);
              return list.map((m) => (typeof m === "string" ? m : (m.name ?? m.id))).filter((v): v is string => Boolean(v)).sort();
            }
            if (!key) return [];
            const res = await fetch(`${baseUrl}/models`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: signal ?? AbortSignal.timeout(8000),
            });
            if (!res.ok) {
              const err = await res.text().catch(() => "");
              throw new Error(`TypeSafe AI returned HTTP ${res.status}: ${err || res.statusText}`);
            }
            const body = (await res.json()) as { models?: Array<{ name?: string; id?: string } | string>; data?: Array<{ name?: string; id?: string } | string> } | Array<{ name?: string; id?: string } | string>;
            const list = Array.isArray(body) ? body : (body.models ?? body.data ?? []);
            return list.map((m) => (typeof m === "string" ? m : (m.name ?? m.id))).filter((v): v is string => Boolean(v)).sort();
          } catch {
            return p.listModels?.(signal) ?? [];
          }
        },
      };
    },
  };
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
    secrets: opts.nativeSessionStore ? nativeSecrets() : process.platform === "darwin" ? keychainStore(opts.keychainService ?? "com.nranjan2code.vakyartha") : fileSecrets(settingsFile),
  });
  // Settings saved in the app win over a developer's .env.
  try {
    settings.load();
  } catch (err) {
    log(`settings not loaded: ${(err as Error).message}`);
  }
  for (const file of opts.envFiles ?? []) loadEnvFile(file);
  hardenNetwork();
  if (opts.egressTransport) globalThis.fetch = opts.egressTransport;

  async function settingsRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/api/sandbox" && req.method === "GET") {
      const execution = integrations!.view().find(i => i.entry.id === "sandbox-execution");
      json(res, 200, {
        platform: process.platform, native: Boolean(opts.sandbox), helper: await sandboxHelper(sandboxBin),
        execution: { enabled: execution?.enabled ?? false, status: execution?.status ?? "off", policy: execution?.tools.find(t => t.name === "run_command")?.policy ?? "ask" },
      });
      return true;
    }
    if (url.pathname !== "/api/settings") return false;
    if (req.method === "PUT") {
      const body = await readJson(req);
      try {
        if (body.presence && typeof body.presence === "object") {
          settings.updatePresence(body.presence as Record<string, boolean>);
        }
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
  // The chat's folder as Rust admits it, refreshed at each turn start for the model's context.
  type FolderBinding = { folder: string; mode: "direct" | "copy_review"; realmId?: string | null };
  const folderBindings = new Map<string, FolderBinding | null>();
  const refreshBinding = async (session: string): Promise<FolderBinding | null> => {
    const binding = opts.sandbox ? ((await opts.sandbox({ session, op: "binding", args: [] }).catch(() => null)) as FolderBinding | null) : null;
    folderBindings.set(session, binding);
    return binding;
  };
  let activeTurnSession: string | undefined;

  const formatWorkspaceInfo = (sess?: string): string => {
    const b = sess ? folderBindings.get(sess) : undefined;
    return b ? `\nActive workspace: folder "${b.folder}" (mode: ${b.mode}, status: admitted).` : "";
  };

  const getWorkspaceScope = (sess: string): string => {
    const b = folderBindings.get(sess);
    if (!b) return "Admitted workspace scope for this session:\n- No project folder is admitted for this chat session. Ask the user to use \"Work in folder\" to admit one.";
    const modeDesc = b.mode === "direct"
      ? "direct in-place editing (commands and edits write directly to the project folder under OS containment; no staging or Apply step is needed)"
      : "isolated copy mode (edits stage in a durable Realm across turns; inspect with snapshot_realm and promote with promote_realm to apply to original)";
    return `Admitted workspace scope for this session:\n- Folder: "${b.folder}"\n- Mode: ${b.mode} (${modeDesc})\n- Status: admitted`;
  };

  const INSTRUCTIONS = (ctx?: { session?: string }) => {
    const sess = ctx?.session ?? activeTurnSession;
    return `You are the assistant inside ${opts.appName ?? "Vakyartha, a desktop app"}.
Today is ${new Date().toISOString().slice(0, 10)}.${formatWorkspaceInfo(sess)}
Prose style: Respond in fluid, elegant, human conversational prose. In dialogue, greetings, and direct answers, speak directly and warmly without gratuitous bold headers, synthetic bullet lists, or robotic markdown artifacts. Structure longer analytical answers with clean paragraphs and meaningful formatting only when complexity demands it.
${skills.index()}`;
  };

  function effectiveEnv(): Record<string, string | undefined> {
    return { ...process.env, ...settings.env };
  }

  function allProviders(env: Record<string, string | undefined> = effectiveEnv()): ProviderEntry[] {
    return [...providersFromEnv(env), typesafeProviderEntry(env)];
  }

  const profiles = new ProfileCache(opts.profilesPath ?? path.join(dataDir, "models.json"));
  const finops = new Finops(dataDir, log, opts.nativeSessionStore);
  const channels = new Channels({
    env: process.env,
    providers: () => withProviderTransport(allProviders(), opts.providerTransport).map(entry => ({ ...entry, make: options => skills.provider(entry.make(options)) })),
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
  /** Integration tools a chat turn's decision step kept, by session, for the length of that turn. */
  const turnToolScope = new Map<string, Set<string>>();
  /** Model providers for turns and voice answers alike: task spending checks and FinOps see every request. */
  function modelProviders(wrapSkills = true): ProviderEntry[] {
    // Bind admission checks and provider construction to the same configuration.
    const env = effectiveEnv();
    const entries = withProviderTransport(allProviders(env), opts.providerTransport).map((entry) => ({ ...entry, make: (options: Parameters<typeof entry.make>[0]) => {
      const spending = tasks?.providerSpending(entry.id);
      if (spending) checkTaskSpending(entry, spending, env);
      return entry.make(options);
    } }));
    // Refused requests never reach either the provider or its usage observer.
    return finops.providers(entries).map((entry) => ({ ...entry, make: (options) => {
      const provider = entry.make(options);
      const guarded: Provider = { ...provider, async *stream(request) {
        await tasks?.beforeModelRequest(entry.id, request.model);
        yield* provider.stream(tasks?.inTask() ? { ...request, maxTokens: Math.min(request.maxTokens ?? 4096, 4096) } : request);
      } };
      return wrapSkills ? skills.provider(guarded) : guarded;
    } }));
  }
  const host = createHost({
    tools: async ({ session }) => {
      finops.session(session);
      activeTurnSession = session;
      await refreshBinding(session);
      const scope = turnToolScope.get(session);
      const offered = (await integrations?.toolsFor(session) ?? []).filter((tool) => !scope || scope.has(tool.spec.name));
      return withSkill([...appAuthoringTools(), ...offered].map((tool) => ({
        ...tool,
        execute: (args, ctx) => sandboxSession.run(session, () => media.withSession(session, () => tool.execute(args, ctx))),
      })), session);
    },
    providers: () => modelProviders(),
    profiles,
    instructions: INSTRUCTIONS,
    transcripts: opts.transcriptsDir ?? path.join(dataDir, "transcripts"),
    ...(opts.nativeSessionStore ? { sessionStore: opts.nativeSessionStore } : { sessionsDir: path.join(dataDir, "sessions") }),
    token,
    allowSessionMutation: (session) => !tasks?.owns(session),
    commitCandidate: opts.candidateCommit,
    // The webview's origin per platform (macOS/Linux, Windows) and the Vite dev server.
    origins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
    // Outside agents get a link to watch what they projected (only when this server serves the UI).
    viewerUrl: opts.uiDir ? (session) => `http://127.0.0.1:${listening}/?session=${encodeURIComponent(session)}` : undefined,
    routes: async (req, res, url) => (await attachRoute(req, res, url)) || (await media.route(req, res, url)) || (await tasksRoute(req, res, url)) || (await finopsRoute(req, res, url)) || (await skillsRoute(req, res, url)) || (await settingsRoute(req, res, url)) || (await channelsRoute(req, res, url)) || (await integrationsRoute(req, res, url)) || (await clientLogRoute(req, res, url)) || (await voiceRoute(req, res, url)) || (await adminFleetRoute(req, res, url)) || (await appsRoute(req, res, url)) || (await realmReviewRoute(req, res, url)) || infoRoute(req, res, url),
    log,
  });

  const sandboxBin = opts.sandboxBin || "vaksb";
  const pool = new SandboxPoolManager({ run: (workspace, argv, timeoutMs, signal) => runScratch(opts.sandbox, workspace, argv, timeoutMs, signal), capacityLease: opts.capacityLease });
  await pool.start();
  const appToolResults = new AppToolResults();
  const apps = new AppRegistry({ dataDir, pool, seedBuiltins: true, callTool: async (app, name, args, signal) => {
    // Unattended apps may use only explicit Allow policies. Ask remains Ask;
    // package declarations never grant a background approval.
    return appToolResults.execute(async session => {
      const available = await integrations!.toolsFor(session);
      const candidates = integrations!.view().filter(i => i.enabled && i.status === "ready")
        .flatMap(i => i.tools.filter(t => toolName(i.entry.id, t.name) === name).map(t => ({ integration: i, tool: t })));
      if (candidates.length !== 1 || candidates[0]!.tool.policy !== "allow") throw new Error("App data access requires an enabled integration tool with an explicit Allow policy in Settings");
      const tool = available.find(t => t.spec.name === name);
      if (!tool) throw new Error("Integration tool is unavailable");
      const result = await tool.execute(args, { signal, callId: crypto.randomUUID() });
      if (typeof result !== "string" && result.isError) throw new Error(result.text);
      return result;
    });
  } });
  await apps.init();
  marketplaces = new Marketplaces(dataDir, integrationCatalog(media, opts.sandbox), opts.marketplaceFetch, opts.marketplaceImageFetch);
  integrations = createIntegrations({ dataDir, observe: (request, result) => { appToolResults.observe(request.session, result); tasks?.observeResult(request, result); }, secrets: settings.secrets, log, approve: (req, emit, signal) => tasks?.inTask() ? tasks.approve(req, emit, signal) : host.approve(req, emit, signal), npm: opts.npm, vakSandbox: { enabled: true, binaryPath: sandboxBin }, launch: opts.launchServer, installer: opts.installPackage }, media, marketplaces.catalog, opts.sandbox);
  // Refresh app-owned tool schemas after an upgrade; the integration journal
  // may otherwise retain an older model's controls indefinitely.
  for (const entry of integrations.view().filter((i) => i.enabled && (i.entry.id.startsWith("media-") || i.entry.id === "sandbox-execution"))) {
    if (entry.entry.id === "media-audio") { try { await media.models("audio"); } catch { log("Media voice metadata is unavailable; no generation was attempted."); } }
    await integrations.refresh(entry.entry.id);
  }
  const freeCapabilities = new Set(["time", "web", "files", "memory"]);
  if (!opts.nativeSessionStore) tasks = await Tasks.open({
    files: new TaskFiles(path.join(dataDir, "outputs"), opts.transcriptsDir ?? path.join(dataDir, "transcripts")),
    dir: path.join(dataDir, "tasks"), run: host.run, view: host.view, remove: host.remove,
    tools: async (session) => {
      await refreshBinding(session);
      return withSkill((await integrations!.toolsFor(session)).map((tool) => ({
        ...tool,
        execute: (args, ctx) => sandboxSession.run(session, () => media.withSession(session, () => tool.execute(args, ctx))),
      })), session);
    }, instructions: INSTRUCTIONS,
    observe: (session, work, run) => finops.chat(async () => { finops.session(session); await work(); }, run), warn: log,
    permissionRevision: (server) => integrationRevisions.get(server) ?? 0,
    permitted: (server, tool) => integrations!.view().some((i) => i.entry.id === server && i.enabled && i.status === "ready" && i.tools.some((t) => t.name === tool && t.policy !== "off")),
    ready(provider, model, selected, confirmedFree, spending) {
      const chosen = allProviders().find((p) => p.id === provider && p.available);
      if (!model || !chosen) throw new Error("Choose an available model");
      checkTaskSpending(chosen, spending, process.env);
      const available = integrations!.view();
      for (const id of selected) if (!available.some((i) => i.entry.id === id && i.enabled && i.status === "ready" && (freeCapabilities.has(id) || (i.entry.trust === "custom" && confirmedFree.includes(id))))) throw new Error("Choose a ready free capability, or verify the cost of your own configured server");
    },
  });

  async function tasksRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (opts.nativeSessionStore && (p === "/api/tasks" || p.startsWith("/api/tasks/"))) {
      json(res, 403, { error: "Desktop tasks are controlled by the native application window" }); return true;
    }
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
        json(res, 200, runUsage(await finops.view(), task.id, usage[2]!));
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

  function appAuthoringTools(): AgentTool[] {
    return [{
      kind: "context",
      spec: { name: "read_app_package", description: "Inspect app/draft manifests, source file names and review fingerprints. Supply path and offset to read up to 16000 source characters. Omit id to list apps and drafts.", inputSchema: { type: "object" as const, properties: { id: { type: "string" as const }, path: { type: "string" as const }, offset: { type: "number" as const } } } },
      execute: async (args: Record<string, unknown>) => {
        if (typeof args.id !== "string") return JSON.stringify({ apps: apps.listApps(), drafts: apps.listDrafts() });
        const draft = apps.getDraft(args.id);
        if (typeof args.path === "string") {
          const text = args.path === "app.json" ? draft.manifestText : draft.files[args.path];
          if (typeof text !== "string") throw new Error("File is not part of this app package");
          const offset = Number(args.offset ?? 0);
          if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid source offset");
          return JSON.stringify({ path: args.path, offset, text: text.slice(offset, offset + 16000), next: offset + 16000 < text.length ? offset + 16000 : null });
        }
        return JSON.stringify({ manifest: draft.manifest, files: Object.keys(draft.files), fingerprint: draft.fingerprint, base: draft.base });
      },
    }, {
      spec: { name: "save_app_draft", description: "Stage an inert executable application package for Studio review and publication. Include actual backend behavior, data-tool declarations and every required file. A saved surface alone does not supply application logic. This does not publish, schedule or execute code.", inputSchema: { type: "object" as const, properties: { manifest: { type: "object" as const }, files: { type: "object" as const, additionalProperties: { type: "string" as const } }, previous: { type: "string" as const }, base: { type: "string" as const } }, required: ["manifest", "files"] } },
      execute: async (args: Record<string, unknown>, ctx) => {
        const manifest = args.manifest as { id?: string };
        const decision = await host.approve({ id: ctx.callId ?? crypto.randomUUID(), server: "apps", tool: "save_app_draft", title: "Save an inert application draft for review", args: { id: manifest?.id, files: Object.keys((args.files ?? {}) as object) } }, ctx.emit, ctx.signal);
        if (decision === "deny") return { text: "App draft save declined; no package was written.", isError: true };
        ctx.signal?.throwIfAborted();
        const draft = apps.saveDraft(String(manifest?.id ?? ""), args as any) as { fingerprint: string };
        return JSON.stringify({ id: manifest.id, fingerprint: draft.fingerprint, files: Object.keys((args.files ?? {}) as object), next: "Open Studio, rehearse and review the package, then publish. Scheduling remains off until enabled." });
      },
    }];
  }

  function withSkill<T>(tools: T[], session?: string): T[] {
    return [...tools, ...skills.tools({ session, getWorkspaceScope }) as T[]];
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
        const entry = modelProviders(false).find(provider => provider.id === b.provider && provider.available);
        if (!entry || typeof b.model !== "string" || !b.model.trim()) throw new Error("Choose an available provider and model for selection evaluation");
        await finops.chat(async () => {
          finops.session("skill-selection-" + randomUUID());
          json(res, 200, await evaluateSkillPrompts(skills, String(b.name ?? ""), b.cases as import("../shared/skills.ts").SkillEvalCase[], { provider: entry.make({}), model: b.model as string }));
        });
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
          sandbox: opts.sandbox,
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
    if (req.method === "GET") json(res, 200, await finops.view());
    else if (req.method === "PUT") {
      try { finops.setRate(await readJson(req)); json(res, 200, await finops.view()); }
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
        await pool.restart();
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
      if (p === "/api/apps/builtin" && req.method === "GET") { json(res, 200, apps.listBuiltins()); return true; }
      const connections = /^\/api\/apps\/([a-z0-9][a-z0-9_-]{1,63})\/connections$/.exec(p);
      if (connections && req.method === "GET") {
        const app = apps.getApp(connections[1]!);
        if (!app) throw new Error("App not found");
        const view = integrations!.view();
        const access = app.manifest.entitlements.mcpTools.map(name => {
          const candidates = view.flatMap(i => i.tools.filter(t => toolName(i.entry.id, t.name) === name).map(t => ({ i, t })));
          if (candidates.length !== 1) {
            const known = view.filter(i => name.startsWith(toolName(i.entry.id, "")));
            const hint = known.length === 1 ? known[0] : undefined;
            return { name, integrationId: hint?.entry.id, integrationName: hint?.entry.name ?? "Data connection", title: "Required tool", policy: "unavailable", ready: false, reason: "Required tool is not available. Configure its integration." };
          }
          const {i,t} = candidates[0]!; const ready = i.enabled && i.status === "ready" && t.policy === "allow";
          return { name, integrationId: i.entry.id, integrationName: i.entry.name, title: t.title ?? t.name, policy: t.policy, ready,
            reason: ready ? "Ready" : !i.enabled || i.status !== "ready" ? "Enable and configure this integration." : t.policy === "ask" ? "Ask is enabled. App refresh currently needs explicit Allow; interactive app approvals are not supported yet." : "This tool is turned off." };
        });
        json(res, 200, access); return true;
      }
      const builtin = /^\/api\/apps\/builtin\/([a-z0-9][a-z0-9_-]{1,63})$/.exec(p);
      if (builtin && req.method === "POST") { json(res, 201, await apps.installBuiltin(builtin[1]!)); return true; }
      const updateMatch = /^\/api\/apps\/([a-z0-9][a-z0-9_-]{1,63})\/update$/.exec(p);
      if (updateMatch && req.method === "GET") { json(res, 200, apps.previewAppUpdate(updateMatch[1]!)); return true; }
      if (updateMatch && req.method === "POST") { json(res, 200, await apps.updateAppToLatest(updateMatch[1]!, await readJson(req))); return true; }
      if (p === "/api/apps/drafts" && req.method === "GET") { json(res, 200, apps.listDrafts()); return true; }
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

      const lifecycle = /^\/api\/apps\/([a-z0-9][a-z0-9_-]{1,63})\/(draft|publish|rehearse|schedule|recover)$/.exec(p);
      if (lifecycle) {
        const [, id, operation] = lifecycle;
        if (operation === "draft" && req.method === "GET") json(res, 200, apps.getDraft(id!));
        else if (operation === "draft" && req.method === "PUT") json(res, 200, apps.saveDraft(id!, await readJson(req) as any));
        else if (operation === "draft" && req.method === "DELETE") { apps.discardDraft(id!); json(res, 200, { ok: true }); }
        else if (req.method === "POST") {
          const body = await readJson(req);
          if (operation === "publish") json(res, 200, await apps.publishDraft(id!, String(body.fingerprint ?? "")));
          else if (operation === "rehearse") json(res, 200, await apps.rehearse(id!, String(body.fingerprint ?? ""), String(body.controlId ?? "rehearsal"), body.value));
          else if (operation === "recover") json(res, 200, await apps.acknowledgeUncertain(id!, String(body.runId ?? "")));
          else if (operation === "schedule") json(res, 200, await apps.setScheduling(id!, body.enabled === true));
          else json(res, 405, { error: "Method not allowed" });
        } else json(res, 405, { error: "Method not allowed" });
        return true;
      }

      const actionMatch = /^\/api\/apps\/([^/]+)\/action$/.exec(p);
      if (actionMatch && req.method === "POST") {
        const id = decodeURIComponent(actionMatch[1]!);
        const body = await readJson(req);
        const result = await apps.dispatchAction(id, String(body.controlId ?? ""), body.value, body.action ? String(body.action) : undefined, typeof body.revision === "number" ? body.revision : undefined, typeof body.surface === "string" ? body.surface : undefined);
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
        json(res, 200, app.state);
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
          const app = await apps.updateApp(id, manifest as any, files, String(body.fingerprint ?? ""));
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

  // The chat panel's Realm review for a folder-bound chat. Bindings themselves are
  // managed by the main window through Rust; Realm work goes through the helper there.
  async function realmReviewRoute(req: HostRequest, res: HostResponse, url: URL): Promise<boolean> {
    const m = /^\/api\/workspaces\/bindings\/([^/]+)\/realm(?:\/(review|apply|undo|refresh|ensure))?$/.exec(url.pathname);
    if (!m) return false;
    const session = decodeURIComponent(m[1]!), action = m[2];
    try {
      const binding = await refreshBinding(session);
      if (!binding) return json(res, opts.sandbox ? 404 : 501, { error: opts.sandbox ? `No folder is admitted for chat '${session}'` : "Folder work needs the desktop app" }), true;
      if (binding.mode === "direct") return json(res, 200, { mode: "direct", bound: true, total: 0, changes: [], message: "Direct editing mode is active. Changes save directly to the folder; no Realm staging is used." }), true;
      const realm = (args: string[]) => opts.sandbox!({ session, op: "realm", args });
      const body = req.method === "POST" ? ((await readJson(req).catch(() => ({}))) as { fingerprint?: string; paths?: string[]; transactionId?: string; force?: boolean }) : {};
      const pathArgs = (body.paths ?? []).map((p) => `--paths=${p}`);
      if (!action && req.method === "GET") json(res, 200, binding.realmId ? { bound: true, realmId: binding.realmId, status: await realm(["status", "{realm}"]) } : { bound: false, message: "No Realm created yet for this session." });
      else if (!action && req.method === "DELETE") { if (binding.realmId) await realm(["destroy", "{realm}"]); json(res, 200, { ok: true }); }
      else if (action === "ensure" && req.method === "POST") json(res, 200, { status: await realm(["status", "{realm}"]) });
      else if (action === "review" && req.method === "GET") json(res, 200, await realm(["snapshot", "{realm}", `--offset=${Math.max(0, Math.trunc(Number(url.searchParams.get("offset") ?? 0)) || 0)}`]));
      else if (action === "apply" && req.method === "POST") json(res, 200, await realm(["promote", "{realm}", `--fingerprint=${String(body.fingerprint ?? "")}`, ...pathArgs]));
      else if (action === "undo" && req.method === "POST") json(res, 200, await realm(["rollback", "{realm}", String(body.transactionId ?? ""), ...pathArgs]));
      else if (action === "refresh" && req.method === "POST") {
        if (binding.realmId) {
          const review = (await realm(["snapshot", "{realm}", "--offset=0"])) as { total?: number };
          if ((review.total ?? 0) > 0 && !body.force) return json(res, 409, { error: `Realm has ${review.total} uncommitted changes. Review and apply or pass force: true to discard.`, total: review.total }), true;
          await realm(["destroy", "{realm}"]);
        }
        json(res, 200, { refreshed: true, ...((await opts.sandbox!({ session, op: "realm_create", args: [] })) as object) });
      } else json(res, 405, { error: "Unsupported Realm review action" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  /** Records the engine's per-model plan from the turn's own event stream; the bytes pass through unchanged. */
  const observePlan = (res: HostResponse): HostResponse => {
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (text.startsWith("event: plan\n")) {
        try {
          const e = JSON.parse(text.slice(text.indexOf("data: ") + 6)) as { generation: string; tier: string; authoring?: string; maxSteps: number };
          finops.recordControls({ plan: { generation: e.generation, tier: e.tier, ...(e.authoring ? { authoring: e.authoring } : {}), maxSteps: e.maxSteps } });
        } catch { /* Telemetry only. */ }
      }
      return write(chunk, ...rest);
    }) as HostResponse["write"];
    return res;
  };

  const handle = async (req: HostRequest, res: HostResponse) => {
    try {
      if (req.method === "POST" && new URL(req.url ?? "/", "http://localhost").pathname === "/api/chat") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let raw = Buffer.concat(chunks);
        let controls: NonNullable<import("../shared/finops.ts").Turn["controls"]> | undefined;
        let decisionUsage: import("../shared/finops.ts").Turn["decisionUsage"] = undefined;
        let scopedSession: string | undefined;
        try {
          const body = JSON.parse(raw.toString("utf8"));
          if (body && typeof body === "object" && body.decisionUsage) {
            decisionUsage = body.decisionUsage;
          }
          // The turn shaper's pruned list can only narrow what Settings already allows, never add to it.
          if (body && typeof body.session === "string" && Array.isArray(body.integrationTools)) {
            scopedSession = body.session;
            turnToolScope.set(body.session, new Set(body.integrationTools.filter((n: unknown): n is string => typeof n === "string").slice(0, 500)));
          }
          if (body && typeof body.provider === "string" && typeof body.model === "string") {
            const fitted = fitTurnControls(body, profiles.get(body.provider, body.model)?.facts);
            if (body.think !== fitted.think || body.effort !== fitted.effort) {
              body.think = fitted.think;
              if (fitted.effort) body.effort = fitted.effort; else delete body.effort;
              raw = Buffer.from(JSON.stringify(body));
            }
            const count = (v: unknown) => typeof v === "number" && v > 0 ? v : undefined;
            controls = { ...fitted, history: count(body.history), maxSteps: count(body.maxSteps), toolRounds: count(body.toolRounds) };
          }
        } catch {}
        const { Readable } = await import("node:stream");
        const streamedReq = Object.assign(Readable.from(raw), {
          headers: req.headers,
          method: req.method,
          url: req.url,
          socket: (req as { socket?: unknown }).socket,
        }) as HostRequest;
        try {
          await finops.chat(async () => {
            if (decisionUsage) finops.recordDecisionUsage(decisionUsage);
            if (controls) finops.recordControls(controls);
            await host.handle(streamedReq, observePlan(res));
          });
        } finally {
          if (scopedSession) turnToolScope.delete(scopedSession);
        }
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
      await pool.shutdown(2000);
      await apps.shutdown();
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
