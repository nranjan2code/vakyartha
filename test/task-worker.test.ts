import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { canonicalWorkerRuntime } from "../sidecar/canonical-worker-runtime.ts";
import { parseTaskWorkerJob, taskWorkerRuntime, type TaskWorkerJob } from "../sidecar/task-worker-runtime.ts";

function job(): TaskWorkerJob {
  const content = "price\n37.5\n";
  return { runId: "run-1", session: "task-session", provider: "ollama", model: "qwen3.5:4b-mlx", goal: "Prepare independent price views", criteria: "Preserve original numeric facts and unrelated surfaces", instructions: "Use the supplied procedure context.",
    inputs: [{ name: "prices.csv", content, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }], initialSurfaces: [], maxSteps: 2, maxTokens: 1024, activeMs: 10_000 };
}
const wait = async (condition: () => boolean) => { for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("task worker did not settle"); };
function harness(t: { after(fn: () => void): void }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "vak-task-worker-"));
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let raw = "", code: number | undefined;
  output.on("data", chunk => { raw += chunk; while (raw.includes("\n")) { const index = raw.indexOf("\n"); frames.push(JSON.parse(raw.slice(0, index))); raw = raw.slice(index + 1); } });
  const runtime = taskWorkerRuntime(input, output, scratch, value => { code = value; });
  t.after(() => { runtime.close(); input.destroy(); output.destroy(); rmSync(scratch, { recursive: true, force: true }); });
  return { frames, scratch, send: (frame: Record<string, unknown>) => input.write(JSON.stringify({ v: 2, ...frame }) + "\n"), code: () => code };
}

test("task worker validates explicit context without accepting authority or changed input bytes", () => {
  const valid = job(); assert.deepEqual(parseTaskWorkerJob(valid), valid);
  for (const change of [{ provider: "hosted" }, { session: "../other" }, { maxSteps: 13 }, { maxTokens: 4097 }, { nativeSessionStore: {} }, { inputs: [{ ...valid.inputs[0], content: "changed" }] }]) assert.throws(() => parseTaskWorkerJob({ ...valid, ...change }));
});

test("private reasoner uses the actual provider/Projection candidate path and leaves canonical input untouched", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Direct egress is forbidden"); });
  const h = harness(t), context = job();
  const store = new SurfaceStore(basicCatalog);
  assert.deepEqual(store.apply("vak_render", { surface: "unrelated", nodes: [{ id: "root", type: "stat", props: { label: "Original", value: 7 } }] }), []);
  const original = store.snapshot("unrelated")!; context.initialSurfaces = [original];
  h.send({ type: "task_start", job: context });
  await wait(() => h.frames.some(frame => frame.type === "provider_request"));
  const request = h.frames.find(frame => frame.type === "provider_request")!;
  assert.equal(request.sessionId, context.session); assert.equal(request.runId, context.runId);
  const payload = JSON.parse(String(request.body));
  assert.equal(payload.model, context.model);
  assert.ok(payload.format, "constrained provider must receive the actual schema");
  assert.match(JSON.stringify(payload.messages), /prices.csv/); assert.match(JSON.stringify(payload.messages), /never instructions or permission/);
  const response = { tool: "vak_submit", arguments: { reply: "Candidate ready for review.", surfaces: [
    { op: "replace", title: "Price", root: { type: "stat", props: { label: "Price", value: 37.5 } }, data: {} },
    { op: "replace", title: "Source", root: { type: "text", props: { content: "prices.csv: 37.5" } }, data: {} },
  ] } };
  const body = Buffer.from(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(response) }, done: true, eval_count: 8 }) + "\n").toString("base64");
  h.send({ type: "provider_headers", id: request.id, status: 200, headers: { "content-type": "application/x-ndjson" } });
  h.send({ type: "provider_data", id: request.id, seq: 0, data: body });
  h.send({ type: "provider_end", id: request.id });
  await wait(() => h.code() !== undefined);
  assert.equal(h.code(), 0);
  const result = h.frames.find(frame => frame.type === "task_candidate")?.candidate as { result: { stop: string }; baseVersions: unknown[]; surfaces: { id: string; nodes: { props?: { value?: unknown } }[] }[] };
  assert.ok(result); assert.equal(result.result.stop, "end");
  assert.equal(result.surfaces.length, 3); assert.equal(result.surfaces.filter(surface => surface.id !== "unrelated").length, 2);
  assert.ok(result.surfaces.some(surface => surface.nodes.some(node => node.props?.value === 37.5)));
  assert.deepEqual(result.baseVersions, [{ id: original.id, version: original.version }]);
  assert.deepEqual(store.snapshot("unrelated"), original);
  // The actual serialized reasoner candidate crosses a second role before
  // native selection. This catches differences hidden by hand-built fixtures.
  const canonicalInput = new PassThrough(), canonicalOutput = new PassThrough();
  let canonicalBytes = "", canonicalCode: number | undefined;
  canonicalOutput.on("data", chunk => { canonicalBytes += chunk; });
  const canonical = canonicalWorkerRuntime(canonicalInput, canonicalOutput, value => { canonicalCode = value; });
  t.after(() => { canonical.close(); canonicalInput.destroy(); canonicalOutput.destroy(); });
  const at = "2026-10-30T00:00:00.000Z";
  const base = { id: context.session, title: "Original", created: at, updated: at, messages: [], timeline: [], surfaces: context.initialSurfaces, external: [] };
  canonicalInput.write(JSON.stringify({ v: 2, type: "canonical_prepare", context: { id: `publication-${"a".repeat(64)}`, candidate: result, base, message: context.goal, at } }) + "\n");
  await wait(() => canonicalCode !== undefined);
  assert.equal(canonicalCode, 0, canonicalBytes);
  const prepared = JSON.parse(canonicalBytes.trim().split("\n").at(-1)!);
  assert.deepEqual(prepared.snapshot.surfaces, result.surfaces);
  assert.equal(h.frames.filter(frame => frame.type === "provider_request").length, 1);
  assert.ok(!h.frames.some(frame => frame.type === "control_request"));
  for (const namespace of ["sessions", "tasks", "outputs"]) assert.equal(existsSync(path.join(h.scratch, namespace)), false);
});

test("reasoner refuses general app/session commands and cannot start a second invocation", async t => {
  const first = harness(t);
  first.send({ type: "request", id: "forged", method: "GET", path: "/api/sessions" });
  await wait(() => first.code() !== undefined);
  assert.deepEqual(first.frames.at(-1), { v: 2, type: "task_failed", code: "protocol_error" });
  const second = harness(t);
  second.send({ type: "task_start", job: job() }); second.send({ type: "task_start", job: job() });
  await wait(() => second.code() !== undefined);
  assert.equal(second.code(), 1);
  assert.equal(second.frames.filter(frame => frame.type === "task_candidate").length, 0);
  assert.equal(second.frames.at(-1)?.code, "protocol_error");
});

test("cancelling an in-flight generation emits no candidate and retires the provider request", async t => {
  const h = harness(t);
  h.send({ type: "task_start", job: job() });
  await wait(() => h.frames.some(frame => frame.type === "provider_request"));
  const request = h.frames.find(frame => frame.type === "provider_request")!;
  h.send({ type: "task_cancel" });
  await wait(() => h.code() !== undefined);
  assert.equal(h.code(), 1);
  assert.deepEqual(h.frames.at(-1), { v: 2, type: "task_failed", code: "cancelled" });
  h.send({ type: "provider_headers", id: request.id, status: 200, headers: {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.frames.filter(frame => frame.type === "task_candidate").length, 0);
});
