// Release packaging for the engine sidecar, run by `tauri build`:
// - bundles sidecar/main.ts and the framework packages it imports into one
//   ES module (Node built-ins stay imports), src-tauri/resources/sidecar.mjs
// - copies the Node binary running this script to
//   src-tauri/binaries/node-<target triple>, Tauri's externalBin naming.
// Node 24+ is required: the bundle uses the same built-ins as the source.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

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
console.log(`sidecar → ${path.relative(app, path.join(tauri, "resources/sidecar.mjs"))}, node ${process.version} → ${path.relative(app, bin)}`);
