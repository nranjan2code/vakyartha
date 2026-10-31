import assert from "node:assert/strict";
import { test } from "node:test";
import { realmRequest, sandboxExecutionEntry, sandboxSession } from "../sidecar/sandbox-execution.ts";
import type { SandboxRequest } from "../sidecar/desktop-transport.ts";

const server = (native?: (r: SandboxRequest) => Promise<unknown>) => {
  const source = sandboxExecutionEntry(native).source;
  if (source.kind !== "builtin") throw new Error("expected builtin");
  return source.server();
};

test("run_command sends the chat session and command to Rust, never a folder", async () => {
  const sent: SandboxRequest[] = [];
  const s = server(async (r) => { sent.push(r); return { code: 0, stdout: "ok", stderr: "" }; });
  const result = await sandboxSession.run("chat-1", () => s.callTool("run_command", { command: "ls", args: ["-la"], workingDirectory: "src" }));
  assert.deepEqual(sent, [{ op: "run", args: ["ls", "-la"], cwd: "src", timeoutSeconds: undefined, session: "chat-1" }]);
  assert.equal(result.isError, false);
  assert.match(result.text, /stdout:\nok/);
  assert.match((await s.callTool("run_command", { command: "ls", args: [], workingDirectory: "../up" })).text, /relative/);
});

test("realm tools use this chat's Realm unless one is named, and reject paths", () => {
  assert.deepEqual(realmRequest("snapshot_realm", {}), { op: "realm", args: ["snapshot", "{realm}", "--offset=0"] });
  assert.deepEqual(realmRequest("read_realm_file", { path: "a.txt", original: true }).args, ["read", "--offset=0", "--original", "--", "{realm}", "a.txt"]);
  assert.deepEqual(realmRequest("run_in_realm", { command: "/bin/sh", args: ["-c", "x"] }).args, ["exec", "{realm}", "--cwd=.", "--", "/bin/sh", "-c", "x"]);
  assert.deepEqual(realmRequest("create_realm", {}), { op: "realm_create", args: [] });
  assert.throws(() => realmRequest("read_realm_file", { path: "/etc/passwd" }));
  assert.throws(() => realmRequest("promote_realm", { fingerprint: "a".repeat(64), paths: ["../x"] }));
  assert.throws(() => realmRequest("realm_status", { realmId: "not-a-uuid" }));
});

test("outside the desktop app nothing runs", async () => {
  assert.match((await server().callTool("run_command", { command: "ls", args: [] })).text, /desktop app/);
});
