import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedTableSources } from "../sidecar/csv-source.ts";

test("selected CSV facts parse independently of presentation, preserving strings and source identity", () => {
  const input = { name: "selected.csv", content: 'item,quantity,price,code\r\n"A, B",3,12,001\r\n"Two ""quoted""\nlines",2,17,$5\r\n' };
  const source = selectedTableSources([input]).file_1!;
  assert.deepEqual(source.columns, ["item", "quantity", "price", "code"]);
  assert.deepEqual(source.rows, [["A, B", 3, 12, "001"], ['Two "quoted"\nlines', 2, 17, "$5"]]);
  assert.equal(source.filename, input.name); assert.equal(source.sha256.length, 64);
  assert.deepEqual(selectedTableSources([{ name: "notes.md", content: "No data permission added" }]), {});
});
test("malformed or unbounded CSV fails before generation instead of inventing source values", () => {
  for (const content of ['a,a\n1,2', 'a,b\n1', 'a,b\n"unclosed,2', 'a,b\n"one"tail,2', 'a,b\nhello"world,2', ',b\n1,2', 'a,b\n', Array(34).fill("column").join(",") + "\n1"]) assert.throws(() => selectedTableSources([{ name: "bad.csv", content }]));
});

test("declared summary identity and source notices are carried without synthesizing facts", () => {
  const input = { name: "data.csv", content: "item,value\nA,12\nB,17\n" }, notes = { name: "notes.md", content: "Fictional captured input. Missing information is unverified." };
  const source = selectedTableSources([input, notes], ["Fictional"], ["A", "B", "All items"]).file_1!;
  assert.equal(source.totalLabel, "All items");
  assert.deepEqual(source.notices, ["Fictional"]);
  assert.equal(source.context![0]!.content, notes.content);
  assert.deepEqual(source.rows, [["A", 12], ["B", 17]]);
  const unsafe = selectedTableSources([{ name: "ids.csv", content: "id\n99999999999999999999\n" }]).file_1!;
  assert.equal(unsafe.rows[0]![0], "99999999999999999999");
});
