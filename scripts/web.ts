// Vakyartha in a browser, for development: the same app server as the desktop
// sidecar (engine, settings, channels) open on loopback :5178, serving the
// same built UI (dist), so the browser and desktop versions are one interface.
// Outside agents can project into it through /api/project (point Projection's
// MCP server at it with VAK_URL=http://127.0.0.1:5178).
//
// Usage: npm run web   (builds the UI first; env: PORT; keys from .env)

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startAppServer } from "../sidecar/server.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Chats, transcripts and logs are private even when the launching shell uses 022.
process.umask(0o077);

const app = await startAppServer({
  dataDir: path.join(repo, ".vak/web"),
  envFiles: [path.join(repo, ".env")],
  keychainService: "com.nranjan2code.vakyartha.web",
  profilesPath: path.join(repo, ".vak/models.json"),
  // Raw model output per session, for replaying a turn through the engine.
  transcriptsDir: path.join(repo, ".vak/web"),
  port: Number(process.env.PORT ?? 5178),
  access: "open",
  uiDir: path.join(repo, "dist"),
  appName: "Vakyartha (browser)",
  sandboxBin: process.env.VAK_SANDBOX_BIN || (existsSync(path.resolve(repo, "../sandbox/target/release/vaksb")) ? path.resolve(repo, "../sandbox/target/release/vaksb") : undefined),
});
console.log(`Vakyartha → ${app.url}`);
