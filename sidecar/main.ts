// Vakyartha sidecar: the engine host the Tauri shell starts and stops.
// Runs the app server on an ephemeral loopback port behind a random bearer
// token, so only the app's own webview (which gets the token over IPC) can
// use the keys and run models. Prints one ready line for the shell:
//   VAK_READY {"port":1234,"token":"..."}
//
// Env (set by the shell): VAK_DATA_DIR (conversations, profiles, settings, logs),
// VAK_ENV_FILES (extra .env files, dev only), VAK_KEYCHAIN_SERVICE (macOS
// Keychain service for API keys), VAK_NPM_CLI (npm-cli.js for installing
// integrations; default: npm on PATH), VAK_PORT (default: any free port).

import { homedir } from "node:os";
import path from "node:path";
import { startAppServer } from "./server.ts";

const app = await startAppServer({
  dataDir: process.env.VAK_DATA_DIR ?? path.join(homedir(), ".vakyartha"),
  envFiles: (process.env.VAK_ENV_FILES ?? "").split(path.delimiter).filter(Boolean),
  keychainService: process.env.VAK_KEYCHAIN_SERVICE,
  port: Number(process.env.VAK_PORT ?? 0),
  access: "token",
  version: process.env.VAK_APP_VERSION,
  npm: process.env.VAK_NPM_CLI,
  sandboxBin: process.env.VAK_SANDBOX_BIN,
});
console.log(`VAK_READY ${JSON.stringify({ port: app.port, token: app.token })}`);

// The shell holds our stdin open; when it goes away (quit or crash), so do
// we, after stopping channels (a few seconds at most).
async function shutdown(): Promise<void> {
  setTimeout(() => process.exit(0), 3000).unref();
  await app.shutdown();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => void shutdown());
process.stdin.on("error", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
