// The Vakyartha app server: @vak/host plus the app's own routes (settings, channels,
// info) and, optionally, the built UI. The desktop sidecar runs it behind a
// token for the Tauri window; the playground runs it open on :5177 for a
// browser, serving the same UI, so both show one interface.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createHost, json, readJson } from "@vak/host";
import type { Integrations } from "@vak/mcp/client";
import { hardenNetwork, loadEnvFile, ProfileCache, providersFromEnv } from "@vak/providers";
import { Channels, CHANNELS } from "./channels.ts";
import { createIntegrations } from "./integrations.ts";
import { Finops } from "./finops.ts";
import { fileSecrets, keychainStore, Settings, SettingsError } from "./settings.ts";
import { Tasks } from "./tasks.ts";

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
  /** Built UI to serve at / (the playground); none: API only. */
  uiDir?: string;
  appName?: string;
  version?: string;
}

export interface AppServer {
  port: number;
  token?: string;
  url: string;
  shutdown(): Promise<void>;
}

export async function startAppServer(opts: AppServerOptions): Promise<AppServer> {
  const dataDir = opts.dataDir;
  mkdirSync(path.join(dataDir, "logs"), { recursive: true });

  // A release app has no terminal: engine output goes to logs/engine.log
  // (one previous file kept), as well as stderr for `npm run desktop`.
  const logFile = path.join(dataDir, "logs", "engine.log");
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

  async function settingsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
  async function clientLogRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/api/client-log" || req.method !== "POST") return false;
    const body = await readJson(req);
    log(`[ui ${String(body.level ?? "error").slice(0, 10)}] ${String(body.message ?? "").slice(0, 2000)}`);
    json(res, 200, { ok: true });
    return true;
  }

  /** For the About page: where things are kept. */
  function infoRoute(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== "/api/info" || req.method !== "GET") return false;
    json(res, 200, { version: opts.version ?? "dev", node: process.version, platform: process.platform, dataDir, logFile, keys: settings.secrets.kind === "keychain" ? "macOS Keychain" : "settings file (owner-only)" });
    return true;
  }

  async function channelsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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

  const INSTRUCTIONS = () => `You are the assistant inside ${opts.appName ?? "Vakyartha, a desktop app"}.
Today is ${new Date().toISOString().slice(0, 10)}.
Answer with rich UI whenever the answer has any structure; keep accompanying text to one short sentence, the UI carries the content.
When the user asks for examples or you lack real data, use realistic sample data and say it is sample data in a caption.
When you receive a "[ui action]" message, the user interacted with your UI: respond to it, usually by updating that surface (vak_update) or rendering a confirmation.`;

  const profiles = new ProfileCache(opts.profilesPath ?? path.join(dataDir, "models.json"));
  const finops = new Finops(dataDir, log);
  const channels = new Channels({
    env: process.env,
    providers: () => providersFromEnv(),
    profiles,
    dataDir,
    log,
  });

  let listening = 0;
  const token = opts.access === "token" ? randomBytes(32).toString("base64url") : undefined;
  // Created after the host (it asks the host for approvals); the host reads it per turn.
  let integrations: Integrations | undefined;
  let tasks: Tasks | undefined;
  const integrationRevisions = new Map<string, number>();
  const host = createHost({
    tools: ({ session }) => {
      finops.session(session);
      return integrations?.toolsFor(session) ?? [];
    },
    providers: () => finops.providers(providersFromEnv()),
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
    routes: async (req, res, url) => (await tasksRoute(req, res, url)) || (await finopsRoute(req, res, url)) || (await settingsRoute(req, res, url)) || (await channelsRoute(req, res, url)) || (await integrationsRoute(req, res, url)) || (await clientLogRoute(req, res, url)) || infoRoute(req, res, url),
    log,
  });

  integrations = createIntegrations({ dataDir, secrets: settings.secrets, log, approve: (req, emit, signal) => tasks?.inTask() ? tasks.approve(req, emit, signal) : host.approve(req, emit, signal), npm: opts.npm });
  const freeCapabilities = new Set(["time", "web", "files", "memory"]);
  tasks = await Tasks.open({
    dir: path.join(dataDir, "tasks"), run: host.run, view: host.view, remove: host.remove,
    tools: (session) => integrations!.toolsFor(session), instructions: INSTRUCTIONS,
    observe: (session, work) => finops.chat(async () => { finops.session(session); await work(); }), warn: log,
    permissionRevision: (server) => integrationRevisions.get(server) ?? 0,
    permitted: (server, tool) => integrations!.view().some((i) => i.entry.id === server && i.enabled && i.status === "ready" && i.tools.some((t) => t.name === tool && t.policy !== "off")),
    ready(provider, model, selected, confirmedFree) {
      if (!model || !providersFromEnv().some((p) => p.id === provider && p.available)) throw new Error("Choose an available model");
      const available = integrations!.view();
      for (const id of selected) if (!available.some((i) => i.entry.id === id && i.enabled && i.status === "ready" && (freeCapabilities.has(id) || (i.entry.trust === "custom" && confirmedFree.includes(id))))) throw new Error("Choose a ready free capability, or verify the cost of your own configured server");
    },
  });

  async function tasksRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    // A task's session is controlled through task commands even between runs.
    const sessionId = /^\/api\/sessions\/([^/]+)$/.exec(p)?.[1];
    if (sessionId && req.method !== "GET" && tasks?.owns(decodeURIComponent(sessionId))) {
      json(res, 409, { error: "This conversation belongs to a task; use its task controls" }); return true;
    }
    if (p === "/api/task-capabilities" && req.method === "GET") {
      json(res, 200, integrations!.view().filter((i) => freeCapabilities.has(i.entry.id) || i.entry.trust === "custom").map((i) => ({ id: i.entry.id, name: i.entry.name, summary: i.entry.summary, ready: i.enabled && i.status === "ready", free: freeCapabilities.has(i.entry.id), access: i.entry.access })));
      return true;
    }
    const m = /^\/api\/tasks(?:\/([\w-]+)(?:\/(input|cancel|complete|approve|schedule))?)?$/.exec(p);
    if (!m) return false;
    try {
      const [, id, operation] = m;
      if (!id && req.method === "GET") json(res, 200, tasks!.list());
      else if (!id && req.method === "POST") json(res, 201, await tasks!.create(await readJson(req)));
      else if (id && !operation && req.method === "GET") json(res, 200, tasks!.get(id));
      else if (id && !operation && req.method === "DELETE") { await tasks!.remove(id, await readJson(req)); json(res, 200, { ok: true }); }
      else if (id && operation && req.method === "POST") {
        const body = await readJson(req);
        const result = operation === "input" ? await tasks!.input(id, body) : operation === "cancel" ? await tasks!.cancel(id) : operation === "complete" ? await tasks!.complete(id) : operation === "schedule" ? await tasks!.changeSchedule(id, body) : await tasks!.answer(id, String(body.approval), body.decision);
        json(res, 200, result);
      } else json(res, 405, { error: "method not allowed" });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  async function finopsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/api/finops") return false;
    if (req.method === "GET") json(res, 200, finops.view());
    else if (req.method === "PUT") {
      try { finops.setRate(await readJson(req)); json(res, 200, finops.view()); }
      catch (err) { json(res, 400, { error: (err as Error).message }); }
    } else json(res, 405, { error: "method not allowed" });
    return true;
  }

  async function integrationsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith("/api/integrations")) return false;
    const m = /^\/api\/integrations(?:\/([\w-]+)(?:\/(install|uninstall|refresh|test))?)?$/.exec(p);
    if (!m) return false;
    const [, id, verb] = m;
    try {
      const list = integrations!;
      if (!id && req.method === "GET") json(res, 200, list.view());
      else if (id === "custom" && !verb && req.method === "POST") {
        const body = await readJson(req);
        const made = list.addCustom({ name: String(body.name ?? ""), command: body.command, args: Array.isArray(body.args) ? body.args.map(String) : undefined, url: body.url, token: body.token });
        json(res, 200, { id: made, integrations: list.view() });
      } else if (id && verb === "test" && req.method === "POST") {
        const body = await readJson(req);
        json(res, 200, await list.test(id, String(body.tool), (body.args ?? {}) as Record<string, unknown>));
      } else if (id && req.method === "POST" && verb) {
        integrationRevisions.set(id, (integrationRevisions.get(id) ?? 0) + 1);
        if (verb === "install") await list.install(id);
        else if (verb === "uninstall") await list.uninstall(id);
        else await list.refresh(id);
        json(res, 200, list.view());
      } else if (id && !verb && req.method === "PUT") {
        integrationRevisions.set(id, (integrationRevisions.get(id) ?? 0) + 1);
        await list.configure(id, await readJson(req));
        json(res, 200, list.view());
      } else return false;
    } catch (err) {
      json(res, 400, { error: (err as Error).message, integrations: integrations!.view() });
    }
    return true;
  }

  const server = createServer(async (req, res) => {
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
  });

  // Loopback only: the server holds API keys and runs model calls.
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  listening = port;
  void channels.startAll();
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    async shutdown() {
      server.close();
      await tasks?.close();
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
async function serveUi(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
  let file = path.resolve(root, rel || "index.html");
  if (!file.startsWith(path.resolve(root) + path.sep)) return void res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    // The page itself may only talk to this server.
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'",
  });
  res.end(readFileSync(file));
}
