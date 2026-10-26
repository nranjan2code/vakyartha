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
import { chmodSync, copyFileSync, cpSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

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

await build({
  configFile: false,
  root: app,
  logLevel: "warn",
  build: {
    ssr: path.join(app, "sidecar/main.ts"),
    outDir: path.join(tauri, "resources"),
    emptyOutDir: true,
    target: "node24",
    minify: false,
    rollupOptions: { output: { entryFileNames: "sidecar.mjs", format: "es" } },
  },
  // Inline the workspace packages; only node: built-ins remain external.
  ssr: { noExternal: true, target: "node" },
});

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("could not read the Rust host triple from `rustc -vV`");
const ext = process.platform === "win32" ? ".exe" : "";
const bin = path.join(tauri, "binaries", `node-${triple}${ext}`);
mkdirSync(path.dirname(bin), { recursive: true });
copyFileSync(realpathSync(process.execPath), bin);
chmodSync(bin, 0o755);
// npm, so integrations can be installed in the release app (it runs with the bundled Node).
const npmDir = path.resolve(path.dirname(realpathSync(process.execPath)), "../lib/node_modules/npm");
cpSync(npmDir, path.join(tauri, "resources", "npm"), { recursive: true, dereference: true });
console.log(`sidecar → ${path.relative(app, path.join(tauri, "resources/sidecar.mjs"))}, node ${process.version} → ${path.relative(app, bin)}`);
