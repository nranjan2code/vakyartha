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
    { id: "combined", version: 1, data: {}, nodes: [{ id: "form", type: "form" }, { id: "table", type: "table" }] },
    { id: "heading", version: 1, data: {}, nodes: [{ id: "title", type: "text" }] },
  ] };
  assert.equal(separateFormAndTable(view), false);
  view.surfaces[1]!.nodes.push({ id: "separate-table", type: "table" });
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
