import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";

test("the decision route sends only the classification to local Ollama on the approved path", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-decision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: Array<{ provider: string; url: string; body: unknown; session?: string }> = [];
  const app = await startAppServer({
    dataDir: dir, access: "token", keychainService: "com.nranjan2code.vakyartha.decision-test",
    providerTransport: async (provider, input, init, context) => {
      if (String(input).endsWith("/v1/systemone")) calls.push({ provider, url: String(input), body: JSON.parse(String(init?.body)), session: context?.sessionId });
      return new Response(JSON.stringify({ model: "d1-omni:latest", answers: { intent: { type: "choice", choice: "salutation", confidence: 0.9, probabilities: {} } } }), { status: 200 });
    },
  });
  t.after(() => app.shutdown());
  const headers = { "content-type": "application/json", authorization: `Bearer ${app.token}` };
  const post = (body: unknown) => fetch(`${app.url}/api/decision/systemone`, { method: "POST", headers, body: JSON.stringify(body) });
  const questions = { intent: { type: "choice", instructions: "x", criteria: { a: "b" } } };

  const ok = await post({ model: "d1-omni:latest", state: "नमस्ते", questions, session: "chat-1", extra: "dropped" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { answers: { intent: { choice: string } } }).answers.intent.choice, "salutation");
  assert.deepEqual(calls, [{ provider: "ollama", url: "http://127.0.0.1:11434/v1/systemone", body: { model: "d1-omni:latest", state: "नमस्ते", questions }, session: "chat-1" }]);

  for (const bad of [{ model: "../x", state: "hi", questions, session: "chat-1" }, { model: "d1-omni:latest", state: "hi", questions, session: "../chat" }, { model: "d1-omni:latest", state: "x".repeat(8001), questions, session: "chat-1" }]) {
    assert.equal((await post(bad)).status, 400);
  }
  assert.equal(calls.length, 1);
});
