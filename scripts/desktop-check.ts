// macOS native transport smoke. Uses a separate app identity, data directory and
// Keychain namespace; no model call, installed-app replacement or channel restart.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const run = promisify(execFile), root = process.cwd(), out = mkdtempSync(path.join(tmpdir(), "vak-desktop-private-")), nativeOut = path.join(path.dirname(out), `.${path.basename(out)}-native`), workspace = `${out}-workspace`, nextWorkspace = `${out}-workspace-next`;
if (process.platform !== "darwin") throw new Error("The native transport check currently targets macOS");
await run("npm", ["run", "build"]);
const host = /host: (\S+)/.exec((await run("rustc", ["-vV"])).stdout)?.[1];
if (!host) throw new Error("Rust host triple unavailable");
await run("npm", ["run", "bundle-sidecar"]);
await run("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "tauri/custom-protocol"], { env: { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: `com.nranjan2code.vakyartha.runtime-check-${path.basename(out).slice(-6).toLowerCase()}`, app: { windows: [{ label: "main", visible: false }] } }) } });
mkdirSync(workspace);
mkdirSync(nextWorkspace);
mkdirSync(path.join(out, "sessions"));
const legacyChat = path.join(out, "sessions", "legacy-chat.json");
const legacyBytes = Buffer.from(JSON.stringify({ id: "legacy-chat", title: "Preserved legacy chat", created: "2026-10-30T00:00:00.000Z", updated: "2026-10-30T00:00:01.000Z", messages: [], timeline: [], surfaces: [], external: [] }));
writeFileSync(legacyChat, legacyBytes, { mode: 0o600 });
const legacyVaultPath = path.join(out, ".vault.secrets"), legacyVaultBytes = Buffer.from("NATIVE_VAULT_PROBE=legacy-value\n");
writeFileSync(legacyVaultPath, legacyVaultBytes, { mode: 0o600 });
const log = path.join(out, "worker/logs/engine.log"), stderr = createWriteStream(path.join(out, "native.stderr"), { mode: 0o600 });
const probe = path.join(out, "desktop-probe.js");
writeFileSync(probe, readFileSync(path.join(root, "scripts/desktop-probe.js"), "utf8").replaceAll("__WORKSPACE__", JSON.stringify(workspace)).replaceAll("__NEXT_WORKSPACE__", JSON.stringify(nextWorkspace)), { mode: 0o600 });
const child = spawn(path.join(root, "src-tauri/target/debug/vakyartha"), [], { env: { ...process.env, VAK_DATA_DIR: out, VAK_DEBUG_JS: probe }, stdio: ["ignore", "ignore", "pipe"] });
child.stderr.pipe(stderr);
let nodeIds: string[] = [];
try {
  for (let i = 0; i < 300; i++) {
    if (existsSync(log) && readFileSync(log, "utf8").includes("NATIVE_PRIVATE_")) break;
    if (child.exitCode !== null) throw new Error(`Native app exited (${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(log) && readFileSync(log, "utf8").includes("NATIVE_PRIVATE_PASS"), `Native probe failed; see ${out}`);
  assert.equal(existsSync(path.join(out, "worker/tasks")), false, "Desktop opened the TypeScript task journal");
  assert.deepEqual(readFileSync(legacyChat), legacyBytes, "Legacy chat source was changed during migration");
  assert.deepEqual(readFileSync(legacyVaultPath), legacyVaultBytes, "Native vault commands modified the legacy in-data vault");
  assert.equal(statSync(path.join(nativeOut, "host-sessions", "session-legacy-chat.json")).mode & 0o077, 0, "Native chat storage permissions are too broad");
  const folder = path.join(out, "worker/attachments/ipc-check"), uploads = readdirSync(folder).filter((file) => file.endsWith(".wav"));
  assert.equal(uploads.length, 1);
  const expected = Buffer.alloc(1024 * 1024 + 44);
  expected.write("RIFF", 0); expected.writeUInt32LE(expected.length - 8, 4); expected.write("WAVEfmt ", 8); expected.writeUInt32LE(16, 16); expected.writeUInt16LE(1, 20); expected.writeUInt16LE(1, 22); expected.writeUInt32LE(16000, 24); expected.writeUInt32LE(32000, 28); expected.writeUInt16LE(2, 32); expected.writeUInt16LE(16, 34); expected.write("data", 36); expected.writeUInt32LE(expected.length - 44, 40);
  const uploaded = path.join(folder, uploads[0]!);
  assert.deepEqual(readFileSync(uploaded), expected, "Private attachment bytes changed in transport");
  assert.equal(statSync(uploaded).mode & 0o077, 0, "Private attachment permissions are too broad");
  const processes = (await run("ps", ["-axo", "pid=,ppid="])).stdout.trim().split("\n").map((line) => line.trim().split(/\s+/));
  const descendants = new Set([String(child.pid)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of processes) if (pid && parent && descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
  }
  descendants.delete(String(child.pid));
  nodeIds = [...descendants];
  assert.ok(nodeIds.length >= 2, "Expected both containment helper and its worker descendants");
  for (const id of nodeIds) {
    try { const found = await run("lsof", ["-a", "-p", id, "-iTCP", "-sTCP:LISTEN", "-Fn"]); throw new Error(`Engine has a TCP listener: ${found.stdout}`); }
    catch (error) { if ((error as { code?: number; stdout?: string }).code !== 1 || (error as { stdout?: string }).stdout) throw error; }
  }
  writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ privateIpc: true, canonicalProjection: true, nativeSessionStore: true, nonDestructiveSessionMigration: true, webkitRendering: true, finops: true, binaryReceipt: true, nodeTcpListeners: 0 }, null, 2), { mode: 0o600 });
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await import("node:fs/promises").then(({ rm }) => rm(workspace, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ rm }) => rm(nextWorkspace, { recursive: true, force: true }));
}
const alive = (id: string) => { try { process.kill(Number(id), 0); return true; } catch { return false; } };
for (let i = 0; i < 80 && nodeIds.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(!nodeIds.some(alive), "Node outlived its Tauri parent");
console.log(`Native private IPC, canonical rendering, FinOps, zero TCP listeners and parent-exit cleanup passed. Evidence: ${out}`);
