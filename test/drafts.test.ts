import assert from "node:assert/strict";
import { test } from "node:test";
import type { SurfaceSnapshot } from "@vak/core";
import { Drafts } from "../src/drafts.ts";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const surface = (id: string, name = ""): SurfaceSnapshot => ({ id, nodes: [], data: { name }, version: 1 });

test("independent field drafts survive navigation and a fresh UI while canonical data remains separate", () => {
  const saved = storage(), drafts = new Drafts(saved, assert.fail);
  drafts.begin("first"); drafts.receive(surface("a")); drafts.receive(surface("b"));
  drafts.record("a", "/name", "Alice"); drafts.record("b", "/name", "Bob");
  drafts.begin("another"); drafts.begin("first");
  assert.equal(drafts.receive(surface("a")).data.name, "Alice");
  assert.equal(drafts.receive(surface("b")).data.name, "Bob");
  drafts.flush();
  const restarted = new Drafts(saved, assert.fail); restarted.begin("first");
  assert.equal(restarted.receive(surface("b")).data.name, "Bob");
  restarted.clear("first"); restarted.begin("first");
  assert.equal(restarted.receive(surface("b")).data.name, "");
});

test("incoming updates preserve unsent values and require an explicit conflict choice", () => {
  const drafts = new Drafts(storage(), assert.fail); drafts.begin("first"); drafts.receive(surface("a", "Old"));
  drafts.record("a", "/name", "Mine");
  const incoming = surface("a", "New");
  const merged = drafts.receive(incoming);
  assert.equal(merged.data.name, "Mine"); assert.equal(incoming.data.name, "New"); assert.equal(drafts.conflicted("a"), true);
  assert.equal(drafts.resolve(merged, false).data.name, "New"); assert.equal(drafts.conflicted("a"), false);
  drafts.record("a", "/name", "Again");
  const next = drafts.receive(surface("a", "Changed"));
  assert.equal(drafts.resolve(next, true).data.name, "Again"); assert.equal(drafts.conflicted("a"), false);
});

test("surface names do not become object properties, and unsafe field pointers cannot alter prototypes", () => {
  const drafts = new Drafts(storage(), assert.fail); drafts.begin("test"); drafts.receive(surface("__proto__"));
  drafts.record("__proto__", "/name", "Mine"); drafts.record("__proto__", "/__proto__/injected", "no");
  assert.equal(drafts.receive(surface("__proto__")).data.name, "Mine");
  assert.equal(Object.hasOwn(Object.prototype, "injected"), false);
});
