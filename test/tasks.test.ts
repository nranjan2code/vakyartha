import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHost, type HostRunOptions } from "@vak/host";
import { ProfileCache, type Provider, type AgentTool } from "@vak/providers";
import { Tasks } from "../sidecar/tasks.ts";
import { parseTaskInput, parseTaskView } from "../task-contract.ts";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("Task did not reach expected state"); await new Promise((r) => setTimeout(r, 5)); }
}

const scripted: Provider = {
  id: "scripted", async describeModel() { return { tools: true, fingerprint: "task-test", source: "test" }; },
  async *stream() {
    for (const id of ["first", "second", "table"]) {
      const nodes = id === "table" ? [{ id: "root", type: "table", props: { columns: ["Name", "Value"], rows: [["B", 2], ["A", 1]] } }] : [{ id: "root", type: "form", props: { submit: "save" }, children: [{ id: "name", type: "input", props: { label: "Name", bind: "/name", checks: ["required"] } }] }];
      yield { type: "tool_start", id, name: "vak_render" };
      yield { type: "tool_args", id, delta: JSON.stringify({ surface: id, title: id, nodes }) };
      yield { type: "tool_end", id };
    }
    yield { type: "done", stop: "tool_use" };
  },
};

test("tasks run through one canonical host, retain multiple interactive surfaces, and require explicit review", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-tasks-"));
  const host = createHost({ providers: () => [{ id: "scripted", label: "Scripted", available: true, make: () => scripted }], profiles: new ProfileCache(path.join(dir, "profiles.json")), instructions: "test", sessionsDir: path.join(dir, "sessions"), log: () => {} });
  const deps = { dir: path.join(dir, "tasks"), run: host.run, view: host.view, tools: async () => [], instructions: () => "test", observe: async (_session: string, work: () => Promise<void>) => work(), ready: () => {}, warn: () => {} };
  let tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "Create two forms and a table", criteria: "All three are usable", provider: "scripted", model: "fake", integrations: [] });
    await until(() => tasks.get(t.id).state === "needs_input");
    const view = await host.view(t.session);
    assert.equal(view.surfaces.length, 3);
    assert.equal(view.surfaces[0]?.nodes[0]?.type, "form");
    assert.equal(tasks.get(t.id).state, "needs_input");
    await tasks.complete(t.id, { ...await tasks.review(t.id), confirmed: true, note: "Checked the saved result against the criteria." });
    assert.equal(tasks.get(t.id).state, "completed");
    await tasks.close(); tasks = await Tasks.open(deps);
    assert.equal(tasks.get(t.id).state, "completed");
    // A finished task's surfaces still accept a continuation; duplicate command IDs are ignored.
    const command = { id: "same-command", action: { surface: "first", source: "root", data: { name: "Alice" } }, revision: view.surfaces[0]!.version };
    await tasks.input(t.id, command); await tasks.input(t.id, command);
    await until(() => tasks.get(t.id).state === "needs_input");
    assert.equal(tasks.get(t.id).runs, 2);
    assert.equal((await host.view(t.id)).timeline.filter((e) => e.kind === "action").length, 1);
    const raw = JSON.parse(await readFile(path.join(dir, "tasks", `${t.id}.json`), "utf8"));
    assert.equal(raw.surfaces, undefined);
    assert.equal(raw.messages, undefined);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("task approvals are exact, one-time decisions; cancellation preserves uncertainty and startup never replays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-permission-"));
  let tasks!: Tasks;
  let calls = 0;
  let permissionRevision = 0;
  const deps = {
    dir, ready: () => {}, warn: () => {}, instructions: () => "test", observe: async (_session: string, work: () => Promise<void>) => work(),
    permissionRevision: () => permissionRevision,
    tools: async (): Promise<AgentTool[]> => [{ spec: { name: "memory__write", description: "test", inputSchema: { type: "object" } }, execute: async () => {
      const decision = await tasks.approve({ id: `permission-${calls}`, server: "memory", tool: "write", title: "Write", args: { value: "test" } });
      if (decision === "allow") calls++;
      return decision;
    } }],
    view: async (id: string) => ({ id, title: "test", updated: "", timeline: [], surfaces: [] }),
    run: async (_input: unknown, options: HostRunOptions) => { await options.tools![0]!.execute({}, { signal: options.signal, callId: "operation-1" }); return { stop: "end" }; },
  };
  tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "Remember a fact", criteria: "Review fact", provider: "scripted", model: "fake", integrations: ["memory"] });
    await until(() => tasks.get(t.id).state === "needs_approval");
    const pending = tasks.get(t.id).approval!;
    assert.deepEqual(pending.args, { value: "test" });
    await assert.rejects(tasks.answer(t.id, pending.id, "allow-chat"));
    await tasks.answer(t.id, pending.id, "allow");
    await until(() => tasks.get(t.id).state === "needs_input");
    await assert.rejects(tasks.answer(t.id, pending.id, "allow"));
    assert.equal(calls, 1);
    await tasks.input(t.id, { id: "next", message: "Another fact" });
    await until(() => tasks.get(t.id).state === "needs_approval");
    assert.equal(calls, 1);
    permissionRevision++;
    await assert.rejects(tasks.answer(t.id, tasks.get(t.id).approval!.id, "allow"), /access changed/);
    await tasks.cancel(t.id);
    await tasks.close();
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(t.id).state, "cancelled");
    assert.equal(calls, 1);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("tool limits count calls independently of model rounds and stop before the next effect", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-limits-"));
  let calls = 0;
  const tasks = await Tasks.open({
    dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_session, work) => work(),
    view: async (id) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }),
    tools: async () => [{ spec: { name: "time__now", description: "test", inputSchema: { type: "object" } }, execute: () => { calls++; return "ok"; } }],
    run: async (_input, options) => { for (let i = 0; i < 50; i++) await options.tools![0]!.execute({}, { signal: options.signal, callId: `op-${i}` }); return { stop: "end" }; },
  });
  try {
    const t = await tasks.create({ goal: "test", criteria: "test", provider: "p", model: "m", integrations: ["time"] });
    await until(() => tasks.get(t.id).state === "failed");
    assert.equal(calls, 24);
    assert.equal(tasks.get(t.id).operations.length, 24);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("task admission fails closed for invalid input and unavailable capabilities", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-admission-"));
  const tasks = await Tasks.open({ dir, run: async () => ({ stop: "end" }), view: async (id) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [], instructions: () => "", observe: async (_session, work) => work(), ready: () => { throw new Error("Capability unavailable"); }, warn: () => {} });
  try {
    await assert.rejects(tasks.create({ goal: "Missing criteria" }), /required/);
    await assert.rejects(tasks.create({ goal: "test", criteria: "test", model: "m", provider: "p", integrations: ["unknown"] }), /unavailable/);
    assert.deepEqual(tasks.list(), []);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("typed input and journal boundaries reject invalid combinations and unsupported versions", () => {
  assert.throws(() => parseTaskInput({ id: "x", message: "hi", action: { surface: "s", source: "a", data: {} }, revision: 1 }));
  assert.throws(() => parseTaskInput({ id: "x", action: { surface: "s", source: "a", data: {} }, revision: -1 }));
  assert.throws(() => parseTaskView({ version: 4 }));
  assert.throws(() => parseTaskView({ version: 1, state: "__proto__" }));
});

test("interrupted journals expire approval authority and require reconciliation before continuation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-restart-"));
  const deps = { dir, run: async () => ({ stop: "end" }), view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [], instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), ready: () => {}, warn: () => {} };
  let tasks = await Tasks.open(deps);
  try {
    const task = await tasks.create({ goal: "test", criteria: "test", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(task.id).state === "needs_input"); await tasks.close();
    const file = path.join(dir, `${task.id}.json`), journal = parseTaskView(JSON.parse(await readFile(file, "utf8")));
    journal.state = "needs_approval";
    journal.approval = { id: "expired", server: "memory", tool: "write", title: "Write", args: {}, expires: new Date(Date.now() + 100000).toISOString(), capabilityRevision: 0 };
    journal.operations.push({ id: "unknown", tool: "memory__write", state: "started" });
    await writeFile(file, JSON.stringify(journal));
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(task.id).state, "interrupted");
    assert.equal(tasks.get(task.id).approval, undefined);
    assert.equal(tasks.get(task.id).operations[0]?.state, "uncertain");
    await assert.rejects(tasks.answer(task.id, "expired", "allow"));
    await assert.rejects(tasks.input(task.id, { id: "resume", message: "Continue" }), /Review uncertain/);
    await tasks.input(task.id, { id: "resume", message: "I checked the effect", reconciled: true });
    await until(() => tasks.get(task.id).state === "needs_input");
    assert.equal(tasks.get(task.id).operations[0]?.state, "reviewed");
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("deletion refuses active/stale tasks and requires acknowledgement before removing uncertain recovery records", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-delete-"));
  const removed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = { dir, run: async () => { await gate; return { stop: "end" }; }, remove: async (id: string) => { removed.push(id); }, view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [], instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), ready: () => {}, warn: () => {} };
  let tasks = await Tasks.open(deps);
  try {
    const task = await tasks.create({ goal: "test", criteria: "test", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(task.id).state === "running");
    await assert.rejects(tasks.remove(task.id, { revision: tasks.get(task.id).revision }), /Cancel/);
    release(); await until(() => tasks.get(task.id).state === "needs_input"); await tasks.close();
    const file = path.join(dir, `${task.id}.json`), journal = parseTaskView(JSON.parse(await readFile(file, "utf8")));
    journal.operations.push({ id: "effect", tool: "memory__write", state: "uncertain" });
    await writeFile(file, JSON.stringify(journal)); tasks = await Tasks.open(deps);
    await assert.rejects(tasks.remove(task.id, { revision: -1 }), /changed/);
    await assert.rejects(tasks.remove(task.id, { revision: tasks.get(task.id).revision }), /Acknowledge/);
    assert.deepEqual(removed, []);
    await tasks.remove(task.id, { revision: tasks.get(task.id).revision, confirmUncertain: true });
    assert.deepEqual(removed, [task.id]); assert.deepEqual(tasks.list(), []);
    await assert.rejects(readFile(file));
  } finally { release(); await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const outcome of ["allow", "revoked", "cancel"] as const) {
  test(`approval wait yields to another task and ${outcome} resumes without parallel execution or replay`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vak-task-slot-"));
    let tasks!: Tasks, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let revision = 0, effects = 0, secondActive = false, starts = 0;
    const tasksDeps = {
      dir, ready: () => {}, warn: () => {}, instructions: () => "", permissionRevision: () => revision,
      observe: async (_session: string, work: () => Promise<void>) => work(),
      view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }),
      remove: async () => {},
      tools: async (): Promise<AgentTool[]> => [{ spec: { name: "memory__write", description: "test", inputSchema: { type: "object" } }, execute: async () => {
        const decision = await tasks.approve({ id: "permission-slot", server: "memory", tool: "write", title: "Write", args: { value: "fact" } });
        if (decision === "allow") { assert.equal(secondActive, false); effects++; }
        return decision;
      } }],
      run: async (input: { message?: string }, options: HostRunOptions) => {
        if (input.message === "First") { starts++; await options.tools![0]!.execute({}, { signal: options.signal, callId: "effect" }); }
        else { secondActive = true; await gate; secondActive = false; }
        return { stop: "end" };
      },
    };
    tasks = await Tasks.open(tasksDeps);
    try {
      const first = await tasks.create({ goal: "First", criteria: "Review", provider: "p", model: "m", integrations: ["memory"] });
      await until(() => tasks.get(first.id).state === "needs_approval");
      const second = await tasks.create({ goal: "Second", criteria: "Review", provider: "p", model: "m", integrations: [] });
      await until(() => secondActive);
      await tasks.answer(first.id, "permission-slot", "allow");
      await until(() => tasks.get(first.id).state === "queued");
      assert.equal(effects, 0);
      await assert.rejects(tasks.remove(first.id, { revision: tasks.get(first.id).revision }), /Cancel/);
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (outcome === "revoked") revision++;
      if (outcome === "cancel") await tasks.cancel(first.id);
      release();
      await until(() => tasks.get(second.id).state === "needs_input");
      await until(() => tasks.get(first.id).state === (outcome === "cancel" ? "cancelled" : "needs_input"));
      await tasks.close();
      assert.equal(effects, outcome === "allow" ? 1 : 0);
      assert.equal(starts, 1);
      assert.equal(tasks.get(first.id).runs, 1);
      const run = tasks.get(first.id).runHistory[0]!;
      assert.equal(run.toolCalls, 1);
      assert.equal(tasks.get(first.id).operations[0]!.runId, run.id);
      assert.ok(Date.parse(run.ended!) - Date.parse(run.started) - run.activeMs >= 30, "review/slot waits counted as active time");
      tasks = await Tasks.open(tasksDeps);
      assert.equal(starts, 1);
      assert.equal(tasks.get(first.id).approval, undefined);
    } finally { release(); await tasks.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("shutdown aborts suspended approvals and a running peer without replaying either", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-task-stop-slots-"));
  let tasks!: Tasks, calls = 0;
  const deps = {
    dir, ready: () => {}, warn: () => {}, instructions: () => "",
    observe: async (_session: string, work: () => Promise<void>) => work(),
    view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [],
    run: async (input: { message?: string }, options: HostRunOptions) => {
      calls++;
      if (input.message === "First") await tasks.approve({ id: "stop-permission", server: "memory", tool: "write", title: "Write", args: {} });
      else await new Promise<void>((resolve) => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { stop: "end" };
    },
  };
  tasks = await Tasks.open(deps);
  try {
    const first = await tasks.create({ goal: "First", criteria: "Review", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(first.id).state === "needs_approval");
    const second = await tasks.create({ goal: "Second", criteria: "Review", provider: "p", model: "m", integrations: [] });
    await until(() => calls === 2);
    await tasks.close();
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(first.id).state, "interrupted");
    assert.equal(tasks.get(second.id).state, "interrupted");
    assert.equal(calls, 2);
    await assert.rejects(tasks.answer(first.id, "stop-permission", "allow"));
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("run history retains distinct input identities and outcomes without copying canonical content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-run-history-"));
  let resultAt = "";
  const deps = { dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), tools: async () => [], view: async (id: string) => ({ id, title: "", updated: "", timeline: [{ kind: "assistant" as const, text: "Result", surfaces: [], notes: [], status: "end", at: resultAt }], surfaces: [] }), run: async () => { resultAt = new Date().toISOString(); return { stop: "end" }; } };
  let tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "First", criteria: "Review", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(t.id).state === "needs_input");
    await tasks.input(t.id, { id: "continuation", message: "Check it again" });
    await until(() => tasks.get(t.id).state === "needs_input");
    await tasks.complete(t.id, { ...await tasks.review(t.id), confirmed: true, note: "Checked the saved result against the criteria." });
    await tasks.close();
    const saved = parseTaskView(JSON.parse(await readFile(path.join(dir, `${t.id}.json`), "utf8")));
    assert.deepEqual(saved.runHistory.map((r) => r.sequence), [1, 2]);
    assert.deepEqual(saved.runHistory.map((r) => r.state), ["review", "accepted"]);
    assert.notEqual(saved.runHistory[0]!.id, saved.runHistory[1]!.id);
    assert.equal(saved.runHistory[1]!.inputId, "continuation");
    assert.ok(saved.runHistory.every((r) => r.ended && r.stop === "end" && r.toolCalls === 0));
    assert.equal("messages" in saved.runHistory[0]!, false);
    assert.equal("surfaces" in saved.runHistory[0]!, false);
    assert.throws(() => parseTaskView({ ...saved, runHistory: [saved.runHistory[1], saved.runHistory[0]] }), /order/);
    assert.throws(() => parseTaskView({ ...saved, version: 1 }), /version/);
    assert.throws(() => parseTaskView({ ...saved, runHistory: undefined }), /collection/);
    assert.throws(() => parseTaskView({ ...saved, runHistory: [{ ...saved.runHistory[0], ended: undefined }] }), /timestamps/);
    tasks = await Tasks.open(deps);
    assert.deepEqual(tasks.get(t.id).runHistory, saved.runHistory);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("run admission reserves queued capacity and refuses continuations past the bounded run limit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-run-limit-"));
  let gate = Promise.resolve(), release = () => {};
  const deps = { dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), tools: async () => [], view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), run: async () => { await gate; return { stop: "end" }; } };
  let tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "Bounded", criteria: "Review", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(t.id).state === "needs_input");
    for (let i = 0; i < 30; i++) {
      await tasks.input(t.id, { id: `prior-${i}`, message: "Continue" });
      await until(() => tasks.get(t.id).state === "needs_input");
    }
    gate = new Promise<void>((resolve) => { release = resolve; });
    await tasks.input(t.id, { id: "last-run", message: "Last continuation" });
    await until(() => tasks.get(t.id).state === "running");
    await assert.rejects(tasks.input(t.id, { id: "overflow", message: "Must not queue" }), /limit/);
    release(); await until(() => tasks.get(t.id).state === "needs_input");
    await assert.rejects(tasks.input(t.id, { id: "overflow-finalizing", message: "Must not queue during final save" }), /limit/);
    await tasks.close();
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(t.id).runs, 32);
    assert.equal(tasks.get(t.id).runHistory[31]!.sequence, 32);
    assert.equal(tasks.get(t.id).runHistory.length, 32);
    await assert.rejects(tasks.input(t.id, { id: "overflow", message: "Must not run" }), /limit/);
  } finally { release(); await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("unfinished run records recover with an unknown end time and never invented completion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-recover-runs-"));
  const deps = { dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), tools: async () => [], view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), run: async () => ({ stop: "end" }) };
  let tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "Recover", criteria: "Review", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(t.id).state === "needs_input"); await tasks.close();
    const file = path.join(dir, `${t.id}.json`), saved = JSON.parse(await readFile(file, "utf8"));
    saved.runHistory[0].state = "running"; delete saved.runHistory[0].ended; delete saved.runHistory[0].stop;
    await writeFile(file, JSON.stringify(saved));
    tasks = await Tasks.open(deps);
    const recovered = tasks.get(t.id);
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.runHistory[0]!.state, "interrupted");
    assert.equal(recovered.runHistory[0]!.ended, undefined);
    assert.ok(recovered.runHistory[0]!.recovered);
    assert.equal(recovered.runs, 1);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("result acceptance binds explicit evidence to the latest saved result and rejects stale or duplicate review", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-result-review-"));
  let at = "", publish = true;
  const surface = { id: "report", title: "Report", version: 1, nodes: [], data: { value: "first" } };
  const deps = { dir, ready: () => {}, warn: () => {}, instructions: () => "", observe: async (_session: string, work: () => Promise<void>) => work(), tools: async () => [], view: async (id: string) => ({ id, title: "", updated: "", timeline: [{ kind: "assistant" as const, text: "Result", at, surfaces: ["report"], notes: [], status: "end" }], surfaces: [structuredClone(surface)] }), run: async () => { if (publish) at = new Date().toISOString(); return { stop: "end" }; } };
  let tasks = await Tasks.open(deps);
  try {
    const t = await tasks.create({ goal: "Report", criteria: "Verified values", provider: "p", model: "m", integrations: [] });
    await until(() => tasks.get(t.id).state === "needs_input");
    const snapshot = await tasks.review(t.id);
    await assert.rejects(tasks.complete(t.id, { ...snapshot, note: "Checked" }), /Confirm/);
    await assert.rejects(tasks.complete(t.id, { ...snapshot, confirmed: true, note: " " }), /Confirm/);
    surface.data.value = "changed without a version bump";
    await assert.rejects(tasks.complete(t.id, { ...snapshot, confirmed: true, note: "Checked" }), /changed/);
    surface.version++;
    const fresh = await tasks.review(t.id);
    const payload = { ...fresh, confirmed: true, note: "Checked the report values against the source receipt." };
    const accepted = await Promise.allSettled([tasks.complete(t.id, payload), tasks.complete(t.id, payload)]);
    assert.equal(accepted.filter((r) => r.status === "fulfilled").length, 1);
    const review = tasks.get(t.id).runHistory[0]!.review!;
    assert.equal(review.method, "user"); assert.equal(review.note, payload.note);
    assert.deepEqual(review.surfaces, [{ id: "report", title: "Report", version: 2 }]);
    assert.equal("data" in review.surfaces[0]!, false);
    await tasks.close(); tasks = await Tasks.open(deps);
    assert.deepEqual(tasks.get(t.id).runHistory[0]!.review, review);
    publish = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tasks.input(t.id, { id: "no-result", message: "Continue" });
    await until(() => tasks.get(t.id).state === "needs_input");
    await assert.rejects(tasks.review(t.id), /no saved assistant result/);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});
