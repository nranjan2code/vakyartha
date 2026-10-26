import assert from "node:assert/strict";
import { test } from "node:test";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { checkTaskResult, parseTaskResultPolicy } from "../task-result.ts";

function result(tableId: string, rows: unknown[], columns: string[]) {
  const store = new SurfaceStore(basicCatalog);
  store.apply("vak_render", { surface: "criteria", data: { budget: 20 }, nodes: [{ id: "root", type: "form", props: { submit: "apply" }, children: [{ id: "budget", type: "input", props: { label: "Budget", kind: "number", bind: "/budget" } }] }] });
  store.apply("vak_render", { surface: tableId, data: { rows }, nodes: [{ id: "root", type: "table", props: { columns, rows: "{/rows}" } }] });
  return { surfaces: store.list().map((s) => store.snapshot(s.id)!), resolved: store.list().map((s) => store.resolve(s.id)!), response: "Ready for review." };
}
test("comparison completion requires distinct editable/table outputs and all declared visible identities", () => {
  const policy = parseTaskResultPolicy({ kind: "comparison", labels: ["Atlas", "Birch"] });
  assert.deepEqual(checkTaskResult(policy, result("comparison", [{ label: "Atlas" }, { label: "Birch" }], ["label"]), new Map()), []);
  assert.ok(checkTaskResult(policy, result("comparison", [{ cost: 12 }], ["cost"]), new Map()).some((message) => message.includes("option names")));
  assert.deepEqual(checkTaskResult(policy, result("custom-table-id", [{ name: "Atlas" }, { name: "Birch" }], ["name"]), new Map()), []);
  const combined = result("comparison", [{ label: "Atlas" }], ["label"]); combined.surfaces.shift(); combined.resolved.shift();
  assert.ok(checkTaskResult(policy, combined, new Map()).some((message) => message.includes("two separate surfaces")));
});
test("research completion rejects failed/missing reads, invented quotes, scope gaps and unsupported output columns", () => {
  const urls = ["https://one.example/page", "https://two.example/page"], quote = "These are exact words returned by a successful source read.";
  const policy = parseTaskResultPolicy({ kind: "research", sources: urls });
  const good = result("evidence", urls.map((source) => ({ source, quote })), ["source", "quote"]);
  const sources = new Map(urls.map((url) => [url, quote]));
  assert.deepEqual(checkTaskResult(policy, good, sources), []);
  assert.ok(checkTaskResult(policy, good, new Map()).length);
  assert.ok(checkTaskResult(policy, result("evidence", [{ source: urls[0], quote: "This invented claim does not occur in the actual source response." }], ["source", "quote"]), sources).some((issue) => issue.includes("verbatim")));
  assert.ok(checkTaskResult(policy, result("evidence", [{ source: urls[0], quote }], ["source", "quote", "conclusion"]), sources).some((issue) => issue.includes("unsupported conclusions")));
  good.response = "Both websites guarantee production availability.";
  assert.ok(checkTaskResult(policy, good, sources).some((issue) => issue.includes("unverified prose")));
});
test("result policy boundaries reject unbounded, insecure or malformed manifests", () => {
  for (const value of [{ kind: "unknown" }, { kind: "research", urls: [] }, { kind: "research", sources: [] }, { kind: "research", sources: ["http://localhost"] }, { kind: "research", sources: ["https://user:pass@example.com"] }, { kind: "comparison", labels: Array(17).fill("option") }]) assert.throws(() => parseTaskResultPolicy(value));
  assert.deepEqual(parseTaskResultPolicy({ kind: "research", sources: ["https://example.com", "https://example.com/"] }), { kind: "research", sources: ["https://example.com/"] });
});
