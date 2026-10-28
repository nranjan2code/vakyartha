// Release packaging for the engine sidecar, run by `tauri build`:
// - bundles sidecar/main.ts and the framework packages it imports into one
//   ES module (Node built-ins stay imports), src-tauri/resources/sidecar.mjs
// - copies the Node binary running this script to
//   src-tauri/binaries/node-<target triple>, Tauri's externalBin naming,
//   and its npm to src-tauri/resources/npm (installing integrations).
// Node 24+ is required: the bundle uses the same built-ins as the source.
// The release refuses a Node that is not signed by the Node.js Foundation, not
// an LTS line, or not that line's newest patch on nodejs.org (security fixes).
// VAK_NODE_CHECK=offline skips only the nodejs.org lookup, with a warning.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSidecar, copyNpm, treeReceipt } from "./sidecar-bundle.ts";

const NODE_TEAM = "HX7739G8FX"; // Developer ID: Node.js Foundation

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
  const major = process.version.split(".")[0] + ".";
  const newest = releases.find(r => r.version.startsWith(major));
  if (!newest?.lts) throw new Error(`Node ${process.version} is not on an LTS line; bundle an LTS release`);
  if (newest.version !== process.version) throw new Error(`Node ${process.version} is outdated: ${newest.version} is the newest ${newest.lts} release${newest.security ? " and contains security fixes" : ""}. Install it from nodejs.org and verify it before releasing.`);
  console.log(`node ${process.version}: Node.js Foundation signature, newest ${newest.lts} LTS release`);
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
copyFileSync(realpathSync(process.execPath), bin);
chmodSync(bin, 0o755);
// npm, so integrations can be installed in the release app (it runs with the bundled Node).
const npmDir = path.resolve(path.dirname(realpathSync(process.execPath)), "../lib/node_modules/npm");
copyNpm(npmDir, path.join(tauri, "resources", "npm"));
console.log(`sidecar → ${path.relative(app, path.join(tauri, "resources/sidecar.mjs"))}, node ${process.version} → ${path.relative(app, bin)}`);

// Bundle vaksb (vak-sandbox CLI) as an external binary alongside node.
const sandboxRepo = path.resolve(app, "..", "sandbox");
const vaksbSrc = path.join(sandboxRepo, "target", triple, "release", `vaksb${ext}`);
// Always ask Cargo to validate current sources and its lockfile. Its incremental
// build is cheap; binary existence alone cannot establish source provenance.
const sandboxBuild = spawnSync("cargo", ["build", "--locked", "--release", "--target", triple, "-p", "vak-sandbox-ctl"], { cwd: sandboxRepo, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: path.join(sandboxRepo, "target") } });
if (sandboxBuild.error) throw sandboxBuild.error;
if (sandboxBuild.status !== 0) throw new Error(`Sandbox build failed (${sandboxBuild.status ?? sandboxBuild.signal}); refusing to package an old binary`);
const vaksbBin = path.join(tauri, "binaries", `vaksb-${triple}${ext}`);
copyFileSync(vaksbSrc, vaksbBin);
chmodSync(vaksbBin, 0o755);
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
  skills: treeReceipt(path.join(resources, "builtin-skills")),
  apps: treeReceipt(path.join(resources, "builtin-apps")),
  duckdb: { version: "1.5.6-r.1", ...treeReceipt(path.join(resources, "duckdb-runtime")) },
  sandbox: { commit: git(sandboxRepo, "rev-parse", "HEAD"), dirty: Boolean(git(sandboxRepo, "status", "--porcelain")), ...treeReceipt(vaksbBin) },
};
writeFileSync(path.join(resources, "runtime-manifest.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(`Runtime receipt: Node ${receipt.node.bytes} bytes; npm ${receipt.npm.files} files / ${receipt.npm.bytes} bytes; sidecar ${receipt.sidecar.bytes} bytes`);
