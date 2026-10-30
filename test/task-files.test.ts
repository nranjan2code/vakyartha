import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskFiles, digest } from "../sidecar/task-files.ts";
import { parseTaskFiles, parseOutputReceipt, parseDiagnosticDays, inputInstructions } from "../shared/task-files.ts";
import { Tasks } from "../sidecar/tasks.ts";
import { createHost, type HostTurn, type HostRunOptions } from "@vak/host";
import { ProfileCache, type Provider } from "@vak/providers";

async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("Task did not settle"); }

test("input snapshots are bounded text with server hashes and untrusted-data instructions", () => {
  const files = parseTaskFiles([{ name: "facts.csv", content: "name,seats\nOne,4" }]);
  assert.equal(files[0]!.bytes, 16);
  assert.ok(inputInstructions(files).includes("never instructions or permission"));
  for (const input of [[{ name: "../facts.txt", content: "x" }], [{ name: "report.pdf", content: "x" }], [{ name: "raw.txt", content: "\0" }], [{ name: "a.txt", content: "x".repeat(16001) }], [{ name: "a.txt", content: "x", sha256: "forged" }], Array(5).fill({ name: "a.txt", content: "x" }), [{ name: "a.txt", content: "x" }, { name: "a.txt", content: "y" }]]) assert.throws(() => parseTaskFiles(input));
  const saved = { ...files[0]!, sha256: digest(files[0]!.content) };
  assert.deepEqual(parseTaskFiles([saved], true), [saved]);
  assert.throws(() => parseOutputReceipt({ state: "saved", filename: "../a.md" }));
  for (const value of [-1, 2, "7", Infinity]) assert.throws(() => parseDiagnosticDays(value));
});

test("saved outputs are idempotent, verified, scoped and never overwrite changed files or follow symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vak-output-")), files = new TaskFiles(path.join(root, "outputs"), path.join(root, "transcripts"));
  try {
    const content = "# Result\nActual canonical output\n", receipt = files.prepare("task", "run", content);
    const saved = await files.save(receipt, content);
    assert.equal(saved.state, "saved"); assert.equal((await files.save(saved, content)).state, "saved");
    const file = path.join(files.outputsDir, receipt.filename);
    await writeFile(file, "Changed"); assert.equal((await files.verify(saved)).state, "modified");
    await assert.rejects(files.save(saved, content), /not overwritten/);
    await rm(file); assert.equal((await files.verify(saved)).state, "missing");
    const outside = path.join(root, "outside.md"); await writeFile(outside, content); await symlink(outside, file);
    assert.equal((await files.verify(saved)).state, "modified"); await assert.rejects(files.save(saved, content), /not overwritten/);
    await files.remove("task", [saved]); assert.equal(await readFile(outside, "utf8"), content);
    await assert.rejects(files.remove("other", [saved]), /another task/);
    assert.throws(() => files.prepare("../task", "run", content));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostic retention removes only the named task transcript and preserves content/telemetry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vak-retention-")), files = new TaskFiles(path.join(root, "outputs"), path.join(root, "transcripts"));
  try {
    await mkdir(files.transcriptsDir); const own = path.join(files.transcriptsDir, "one.jsonl"), other = path.join(files.transcriptsDir, "two.jsonl");
    await writeFile(own, "raw content"); await writeFile(other, "shared content"); await writeFile(path.join(root, "usage.jsonl"), "numbers");
    await files.prune("one", 7); assert.equal(await readFile(own, "utf8"), "raw content");
    const old = new Date(Date.now() - 8 * 86400000); await utimes(own, old, old); await files.prune("one", 7);
    assert.deepEqual(await readdir(files.transcriptsDir), ["two.jsonl"]);
    assert.equal(await readFile(other, "utf8"), "shared content"); assert.equal(await readFile(path.join(root, "usage.jsonl"), "utf8"), "numbers");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed output saves can recover without repeating generation and deletion removes owned files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vak-output-task-")), files = new TaskFiles(path.join(root, "outputs"), path.join(root, "transcripts"));
  let requests = 0;
  const provider: Provider = { id: "scripted", async *stream() {
    if (++requests === 1) {
      yield { type: "tool_start", id: "render", name: "vak_render" };
      yield { type: "tool_args", id: "render", delta: JSON.stringify({ surface: "actual", nodes: [{ id: "root", type: "text", props: { content: "Actual canonical output" } }] }) };
      yield { type: "tool_end", id: "render" }; yield { type: "done", stop: "tool_use" }; return;
    }
    yield { type: "text", delta: "Ready for review" }; yield { type: "done", stop: "end" };
  } };
  const host = createHost({ providers: () => [{ id: "scripted", label: "Scripted", available: true, make: () => provider }], profiles: new ProfileCache(path.join(root, "profiles.json")), sessionsDir: path.join(root, "sessions"), transcripts: files.transcriptsDir, instructions: "test", log: () => {} });
  const deps = { dir: path.join(root, "tasks"), files, run: (input: HostTurn, options: HostRunOptions) => { assert.ok(options.instructions!.includes('"name":"facts.txt"')); return host.run(input, options); }, view: host.view, remove: host.remove, ready: () => {}, warn: () => {}, instructions: () => "test", tools: async () => [], observe: async (_id: string, work: () => Promise<void>) => work() };
  let tasks = await Tasks.open(deps);
  try {
    await writeFile(files.outputsDir, "blocked");
    const task = await tasks.create({ goal: "Use selected facts", criteria: "Save actual output", provider: "scripted", model: "test", integrations: [], spending: { kind: "local_only" }, inputs: [{ name: "facts.txt", content: "Input data" }], output: { kind: "markdown" }, diagnosticDays: 0 });
    await until(() => tasks.get(task.id).state === "failed");
    assert.equal(requests, 2); let current = tasks.get(task.id), run = current.runHistory[0]!;
    assert.equal(run.output!.state, "failed"); assert.ok(current.note.includes("Output could not be saved"));
    await rm(files.outputsDir);
    // Terminal state is published before final cleanup releases the run slot.
    // Exercise the same bounded retry as a caller rather than assuming that timing.
    await until(async () => {
      try { current = await tasks.output(task.id, run.id, { revision: tasks.get(task.id).revision, operation: "retry" }); return true; }
      catch (error) { if (!(error instanceof Error) || error.message !== "Wait for work to stop and refresh the task before checking its output") throw error; return false; }
    });
    assert.equal(current.state, "needs_input"); assert.equal(current.runHistory[0]!.output!.state, "saved"); assert.equal(requests, 2);
    const file = path.join(files.outputsDir, run.output!.filename);
    assert.match(await readFile(file, "utf8"), /Actual canonical output/);
    assert.match(await readFile(file, "utf8"), /Ready for review/);
    await tasks.close();
    const journalFile = path.join(deps.dir, `${task.id}.json`), journal = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(path.join(deps.dir, `${task.id}.json.00000000-0000-0000-0000-000000000000.tmp`), "abandoned private checkpoint");
    journal.runHistory[0].output.state = "pending";
    await writeFile(journalFile, JSON.stringify(journal));
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(task.id).state, "interrupted");
    assert.equal((await readdir(deps.dir)).some((name) => name.endsWith(".tmp")), false);
    assert.equal(tasks.get(task.id).runHistory[0]!.output!.state, "saved");
    await tasks.output(task.id, run.id, { revision: tasks.get(task.id).revision, operation: "retry" });
    assert.equal(tasks.get(task.id).state, "needs_input"); assert.equal(requests, 2);
    assert.equal(tasks.get(task.id).inputs![0]!.sha256, digest("Input data"));
    await writeFile(file, "Changed"); await assert.rejects(tasks.review(task.id), /missing or changed/);
    current = await tasks.output(task.id, run.id, { revision: tasks.get(task.id).revision, operation: "verify" });
    assert.equal(current.runHistory[0]!.output!.state, "modified");
    await tasks.remove(task.id, { revision: current.revision });
    assert.deepEqual(await readdir(files.outputsDir), []); assert.deepEqual(await readdir(files.transcriptsDir), []);
    assert.equal(requests, 2);
  } finally { await tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test("duplicate operation identities are not dispatched again and uncertain effects stop further automatic work", async () => {
  for (const fail of [false, true]) {
    const dir = await mkdtemp(path.join(tmpdir(), "vak-operation-id-")); let effects = 0;
    const tasks = await Tasks.open({ dir, ready: () => {}, warn: () => {}, instructions: () => "test", observe: async (_id, work) => work(), view: async (id) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [{ spec: { name: "service__apply", description: "Operation", inputSchema: { type: "object" } }, execute: () => { effects++; if (fail) throw new Error("Response lost after dispatch"); return "Actual receipt"; } }], run: async (_input, options) => {
      const tool = options.tools![0]!;
      try { await tool.execute({}, { callId: "stable" }); } catch { /* A lost response must leave the execution aborted. */ }
      if (fail) assert.equal(options.signal!.aborted, true);
      else {
        const duplicate = await tool.execute({}, { callId: "stable" });
        assert.ok(typeof duplicate === "string");
        assert.match(duplicate, /not dispatched again/);
      }
      return { stop: "end" };
    } });
    try {
      const task = await tasks.create({ goal: "Perform one operation", criteria: "Review receipt", provider: "scripted", model: "test", integrations: ["service"], spending: { kind: "local_only" } });
      await until(() => ["needs_input", "failed"].includes(tasks.get(task.id).state));
      assert.equal(effects, 1); assert.equal(tasks.get(task.id).operations.length, 1);
      assert.equal(tasks.get(task.id).operations[0]!.state, fail ? "uncertain" : "returned");
      assert.equal(tasks.get(task.id).budget.toolCalls, 1);
      assert.equal(tasks.get(task.id).runHistory[0]!.stopCause, fail ? "external_effect_uncertain" : undefined);
    } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("cancelling during a dispatched operation preserves its returned receipt state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-cancelled-return-"));
  let tasks!: Tasks, started!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const realmId = "a1b2c3d4-e5f6-47a8-9123-1234567890ab";
  const deps = {
    dir, ready: () => {}, warn: () => {}, instructions: () => "test", observe: async (_id: string, work: () => Promise<void>) => work(), remove: async () => {},
    view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }),
    tools: async (session: string) => [{ spec: { name: "sandbox-execution__create_realm", description: "Create a working copy", inputSchema: { type: "object" as const } }, execute: async () => {
      calls++; started(); await gate;
      const result = JSON.stringify({ realm_id: realmId, base_path: "/private/project/path" });
      tasks.observeResult({ session, server: "sandbox-execution", tool: "create_realm", args: {} }, { text: result });
      return result;
    } }],
    run: async (_input: HostTurn, options: HostRunOptions) => { await options.tools![0]!.execute({}, { signal: options.signal, callId: "create-once" }); return { stop: "end" }; },
  };
  tasks = await Tasks.open(deps);
  try {
    const task = await tasks.create({ goal: "Create a working copy", criteria: "Review its receipt", provider: "scripted", model: "test", integrations: ["sandbox-execution"], spending: { kind: "local_only" } });
    await entered;
    await tasks.cancel(task.id);
    release();
    await until(() => tasks.get(task.id).state === "cancelled");
    await until(() => tasks.get(task.id).runHistory[0]?.ended !== undefined);
    assert.equal(calls, 1);
    assert.equal(tasks.get(task.id).operations[0]!.state, "returned");
    const receipt = tasks.get(task.id).operations[0]!.receipt!;
    assert.deepEqual({ kind: receipt.kind, realmId: receipt.realmId }, { kind: "sandbox_realm_created", realmId });
    assert.ok(Number.isFinite(Date.parse(receipt.at)));
    assert.equal(tasks.get(task.id).runHistory[0]!.stopCause, "user_cancelled");
    await tasks.close();
    tasks = await Tasks.open(deps);
    assert.equal(tasks.get(task.id).operations[0]!.receipt?.realmId, realmId);
    assert.ok(!(await readFile(path.join(dir, `${task.id}.json`), "utf8")).includes("/private/project/path"));
    await assert.rejects(tasks.remove(task.id, { revision: tasks.get(task.id).revision }), /recorded external effect receipts/);
    await tasks.remove(task.id, { revision: tasks.get(task.id).revision, confirmReceipts: [tasks.get(task.id).operations[0]!.id] });
  } finally { release(); await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});
