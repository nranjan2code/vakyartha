// Vakyartha sidecar: the engine host the Tauri shell starts and stops.
// Runs the canonical app host over the helper's private descriptor 3
// connection. Desktop opens no network listener. Prints one ready handshake:
//   VAK_READY {"transport":"stdio","version":2}
//
// The shell sets VAK_DATA_DIR, VAK_APP_VERSION,
// and VAK_SANDBOX_BIN. The worker receives no environment files.

import { Socket } from "node:net";
import { startAppServer } from "./server.ts";
import { desktopTransport, DESKTOP_PROTOCOL, type SandboxCall } from "./desktop-transport.ts";
import type { HostCandidateCommitRequest, HostCandidateCommitReceipt, HostSessionStore } from "@vak/host";
import type { ProviderTransport } from "@vak/providers";
import type { VoiceTransport } from "./voice/transport.ts";

// Chats, transcripts and logs are private even when the launching shell uses 022.
process.umask(0o077);
const channel = new Socket({ fd: 3, readable: true, writable: true });
if (!process.env.VAK_DATA_DIR) throw new Error("Native worker data directory is required");

let nativeCommit: (candidate: HostCandidateCommitRequest) => Promise<HostCandidateCommitReceipt> = async () => { throw new Error("Native control transport is not ready"); };
let nativeTransport: ReturnType<typeof desktopTransport> | undefined;
let nativeProviderFetch: ProviderTransport = async () => { throw new Error("Native provider transport is not ready"); };
let nativeEgressFetch: typeof fetch = async () => { throw new Error("Native egress is not ready"); };
let nativeVoice: VoiceTransport = async () => { throw new Error("Native voice is not ready"); };
let nativeSandbox: SandboxCall = async () => { throw new Error("Native sandbox is not ready"); };
let nativeTransportReady: ReturnType<typeof desktopTransport> | undefined;
const nativeSessionStore: HostSessionStore = {
  load: async (id) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.load(id); },
  save: async (snapshot, revision) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.save(snapshot, revision); },
  list: async () => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.list(); },
  remove: async (id, revision) => { if (!nativeTransport) throw new Error("Native session transport is not ready"); return nativeTransport.hostSessionStore.remove(id, revision); },
};
const capacityLease = {
  reserve: async (requestId: string, rootId: string, amounts: Record<string, number>) => {
    if (!nativeTransport) throw new Error("Native capacity transport is not ready");
    return nativeTransport.reserveCapacity(requestId, rootId, amounts);
  },
  release: async (lease: import("./desktop-transport.ts").Lease) => {
    if (!nativeTransport) throw new Error("Native capacity transport is not ready");
    return nativeTransport.releaseCapacity(lease);
  },
};
const app = await startAppServer({
  dataDir: process.env.VAK_DATA_DIR,
  envFiles: [],
  access: "token",
  transport: "stdio",
  version: process.env.VAK_APP_VERSION,
  sandboxBin: process.env.VAK_SANDBOX_BIN,
  candidateCommit: (candidate) => nativeCommit(candidate),
  nativeSessionStore,
  capacityLease,
  providerTransport: (...args) => nativeProviderFetch(...args),
  egressTransport: (...args) => nativeEgressFetch(...args),
  voiceTransport: (call) => nativeVoice(call),
  sandbox: (...args) => nativeSandbox(...args),
  launchServer: (t) => { if (!nativeTransportReady) throw new Error("Native servers are not ready"); return nativeTransportReady.launchServer(t); },
  installPackage: (args, target) => nativeTransportReady ? nativeTransportReady.installPackage(args, target) : Promise.reject(new Error("Native installs are not ready")),
});
const transport = desktopTransport(app.request, app.token!, channel, channel, (error) => { console.error(error.message); void shutdown(); });
nativeCommit = transport.commitCandidate;
nativeTransport = transport;
nativeProviderFetch = transport.providerFetch;
nativeEgressFetch = transport.egressFetch;
nativeVoice = transport.voice;
nativeSandbox = transport.sandbox;
nativeTransportReady = transport;
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
