// Vakyartha sidecar: the engine host the Tauri shell starts and stops.
// Runs the canonical app host over the helper's private descriptor 3
// connection. Desktop opens no network listener. Prints one ready handshake:
//   VAK_READY {"transport":"stdio","version":2}
//
// The shell sets VAK_DATA_DIR, VAK_APP_VERSION,
// VAK_NPM_CLI and VAK_SANDBOX_BIN. The worker receives no environment files.

import { Socket } from "node:net";
import { startAppServer } from "./server.ts";
import { desktopTransport, DESKTOP_PROTOCOL } from "./desktop-transport.ts";
import type { HostCandidateCommitRequest, HostCandidateCommitReceipt, HostSessionStore } from "@vak/host";
import type { ProviderTransport } from "@vak/providers";

// Chats, transcripts and logs are private even when the launching shell uses 022.
process.umask(0o077);
const channel = new Socket({ fd: 3, readable: true, writable: true });
if (!process.env.VAK_DATA_DIR) throw new Error("Native worker data directory is required");

let nativeCommit: (candidate: HostCandidateCommitRequest) => Promise<HostCandidateCommitReceipt> = async () => { throw new Error("Native control transport is not ready"); };
let nativeTransport: ReturnType<typeof desktopTransport> | undefined;
let nativeProviderFetch: ProviderTransport = async () => { throw new Error("Native provider transport is not ready"); };
const nativeSessionStore: HostSessionStore = {
  load: async (id) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.load(id); },
  save: async (snapshot, revision) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.save(snapshot, revision); },
  list: async () => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.list(); },
  remove: async (id, revision) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.remove(id, revision); },
};
const app = await startAppServer({
  dataDir: process.env.VAK_DATA_DIR,
  envFiles: [],
  access: "token",
  transport: "stdio",
  version: process.env.VAK_APP_VERSION,
  npm: process.env.VAK_NPM_CLI,
  sandboxBin: process.env.VAK_SANDBOX_BIN,
  candidateCommit: (candidate) => nativeCommit(candidate),
  nativeSessionStore,
  providerTransport: (...args) => nativeProviderFetch(...args),
});
const transport = desktopTransport(app.request, app.token!, channel, channel, (error) => { console.error(error.message); void shutdown(); });
nativeCommit = transport.commitCandidate;
nativeTransport = transport;
nativeProviderFetch = transport.providerFetch;
channel.write(`VAK_READY ${JSON.stringify({ transport: "stdio", version: DESKTOP_PROTOCOL })}\n`);

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
channel.resume();
const controlHealth = await transport.pingControl().catch(() => ({ status: "unavailable" as const }));
if (controlHealth.status !== "ready") console.error(`[control] native actor status: ${controlHealth.status}`);
channel.on("end", () => void shutdown());
channel.on("error", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
