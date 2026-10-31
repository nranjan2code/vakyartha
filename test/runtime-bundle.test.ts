import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSidecar, copyNpm, treeReceipt } from "../scripts/sidecar-bundle.ts";

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("npm trimming preserves installer dependencies, licenses and nested documentation", (t) => {
  const root = fixture(t), source = path.join(root, "npm"), dest = path.join(root, "copy");
  const files = ["docs/index.html", "man/npm.1", "LICENSE", "bin/npm-cli.js", "node_modules/tool/docs/runtime.js", "node_modules/tool/LICENSE"];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), file);
  }
  copyNpm(source, dest);
  assert.equal(existsSync(path.join(dest, "docs")), false);
  assert.equal(existsSync(path.join(dest, "man")), false);
  for (const file of files.slice(2)) assert.equal(readFileSync(path.join(dest, file), "utf8"), file);
  const original = treeReceipt(dest);
  writeFileSync(path.join(dest, "bin/npm-cli.js"), "changed");
  assert.notEqual(treeReceipt(dest).sha256, original.sha256);
  copyNpm(source, path.join(root, "second-copy"));
  assert.deepEqual(treeReceipt(path.join(root, "second-copy")), original);
});

test("sidecar bundles without frontend files or workspace dependencies and rejects external imports", async (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "sidecar/builtin-skills/demo"), { recursive: true });
  mkdirSync(path.join(root, "public"));
  writeFileSync(path.join(root, "public/unneeded.txt"), "frontend only");
  writeFileSync(path.join(root, "sidecar/builtin-skills/demo/SKILL.md"), "skill");
  writeFileSync(path.join(root, "sidecar/main.ts"), 'import { platform } from "node:os"; console.log(platform());');
  writeFileSync(path.join(root, "sidecar/task-worker.ts"), 'import { arch } from "node:os"; console.log(arch());');
  writeFileSync(path.join(root, "sidecar/canonical-worker.ts"), 'import { arch } from "node:os"; console.log(arch());');
  writeFileSync(path.join(root, "sidecar/mcp-bridge.ts"), 'import { spawn } from "node:child_process"; console.log(typeof spawn);');
  const out = path.join(root, "out");
  await buildSidecar(root, out);
  assert.equal(existsSync(path.join(out, "unneeded.txt")), false);
  assert.equal(readFileSync(path.join(out, "builtin-skills/demo/SKILL.md"), "utf8"), "skill");
  assert.match(readFileSync(path.join(out, "sidecar.mjs"), "utf8"), /node:os/);
  assert.match(readFileSync(path.join(out, "task-worker.mjs"), "utf8"), /node:os/);
  assert.match(readFileSync(path.join(out, "canonical-worker.mjs"), "utf8"), /node:os/);
  writeFileSync(path.join(root, "sidecar/canonical-worker.ts"), 'import "unreviewed-external-package";');
  await assert.rejects(buildSidecar(root, out), /Unexpected runtime dependency|Could not resolve|failed to resolve/);
  writeFileSync(path.join(root, "sidecar/canonical-worker.ts"), 'console.log("canonical-worker");');
  writeFileSync(path.join(root, "sidecar/task-worker.ts"), 'import "unreviewed-external-package";');
  await assert.rejects(buildSidecar(root, out), /Unexpected runtime dependency|Could not resolve|failed to resolve/);
  writeFileSync(path.join(root, "sidecar/task-worker.ts"), 'console.log("task-worker");');
  writeFileSync(path.join(root, "sidecar/main.ts"), 'import "unreviewed-external-package";');
  await assert.rejects(buildSidecar(root, out), /Unexpected runtime dependency|Could not resolve|failed to resolve/);
});
