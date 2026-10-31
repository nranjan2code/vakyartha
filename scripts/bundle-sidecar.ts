// Release packaging for the engine sidecar, run by `tauri build`:
// - bundles sidecar/main.ts and the framework packages it imports into one
//   ES module (Node built-ins stay imports), src-tauri/resources/sidecar.mjs
// - copies the Node binary running this script to
//   src-tauri/binaries/node-<target triple>, Tauri's externalBin naming,
//   and its npm to src-tauri/resources/npm (installing integrations).
// Node 26+ is required: the bundle uses the same built-ins as the source.
// The release refuses a Node that is not signed by the Node.js Foundation, not
// an LTS line, or not that line's newest patch on nodejs.org (security fixes).
// VAK_NODE_CHECK=offline skips only the nodejs.org lookup, with a warning.

import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSidecar, copyNpm, treeReceipt } from "./sidecar-bundle.ts";

const NODE_TEAM = "HX7739G8FX"; // Developer ID: Node.js Foundation

function installExecutable(source: string, destination: string): void {
  // Replace the inode instead of overwriting signed executable pages. On macOS
  // an in-place helper update can retain stale kernel code-signing state and be
  // killed at exec even though codesign verifies the new bytes.
  const temporary = `${destination}.stage-${randomUUID()}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}


async function checkNode(): Promise<void> {
  const exe = realpathSync(process.execPath);
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--verify", "--strict", exe]);
    // codesign prints signing details on stderr.
    const details = spawnSync("codesign", ["-dv", "--verbose=2", exe], { encoding: "utf8" }).stderr;
    if (!details.includes(`TeamIdentifier=${NODE_TEAM}`)) throw new Error(`${exe} is not signed by the Node.js Foundation (${NODE_TEAM}); install Node from nodejs.org`);
  }
  if (process.env.VAK_NODE_CHECK === "offline") { console.warn(`warning: skipped the nodejs.org check; bundling ${process.version} unverified for currency`); return; }
  const res = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`nodejs.org release index unavailable (${res.status}); retry, or set VAK_NODE_CHECK=offline knowingly`);
  const releases = await res.json() as { version: string; lts: string | false; security: boolean }[];
  const ltsReleases = releases.filter((release) => release.lts);
  const newestMajor = Math.max(...ltsReleases.map((release) => Number(/^v(\d+)\./.exec(release.version)?.[1] ?? 0)));
  const newest = ltsReleases.find((release) => release.version.startsWith(`v${newestMajor}.`));
  if (!newest) throw new Error("Could not determine the newest Node.js LTS release");
  if (!process.version.startsWith(`v${newestMajor}.`)) throw new Error(`Node ${process.version} is not on the newest LTS line: Node ${newestMajor} (${newest.lts}); install its newest release ${newest.version} from nodejs.org.`);
  if (newest.version !== process.version) throw new Error(`Node ${process.version} is outdated: ${newest.version} is the newest ${newest.lts} release${newest.security ? " and contains security fixes" : ""}. Install it from nodejs.org and verify it before releasing.`);
  console.log(`node ${process.version}: Node.js Foundation signature, newest LTS line (${newest.lts}) and release`);
}
await checkNode();

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = path.join(app, "src-tauri");

await buildSidecar(app, path.join(tauri, "resources"));

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("could not read the Rust host triple from `rustc -vV`");
const ext = process.platform === "win32" ? ".exe" : "";
const bin = path.join(tauri, "binaries", `node-${triple}${ext}`);
mkdirSync(path.dirname(bin), { recursive: true });
installExecutable(realpathSync(process.execPath), bin);
// npm, so integrations can be installed in the release app (it runs with the bundled Node).
const npmDir = path.resolve(path.dirname(realpathSync(process.execPath)), "../lib/node_modules/npm");
copyNpm(npmDir, path.join(tauri, "resources", "npm"));
console.log(`sidecar → ${path.relative(app, path.join(tauri, "resources/sidecar.mjs"))}, node ${process.version} → ${path.relative(app, bin)}`);

// Bundle vaksb (vak-sandbox CLI) as an external binary alongside node.
const sandboxRepo = path.resolve(app, "..", "sandbox");
const sandboxRevision = "19c493dc7f619ec772c99a5f6f397a4a71888f61";
const sandboxGit = (...args: string[]) => execFileSync("git", ["-C", sandboxRepo, ...args], { encoding: "utf8" }).trim();
if (sandboxGit("rev-parse", "HEAD") !== sandboxRevision || sandboxGit("status", "--porcelain")) {
  throw new Error(`Sandbox must be the clean reviewed revision ${sandboxRevision}`);
}
const vaksbSrc = path.join(sandboxRepo, "target", triple, "release", `vaksb${ext}`);
// Always ask Cargo to validate current sources and its lockfile. Its incremental
// build is cheap; binary existence alone cannot establish source provenance.
const sandboxBuild = spawnSync("cargo", ["build", "--locked", "--release", "--target", triple, "-p", "vak-sandbox-ctl"], { cwd: sandboxRepo, stdio: "inherit", env: { ...process.env, RUSTUP_TOOLCHAIN: "1.99.1", CARGO_TARGET_DIR: path.join(sandboxRepo, "target") } });
if (sandboxBuild.error) throw sandboxBuild.error;
if (sandboxBuild.status !== 0) throw new Error(`Sandbox build failed (${sandboxBuild.status ?? sandboxBuild.signal}); refusing to package an old binary`);
const vaksbBin = path.join(tauri, "binaries", `vaksb-${triple}${ext}`);
installExecutable(vaksbSrc, vaksbBin);
console.log(`vaksb → ${path.relative(app, vaksbBin)}`);

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const resources = path.join(tauri, "resources");
const npmVersion = (JSON.parse(readFileSync(path.join(resources, "npm/package.json"), "utf8")) as { version: string }).version;
const receipt = {
  schema: 1,
  app: { commit: git(app, "rev-parse", "HEAD"), dirty: Boolean(git(app, "status", "--porcelain")) },
  framework: git(path.join(app, "framework"), "rev-parse", "HEAD"),
  lockfile: treeReceipt(path.join(app, "package-lock.json")),
  node: { version: process.version, ...treeReceipt(bin) },
  npm: { version: npmVersion, ...treeReceipt(path.join(resources, "npm")) },
  sidecar: treeReceipt(path.join(resources, "sidecar.mjs")),
  taskWorker: treeReceipt(path.join(resources, "task-worker.mjs")),
  canonicalWorker: treeReceipt(path.join(resources, "canonical-worker.mjs")),
  mcpBridge: treeReceipt(path.join(resources, "mcp-bridge.mjs")),
  skills: treeReceipt(path.join(resources, "builtin-skills")),
  apps: treeReceipt(path.join(resources, "builtin-apps")),
  duckdb: { version: "2.0.0-r.1", ...treeReceipt(path.join(resources, "duckdb-runtime")) },
  sandbox: { commit: git(sandboxRepo, "rev-parse", "HEAD"), dirty: Boolean(git(sandboxRepo, "status", "--porcelain")), ...treeReceipt(vaksbBin) },
};
writeFileSync(path.join(resources, "runtime-manifest.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(`Runtime receipt: Node ${receipt.node.bytes} bytes; npm ${receipt.npm.files} files / ${receipt.npm.bytes} bytes; sidecar ${receipt.sidecar.bytes} bytes`);
