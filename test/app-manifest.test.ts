import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppManifest } from "../shared/app-manifest.ts";

test("app manifest parses valid configuration with bounded runtime defaults", () => {
  const manifest = parseAppManifest({
    id: "portfolio-tracker",
    version: "1.0.0",
    name: "Portfolio Tracker",
    description: "Live stock analytics calculation engine",
    author: "Nisheeth",
    category: "finance",
    entrypoints: {
      backend: "server.ts",
      surface: "canvas.json",
    },
    runtime: {
      engine: "node24",
      memoryLimitMb: 256,
      cpuTimeLimitSec: 60,
      maxStorageMb: 512,
    },
    entitlements: {
      network: {
        mode: "brokered",
        allowedDomains: ["api.coingecko.com", "finance.yahoo.com"],
      },
      mcpTools: ["nse-market-data"],
      storage: { sqlite: true, duckdb: false },
    },
    triggers: [
      {
        id: "daily-sync",
        kind: "cron",
        expression: "0 9 * * *",
        action: "syncPortfolio",
        maxDurationSec: 45,
      },
    ],
  });

  assert.equal(manifest.id, "portfolio-tracker");
  assert.equal(manifest.name, "Portfolio Tracker");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.category, "finance");
  assert.equal(manifest.entrypoints.backend, "server.ts");
  assert.equal(manifest.entrypoints.surface, "canvas.json");
  assert.equal(manifest.runtime.engine, "node24");
  assert.equal(manifest.runtime.memoryLimitMb, 256);
  assert.deepEqual(manifest.entitlements.network.allowedDomains, ["api.coingecko.com", "finance.yahoo.com"]);
  assert.equal(manifest.triggers[0]?.expression, "0 9 * * *");
});

test("app manifest rejects invalid id or missing name", () => {
  assert.throws(() => parseAppManifest({ id: "Invalid ID with spaces", name: "Test" }), /Invalid app id/);
  assert.throws(() => parseAppManifest({ id: "valid-id", name: "" }), /App name is required/);
  assert.throws(() => parseAppManifest({ id: "valid-id", name: "Valid", version: "not-semver" }), /Invalid semver version/);
});

test("app manifest strictly refuses directory traversal in entrypoints and triggers", () => {
  assert.throws(
    () =>
      parseAppManifest({
        id: "traversal-app",
        name: "Traversal",
        version: "1.0.0",
        entrypoints: { backend: "../../../etc/passwd" },
      }),
    /safe relative path without directory traversal/
  );

  assert.throws(
    () =>
      parseAppManifest({
        id: "traversal-app",
        name: "Traversal",
        version: "1.0.0",
        entrypoints: { backend: "/absolute/path/index.js" },
      }),
    /safe relative path without directory traversal/
  );
});

test("app manifest clamps runaway memory and storage quotas within platform bounds", () => {
  const manifest = parseAppManifest({
    id: "clamped-app",
    name: "Clamped",
    version: "1.0.0",
    entrypoints: { backend: "index.js" },
    runtime: {
      memoryLimitMb: 100_000, // Excessive
      maxStorageMb: 50_000,   // Excessive
      cpuTimeLimitSec: 3600,  // Excessive
    },
  });

  assert.equal(manifest.runtime.memoryLimitMb, 1024); // Clamped to 1024 MiB
  assert.equal(manifest.runtime.maxStorageMb, 2048);  // Clamped to 2048 MiB
  assert.equal(manifest.runtime.cpuTimeLimitSec, 300); // Clamped to 300s
});

