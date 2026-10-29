import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Server } from "node:net";
import { test } from "node:test";
import { desktopTransport } from "../sidecar/desktop-transport.ts";
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
