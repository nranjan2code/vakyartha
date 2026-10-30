import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { canonicalWorkerRuntime } from "../sidecar/canonical-worker-runtime.ts";

function context() {
  return { id: `publication-${"a".repeat(64)}`, message: "Show source amount", at: "2026-10-30T00:00:00.000Z", candidate: {
    candidateId: "candidate-1", session: "task-1", provider: "ollama", model: "local", result: { stop: "end" }, reply: "Ready for review", baseVersions: [],
    surfaces: [{ id: "amount", version: 1, data: { amount: 37.5 }, nodes: [{ id: "root", type: "stat", props: { label: "Source amount", value: "{/amount}" } }] },
      { id: "form", version: 1, data: { amount: 37.5 }, nodes: [{ id: "root", type: "form", props: { submit: "apply" }, children: ["value"] }, { id: "value", type: "input", props: { label: "Amount", bind: "/amount" } }] }],
  } };
}
function harness(t: { after(fn: () => void): void }) {
  const input = new PassThrough(), output = new PassThrough(), frames: Record<string, unknown>[] = [];
  let code: number | undefined, raw = "";
  output.on("data", chunk => { raw += chunk; while (raw.includes("\n")) { const index = raw.indexOf("\n"); frames.push(JSON.parse(raw.slice(0, index))); raw = raw.slice(index + 1); } });
  const runtime = canonicalWorkerRuntime(input, output, value => { code = value; });
  t.after(() => { runtime.close(); input.destroy(); output.destroy(); });
  return { input, frames, code: () => code, send: (frame: unknown) => input.write(JSON.stringify(frame) + "\n") };
}
const wait = async (condition: () => boolean) => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("canonical worker did not settle"); };

test("canonical role revalidates exact multi-surface facts and interactions with no model/egress path", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No canonical egress"); });
  const h = harness(t), original = context();
  const bytes = JSON.stringify({ v: 2, type: "canonical_prepare", context: original }) + "\n";
  for (let i = 0; i < bytes.length; i += 73) h.input.write(bytes.slice(i, i + 73));
  await wait(() => h.code() !== undefined);
  assert.equal(h.code(), 0);
  assert.deepEqual(h.frames.map(frame => frame.type), ["canonical_ready", "canonical_prepared"]);
  assert.equal(h.frames[1]!.id, original.id);
  const snapshot = h.frames[1]!.snapshot as { surfaces: unknown[]; messages: unknown[] };
  assert.deepEqual(snapshot.surfaces, original.candidate.surfaces);
  assert.deepEqual(snapshot.messages, [{ role: "user", content: original.message }, { role: "assistant", content: original.candidate.reply }]);
  h.send({ v: 2, type: "canonical_prepare", context: original });
  assert.equal(h.frames.length, 2, "one result per process");
});

test("canonical role rejects failed results, stale bases and every authority command family", async t => {
  for (const frame of [
    { v: 2, type: "provider_headers", id: "forged", status: 200 },
    { v: 2, type: "request", method: "POST", path: "/api/tasks" },
    { v: 2, type: "task_start", job: {} },
    { v: 2, type: "canonical_prepare", context: { ...context(), nativeSessionStore: {} } },
    { v: 2, type: "canonical_prepare", context: { ...context(), candidate: { ...context().candidate, result: { stop: "max_steps" } } } },
    { v: 2, type: "canonical_prepare", context: { ...context(), candidate: { ...context().candidate, baseVersions: [{ id: "missing", version: 1 }] } } },
  ]) {
    const h = harness(t); h.send(frame); await wait(() => h.code() !== undefined);
    assert.equal(h.code(), 1); assert.equal(h.frames.at(-1)!.type, "canonical_failed");
    assert.ok(!h.frames.some(frame => frame.type === "canonical_prepared"));
  }
  const truncated = harness(t); truncated.input.end('{"v":2'); await wait(() => truncated.code() !== undefined);
  assert.equal(truncated.code(), 1); assert.equal(truncated.frames.length, 1);
});
