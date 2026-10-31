import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message, Provider } from "@vak/providers";
import { emptyShape, estimateCost, runUsage, parseRunUsage, type Turn } from "../shared/finops.ts";
import { Finops } from "../sidecar/finops.ts";

function manager(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-finops-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, ledger: new Finops(dir) };
}
const provider: Provider = {
  id: "fake", async listModels() { return []; }, async describeModel() { return { fingerprint: "fake", source: "test" }; },
  async *stream() {
    yield { type: "text", delta: "answer" };
    yield { type: "tool_start", id: "render", name: "vak_render" };
    yield { type: "tool_args", id: "render", delta: '{"surface":"test"}' };
    yield { type: "tool_end", id: "render" };
    yield { type: "done", stop: "tool_use", usage: { input: 100, output: 25, cachedInput: 60 } };
  },
};

test("app observer persists each model step, preserves events, and never saves content", async (t) => {
  const { ledger, dir } = manager(t), observed = ledger.observe(provider, false);
  const messages: Message[] = [{ role: "user", content: "private user text" }, { role: "tool", content: "private fetched page", toolName: "web__fetch" }];
  await ledger.chat(async () => {
    ledger.session("chat-a");
    for (let i = 0; i < 2; i++) {
      const events = [];
      for await (const e of observed.stream({ model: "model", system: "private system", tools: [], messages })) events.push(e);
      assert.equal(events.at(-1)?.type, "done");
    }
  });
  const turns = (await ledger.view()).turns;
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.session, "chat-a");
  assert.equal(turn.steps.length, 2);
  assert.equal(turn.steps[0]!.systemChars, 14);
  assert.equal(turn.context.results, 20);
  assert.equal(turn.output.text, 12);
  assert.equal(turn.projectionCalls, 2);
  ledger.setRate({ provider: "fake", model: "model", input: 2, cached: .2, output: 8 });
  assert.ok(Math.abs(estimateCost(turn, ledger.rates())! - .000584) < 1e-12);
  const raw = readFileSync(path.join(dir, "logs/finops.jsonl"), "utf8");
  assert.doesNotMatch(raw, /private|answer|surface|fetched/);
  assert.equal((await new Finops(dir).view()).turns[0]?.steps.length, 2);
});

test("overlapping chats have independent ledgers and incomplete paid streams stay unknown", async (t) => {
  const { ledger } = manager(t);
  const observed = ledger.observe({ ...provider, async *stream(req) {
    yield { type: "text", delta: req.model };
    if (req.model === "broken") throw new Error("offline");
    yield { type: "done", stop: "end", usage: { input: 50, output: 3 } };
  } }, false);
  await Promise.all(["broken", "working"].map((model) => ledger.chat(async () => {
    ledger.session(model);
    try { for await (const _ of observed.stream({ model, messages: [] })) { /* consume */ } } catch { /* engine can recover */ }
  })));
  const turns = (await ledger.view()).turns;
  assert.equal(turns.length, 2);
  assert.equal(turns.find((x) => x.session === "broken")?.complete, false);
  assert.equal(turns.find((x) => x.session === "working")?.complete, true);
  for (const turn of turns) assert.equal(estimateCost(turn, [{ provider: "fake", model: turn.model, input: 1, cached: .1, output: 1, updated: "today" }]), undefined);
});

test("legacy sessions show context growth and repairs without inventing tokens; measured turns replace them", async (t) => {
  const { dir, ledger } = manager(t);
  mkdirSync(path.join(dir, "sessions"));
  const at = new Date().toISOString();
  writeFileSync(path.join(dir, "sessions/chat.json"), JSON.stringify({ id: "chat", timeline: [{ kind: "assistant", at, status: "fake · model · 2.0s" }], messages: [
    { role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "x", name: "vak_render", arguments: "{}" }] },
    { role: "tool", toolName: "vak_render", content: "invalid", isError: true }, { role: "assistant", content: "fixed" },
  ] }));
  const old = (await ledger.view()).turns[0]!;
  assert.equal(old.source, "reconstructed"); assert.equal(old.steps.length, 2); assert.equal(old.context.user, 2); assert.equal(old.errors, 1);
  assert.equal(old.steps[0]?.input, undefined);
  assert.equal(estimateCost(old, []), undefined);
  await ledger.chat(async () => { ledger.session("chat"); for await (const _ of ledger.observe(provider, false).stream({ model: "model", messages: [] })) { /* consume */ } });
  assert.equal((await ledger.view()).turns.length, 1);
  assert.equal((await ledger.view()).turns[0]?.source, "recorded");
  assert.equal((await ledger.view()).turns[0]?.errors, 1);
});

test("rates reject invalid numbers and zero is distinct from unavailable cost", (t) => {
  const { ledger } = manager(t);
  for (const n of [-1, NaN, Infinity, "1"]) assert.throws(() => ledger.setRate({ provider: "x", model: "y", input: n, cached: 0, output: 1 }));
  const turn: Turn = { id: "x", session: "x", at: "", provider: "x", model: "y", local: false, ms: 0, source: "recorded", context: emptyShape(), output: emptyShape(), steps: [], projectionCalls: 0, externalCalls: 0, errors: 0, complete: true };
  assert.equal(estimateCost(turn, []), undefined);
  assert.equal(estimateCost({ ...turn, local: true }, []), 0);
  assert.deepEqual(ledger.rates(), []);
});

test("authenticated app HTTP chats record real request metrics and replace reconstructed history", async (t) => {
  const { createServer } = await import("node:http");
  const { startAppServer } = await import("../sidecar/server.ts");
  const { dir } = manager(t);
  const fake = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const selecting = body.tools?.length === 1 && body.tools[0]?.function?.name === "use_skill";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: selecting ? { tool_calls: [{ index: 0, id: "select", type: "function", function: { name: "use_skill", arguments: '{"names":[]}' } }] } : { content: "Local test response" }, finish_reason: selecting ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 60 } } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OPENAI_COMPAT_BASE_URL;
  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
    else process.env.OPENAI_COMPAT_BASE_URL = previous;
    fake.closeAllConnections(); fake.close();
  });
  const app = await startAppServer({ dataDir: dir, access: "token", keychainService: "com.nranjan2code.vakyartha.finops-test" });
  t.after(() => app.shutdown());
  assert.equal((await fetch(`${app.url}/api/finops`)).status, 401);
  assert.equal((await fetch(`${app.url}/api/tasks`)).status, 401);
  const headers = { "content-type": "application/json", authorization: `Bearer ${app.token}` };
  const response = await fetch(`${app.url}/api/chat`, { method: "POST", headers, body: JSON.stringify({ session: "http-test", provider: "compatible", model: "fake", message: "test", history: 6, task: { taskId: "forged", runId: "forged" } }) });
  assert.equal(response.status, 200);
  await response.text();
  const view = await (await fetch(`${app.url}/api/finops`, { headers })).json() as { turns: Turn[] };
  assert.equal(view.turns.length, 1);
  const turn = view.turns[0]!;
  assert.equal(turn.source, "recorded"); assert.equal(turn.session, "http-test"); assert.equal(turn.task, undefined);
  assert.equal(turn.steps[0]?.input, 100); assert.equal(turn.steps[0]?.cachedInput, 60);
  assert.equal(turn.steps.length, 2, "selection and answer are both metered");
  assert.ok(turn.steps[0]!.systemChars > 0); assert.ok(turn.steps[0]!.schemaChars > 0);
  const clock = await fetch(`${app.url}/api/integrations/time/test`, { method: "POST", headers, body: JSON.stringify({ tool: "now", args: { timezone: "UTC" } }) });
  assert.equal(clock.status, 200);
  const clockResult: unknown = await clock.json();
  assert.ok(clockResult && typeof clockResult === "object" && "isError" in clockResult && clockResult.isError === false);
  for (const spending of [{ kind: "local_only" }, { kind: "api_allowed", acknowledged: false }, { kind: "ceiling", usd: 1 }]) {
    const blocked = await fetch(`${app.url}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ goal: "Blocked", criteria: "No execution", provider: "compatible", model: "fake", integrations: [], spending }) });
    assert.equal(blocked.status, 400);
  }
  assert.equal(((await (await fetch(`${app.url}/api/finops`, { headers })).json()) as { turns: Turn[] }).turns.length, 1);
  const created = await fetch(`${app.url}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ goal: "Synthetic task", criteria: "Review synthetic result", provider: "compatible", model: "fake", spending: { kind: "api_allowed", acknowledged: true }, integrations: [], limits: { runs: 1, modelRequests: 2, toolCalls: 0, activeMs: 60000 } }) });
  assert.equal(created.status, 201);
  const { parseTaskView } = await import("../shared/task-contract.ts");
  const task = parseTaskView(await created.json());
  let finished = task;
  for (let i = 0; i < 100; i++) {
    finished = parseTaskView(await (await fetch(`${app.url}/api/tasks/${task.id}`, { headers })).json());
    if (finished.state === "needs_input") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(finished.state, "needs_input");
  assert.equal(finished.budget.modelRequests, 2);
  assert.equal(finished.runHistory[0]!.modelRequests, 2);
  assert.equal(finished.budget.toolCalls, 0, "loading local skills uses no external operation allowance");
  assert.deepEqual(finished.operations, []);
  const taskUsage = await (await fetch(`${app.url}/api/finops`, { headers })).json() as { turns: Turn[] };
  const recorded = taskUsage.turns.find((turn) => turn.session === task.id)!;
  assert.deepEqual(recorded.task, { taskId: task.id, runId: finished.runHistory[0]!.id });
  assert.equal((await fetch(`${app.url}/api/tasks/${task.id}/review`)).status, 401);
  const snapshot = await (await fetch(`${app.url}/api/tasks/${task.id}/review`, { headers })).json();
  assert.equal((await fetch(`${app.url}/api/tasks/${task.id}/complete`, { method: "POST", headers, body: JSON.stringify({ ...snapshot, note: "No confirmation" }) })).status, 400);
  const usageUrl = `${app.url}/api/tasks/${task.id}/runs/${finished.runHistory[0]!.id}/usage`;
  assert.equal((await fetch(usageUrl)).status, 401);
  const measured = parseRunUsage(await (await fetch(usageUrl, { headers })).json());
  assert.equal(measured.input, 200); assert.equal(measured.output, 50);
  assert.equal((await fetch(`${app.url}/api/tasks/${task.id}/runs/not-this-run/usage`, { headers })).status, 400);
  const bypass = await fetch(`${app.url}/api/reset`, { method: "POST", headers, body: JSON.stringify({ session: task.id }) });
  assert.equal(bypass.status, 409);
  assert.equal((await fetch(`${app.url}/api/tasks/${task.id}`, { method: "DELETE", headers, body: JSON.stringify({ revision: -1 }) })).status, 400);
  assert.equal((await fetch(`${app.url}/api/tasks/${task.id}`, { method: "DELETE", headers, body: JSON.stringify({ revision: finished.revision }) })).status, 200);
  assert.equal(readFileSync(path.join(dir, "logs/finops.jsonl"), "utf8").includes("Synthetic task"), false);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(path.join(dir, "tasks", `${task.id}.json`)), false);
  assert.equal(existsSync(path.join(dir, "sessions", `${task.id}.json`)), false);
  assert.equal(existsSync(path.join(dir, "transcripts", `${task.id}.jsonl`)), false);
});


test("run accounting isolates overlapping runs and keeps absent, partial and unpriced usage unknown", async (t) => {
  const { ledger } = manager(t);
  const observed = ledger.observe(provider, false);
  await Promise.all(["run-one", "run-two"].map((runId) => ledger.chat(async () => {
    ledger.session("one-task");
    await new Promise((resolve) => setTimeout(resolve, runId === "run-one" ? 10 : 1));
    for await (const _ of observed.stream({ model: "model", messages: [] })) { /* consume */ }
  }, { taskId: "one-task", runId })));
  const view = await ledger.view();
  assert.equal(view.turns.length, 2);
  for (const runId of ["run-one", "run-two"]) {
    assert.equal(view.turns.filter((turn) => turn.task?.runId === runId).length, 1);
    assert.deepEqual(runUsage(view, "one-task", runId), { requests: 1, input: 100, output: 25, estimatedModelUsd: undefined });
  }
  assert.equal(runUsage(view, "another-task", "run-one").requests, 0);
  assert.equal(runUsage(view, "one-task", "missing").estimatedModelUsd, undefined);
  ledger.setRate({ provider: "fake", model: "model", input: 2, cached: .2, output: 8 });
  assert.ok(runUsage(await ledger.view(), "one-task", "run-one").estimatedModelUsd! > 0);
  view.turns[0]!.complete = false;
  const partial = runUsage(view, "one-task", view.turns[0]!.task!.runId);
  assert.equal(partial.input, undefined); assert.equal(partial.estimatedModelUsd, undefined);
  assert.throws(() => parseRunUsage({ requests: -1 }));
  assert.throws(() => parseRunUsage({ requests: 1, estimatedModelUsd: Infinity }));
});

test("history deduplication keeps session, provider and strict timestamp-skew boundaries", async (t) => {
  const { dir, ledger } = manager(t);
  mkdirSync(path.join(dir, "sessions")); mkdirSync(path.join(dir, "logs"));
  const at = Date.UTC(2026, 0, 1);
  const turns: Turn[] = [999, -999, 1000, -1000].map((offset, n) => ({ id: `record-${n}`, session: `chat-${n}`, at: new Date(at + offset).toISOString(), provider: "fake", model: "model", local: true, ms: 1, source: "recorded", context: emptyShape(), output: emptyShape(), steps: [], projectionCalls: 0, externalCalls: 0, errors: 0, complete: true }));
  // Out-of-order ledger timestamps must not affect matching.
  writeFileSync(ledger.file, turns.reverse().map((turn) => JSON.stringify(turn)).join("\n"));
  for (let n = 0; n < 5; n++) writeFileSync(path.join(dir, "sessions", `chat-${n}.json`), JSON.stringify({ id: `chat-${n}`, timeline: [{ kind: "assistant", at: new Date(at).toISOString(), status: `${n === 4 ? "other" : "fake"} · model · 1.0s` }], messages: [{ role: "user", content: "test" }, { role: "assistant", content: "reply" }] }));
  const view = await ledger.view();
  assert.deepEqual(view.turns.filter((turn) => turn.source === "reconstructed").map((turn) => turn.session).sort(), ["chat-2", "chat-3", "chat-4"]);
  assert.equal(view.turns.filter((turn) => turn.source === "recorded").length, 4);
});

test("standard model rates resolve known presets with cached token discounts", async () => {
  const { findStandardRate, STANDARD_MODEL_RATES } = await import("../src/finops-page.ts");
  assert.ok(STANDARD_MODEL_RATES["openai/gpt-4o"]);
  assert.equal(STANDARD_MODEL_RATES["openai/gpt-4o"]?.cached, 1.25);
  assert.equal(STANDARD_MODEL_RATES["anthropic/claude-3-5-sonnet"]?.cached, 0.30);
  assert.equal(STANDARD_MODEL_RATES["gemini/gemini-2.5-pro"]?.cached, 0.3125);

  const openaiRate = findStandardRate("openai", "gpt-4o");
  assert.deepEqual(openaiRate, { input: 2.50, cached: 1.25, output: 10.00 });

  const anthropicRate = findStandardRate("anthropic", "claude-3-5-sonnet");
  assert.deepEqual(anthropicRate, { input: 3.00, cached: 0.30, output: 15.00 });

  const unknownRate = findStandardRate("fixture", "custom-model");
  assert.equal(unknownRate, undefined);
});

test("a chat turn's decision-pruned integration list narrows the tools offered to the model", async (t) => {
  const { createServer } = await import("node:http");
  const { startAppServer } = await import("../sidecar/server.ts");
  const { dir } = manager(t);
  const offered: string[][] = [];
  const fake = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      offered.push((body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name ?? ""));
      const selecting = body.tools?.length === 1 && body.tools[0]?.function?.name === "use_skill";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: selecting ? { tool_calls: [{ index: 0, id: "select", type: "function", function: { name: "use_skill", arguments: '{"names":[]}' } }] } : { content: "ok" }, finish_reason: selecting ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OPENAI_COMPAT_BASE_URL;
  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
    else process.env.OPENAI_COMPAT_BASE_URL = previous;
    fake.closeAllConnections(); fake.close();
  });
  const app = await startAppServer({ dataDir: dir, access: "token", keychainService: "com.nranjan2code.vakyartha.finops-test" });
  t.after(() => app.shutdown());
  const headers = { "content-type": "application/json", authorization: `Bearer ${app.token}` };
  const turn = async (extra: Record<string, unknown>) => {
    offered.length = 0;
    const response = await fetch(`${app.url}/api/chat`, { method: "POST", headers, body: JSON.stringify({ session: "scope-test", provider: "compatible", model: "fake", message: "what time is it", ...extra }) });
    await response.text();
    return offered.flat();
  };
  const all = await turn({});
  assert.ok(all.some((name) => name.startsWith("time__")), "the time integration is offered without a decision scope");
  const scoped = await turn({ integrationTools: [] });
  assert.ok(!scoped.some((name) => name.startsWith("time__")), "an empty decision scope offers no integration tools");
  const forged = await turn({ integrationTools: ["time__now", "not_installed__tool"] });
  assert.ok(!forged.includes("not_installed__tool"), "a scope cannot add a tool Settings does not offer");
  const after = await turn({});
  assert.ok(after.some((name) => name.startsWith("time__")), "the scope ends with its turn");
  const view = await (await fetch(`${app.url}/api/finops`, { headers })).json() as { turns: Turn[] };
  const last = view.turns.at(-1)!;
  assert.equal(last.controls?.think, false);
  assert.ok(last.controls?.plan?.generation, "the engine's per-model plan is recorded with the turn");
});
