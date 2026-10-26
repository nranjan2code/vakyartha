import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentsRoute } from "../sidecar/attachments.ts";

test("attachments live in their chat's folder and go when the chat is deleted", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vak-attach-"));
  const route = attachmentsRoute(dir);
  const server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url ?? "/", "http://x")))) res.writeHead(204).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const post = (session: string, type: string) =>
      fetch(`${base}/api/attachments?session=${session}`, { method: "POST", body: JSON.stringify({ type, data: Buffer.from("png").toString("base64") }) });
    const ok = await post("chat-1", "image/png");
    const file = ((await ok.json()) as { path: string }).path;
    assert.equal(path.dirname(file), path.join(dir, "chat-1"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await post("chat-1", "text/html")).status, 415);
    assert.equal((await post("../up", "image/png")).status, 400);
    await fetch(`${base}/api/sessions/chat-1`, { method: "DELETE" });
    assert.equal(existsSync(path.join(dir, "chat-1")), false);
  } finally {
    server.close();
  }
});
