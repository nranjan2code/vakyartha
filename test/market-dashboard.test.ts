import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { basicCatalog, prepareSubmission } from "@vak/core";

const template = JSON.parse(readFileSync(new URL("../sidecar/builtin-skills/market-dashboard/references/market-dashboard-example.json", import.meta.url), "utf8"));

test("market reference is a valid reusable Projection shape with one dated data owner", () => {
  const admitted = prepareSubmission(basicCatalog, [], template);
  assert.deepEqual(admitted.issues, []);
  const surface = admitted.store!.resolve("illustrative-market-review")!;
  const nodes = [surface.root!, ...(surface.root?.children ?? []).flatMap(function visit(node): unknown[] { return [node, ...(node.children ?? []).flatMap(visit)]; })] as { type: string; props: Record<string, unknown> }[];
  const data = template.surfaces[0].data;
  assert.equal(data.history.length, 5);
  assert.ok(Math.abs((data.history.at(-1).close / data.history[0].close - 1) * 100 - data.summary.weekPriceReturnPercent) < 1e-9);
  assert.deepEqual(nodes.find(node => node.type === "chart")?.props.labels, data.history.map((row: { date: string }) => row.date));
  assert.deepEqual(nodes.find(node => node.type === "table")?.props.rows, data.history.map((row: { date: string; close: number }) => [row.date, row.close]));
  assert.equal(nodes.find(node => node.type === "table")?.props.totals, false);
  assert.match(String(nodes.find(node => node.type === "text" && String(node.props.content).includes("rose"))?.props.content), /fictional figures/);
});
