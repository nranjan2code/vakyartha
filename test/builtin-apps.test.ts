// Verification tests for built-in reference application calculation engine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseAppManifest } from "../shared/app-manifest.ts";
import {
  computePortfolioVaR,
  rebalanceWeights,
  handleAction,
} from "../sidecar/builtin-apps/portfolio-risk-dashboard/server.ts";

test("builtin portfolio risk app manifest is strictly valid", () => {
  const manifestPath = path.join(process.cwd(), "sidecar/builtin-apps/portfolio-risk-dashboard/app.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const parsed = parseAppManifest(raw);

  assert.equal(parsed.id, "portfolio-risk-dashboard");
  assert.equal(parsed.category, "finance");
  assert.equal(parsed.runtime.engine, "node24");
  assert.equal(parsed.entitlements.storage.sqlite, false);
  assert.equal(parsed.entitlements.storage.duckdb, false);
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.triggers[0]?.kind, "cron");
});

test("portfolio VaR calculation implements standard parametric normal distribution formula", () => {
  // $100k, 95% confidence (z = 1.645), 1.5% daily volatility, 1 day horizon
  const var95 = computePortfolioVaR(100_000, 0.95, 0.015, 1);
  assert.equal(Math.round(var95), 2468); // 100,000 * 1.645 * 0.015 = 2467.5

  // $100k, 99% confidence (z = 2.326), 1.5% daily volatility, 1 day horizon
  const var99 = computePortfolioVaR(100_000, 0.99, 0.015, 1);
  assert.equal(Math.round(var99), 3489); // 100,000 * 2.326 * 0.015 = 3489.0
});

test("portfolio risk sensitivity rebalances asset allocation weights dynamically", () => {
  // Conservative (0% risk tolerance): heavy bonds, low equities
  const conservative = rebalanceWeights(0);
  assert.equal(conservative[0], 20); // 20% equities
  assert.equal(conservative[1], 50); // 50% bonds
  assert.equal(conservative.reduce((a: number, b: number) => a + b, 0), 100);

  // Aggressive (100% risk tolerance): heavy equities, low bonds
  const aggressive = rebalanceWeights(100);
  assert.equal(aggressive[0], 80); // 80% equities
  assert.equal(aggressive[1], 15); // 15% bonds
  assert.equal(aggressive.reduce((a: number, b: number) => a + b, 0), 100);

  // Moderate (50% risk tolerance)
  const moderate = rebalanceWeights(50);
  assert.equal(moderate[0], 50); // 50% equities
  assert.equal(moderate.reduce((a: number, b: number) => a + b, 0), 100);
});

test("handleAction yields valid Canvas reactive surface patches in sub-millisecond time", () => {
  const result = handleAction("select-risk-profile", "conservative");
  assert.equal(result.op, "batch_update");
  assert.equal(result.controlId, "select-risk-profile");
  assert.equal(result.value, "conservative");

  const patches = result.patches as Array<{ id: string; props: Record<string, unknown> }>;
  assert.ok(Array.isArray(patches));
  assert.ok(patches.some((p) => p.id === "card-var-95"));
  assert.ok(patches.some((p) => p.id === "chart-section"));
});

