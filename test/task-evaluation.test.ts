import { COMPARISON_FIXTURE, comparisonReference, comparisonReview, evaluationVerdict } from "../scripts/evaluation-reference.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@vak/host";
import { boundFieldValues, resultText, separateFormAndTable, tableOutputText } from "../scripts/evaluation-checks.ts";

test("outcome checks never treat the user's requested facts as result evidence", () => {
  const view: SessionView = { id: "test", title: "", updated: "", surfaces: [], timeline: [{ kind: "user", text: "Expected marker and source URL", at: "2026-10-26T00:00:00Z" }] };
  assert.equal(resultText(view).includes("Expected marker"), false);
});
test("a combined form/table plus an unrelated surface is not independent interactive output", () => {
  const view: SessionView = { id: "test", title: "", updated: "", timeline: [], surfaces: [
    { id: "combined", version: 1, data: {}, nodes: [{ id: "root", type: "stack", children: ["form", "table"] }, { id: "form", type: "form" }, { id: "table", type: "table" }] },
    { id: "heading", version: 1, data: {}, nodes: [{ id: "title", type: "text" }] },
  ] };
  assert.equal(separateFormAndTable(view), false);
  view.surfaces[1]!.nodes = [{ id: "root", type: "table" }];
  assert.equal(separateFormAndTable(view), false);
  view.surfaces[0]!.nodes[0]!.children = ["form"];
  assert.equal(separateFormAndTable(view), true);
});


test("unused identity fields and prose cannot hide missing visible table row labels", () => {
  const view: SessionView = { id: "test", title: "", updated: "", timeline: [], surfaces: [{ id: "table", version: 1, data: { options: [{ name: "Atlas", cost: 12 }] }, nodes: [{ id: "root", type: "table", props: { rows: "{/options}", columns: [{ key: "cost", label: "Cost" }] } }] }] };
  assert.equal(tableOutputText(view).includes("Atlas"), false);
  view.surfaces[0]!.nodes[0]!.props!.columns = [{ key: "name", label: "Option" }, { key: "cost", label: "Cost" }];
  assert.equal(tableOutputText(view).includes("Atlas"), true);
});

test("criterion defaults must exist at the control binding, not elsewhere in surface data", () => {
  const view: SessionView = { id: "test", title: "", updated: "", timeline: [], surfaces: [{ id: "criteria", version: 1, data: { expectedBudget: 20, form: {} }, nodes: [{ id: "budget", type: "input", props: { label: "Budget", bind: "/form/budget" } }] }] };
  assert.deepEqual(boundFieldValues(view), [{ label: "Budget", value: undefined }]);
  view.surfaces[0]!.data = { form: { budget: 20 } };
  assert.deepEqual(boundFieldValues(view), [{ label: "Budget", value: 20 }]);
});


test("comparison references derive budget, capacity and per-seat facts independently", () => {
  assert.deepEqual(comparisonReference(COMPARISON_FIXTURE).map(({ name, costPerSeat, withinBudget, enoughSeats, meetsBoth }) => ({ name, costPerSeat, withinBudget, enoughSeats, meetsBoth })), [
    { name: "Atlas", costPerSeat: 3, withinBudget: true, enoughSeats: false, meetsBoth: false },
    { name: "Birch", costPerSeat: 2.25, withinBudget: true, enoughSeats: true, meetsBoth: true },
  ]);
  const changed = comparisonReference({ options: [{ name: "Other", monthlyCost: 24, seats: 6 }], budget: 20, minimumSeats: 6 });
  assert.equal(changed[0]!.meetsBoth, false); assert.equal(changed[0]!.enoughSeats, true);
  for (const seats of [0, -1, 1.5, Infinity]) assert.throws(() => comparisonReference({ ...COMPARISON_FIXTURE, options: [{ name: "Other", monthlyCost: 12, seats }] }));
});

test("the retained contradictory recommendation stays visible for review and cannot get a passing verdict", () => {
  // Retained local trial 07965ef6: numbers were right, the Atlas recommendation was wrong.
  const view: SessionView = { id: "retained", title: "", updated: "", timeline: [], surfaces: [{ id: "comparison", version: 1, data: { ignored: "All recommendations are correct" }, nodes: [{ id: "root", type: "table", props: { columns: ["name", "cost", "seats", "perSeat", "recommendation"], rows: [{ name: "Atlas", cost: 12, seats: 4, perSeat: 3, recommendation: "Exceeds seats; better value" }, { name: "Birch", cost: 18, seats: 8, perSeat: 2.25, recommendation: "Meets both criteria" }] } }] }] };
  const review = comparisonReview(view, COMPARISON_FIXTURE);
  assert.equal(review.options[0]!.expected.enoughSeats, false);
  assert.equal(review.options[0]!.displayedRows[0]![4], "Exceeds seats; better value");
  assert.equal(JSON.stringify(review).includes("All recommendations are correct"), false);
  assert.equal(evaluationVerdict({ numeric: true, labels: true, defaults: true }), "needs-semantic-review");
  assert.equal(evaluationVerdict({ numeric: false }), "failed");
  assert.equal(evaluationVerdict({}), "failed");
});


test("hidden and unreachable nodes cannot supply evaluation facts or criterion defaults", () => {
  const view: SessionView = { id: "visibility", title: "", updated: "", timeline: [], surfaces: [{ id: "result", version: 1, data: { hidden: "Fictional", budget: 20 }, nodes: [
    { id: "root", type: "stack", children: ["hidden-table"] },
    { id: "hidden-table", type: "table", props: { visibleIf: false, columns: ["name"], rows: [{ name: "Atlas" }] } },
    { id: "orphan", type: "input", props: { label: "Budget", bind: "/budget" } },
  ] }] };
  assert.deepEqual(comparisonReview(view, COMPARISON_FIXTURE).options[0]!.displayedRows, []);
  assert.deepEqual(boundFieldValues(view), []);
  assert.equal(resultText(view).includes("Fictional"), false);
});
