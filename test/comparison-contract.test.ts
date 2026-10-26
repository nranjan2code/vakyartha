import assert from "node:assert/strict";
import { test } from "node:test";
import { checkComparisonContract, comparisonExpectedRows, parseComparisonContract, reviseComparisonCriteria } from "../comparison-contract.ts";
import { parseTaskResultPolicy, reviewTaskResult } from "../task-result.ts";
import { COMPARISON_FIXTURE, comparisonClaimContract, interactiveComparisonContract } from "../scripts/evaluation-reference.ts";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { runAgent, type Provider } from "@vak/providers";

const contract = comparisonClaimContract(COMPARISON_FIXTURE);
const columns = Object.keys(contract.rows[0]!).map((key) => ({ key, label: key }));

test("typed calculations use submitted criteria and reject unsafe, unbounded or invalid expressions", () => {
  const original = interactiveComparisonContract(COMPARISON_FIXTURE);
  const changed = reviseComparisonCriteria(original, { budget: 10, seats: 8 });
  assert.deepEqual(changed.rows, original.rows);
  assert.deepEqual(changed.calculations, original.calculations);
  assert.deepEqual(comparisonExpectedRows(changed).map((row) => [row.within_budget, row.enough_seats, row.meets_both]), [[false, false, false], [false, true, false]]);
  assert.deepEqual(original.criteria, { budget: 20, seats: 6 });
  for (const criteria of [{ budget: 10 }, { budget: "10", seats: 8 }, { budget: NaN, seats: 8 }, { budget: 10, seats: 8, other: 1 }]) assert.throws(() => reviseComparisonCriteria(original, criteria));
  for (const expression of [{ criterion: "missing" }, { column: "missing" }, { op: "eval", args: [1, 2] }, { op: "divide", args: [1, 0] }, { op: "and", args: [1, true] }, { op: "gte", args: [{ column: "option" }, 1] }, { op: "lte", args: [1, 2], extra: true }]) assert.throws(() => parseComparisonContract({ ...original, calculations: { computed: expression } }));
  let deep: unknown = 1;
  for (let i = 0; i < 8; i++) deep = { op: "divide", args: [deep, 1] };
  assert.throws(() => parseComparisonContract({ ...original, calculations: { computed: deep } }));
  assert.throws(() => parseComparisonContract({ ...original, calculations: { option: 1 } }));
  const changedRows = comparisonExpectedRows(changed);
  assert.deepEqual(checkComparisonContract(changed, { columns: Object.keys(changedRows[0]!), rows: changedRows }), []);
  assert.ok(checkComparisonContract(changed, { columns: Object.keys(changedRows[0]!), rows: comparisonExpectedRows(original) }).length);
});

test("formal visible claims match the independent arithmetic and constraints", () => {
  assert.deepEqual(checkComparisonContract(contract, { columns, rows: contract.rows }), []);
  const wrong = structuredClone(contract.rows); wrong[0]!.enough_seats = true;
  assert.ok(checkComparisonContract(contract, { columns, rows: wrong }).some((issue) => issue.includes('"Atlas" column "enough_seats"') && issue.includes("false (boolean)")));
  const strings = structuredClone(contract.rows); strings[0]!.within_budget = "true";
  assert.ok(checkComparisonContract(contract, { columns, rows: strings }).length);
  const reversed = [...columns].reverse();
  assert.deepEqual(checkComparisonContract(contract, { columns: reversed, rows: contract.rows.map((row) => reversed.map(({ key }) => row[key])) }), []);
  for (const rows of [contract.rows.slice(1), [...contract.rows, contract.rows[0]], [{ ...contract.rows[0], option: "Other" }, contract.rows[1]]]) assert.ok(checkComparisonContract(contract, { columns, rows }).length);
  assert.ok(checkComparisonContract(contract, { columns: columns.slice(1), rows: contract.rows }).length);
});

test("contract parsing rejects malformed, oversized or inconsistent assertions and policy mismatches", () => {
  for (const value of [null, { ...contract, extra: true }, { ...contract, identityColumn: "__proto__" }, { ...contract, rows: [] }, { ...contract, rows: [contract.rows[0], contract.rows[0]] }, { identityColumn: "id", rows: [{ id: "a", n: NaN }] }, { identityColumn: "id", rows: [{ id: "a", n: null }] }, { identityColumn: "id", rows: [{ id: "a", n: 1 }, { id: "b" }] }, { identityColumn: "id", rows: [{ id: "a", n: "x".repeat(501) }] }, { identityColumn: "id", rows: Array.from({ length: 17 }, (_, i) => ({ id: String(i) })) }]) assert.throws(() => parseComparisonContract(value));
  for (const value of [
    { identityColumn: "id", rows: [{ id: "a", "bad/key": 1 }] },
    { identityColumn: "id", rows: [{ id: "a", ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, i])) }] },
    { identityColumn: "id", rows: Array.from({ length: 16 }, (_, i) => ({ id: String(i), ...Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`n${j}`, j])) })) },
    { identityColumn: "id", rows: Array.from({ length: 16 }, (_, i) => ({ id: String(i), a: "x".repeat(500), b: "y".repeat(500) })) },
  ]) assert.throws(() => parseComparisonContract(value));
  assert.throws(() => parseTaskResultPolicy({ kind: "research", table: contract }));
  assert.throws(() => parseTaskResultPolicy({ kind: "comparison", labels: ["Other"], table: contract }));
  assert.deepEqual(parseTaskResultPolicy({ kind: "comparison", labels: ["Atlas", "Birch"], table: contract }).kind, "comparison");
  assert.deepEqual(checkComparisonContract(parseComparisonContract({ identityColumn: "id", rows: [{ id: "a", n: 0, ok: false }] }), { columns: ["id", "n", "ok"], rows: [["a", 0, false]] }), []);
});

test("failed exact claims repair in the same bounded run; unused expected data cannot satisfy them", async () => {
  const store = new SurfaceStore(basicCatalog), policy = parseTaskResultPolicy({ kind: "comparison", labels: ["Atlas", "Birch"], table: contract });
  store.apply("vak_render", { surface: "criteria", nodes: [{ id: "root", type: "form", children: [{ id: "budget", type: "input", props: { bind: "/budget", label: "Budget" } }] }], data: { budget: 20 } });
  const wrong = structuredClone(contract.rows); wrong[0]!.enough_seats = true;
  store.apply("vak_render", { surface: "table", nodes: [{ id: "root", type: "table", props: { columns, rows: wrong } }], data: { correctButUnused: contract.rows } });
  let requests = 0;
  const provider: Provider = { id: "scripted", async *stream(req) {
    const step = requests++;
    if (step === 1) {
      assert.match(req.messages.at(-1)!.content, /enough_seats/);
      yield { type: "tool_start", id: "fix", name: "vak_update" };
      yield { type: "tool_args", id: "fix", delta: JSON.stringify({ surface: "table", nodes: [{ id: "root", props: { rows: contract.rows } }] }) };
      yield { type: "tool_end", id: "fix" }; yield { type: "done", stop: "tool_use" }; return;
    }
    yield { type: "text", delta: "Ready" }; yield { type: "done", stop: "end" };
  } };
  const output = await runAgent({ provider, model: "test", store, messages: [{ role: "user", content: "Check the declared claims" }], completion: "response", maxSteps: 3, validateCompletion: (result) => reviewTaskResult(policy, result, new Map()), emit: () => {} });
  assert.equal(output.stop, "end"); assert.equal(requests, 3);
  assert.equal(store.resolve("table")!.root!.props.rows instanceof Array, true);
});
