// vak desktop sidecar: the engine host the Tauri shell starts and stops.
// Runs @vak/host on an ephemeral loopback port behind a random bearer token,
// so only the app's own webview (which gets the token over IPC) can use the
// keys and run models. Prints one ready line for the shell:
//   VAK_READY {"port":1234,"token":"..."}
//
// Env (set by the shell): VAK_DATA_DIR (conversations, profiles, settings, logs),
// VAK_ENV_FILES (extra .env files, dev only), VAK_KEYCHAIN_SERVICE (macOS
// Keychain service for API keys), VAK_PORT (default: any free port).

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { createHost, json, readJson } from "@vak/host";
import { hardenNetwork, loadEnvFile, ProfileCache, providersFromEnv } from "@vak/providers";
import { Channels, CHANNELS } from "./channels.ts";
import { fileSecrets, keychainStore, Settings, SettingsError } from "./settings.ts";

const dataDir = process.env.VAK_DATA_DIR ?? path.join(homedir(), ".vak-desktop");
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
  secrets: process.platform === "darwin" ? keychainStore(process.env.VAK_KEYCHAIN_SERVICE ?? "com.vakprojection.desktop") : fileSecrets(settingsFile),
});
// Settings saved in the app win over a developer's .env.
try {
  settings.load();
} catch (err) {
  log(`settings not loaded: ${(err as Error).message}`);
}
for (const file of (process.env.VAK_ENV_FILES ?? "").split(path.delimiter).filter(Boolean)) loadEnvFile(file);
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

/** For the About page: where things are kept. */
function infoRoute(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname !== "/api/info" || req.method !== "GET") return false;
  json(res, 200, { version: process.env.VAK_APP_VERSION ?? "dev", node: process.version, platform: process.platform, dataDir, logFile, keys: settings.secrets.kind === "keychain" ? "macOS Keychain" : "settings file (owner-only)" });
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

const INSTRUCTIONS = () => `You are the assistant inside the vak desktop app.
Today is ${new Date().toISOString().slice(0, 10)}.
Answer with rich UI whenever the answer has any structure; keep accompanying text to one short sentence, the UI carries the content.
When the user asks for examples or you lack real data, use realistic sample data and say it is sample data in a caption.
When you receive a "[ui action]" message, the user interacted with your UI: respond to it, usually by updating that surface (vak_update) or rendering a confirmation.`;

const profiles = new ProfileCache(path.join(dataDir, "models.json"));
const channels = new Channels({
  env: process.env,
  providers: () => providersFromEnv(),
  profiles,
  dataDir,
  log,
});

const token = randomBytes(32).toString("base64url");
const host = createHost({
  providers: () => providersFromEnv(),
  profiles,
  instructions: INSTRUCTIONS,
  transcripts: path.join(dataDir, "transcripts"),
  sessionsDir: path.join(dataDir, "sessions"),
  token,
  // The webview's origin per platform (macOS/Linux, Windows) and the Vite dev server.
  origins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
  routes: async (req, res, url) => (await settingsRoute(req, res, url)) || (await channelsRoute(req, res, url)) || infoRoute(req, res, url),
  log,
});

const server = createServer(async (req, res) => {
  if (!(await host.handle(req, res))) res.writeHead(404).end("not found");
});

// Loopback only: the sidecar holds API keys and runs model calls.
server.listen(Number(process.env.VAK_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(`VAK_READY ${JSON.stringify({ port, token })}`);
  void channels.startAll();
});

// The shell holds our stdin open; when it goes away (quit or crash), so do
// we, after stopping channels (a few seconds at most).
async function shutdown(): Promise<void> {
  setTimeout(() => process.exit(0), 3000).unref();
  await channels.stopAll();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => void shutdown());
process.stdin.on("error", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
