import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { build } from "vite";

/** A release must run without workspace links or app node_modules. */
export async function buildSidecar(app: string, outDir: string): Promise<void> {
  await build({
    configFile: false,
    root: app,
    // Frontend assets are already in dist; the engine has no public directory.
    publicDir: false,
    logLevel: "warn",
    build: {
      ssr: path.join(app, "sidecar/main.ts"),
      outDir,
      emptyOutDir: true,
      target: "node24",
      minify: false,
      reportCompressedSize: false,
      rolldownOptions: { output: { entryFileNames: "sidecar.mjs", format: "es", codeSplitting: false } },
    },
    ssr: { noExternal: true, target: "node" },
    plugins: [{
      name: "sidecar-runtime-boundary",
      generateBundle(_options, bundle) {
        const outputs = Object.values(bundle);
        if (outputs.length !== 1 || outputs[0]?.type !== "chunk" || outputs[0].fileName !== "sidecar.mjs") {
          throw new Error("The sidecar must be one self-contained module");
        }
        for (const id of [...outputs[0].imports, ...outputs[0].dynamicImports]) {
          if (!isBuiltin(id)) throw new Error(`Unexpected sidecar runtime dependency: ${id}`);
        }
      },
    }],
  });

  const workerSrc = path.join(app, "sidecar/sandbox-pool/worker.ts");
  if (existsSync(workerSrc)) {
    await build({
      configFile: false,
      root: app,
      publicDir: false,
      logLevel: "warn",
      build: {
        ssr: workerSrc,
        outDir,
        emptyOutDir: false,
        target: "node24",
        minify: false,
        reportCompressedSize: false,
        rolldownOptions: { output: { entryFileNames: "worker.mjs", format: "es", codeSplitting: false } },
      },
      ssr: { noExternal: true, target: "node" },
      plugins: [{
        name: "worker-runtime-boundary",
        generateBundle(_options, bundle) {
          const outputs = Object.values(bundle);
          if (outputs.length !== 1 || outputs[0]?.type !== "chunk" || outputs[0].fileName !== "worker.mjs") {
            throw new Error("The worker must be one self-contained module");
          }
          for (const id of [...outputs[0].imports, ...outputs[0].dynamicImports]) {
            if (!isBuiltin(id)) throw new Error(`Unexpected worker runtime dependency: ${id}`);
          }
        },
      }],
    });
  }

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
