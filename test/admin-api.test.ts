// Real multi-process end-to-end integration tests for Sandbox Pool Admin & App APIs.
// Strictly no mocks or stubs: runs real OS processes, real HTTP dispatch, and real filesystem volumes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startAppServer } from "../sidecar/server.ts";

test("admin and hosted apps HTTP APIs manage real sandboxed worker lifecycle end-to-end", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-admin-api-test-"));
  const app = await startAppServer({
    dataDir: tmp,
    access: "open",
    keychainService: "com.nranjan2code.vakyartha.admin-api-test",
  });

  t.after(async () => {
    await app.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  });

  // 1. GET /api/admin/fleet - verify fleet snapshot
  const fleetRes = await app.request(new Request("http://localhost/api/admin/fleet"));
  assert.equal(fleetRes.status, 200);
  const fleet = await fleetRes.json();
  assert.equal(typeof fleet.activeCount, "number");
  assert.equal(fleet.maxActiveWorkers, 3);
  assert.ok(Array.isArray(fleet.slots));

  // 2. POST /api/apps - install a real sandboxed dynamic app
  const manifest = {
    id: "portfolio-risk",
    name: "Portfolio Risk Monitor",
    version: "1.0.0",
    description: "Real-time VaR and sensitivity calculator",
    author: "Nisheeth",
    category: "finance",
    icon: "chart-line",
    entrypoints: {
      backend: "server.ts",
      surface: "surface.json",
    },
    runtime: {
      engine: "node24",
      memoryLimitMb: 256,
      maxStorageMb: 512,
      cpuTimeLimitSec: 60,
    },
    entitlements: {
      network: {
        mode: "airgap",
        allowedDomains: [],
      },
      mcpTools: [],
      storage: { sqlite: true, duckdb: false },
    },
    triggers: [
      {
        id: "market-poll",
        kind: "cron",
        expression: "*/5 * * * *",
        action: "pollMarket",
        maxDurationSec: 30,
      },
    ],
  };

  const installRes = await app.request(
    new Request("http://localhost/api/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest,
        files: {
          "server.ts": "// Application logic",
          "surface.json": JSON.stringify({
            title: "Portfolio Risk",
            nodes: [{ id: "root", type: "metric", props: { label: "VaR", value: "3.2%" } }],
          }),
        },
      }),
    })
  );
  assert.equal(installRes.status, 201);
  const installedApp = await installRes.json();
  assert.equal(installedApp.manifest.id, "portfolio-risk");
  assert.equal(installedApp.manifest.name, "Portfolio Risk Monitor");
  assert.ok(installedApp.storageBytes > 0);

  // 3. GET /api/apps - inventory listing
  const listRes = await app.request(new Request("http://localhost/api/apps"));
  assert.equal(listRes.status, 200);
  const appList = await listRes.json();
  assert.ok(Array.isArray(appList));
  assert.ok(appList.some((a: any) => a.id === "portfolio-risk"));

  // 4. GET /api/apps/portfolio-risk - single app details
  const getRes = await app.request(new Request("http://localhost/api/apps/portfolio-risk"));
  assert.equal(getRes.status, 200);
  const appDetails = await getRes.json();
  assert.equal(appDetails.manifest.id, "portfolio-risk");

  // 5. POST /api/apps/portfolio-risk/action - dispatch Canvas interactive action
  const actionRes = await app.request(
    new Request("http://localhost/api/apps/portfolio-risk/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controlId: "slider-risk-tolerance",
        value: 75,
        action: "updateWeights",
      }),
    })
  );
  assert.equal(actionRes.status, 200);
  const actionResult = await actionRes.json();
  assert.equal(actionResult.controlId, "slider-risk-tolerance");
  assert.equal(actionResult.value, 75);

  // 6. POST /api/apps/portfolio-risk/triggers/market-poll/run - manual trigger run
  const triggerRes = await app.request(
    new Request("http://localhost/api/apps/portfolio-risk/triggers/market-poll/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(triggerRes.status, 200);
  const triggerResult = await triggerRes.json();
  assert.equal(triggerResult.ok, true);
  assert.equal(triggerResult.action, "pollMarket");
  assert.ok(typeof triggerResult.durationMs === "number");

  // 7. GET /api/apps/portfolio-risk/state - check persisted state
  const stateRes = await app.request(new Request("http://localhost/api/apps/portfolio-risk/state"));
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.equal(state["slider-risk-tolerance"], 75);

  // 8. Fleet check & POST /api/admin/fleet/slots/:id/hibernate
  const fleetAfterLeaseRes = await app.request(new Request("http://localhost/api/admin/fleet"));
  const fleetAfterLease = await fleetAfterLeaseRes.json();
  const activeSlot = fleetAfterLease.slots.find((s: any) => s.tenantId === "portfolio-risk");
  assert.ok(activeSlot, "A worker slot must be leased for the portfolio-risk app");
  assert.equal(activeSlot.state, "active");

  const hibernateRes = await app.request(
    new Request(`http://localhost/api/admin/fleet/slots/${encodeURIComponent(activeSlot.slotId)}/hibernate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(hibernateRes.status, 200);
  const hibernateData = await hibernateRes.json();
  assert.equal(hibernateData.ok, true);

  // 9. Workstation physical lifecycle endpoints: suspend and wake
  const suspendRes = await app.request(
    new Request("http://localhost/api/admin/lifecycle/suspend", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(suspendRes.status, 200);
  const suspendData = await suspendRes.json();
  assert.equal(suspendData.status, "suspended");

  const wakeRes = await app.request(
    new Request("http://localhost/api/admin/lifecycle/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(wakeRes.status, 200);
  const wakeData = await wakeRes.json();
  assert.equal(wakeData.status, "reconciled");

  // 10. DELETE /api/apps/portfolio-risk - uninstall app
  const deleteRes = await app.request(
    new Request("http://localhost/api/apps/portfolio-risk", { method: "DELETE" })
  );
  assert.equal(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.equal(deleteData.ok, true);
  assert.equal(deleteData.id, "portfolio-risk");

  // 11. GET /api/apps/portfolio-risk should now return 404
  const notFoundRes = await app.request(new Request("http://localhost/api/apps/portfolio-risk"));
  assert.equal(notFoundRes.status, 404);

  // 12. GET /api/admin/telemetry/stream - SSE connection and initial snapshot test
  const sseRes = await app.request(new Request("http://localhost/api/admin/telemetry/stream"));
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get("content-type"), "text/event-stream");
  const reader = sseRes.body?.getReader();
  assert.ok(reader);
  const chunk = await reader.read();
  assert.ok(!chunk.done);
  const text = new TextDecoder().decode(chunk.value);
  assert.match(text, /data: .*"snapshot"/);
  await reader.cancel();

  // 13. GET /api/admin/logs/stream - SSE log stream connection test
  const logsRes = await app.request(new Request("http://localhost/api/admin/logs/stream"));
  assert.equal(logsRes.status, 200);
  assert.equal(logsRes.headers.get("content-type"), "text/event-stream");
  const logsReader = logsRes.body?.getReader();
  assert.ok(logsReader);
  await logsReader.cancel();
});
