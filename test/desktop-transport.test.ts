import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Server } from "node:net";
import { test } from "node:test";
import { desktopTransport } from "../sidecar/desktop-transport.ts";
import type { HostCandidateCommitRequest } from "@vak/host";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
import { startAppServer } from "../sidecar/server.ts";

test("desktop app serves real admitted settings over private pipes without listening", async (t) => {
  t.mock.method(Server.prototype, "listen", () => { throw new Error("Desktop must never open a listener"); });
  const dir = mkdtempSync(path.join(tmpdir(), "vak-private-"));
  const app = await startAppServer({ dataDir: dir, keychainService: "com.nranjan2code.vakyartha.private-test", access: "token", transport: "stdio" });
  t.after(async () => { await app.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(app.port, 0);
  assert.equal(app.url, "vak://localhost");
  assert.equal((await app.request(new Request("http://localhost/api/info"))).status, 401);
  const input = new PassThrough(), output = new PassThrough();
  let raw = "", ended = false;
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(app.request, app.token!, input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  output.on("data", (chunk) => {
    raw += chunk;
    while (raw.includes("\n")) {
      const index = raw.indexOf("\n"), frame = JSON.parse(raw.slice(0, index)); raw = raw.slice(index + 1); frames.push(frame);
      if (frame.type === "data") input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: frame.id, type: "ack" }) + "\n");
      if (frame.type === "end") ended = true;
    }
  });
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, type: "request", id: "one", method: "GET", path: "/api/info", headers: {} }) + "\n");
  for (let i = 0; i < 100 && !ended; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ended, true);
  assert.equal(frames[0]?.type, "headers"); assert.equal(frames[0]?.status, 200);
  const body = frames.filter((f) => f.type === "data").map((f) => Buffer.from(String(f.data), "base64").toString()).join("");
  assert.equal(JSON.parse(body).dataDir, dir);
  assert.doesNotMatch(JSON.stringify(frames), new RegExp(app.token!));
});

test("private response flow control bounds chunks, multiplexes requests and cancels readers", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let raw = "", cancelled = false;
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(200_000)); }, cancel() { cancelled = true; } })), "token", input, output, (error) => { throw error; });
  output.on("data", (chunk) => { raw += chunk; while (raw.includes("\n")) { const i = raw.indexOf("\n"); frames.push(JSON.parse(raw.slice(0, i))); raw = raw.slice(i + 1); } });
  const send = (f: Record<string, unknown>) => input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, ...f }) + "\n");
  send({ type: "request", id: "a", method: "GET", path: "/api/test" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames.filter((f) => f.type === "data").length, 1);
  assert.equal(Buffer.from(String(frames.find((f) => f.type === "data")?.data), "base64").length, 65536);
  send({ type: "request", id: "b", method: "GET", path: "/api/test" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames.filter((f) => f.type === "data").length, 2);
  send({ type: "ack", id: "a" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames.filter((f) => f.type === "data" && f.id === "a").length, 2);
  send({ type: "cancel", id: "a" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, true);
  bridge.close();
});

test("native control health uses its own typed identity and bounded response", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  output.on("data", (chunk) => { frames.push(JSON.parse(String(chunk))); });
  const pending = bridge.pingControl();
  for (let i = 0; i < 100 && !frames.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    v: DESKTOP_PROTOCOL,
    id: frames[0]!.id,
    type: "control_request",
    operation: "health",
  });
  assert.match(String(frames[0]!.id), /^ctl-[a-f0-9-]{36}$/);
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: frames[0]!.id, type: "control_response", status: "ready" }) + "\n");
  assert.deepEqual(await pending, { status: "ready" });
});

test("native candidate commit sends only the fenced proposal and validates its durable receipt", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  output.on("data", (chunk) => { frames.push(JSON.parse(String(chunk))); });
  const candidate = {
    candidateId: "d8998d68-f1a7-4498-839f-fb04ab231e8c", commitId: "commit_1",
    session: "session_1", provider: "ollama", model: "qwen3.5:4b-mlx",
    fence: { rootId: "root_1", rootRevision: 2, contractRevision: 3, cancellationEpoch: 1 },
    expectedCanonicalRevision: 0,
    result: { stop: "end", turns: 1 }, reply: "finished", baseVersions: [], surfaces: [],
  } as HostCandidateCommitRequest;
  const pending = bridge.commitCandidate(candidate);
  for (let i = 0; i < 100 && !frames.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = frames[0]!;
  assert.equal(request.type, "control_request");
  assert.equal(String(request.id).startsWith("ctl-"), true);
  assert.deepEqual(request.operation, { candidate_commit: {
    session_id: "session_1", commit_id: "commit_1",
    fence: { root_id: "root_1", root_revision: 2, contract_revision: 3, cancellation_epoch: 1 },
    expected_canonical_revision: 0,
    candidate: { provider: "ollama", model: "qwen3.5:4b-mlx", result: { stop: "end", turns: 1 }, reply: "finished", baseVersions: [], surfaces: [] },
  } });
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: request.id, type: "control_response", status: "committed", receipt: {
    commit_id: "commit_1", session_id: "session_1", root_id: "root_1", root_revision: 2,
    contract_revision: 3, cancellation_epoch: 1, expected_canonical_revision: 0,
    canonical_revision: 1, digest: "a".repeat(64), request_fingerprint: "b".repeat(64),
  } }) + "\n");
  assert.deepEqual(await pending, { canonicalRevision: 1, rootRevision: 2 });
});

test("native host session adapter uses typed revisioned operations and summaries", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  let raw = "";
  const requests: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  output.on("data", (chunk) => {
    raw += String(chunk);
    while (raw.includes("\n")) {
      const index = raw.indexOf("\n"), request = JSON.parse(raw.slice(0, index)) as Record<string, unknown>;
      raw = raw.slice(index + 1);
      requests.push(request);
      const operation = request.operation as Record<string, unknown>;
      const status = "session_save" in operation ? "saved" : "session_load" in operation ? "loaded" : "session_list" in operation ? "listed" : "removed";
      const response = status === "saved" ? { revision: 1 }
        : status === "loaded" ? { revision: 1, snapshot: { id: "chat-1", title: "Chat", created: "2026-10-30T00:00:00.000Z", updated: "2026-10-30T00:00:01.000Z", messages: [], timeline: [], surfaces: [], external: [] } }
          : status === "listed" ? { sessions: [{ id: "chat-1", title: "Chat", updated: "2026-10-30T00:00:01.000Z" }] } : {};
      input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: request.id, type: "control_response", status, ...response }) + "\n");
    }
  });
  const snapshot = { id: "chat-1", title: "Chat", created: "2026-10-30T00:00:00.000Z", updated: "2026-10-30T00:00:01.000Z", messages: [], timeline: [], surfaces: [], external: [] };
  assert.equal(await bridge.hostSessionStore.save(snapshot, 0), 1);
  assert.deepEqual(await bridge.hostSessionStore.load("chat-1"), { revision: 1, snapshot });
  assert.deepEqual(await bridge.hostSessionStore.list(), [{ id: "chat-1", title: "Chat", updated: "2026-10-30T00:00:01.000Z" }]);
  await bridge.hostSessionStore.remove("chat-1", 1);
  assert.deepEqual(requests.map((request) => Object.keys(request.operation as object)[0]), ["session_save", "session_load", "session_list", "session_remove"]);
  assert.equal("token" in requests[0]!, false);
});

test("native provider transport strips credentials and streams bounded response chunks", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  output.on("data", (chunk) => {
    const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
    frames.push(frame);
  });
  const pending = bridge.providerFetch("openai", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: "{}",
  }, { operationId: "root_operation_1", attempt: 2, sessionId: "session-1", runId: "run-1" });
  for (let i = 0; i < 100 && !frames.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = frames[0]!;
  assert.equal(request.type, "provider_request");
  assert.equal(request.operation, "responses");
  assert.equal("url" in request, false);
  assert.equal("headers" in request, false);
  assert.equal(request.operationId, "root_operation_1");
  assert.equal(request.attempt, 2);
  assert.equal(request.sessionId, "session-1");
  assert.equal(request.runId, "run-1");
  assert.doesNotMatch(JSON.stringify(request), /secret/);
  const id = String(request.id);
  const send = (frame: Record<string, unknown>) => input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id, ...frame }) + "\n");
  send({ type: "provider_headers", status: 200, headers: { "content-type": "application/json" } });
  const response = await pending;
  send({ type: "provider_data", seq: 0, data: Buffer.from("ok").toString("base64") });
  send({ type: "provider_end" });
  assert.equal(await response.text(), "ok");
  assert.equal(frames.some((frame) => frame.type === "provider_ack" && frame.seq === 0), true);
});

test("native provider framing sends registered operations without caller-selected destinations", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  t.after(() => bridge.close());
  let raw = "";
  output.on("data", (chunk) => {
    raw += String(chunk);
    while (raw.includes("\n")) {
      const index = raw.indexOf("\n");
      frames.push(JSON.parse(raw.slice(0, index)) as Record<string, unknown>);
      raw = raw.slice(index + 1);
    }
  });
  const gemini = bridge.providerFetch("gemini", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse", { method: "POST", body: "{}" }, { operationId: "gemini-op", attempt: 0, sessionId: "session-1", runId: "run-1" });
  for (let i = 0; i < 100 && frames.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames[0]?.operation, "stream_generate_content");
  assert.equal(frames[0]?.routeModel, "gemini-2.5-flash");
  assert.equal("url" in frames[0]!, false);
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: frames[0]!.id, type: "provider_error", message: "test refusal" }) + "\n");
  await assert.rejects(gemini, /test refusal/);

  const ollama = bridge.providerFetch("ollama", "http://127.0.0.1:11434/api/chat", { method: "POST", body: "{}" }, { operationId: "ollama-op", attempt: 0, sessionId: "session-1", runId: "run-1" });
  for (let i = 0; i < 100 && frames.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames[1]?.operation, "ollama_chat");
  assert.equal("url" in frames[1]!, false);
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: frames[1]!.id, type: "provider_error", message: "test refusal" }) + "\n");
  await assert.rejects(ollama, /test refusal/);

  await assert.rejects(
    bridge.providerFetch("openai", "https://attacker.example/v1/responses", { method: "POST", body: "{}" }, { operationId: "bad-host", attempt: 0, sessionId: "session-1", runId: "run-1" }),
    /Unsupported native provider operation/,
  );
  await assert.rejects(
    bridge.providerFetch("openai", "https://api.openai.com/v1/responses?key=secret", { method: "POST", body: "{}" }, { operationId: "query-key", attempt: 0, sessionId: "session-1", runId: "run-1" }),
    /Unsupported native provider operation/,
  );
  await assert.rejects(
    bridge.providerFetch("openai", "https://api.openai.com/v1/responses", { method: "POST", body: "{}" }, { operationId: "missing-run", attempt: 0 }),
    /Missing provider execution identity/,
  );
  await assert.rejects(
    bridge.providerFetch("openai", "https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
    /Missing provider operation identity/,
  );
});

test("private transport rejects incompatible frames and untrusted authority headers", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const errors: Error[] = [], frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => { throw new Error("must not dispatch"); }, "token", input, output, (error) => errors.push(error));
  output.on("data", (chunk) => frames.push(JSON.parse(String(chunk))));
  input.write(JSON.stringify({ v: DESKTOP_PROTOCOL, id: "bad", type: "request", method: "GET", path: "/api/info", headers: { authorization: "attacker" } }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames[0]?.type, "error");
  input.write('{"v":99,"type":"ack","id":"bad"}\n');
  assert.match(errors[0]!.message, /Incompatible/);
  bridge.close();
});

test("private transport reserves and releases native capacity leases", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const bridge = desktopTransport(async () => new Response(null), "token", input, output, (error) => { throw error; });
  output.on("data", (chunk) => {
    const raw = String(chunk);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      frames.push(JSON.parse(line));
    }
  });

  const reservePromise = bridge.reserveCapacity("req-cap-1", "root-cap-1", { ContainedProcess: 1 });
  for (let i = 0; i < 100 && frames.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(frames[0]?.type, "control_request");
  const reqOp = frames[0]?.operation as { capacity_reserve: { request_id: string; root_id: string; amounts: Record<string, number> } };
  assert.equal(reqOp.capacity_reserve.request_id, "req-cap-1");
  assert.equal(reqOp.capacity_reserve.root_id, "root-cap-1");

  const lease = {
    id: 101,
    request_id: "req-cap-1",
    root_id: "root-cap-1",
    amounts: { ContainedProcess: 1 },
  };
  input.write(JSON.stringify({
    v: DESKTOP_PROTOCOL,
    id: frames[0]!.id,
    type: "control_response",
    status: "reserved",
    lease,
  }) + "\n");
  const granted = await reservePromise;
  assert.equal(granted.id, 101);
  assert.equal(granted.request_id, "req-cap-1");

  const releasePromise = bridge.releaseCapacity(granted);
  for (let i = 0; i < 100 && frames.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(frames[1]?.type, "control_request");
  const relOp = frames[1]?.operation as { capacity_release: { lease: typeof lease } };
  assert.equal(relOp.capacity_release.lease.id, 101);

  input.write(JSON.stringify({
    v: DESKTOP_PROTOCOL,
    id: frames[1]!.id,
    type: "control_response",
    status: "released",
  }) + "\n");
  await releasePromise;

  bridge.close();
});
