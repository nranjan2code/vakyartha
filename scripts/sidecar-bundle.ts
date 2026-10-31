import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { build } from "vite";

/** Every privileged/runtime entry is a self-contained module with built-ins only. */
async function bundleRuntime(app: string, outDir: string, source: string, filename: string, emptyOutDir: boolean): Promise<void> {
  await build({
    configFile: false, root: app, publicDir: false, logLevel: "warn",
    build: {
      ssr: path.join(app, source), outDir, emptyOutDir, target: "node26", minify: false, reportCompressedSize: false,
      rolldownOptions: { output: { entryFileNames: filename, format: "es", codeSplitting: false } },
    },
    ssr: { noExternal: true, target: "node" },
    plugins: [{ name: "runtime-boundary", generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      if (outputs.length !== 1 || outputs[0]?.type !== "chunk" || outputs[0].fileName !== filename) throw new Error("Runtime entry must be one self-contained module");
      for (const id of [...outputs[0].imports, ...outputs[0].dynamicImports]) if (!isBuiltin(id)) throw new Error(`Unexpected runtime dependency: ${id}`);
    } }],
  });
}

/** A release must run without workspace links or app node_modules. */
export async function buildSidecar(app: string, outDir: string): Promise<void> {
  await bundleRuntime(app, outDir, "sidecar/main.ts", "sidecar.mjs", true);
  await bundleRuntime(app, outDir, "sidecar/task-worker.ts", "task-worker.mjs", false);
  await bundleRuntime(app, outDir, "sidecar/canonical-worker.ts", "canonical-worker.mjs", false);
  await bundleRuntime(app, outDir, "sidecar/mcp-bridge.ts", "mcp-bridge.mjs", false);
  const workerSrc = path.join(app, "sidecar/sandbox-pool/worker.ts");
  if (existsSync(workerSrc)) await bundleRuntime(app, outDir, "sidecar/sandbox-pool/worker.ts", "worker.mjs", false);

  // Native analytics stays outside the JS bundle and is staged only for opted-in apps.
  const duckdbModules = path.join(app, "node_modules");
  if (existsSync(workerSrc)) for (const name of ["@duckdb/node-api", "@duckdb/node-bindings", `@duckdb/node-bindings-${process.platform}-${process.arch}`]) {
    cpSync(path.join(duckdbModules, name), path.join(outDir, "duckdb-runtime/node_modules", name), { recursive: true });
  }

  if (existsSync(path.join(app, "sidecar/builtin-skills"))) {
    cpSync(path.join(app, "sidecar/builtin-skills"), path.join(outDir, "builtin-skills"), { recursive: true });
  }
  if (existsSync(path.join(app, "sidecar/builtin-apps"))) {
    cpSync(path.join(app, "sidecar/builtin-apps"), path.join(outDir, "builtin-apps"), { recursive: true });
  }
}

/** Keep npm and its dependencies intact; omit only its top-level documentation. */
export function copyNpm(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => !["docs", "man"].includes(path.relative(source, file)),
  });
}

/** Deterministic content receipt, independent of build-machine absolute paths. */
export function treeReceipt(root: string): { files: number; bytes: number; sha256: string } {
  if (statSync(root).isFile()) {
    const body = readFileSync(root);
    return { files: 1, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  }
  const files: [string, number, string][] = [];
  function visit(file: string): void {
    if (statSync(file).isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    } else {
      const body = readFileSync(file);
      files.push([path.relative(root, file).split(path.sep).join("/"), body.length, createHash("sha256").update(body).digest("hex")]);
    }
  }
  visit(root);
  return { files: files.length, bytes: files.reduce((n, f) => n + f[1], 0), sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}
