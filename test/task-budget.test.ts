import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HostRunOptions } from "@vak/host";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { runAgent, ToolGenerationError, type Provider } from "@vak/providers";
import { Tasks } from "../sidecar/tasks.ts";
import { parseTaskView, parseTaskLimits, type TaskLimits } from "../task-contract.ts";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("Budget test did not settle"); await new Promise((r) => setTimeout(r, 5)); }
}
async function harness(work: (tasks: Tasks, options: HostRunOptions) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-budget-"));
  let tasks!: Tasks, effects = 0;
  const deps = { dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_id: string, work: () => Promise<void>) => work(), view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [{ spec: { name: "test__write", description: "test", inputSchema: { type: "object" as const } }, execute: async () => { effects++; return "receipt"; } }], run: async (_input: unknown, options: HostRunOptions) => { await work(tasks, options); return { stop: "end" }; } };
  tasks = await Tasks.open(deps);
  return { get tasks() { return tasks; }, get effects() { return effects; }, dir,
    create: (limits: TaskLimits) => tasks.create({ goal: "Bounded work", criteria: "Evidence", provider: "scripted", model: "test", integrations: ["test"], spending: { kind: "local_only" }, limits }),
    reopen: async () => { await tasks.close(); tasks = await Tasks.open(deps); },
    close: async () => { await tasks.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
const limits: TaskLimits = { runs: 4, modelRequests: 4, toolCalls: 4, activeMs: 30000 };

test("model reservations survive continuations and restart without replenishment", async () => {
  let requests = 0;
  const h = await harness(async (tasks) => { await tasks.beforeModelRequest("scripted", "test"); requests++; });
  try {
    const t = await h.create({ ...limits, modelRequests: 2 });
    await until(() => h.tasks.get(t.id).state === "needs_input"); await h.reopen();
    assert.equal(h.tasks.get(t.id).budget.modelRequests, 1);
    await h.tasks.input(t.id, { id: "second", message: "Continue" });
    await until(() => h.tasks.get(t.id).state === "needs_input"); await h.reopen();
    await assert.rejects(h.tasks.input(t.id, { id: "third", message: "Continue" }), /budget exhausted/);
    assert.equal(requests, 2);
    assert.deepEqual(h.tasks.get(t.id).runHistory.map((r) => r.modelRequests), [1, 1]);
    parseTaskView(h.tasks.get(t.id));
  } finally { await h.close(); }
});
for (const [allowance, expected] of [[2, 2], [30, 12]] as const) test(`generation retries stop before request ${expected + 1}`, async () => {
  let requests = 0;
  const h = await harness(async (tasks) => { for (let i = 0; i < 50; i++) { await tasks.beforeModelRequest("scripted", "test"); requests++; } });
  try {
    const t = await h.create({ ...limits, modelRequests: allowance! });
    await until(() => h.tasks.get(t.id).state === "failed");
    assert.equal(requests, expected); assert.equal(h.tasks.get(t.id).budget.modelRequests, expected);
    assert.match(h.tasks.get(t.id).note, /Model-request budget/);
  } finally { await h.close(); }
});

test("tool attempt limits carry across runs and stop before another effect", async () => {
  const h = await harness(async (_tasks, options) => { await options.tools![0]!.execute({}, { signal: options.signal }); });
  try {
    const t = await h.create({ ...limits, toolCalls: 1 });
    await until(() => h.tasks.get(t.id).state === "needs_input"); await h.reopen();
    await h.tasks.input(t.id, { id: "second", message: "Another effect" });
    await until(() => h.tasks.get(t.id).state === "failed");
    assert.equal(h.effects, 1); assert.equal(h.tasks.get(t.id).budget.toolCalls, 1);
    assert.equal(h.tasks.get(t.id).operations.length, 1);
  } finally { await h.close(); }
});

test("crash recovery keeps an unfinished active-time reservation charged", async () => {
  const h = await harness(async () => {});
  try {
    const t = await h.create({ ...limits, activeMs: 1000 });
    await until(() => h.tasks.get(t.id).state === "needs_input"); await h.tasks.close();
    const file = path.join(h.dir, `${t.id}.json`), raw = JSON.parse(await readFile(file, "utf8"));
    raw.state = "running"; raw.budget.activeMs = 1000; raw.runHistory[0].chargedMs = 1000; raw.runHistory[0].activeMs = 0; raw.runHistory[0].state = "running"; delete raw.runHistory[0].ended;
    await writeFile(file, JSON.stringify(raw)); await h.reopen();
    assert.equal(h.tasks.get(t.id).state, "interrupted");
    assert.equal(h.tasks.get(t.id).budget.activeMs, 1000);
    await assert.rejects(h.tasks.input(t.id, { id: "retry", message: "Continue" }), /budget exhausted|previous run/);
    await h.reopen();
    await assert.rejects(h.tasks.input(t.id, { id: "after-restart", message: "Continue" }), /budget exhausted/);
  } finally { await h.close(); }
});

test("approval waits longer than the active budget do not consume active time", async () => {
  const h = await harness(async (tasks) => { await tasks.approve({ id: "budget-approval", server: "test", tool: "write", title: "Write", args: {} }); });
  try {
    const t = await h.create({ ...limits, activeMs: 1000 });
    await until(() => h.tasks.get(t.id).state === "needs_approval");
    await new Promise((r) => setTimeout(r, 1100));
    await h.tasks.answer(t.id, "budget-approval", "allow");
    await until(() => h.tasks.get(t.id).state === "needs_input"); await h.reopen();
    const saved = h.tasks.get(t.id);
    assert.ok(saved.budget.activeMs < 1000); assert.equal(saved.budget.activeMs, saved.runHistory[0]!.chargedMs);
  } finally { await h.close(); }
});

test("budget boundaries reject invalid limits and inconsistent journal counters", async () => {
  for (const value of [{ ...limits, runs: 0 }, { ...limits, modelRequests: Infinity }, { ...limits, toolCalls: -1 }, { ...limits, activeMs: 999 }]) assert.throws(() => parseTaskLimits(value));
  const h = await harness(async () => {});
  try {
    const t = await h.create({ ...limits, runs: 1 });
    await until(() => h.tasks.get(t.id).state === "needs_input");
    await assert.rejects(h.tasks.input(t.id, { id: "extra", message: "Continue" }), /continuation limit/);
    const saved = h.tasks.get(t.id); saved.budget.modelRequests++;
    assert.throws(() => parseTaskView(saved), /does not match/);
  } finally { await h.close(); }
});

test("active-time exhaustion stops work and cannot be reset by a continuation", async () => {
  const h = await harness(async (tasks, options) => {
    await tasks.beforeModelRequest("scripted", "test");
    await new Promise<void>((resolve) => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  });
  try {
    const t = await h.create({ ...limits, activeMs: 1000 });
    await until(() => h.tasks.get(t.id).state === "failed");
    assert.match(h.tasks.get(t.id).note, /Active time limit/);
    assert.equal(h.tasks.get(t.id).budget.activeMs, 1000);
    await assert.rejects(h.tasks.input(t.id, { id: "retry", message: "Continue" }), /budget exhausted|previous run/);
    await h.reopen();
    await assert.rejects(h.tasks.input(t.id, { id: "after-restart", message: "Continue" }), /budget exhausted/);
  } finally { await h.close(); }
});

test("a failed reservation save prevents generation dispatch", async () => {
  let requests = 0;
  const h = await harness(async (tasks) => {
    await rm(h.dir, { recursive: true, force: true });
    await tasks.beforeModelRequest("scripted", "test");
    requests++;
  });
  try {
    const t = await h.create(limits);
    await until(() => h.tasks.get(t.id).state === "failed");
    await h.tasks.close();
    assert.equal(requests, 0);
    assert.match(h.tasks.get(t.id).note, /could not be saved/);
  } finally { await h.close(); }
});


test("rejected tool generations consume durable task request reservations before another retry", async () => {
  let requests = 0;
  const h = await harness(async (tasks, options) => {
    const provider: Provider = { id: "scripted", async *stream() {
      await tasks.beforeModelRequest("scripted", "test");
      requests++;
      throw new ToolGenerationError("scripted", "generated tool syntax rejected");
    } };
    await runAgent({ provider, model: "test", messages: [{ role: "user", content: "Bounded work" }], store: new SurfaceStore(basicCatalog), completion: "response", maxSteps: 12, signal: options.signal, emit: options.emit ?? (() => {}) });
  });
  try {
    const t = await h.create({ ...limits, modelRequests: 2 });
    await until(() => h.tasks.get(t.id).state === "failed");
    assert.equal(requests, 2);
    assert.equal(h.tasks.get(t.id).budget.modelRequests, 2);
    assert.equal(h.tasks.get(t.id).runHistory[0]!.modelRequests, 2);
    assert.match(h.tasks.get(t.id).note, /Model-request budget/);
    assert.equal(h.effects, 0);
    await h.reopen();
    await assert.rejects(h.tasks.input(t.id, { id: "retry-rejected-generation", message: "Continue" }), /budget exhausted/);
    assert.equal(requests, 2);
  } finally { await h.close(); }
});
