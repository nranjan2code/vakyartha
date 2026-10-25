// vak desktop sidecar: the engine host the Tauri shell starts and stops.
// Runs @vak/host on an ephemeral loopback port behind a random bearer token,
// so only the app's own webview (which gets the token over IPC) can use the
// keys and run models. Prints one ready line for the shell:
//   VAK_READY {"port":1234,"token":"..."}
//
// Env (set by the shell): VAK_DATA_DIR (conversations, profiles, settings),
// VAK_ENV_FILES (extra .env files, dev only), VAK_PORT (default: any free port).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { createHost, json, readJson } from "@vak/host";
import { hardenNetwork, loadEnvFile, ProfileCache, providersFromEnv } from "@vak/providers";

const dataDir = process.env.VAK_DATA_DIR ?? path.join(homedir(), ".vak-desktop");
mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, "settings.env");

// Settings saved in the app win over a developer's .env.
loadEnvFile(settingsFile);
for (const file of (process.env.VAK_ENV_FILES ?? "").split(path.delimiter).filter(Boolean)) loadEnvFile(file);
hardenNetwork();

/** What the settings screen may read and write. Secrets are never sent back, only whether they are set. */
const SETTINGS = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
  { name: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
  { name: "GEMINI_API_KEY", label: "Gemini API key", secret: true },
  { name: "OLLAMA_HOST", label: "Ollama host", secret: false, placeholder: "http://127.0.0.1:11434" },
  { name: "OLLAMA_MODEL", label: "Default Ollama model", secret: false, placeholder: "qwen3.5:4b-mlx" },
  { name: "OPENAI_COMPAT_BASE_URL", label: "OpenAI-compatible base URL", secret: false, placeholder: "http://127.0.0.1:1234/v1" },
  { name: "OPENAI_COMPAT_API_KEY", label: "OpenAI-compatible API key", secret: true },
] as const;
type SettingName = (typeof SETTINGS)[number]["name"];

function readSettingsFile(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(settingsFile)) return out;
  for (const line of readFileSync(settingsFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}

function settingsView() {
  return SETTINGS.map((s) => ({
    name: s.name,
    label: s.label,
    secret: s.secret,
    placeholder: "placeholder" in s ? s.placeholder : undefined,
    set: Boolean(process.env[s.name]),
    value: s.secret ? undefined : (process.env[s.name] ?? ""),
  }));
}

/** Apply changes: a string sets, null or "" clears. Written 0600: the file holds API keys. */
function saveSettings(values: Record<string, unknown>): void {
  const known = new Set<string>(SETTINGS.map((s) => s.name));
  const file = readSettingsFile();
  for (const [name, value] of Object.entries(values)) {
    if (!known.has(name)) continue;
    const v = typeof value === "string" ? value.trim() : "";
    // A newline would start another variable in the file.
    if (/[\r\n]/.test(v)) continue;
    if (v) {
      file.set(name, v);
      process.env[name as SettingName] = v;
    } else {
      file.delete(name);
      delete process.env[name];
    }
  }
  writeFileSync(settingsFile, [...file].map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(""), { mode: 0o600 });
  chmodSync(settingsFile, 0o600);
}

async function settingsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/settings") return false;
  if (req.method === "PUT") {
    const body = await readJson(req);
    if (body.values && typeof body.values === "object") saveSettings(body.values);
  } else if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  json(res, 200, settingsView());
  return true;
}

const INSTRUCTIONS = () => `You are the assistant inside the vak desktop app.
Today is ${new Date().toISOString().slice(0, 10)}.
Answer with rich UI whenever the answer has any structure; keep accompanying text to one short sentence, the UI carries the content.
When the user asks for examples or you lack real data, use realistic sample data and say it is sample data in a caption.
When you receive a "[ui action]" message, the user interacted with your UI: respond to it, usually by updating that surface (vak_update) or rendering a confirmation.`;

const token = randomBytes(32).toString("base64url");
const host = createHost({
  providers: () => providersFromEnv(),
  profiles: new ProfileCache(path.join(dataDir, "models.json")),
  instructions: INSTRUCTIONS,
  transcripts: path.join(dataDir, "transcripts"),
  sessionsDir: path.join(dataDir, "sessions"),
  token,
  // The webview's origin per platform (macOS/Linux, Windows) and the Vite dev server.
  origins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
  routes: settingsRoute,
  log: (line) => console.error(line),
});

const server = createServer(async (req, res) => {
  if (!(await host.handle(req, res))) res.writeHead(404).end("not found");
});

// Loopback only: the sidecar holds API keys and runs model calls.
server.listen(Number(process.env.VAK_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(`VAK_READY ${JSON.stringify({ port, token })}`);
});

// The shell holds our stdin open; when it goes away (quit or crash), so do we.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
