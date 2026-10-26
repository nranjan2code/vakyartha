import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasReason, MAX_INLINE_FIELDS, MAX_INLINE_NODES } from "../src/placement.ts";

const node = (type: string, props: Record<string, unknown> = {}, children?: unknown[]) => ({ id: type, type, props, children });

test("small interfaces stay in the conversation", () => {
  // The "hello" greeting a 4B model rendered on 2026-10-26: a stack with a text.
  assert.equal(canvasReason({ nodes: [node("stack", {}, [node("text", { content: "Hello! How can I help?" })])] }), undefined);
  assert.equal(canvasReason({ nodes: [node("card", { title: "Weather" }), node("stat", { label: "Now", value: "21°" })] }), undefined);
  const fields = Array.from({ length: MAX_INLINE_FIELDS }, (_, i) => node("input", { label: `F${i}` }));
  assert.equal(canvasReason({ nodes: [node("form", {}, fields)] }), undefined);
  assert.equal(canvasReason({ nodes: [node("code", { code: "npm test\nnpm run build" })] }), undefined);
});

test("wide, long or busy interfaces go to the canvas", () => {
  for (const type of ["table", "chart", "tabs", "map", "gantt", "diff", "board"]) assert.equal(canvasReason({ nodes: [node("stack", {}, [node(type)])] }), type);
  const fields = Array.from({ length: MAX_INLINE_FIELDS + 1 }, (_, i) => node("input", { label: `F${i}` }));
  assert.equal(canvasReason({ nodes: [node("form", {}, fields)] }), "form");
  assert.equal(canvasReason({ nodes: [node("code", { code: Array(20).fill("line").join("\n") })] }), "long code");
  assert.equal(canvasReason({ nodes: Array.from({ length: MAX_INLINE_NODES + 1 }, () => node("text", { content: "x" })) }), "size");
  assert.equal(canvasReason({ nodes: [node("text", { content: "{/body}" })], data: { body: "word ".repeat(400) } }), "length");
});
