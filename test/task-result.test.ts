import assert from "node:assert/strict";
import { test } from "node:test";
import { basicCatalog, SurfaceStore, type AgentEvent } from "@vak/core";
import { runAgent, type Provider } from "@vak/providers";
import { checkTaskResult, parseTaskResultPolicy, reviewTaskResult } from "../task-result.ts";

function result(tableId: string, rows: unknown[], columns: (string | { key: string; label: string })[]) {
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
  assert.deepEqual(reviewTaskResult(policy, good, sources), { issues: [], response: "Ready for review." });
  assert.ok(reviewTaskResult(policy, good, new Map()).issues.length);
});
test("result policy boundaries reject unbounded, insecure or malformed manifests", () => {
  for (const value of [{ kind: "unknown" }, { kind: "research", urls: [] }, { kind: "research", sources: [] }, { kind: "research", sources: ["http://localhost"] }, { kind: "research", sources: ["https://user:pass@example.com"] }, { kind: "comparison", labels: Array(17).fill("option") }]) assert.throws(() => parseTaskResultPolicy(value));
  assert.deepEqual(parseTaskResultPolicy({ kind: "research", sources: ["https://example.com", "https://example.com/"] }), { kind: "research", sources: ["https://example.com/"] });
});


test("valid task output reaches review once without publishing an unverified provider summary", async () => {
  const supplied = result("comparison", [{ label: "Atlas" }, { label: "Birch" }], ["label"]);
  const store = new SurfaceStore(basicCatalog);
  supplied.surfaces.forEach((surface) => store.load(surface));
  const events: AgentEvent[] = [];
  let requests = 0;
  const provider: Provider = { id: "scripted", async *stream() { requests++; yield { type: "text", delta: "All results are independently verified." }; yield { type: "done", stop: "end" }; } };
  const output = await runAgent({ provider, model: "test", store, messages: [{ role: "user", content: "Review" }], completion: "response", maxSteps: 3, validateCompletion: (candidate) => reviewTaskResult({ kind: "comparison", labels: ["Atlas", "Birch"] }, candidate, new Map()), emit: (event) => events.push(event) });
  assert.equal(output.stop, "end"); assert.equal(requests, 1);
  assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""), "Ready for review.");
  assert.deepEqual(store.snapshot("criteria")!.data, { budget: 20 });
});


test("surplus-output feedback names obsolete surfaces while preserving the valid independent outputs", () => {
  const candidate = result("author-table", [{ name: "Atlas" }, { name: "Birch" }], ["name"]);
  const store = new SurfaceStore(basicCatalog);
  store.apply("vak_render", { surface: "old-combined", nodes: [{ id: "root", type: "stack", children: [{ id: "old", type: "text", props: { content: "Prior attempt" } }] }] });
  candidate.surfaces.unshift(store.snapshot("old-combined")!); candidate.resolved.unshift(store.resolve("old-combined")!);
  const issues = checkTaskResult({ kind: "comparison", labels: ["Atlas", "Birch"] }, candidate, new Map());
  assert.ok(issues.some((issue) => issue.includes('Keep the separate form "criteria" and table "author-table"')));
  assert.ok(issues.some((issue) => issue.includes('[{"surface":"old-combined"}]')));
});


test("independent form/table surfaces may have layout wrappers but combined outputs remain invalid", () => {
  const supplied = result("comparison", [{ label: "Atlas" }, { label: "Birch" }], ["label"]);
  for (const surface of supplied.resolved) {
    const child = surface.root!;
    surface.root = { id: "wrapper", key: "wrapper", type: "stack", props: {}, children: [child] };
  }
  const policy = { kind: "comparison" as const, labels: ["Atlas", "Birch"] };
  assert.deepEqual(checkTaskResult(policy, supplied, new Map()), []);
  supplied.resolved[0]!.root!.children.push(supplied.resolved[1]!.root!.children[0]!);
  assert.ok(checkTaskResult(policy, supplied, new Map()).some((issue) => issue.includes("two separate surfaces")));
});

test("comparison checks expose missing displayed field values without guessing numeric facts", () => {
  const candidate = result("comparison", [{ name: "Atlas", cost: 12, recommendation: "" }, { name: "Birch", cost: 18, recommendation: "" }], ["name", "monthly_cost", "recommendation"].map((key) => ({ key, label: key })));
  const policy = { kind: "comparison" as const, labels: ["Atlas", "Birch"] };
  const issues = checkTaskResult(policy, candidate, new Map());
  assert.ok(issues.some((issue) => issue.includes('["monthly_cost","recommendation"]') && issue.includes('["name","cost","recommendation"]')));
  assert.ok(issues.every((issue) => !issue.includes('"monthly_cost":12')));
  const explicit = result("comparison", [{ name: "Atlas", monthly_cost: "Unknown", recommendation: "Not evaluated" }, { name: "Birch", monthly_cost: 0, recommendation: false }], ["name", "monthly_cost", "recommendation"]);
  assert.deepEqual(checkTaskResult(policy, explicit, new Map()), []);
});

test("user-supplied notices must be visible; metadata and negated word fragments do not count", () => {
  const policy = parseTaskResultPolicy({ kind: "comparison", labels: ["Atlas", "Birch"], notices: [" Fictional "] });
  assert.deepEqual(policy.notices, ["Fictional"]);
  const candidate = result("comparison", [{ label: "Atlas" }, { label: "Birch" }], ["label"]);
  candidate.resolved[1]!.data.notice = "Fictional";
  candidate.resolved[1]!.title = "Nonfictional comparison";
  assert.ok(checkTaskResult(policy, candidate, new Map()).some((issue) => issue.includes("user-supplied notice")));
  candidate.resolved[1]!.title = "Comparison — Fictional data";
  assert.deepEqual(checkTaskResult(policy, candidate, new Map()), []);
});

test("visible notices are optional, bounded and supported for either checked layout", () => {
  for (const notices of [[], [""], ["x".repeat(121)], Array(9).fill("Notice"), "Fictional"]) assert.throws(() => parseTaskResultPolicy({ kind: "comparison", notices }));
  assert.deepEqual(parseTaskResultPolicy({ kind: "research", notices: ["Unverified", "Unverified"] }), { kind: "research", notices: ["Unverified"] });
});
