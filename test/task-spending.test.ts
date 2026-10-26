import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { providersFromEnv } from "@vak/providers";
import { parseTaskSpending } from "../shared/task-contract.ts";
import { checkTaskSpending } from "../sidecar/task-policy.ts";
import { Tasks } from "../sidecar/tasks.ts";

test("spending admission requires an explicit policy, acknowledgement and an enforceable mode", () => {
  for (const value of [undefined, {}, { kind: "api_allowed" }, { kind: "api_allowed", acknowledged: false }, { kind: "ceiling", usd: -1 }, { kind: "ceiling", usd: Infinity }]) assert.throws(() => parseTaskSpending(value));
  const local = providersFromEnv({}).find((p) => p.id === "ollama")!;
  assert.throws(() => checkTaskSpending(local, parseTaskSpending({ kind: "ceiling", usd: 1 }), {}), /cannot be enforced/);
  const custom = providersFromEnv({ OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:1234" }).find((p) => p.id === "compatible")!;
  assert.throws(() => checkTaskSpending(custom, { kind: "local_only" }, {}), /local provider/);
  checkTaskSpending(custom, { kind: "api_allowed", acknowledged: true }, {});
});

test("local-only routing validates declared endpoints instead of trusting the local label", () => {
  const local = providersFromEnv({}).find((p) => p.id === "ollama")!;
  for (const host of ["127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) checkTaskSpending(local, { kind: "local_only" }, { OLLAMA_HOST: host });
  for (const host of ["https://example.invalid", "http://127.0.0.1.example.invalid", "http://user:pass@127.0.0.1", "file:///tmp/model", "not a host"]) assert.throws(() => checkTaskSpending(local, { kind: "local_only" }, { OLLAMA_HOST: host }));
  const studio = providersFromEnv({}).find((p) => p.id === "lmstudio")!;
  checkTaskSpending(studio, { kind: "local_only" }, {});
  assert.throws(() => checkTaskSpending(studio, { kind: "local_only" }, { LMSTUDIO_BASE_URL: "https://example.invalid" }), /loopback/);
});

test("scheduled work rechecks spending policy before dispatch and never falls back to another provider", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-spending-"));
  let endpoint = "http://127.0.0.1:11434", calls = 0;
  const tasks = await Tasks.open({ dir, run: async () => { calls++; return { stop: "end" }; }, view: async (id) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [], instructions: () => "", observe: async (_id, work) => work(), warn: () => {}, ready: (id, _model, _selected, _confirmed, policy) => { const env = { OLLAMA_HOST: endpoint }; checkTaskSpending(providersFromEnv(env).find((p) => p.id === id)!, policy, env); } });
  try {
    const input = { goal: "Review", criteria: "Evidence", provider: "ollama", model: "local", integrations: [], spending: { kind: "local_only" } };
    await assert.rejects(tasks.create({ ...input, spending: { kind: "ceiling", usd: 1 } }), /cannot be enforced/);
    const task = await tasks.create({ ...input, schedule: { kind: "once", at: new Date(Date.now() + 120).toISOString(), timezone: "UTC", status: "armed", missed: "review" } });
    endpoint = "https://example.invalid";
    const end = Date.now() + 3000;
    while (tasks.get(task.id).state !== "failed") { if (Date.now() > end) throw new Error("Schedule did not fail closed"); await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(calls, 0);
    assert.match(tasks.get(task.id).note, /loopback/);
    assert.equal(tasks.get(task.id).provider, "ollama");
    assert.deepEqual(tasks.get(task.id).spending, { kind: "local_only" });
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});
