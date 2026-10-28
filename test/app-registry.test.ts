import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppRegistry, isCronMatch } from "../sidecar/sandbox-pool/app-registry.ts";
import { SandboxPoolManager } from "../sidecar/sandbox-pool/pool-manager.ts";

test("cron matching handles wildcard, step, list and exact minute matches", () => {
  // Test: At minute 15 on every hour
  const d1 = new Date(2026, 9, 28, 14, 15, 0); // 14:15
  assert.equal(isCronMatch("15 * * * *", d1), true);

  const d2 = new Date(2026, 9, 28, 14, 16, 0); // 14:16
  assert.equal(isCronMatch("15 * * * *", d2), false);

  // Test: Every 5 minutes (*/5)
  assert.equal(isCronMatch("*/5 * * * *", new Date(2026, 9, 28, 14, 25, 0)), true);
  assert.equal(isCronMatch("*/5 * * * *", new Date(2026, 9, 28, 14, 26, 0)), false);

  // Test: List (0,30)
  assert.equal(isCronMatch("0,30 * * * *", new Date(2026, 9, 28, 14, 30, 0)), true);
  assert.equal(isCronMatch("0,30 * * * *", new Date(2026, 9, 28, 14, 31, 0)), false);
});

test("app registry installs, lists, executes actions, runs triggers and uninstalls apps", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-registry-test-"));
  const pool = new SandboxPoolManager({
    maxActiveWorkers: 2,
    standbyWorkers: 1,
  });

  const registry = new AppRegistry({ dataDir: tmp, pool });

  t.after(async () => {
    registry.shutdown();
    await pool.shutdown(2000);
    rmSync(tmp, { recursive: true, force: true });
  });

  await pool.start();
  await registry.init();

  // 1. Initially no apps
  assert.equal(registry.listApps().length, 0);

  // 2. Install a dynamic app
  const app = await registry.installApp(
    {
      id: "risk-dashboard",
      name: "Risk Dashboard",
      version: "1.0.0",
      description: "Interactive portfolio risk dashboard",
      author: "Nisheeth",
      category: "finance",
      icon: "chart",
      entrypoints: {
        backend: "server.ts",
        surface: "surface.json",
      },
      runtime: {
        engine: "node24",
        memoryLimitMb: 128,
        cpuTimeLimitSec: 30,
        maxStorageMb: 256,
      },
      entitlements: {
        network: { mode: "brokered", allowedDomains: ["api.risk.com"] },
        mcpTools: [],
        storage: { sqlite: true },
      },
      triggers: [
        {
          id: "hourly-calc",
          kind: "cron",
          expression: "0 * * * *",
          action: "recalculateRisk",
          maxDurationSec: 30,
        },
      ],
    },
    {
      "server.ts": "// backend code\nexport function calculate() { return 42; }",
      "surface.json": JSON.stringify({ type: "dashboard", title: "Risk Live" }),
    }
  );

  assert.equal(app.manifest.id, "risk-dashboard");
  assert.ok(app.storageBytes > 0, "Storage bytes should be greater than 0");
  assert.equal(app.surface?.title, "Risk Live");

  // 3. List apps
  const list = registry.listApps();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "risk-dashboard");
  assert.equal(list[0]?.category, "finance");

  // 4. Dispatch action to the app
  const patch = await registry.dispatchAction("risk-dashboard", "slider-volatility", 0.25, "slide");
  assert.equal(patch.controlId, "slider-volatility");
  assert.equal(patch.value, 0.25);

  // Verify app is now running in pool
  const runningDetails = registry.getApp("risk-dashboard");
  assert.equal(runningDetails?.isRunning, true);

  // 5. Run declared trigger
  const trigResult = await registry.runTrigger("risk-dashboard", "hourly-calc");
  assert.equal(trigResult.ok, true);
  assert.equal(trigResult.action, "recalculateRisk");

  // 6. Delete app
  const deleted = await registry.deleteApp("risk-dashboard");
  assert.equal(deleted, true);
  assert.equal(registry.listApps().length, 0);
  assert.ok(!existsSync(path.join(tmp, "apps", "risk-dashboard")));
});

