import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppRegistry, isCronMatch } from "../sidecar/sandbox-pool/app-registry.ts";
import { SandboxPoolManager } from "../sidecar/sandbox-pool/pool-manager.ts";
import { helperRun } from "./support/sandbox-run.ts";

const helper = process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb");
const manifest = { id: "computed-app", name: "Computed app", version: "1.0.0", entrypoints: { backend: "main.ts", surface: "surface.json" }, triggers: [{ id: "refresh", kind: "cron", expression: "* * * * *", action: "refreshData", maxDurationSec: 10 }] };
const surface = { id: "view", version: 1, data: { total: 0 }, nodes: [{ id: "root", type: "text", props: { content: "{/total}" } }] };
const files = { "surface.json": JSON.stringify(surface), "main.ts": `export async function handleAction(id,value,ctx){ctx.state.total=Number(value)*2;return {data:{total:ctx.state.total}}}
export async function refreshData(ctx){ctx.state.total=(ctx.state.total??0)+3;return {data:{total:ctx.state.total}}}` };
function setup() {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-app-registry-"));
  const pool = new SandboxPoolManager({ run: helperRun(helper) });
  const registry = new AppRegistry({ dataDir: tmp, pool });
  return { tmp, pool, registry, async close() { await pool.shutdown(); await registry.shutdown(); rmSync(tmp, { recursive: true, force: true }); } };
}
test("cron supports exact, step and list matches", () => {
  assert.equal(isCronMatch("15 * * * *", new Date(2026, 9, 28, 14, 15)), true);
  assert.equal(isCronMatch("*/5 * * * *", new Date(2026, 9, 28, 14, 26)), false);
  assert.equal(isCronMatch("0,30 * * * *", new Date(2026, 9, 28, 14, 30)), true);
});
test("package traversal, deletion escape, stale publication and live draft writes are refused", async () => {
  const s = setup(); await s.registry.init();
  try {
    mkdirSync(path.join(s.tmp, "outside"));
    await assert.rejects(s.registry.installApp(manifest, { ...files, "../outside/escaped": "bad" }), /Unsafe/);
    await assert.rejects(s.registry.deleteApp("../outside"), /identifier/);
    assert.ok(existsSync(path.join(s.tmp, "outside")));
    const draft = s.registry.saveDraft(manifest.id, { manifest, files }) as any;
    assert.equal(s.registry.listApps().length, 0);
    await assert.rejects(s.registry.publishDraft(manifest.id, "stale"), /changed/);
    await s.registry.publishDraft(manifest.id, draft.fingerprint);
    const live = s.registry.getApp(manifest.id)!;
    const edited = s.registry.saveDraft(manifest.id, { manifest: { ...manifest, version: "1.0.1" }, files, base: live.fingerprint }) as any;
    assert.equal(s.registry.getApp(manifest.id)!.manifest.version, "1.0.0");
    assert.equal(s.registry.getDraft(manifest.id).files["main.ts"], files["main.ts"]);
    await assert.rejects(s.registry.updateApp(manifest.id, { version: "1.0.2" }, {}, "stale"), /changed/);
    await s.registry.publishDraft(manifest.id, edited.fingerprint);
    assert.notEqual(s.registry.getApp(manifest.id)!.fingerprint, live.fingerprint);
    assert.equal(s.registry.getApp(manifest.id)!.scheduling, false);
  } finally { await s.close(); }
});
test("incomplete draft source survives saves but cannot be published", async () => {
  const s = setup(); await s.registry.init();
  try {
    const draft = s.registry.saveDraft(manifest.id, { manifest, manifestText: "{ incomplete", files: { ...files, "surface.json": "{ incomplete" } }) as any;
    assert.equal(s.registry.getDraft(manifest.id).manifestText, "{ incomplete");
    assert.equal(s.registry.getDraft(manifest.id).files["surface.json"], "{ incomplete");
    await assert.rejects(s.registry.publishDraft(manifest.id, draft.fingerprint));
    assert.equal(s.registry.listApps().length, 0);
  } finally { await s.close(); }
});
test("direct async actions, named refresh, reopen and restart retain calculated data without models", { skip: process.platform !== "darwin" }, async () => {
  const s = setup(); await s.registry.init();
  try {
    await s.registry.installApp(manifest, files);
    const response = await s.registry.dispatchAction(manifest.id, "/input", 21, undefined, 1);
    assert.equal(response.surfaces.view.data.total, 42);
    assert.equal(s.registry.getApp(manifest.id)!.state.total, 42);
    await assert.rejects(s.registry.dispatchAction(manifest.id, "/input", 99, undefined, 1), /changed/);
    await s.registry.runTrigger(manifest.id, "refresh");
    assert.equal(s.registry.getApp(manifest.id)!.surfaces!.view!.data.total, 45);
    s.registry.reloadApps();
    assert.equal(s.registry.getApp(manifest.id)!.state.total, 45);
    assert.equal(s.registry.getApp(manifest.id)!.surfaces!.view!.data.total, 45);
    await s.registry.setScheduling(manifest.id, true);
    const minute = new Date(2026, 9, 28, 14, 15);
    await Promise.all([s.registry.checkSchedules(minute), s.registry.checkSchedules(minute)]);
    assert.equal(s.registry.getApp(manifest.id)!.state.total, 48);
    s.registry.reloadApps(); await s.registry.checkSchedules(minute);
    assert.equal(s.registry.getApp(manifest.id)!.state.total, 48);
  } finally { await s.close(); }
});

test("app update review binds both snapshots without silent startup replacement", async t => {
  const s = setup(); await s.registry.init();
  const bundled = path.join(s.tmp, "bundled"), folder = path.join(bundled, manifest.id);
  mkdirSync(folder, { recursive: true });
  const shipped = { ...manifest, version: "2.0.0" };
  writeFileSync(path.join(folder, "app.json"), JSON.stringify(shipped));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(folder, name), text);
  t.mock.method(s.registry, "getBuiltinDir", () => bundled);
  let restarted: AppRegistry | undefined;
  try {
    const installed = await s.registry.installApp({ ...manifest, name: "My edited app" }, files);
    await assert.rejects(s.registry.updateApp(manifest.id, shipped, {}, undefined), /changed/);
    await assert.rejects(s.registry.installBuiltin(manifest.id), /already exists/);
    const preview = s.registry.previewAppUpdate(manifest.id);
    assert.equal(preview.source, "builtin");
    assert.equal(preview.manifest.version, "2.0.0");
    await assert.rejects(s.registry.updateAppToLatest(manifest.id, undefined), /Review/);
    writeFileSync(path.join(folder, "main.ts"), files["main.ts"] + "\n// new source after review");
    const review = ({ baseFingerprint, baseRevision, candidateFingerprint }: typeof preview) => ({ baseFingerprint, baseRevision, candidateFingerprint });
    await assert.rejects(s.registry.updateAppToLatest(manifest.id, review(preview)), /changed/);
    assert.equal(s.registry.getApp(manifest.id)!.manifest.name, "My edited app");
    const draft = s.registry.saveDraft(manifest.id, { manifest: { ...manifest, name: "My saved draft", version: "3.0.0" }, files, base: installed.fingerprint }) as any;
    const draftPreview = s.registry.previewAppUpdate(manifest.id);
    assert.equal(draftPreview.source, "draft", "saved edits take precedence over the shipped package");
    assert.equal(s.registry.listApps()[0]!.hasDraft, true);
    const updated = await s.registry.updateAppToLatest(manifest.id, review(draftPreview));
    assert.equal(updated.manifest.name, "My saved draft");
    assert.equal(updated.manifest.version, "3.0.0");
    assert.equal(updated.scheduling, false);
    assert.equal(s.registry.getDraft(manifest.id).fingerprint, null, "only the applied draft was retired");
    assert.ok(draft.fingerprint);
    const published = updated.fingerprint;
    await s.registry.shutdown();
    restarted = new AppRegistry({ dataDir: s.tmp, pool: s.pool, seedBuiltins: true });
    t.mock.method(restarted, "getBuiltinDir", () => bundled);
    await restarted.init();
    assert.equal(restarted.getApp(manifest.id)!.fingerprint, published, "startup must not replace user code with bundled source");
    assert.equal(restarted.getApp(manifest.id)!.manifest.name, "My saved draft");
    assert.equal(restarted.listApps()[0]!.updateAvailable, true);
  } finally { await restarted?.shutdown(); await s.close(); }
});
