// Vakyartha sidecar: the engine host the Tauri shell starts and stops.
// Runs the canonical app host over the Tauri parent's private stdin/stdout
// connection. Desktop opens no network listener. Prints one ready handshake:
//   VAK_READY {"transport":"stdio","version":2}
//
// The shell sets VAK_DATA_DIR, VAK_KEYCHAIN_SERVICE, VAK_APP_VERSION,
// VAK_NPM_CLI and VAK_SANDBOX_BIN. VAK_ENV_FILES is for development only.

import { homedir } from "node:os";
import path from "node:path";
import { startAppServer } from "./server.ts";
import { desktopTransport, DESKTOP_PROTOCOL } from "./desktop-transport.ts";
import type { HostCandidateCommitRequest, HostCandidateCommitReceipt } from "@vak/host";

// Chats, transcripts and logs are private even when the launching shell uses 022.
process.umask(0o077);

let nativeCommit: (candidate: HostCandidateCommitRequest) => Promise<HostCandidateCommitReceipt> = async () => { throw new Error("Native control transport is not ready"); };
const app = await startAppServer({
  dataDir: process.env.VAK_DATA_DIR ?? path.join(homedir(), ".vakyartha"),
  envFiles: (process.env.VAK_ENV_FILES ?? "").split(path.delimiter).filter(Boolean),
  keychainService: process.env.VAK_KEYCHAIN_SERVICE,
  access: "token",
  transport: "stdio",
  version: process.env.VAK_APP_VERSION,
  npm: process.env.VAK_NPM_CLI,
  sandboxBin: process.env.VAK_SANDBOX_BIN,
  candidateCommit: (candidate) => nativeCommit(candidate),
});
const transport = desktopTransport(app.request, app.token!, process.stdin, process.stdout, (error) => { console.error(error.message); void shutdown(); });
nativeCommit = transport.commitCandidate;
console.log(`VAK_READY ${JSON.stringify({ transport: "stdio", version: DESKTOP_PROTOCOL })}`);

// The shell holds our stdin open; when it goes away (quit or crash), so do
// we, after stopping channels (a few seconds at most).
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  transport.close();
  setTimeout(() => process.exit(0), 3000).unref();
  await app.shutdown();
  process.exit(0);
}
process.stdin.resume();
const controlHealth = await transport.pingControl().catch(() => ({ status: "unavailable" as const }));
if (controlHealth.status !== "ready") console.error(`[control] native actor status: ${controlHealth.status}`);
process.stdin.on("end", () => void shutdown());
process.stdin.on("error", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
