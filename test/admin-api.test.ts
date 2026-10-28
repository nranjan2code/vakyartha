import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startAppServer } from "../sidecar/server.ts";

test("app API stages, publishes and executes real code; invalid targets and stale updates fail", { skip: process.platform !== "darwin" }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-app-api-"));
  const app = await startAppServer({ dataDir: tmp, access: "open", transport: "stdio", sandboxBin: process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb"), keychainService: "com.nranjan2code.vakyartha.admin-api-test" });
  const request = (route: string, method = "GET", body?: unknown) => app.request(new Request(`http://localhost${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  try {
    const manifest = { id: "api-app", name: "API app", version: "1.0.0", entrypoints: { backend: "worker.ts" } };
    const draftRes = await request("/api/apps/api-app/draft", "PUT", { manifest, files: { "worker.ts": "export async function handleAction(id,value,ctx){ctx.state.value=value*3;return {value:ctx.state.value}}" } });
    assert.equal(draftRes.status, 200); const draft = await draftRes.json();
    assert.equal((await request("/api/apps/api-app")).status, 404);
    const publish = await request("/api/apps/api-app/publish", "POST", { fingerprint: draft.fingerprint });
    assert.equal(publish.status, 200);
    const action = await request("/api/apps/api-app/action", "POST", { controlId: "value", value: 7, revision: 1 });
    assert.equal(action.status, 200); assert.equal((await action.json()).value, 21);
    assert.deepEqual(await (await request("/api/apps/api-app/state")).json(), { value: 21 });
    assert.equal((await request("/api/apps/api-app", "PUT", { manifest: { version: "1.0.1" } })).status, 400);
    assert.equal((await request("/api/apps/%2e%2e%2foutside", "DELETE")).status, 400);
    assert.equal((await request("/api/admin/fleet/restart", "POST", {})).status, 200);
    assert.equal((await request("/api/apps/api-app", "DELETE")).status, 200);
    const live = await request("/api/apps", "POST", { manifest: { ...manifest, id: "clock-app", entitlements: { mcpTools: ["time__now"] } }, files: { "worker.ts": "export async function handleAction(id,value,ctx){ctx.state.clock=await ctx.callTool('time__now',{timezone:'Asia/Kolkata'});return {clock:ctx.state.clock}}" } });
    assert.equal(live.status, 201);
    const clock = await request("/api/apps/clock-app/action", "POST", { controlId: "refresh", value: null, revision: 1 });
    assert.equal(clock.status, 200, await clock.clone().text());
    assert.match((await clock.json()).clock, /Asia\/Kolkata|GMT\+5:30|India/);
    const integrations = await (await request("/api/integrations")).json();
    const time = integrations.find((i: any) => i.entry.id === "time");
    const denied = await request("/api/integrations/time", "PUT", { enabled: false });
    assert.equal(denied.status, 200);
    const revoked = await request("/api/apps/clock-app/action", "POST", { controlId: "refresh", value: null, revision: 2 });
    assert.equal(revoked.status, 400);
    const uncertain = await (await request("/api/apps/clock-app")).json();
    assert.equal(uncertain.run.status, "uncertain");
    assert.equal((await request("/api/apps/clock-app/recover", "POST", { runId: "wrong" })).status, 400);
    assert.equal((await request("/api/apps/clock-app/recover", "POST", { runId: uncertain.run.id })).status, 200);
    assert.equal((await (await request("/api/apps/clock-app")).json()).scheduling, false);

  } finally { await app.shutdown(); rmSync(tmp, { recursive: true, force: true }); }
});
