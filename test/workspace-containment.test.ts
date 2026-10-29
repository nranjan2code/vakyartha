import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { validateWorkspaceFolder, WorkspaceRegistry } from "../sidecar/workspace-registry.ts";
import { runSandboxCommand } from "../sidecar/sandbox-execution.ts";
import { SandboxRealms } from "../sidecar/sandbox-realms.ts";
import { Skills } from "../sidecar/skills.ts";

const helper = process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb");
const native = process.platform === "darwin" && existsSync(helper);

test("workspace admission denies path traversal, symlink escapes, home and system folders", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vak-sec-admit-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-data-"));
  const subFolder = path.join(root, "valid-project");
  mkdirSync(subFolder, { recursive: true });

  try {
    // 1. Valid folder inside root passes
    const valid = validateWorkspaceFolder(subFolder, dataDir);
    assert.equal(valid.isDirectory, true);
    assert.equal(valid.isReadable, true);
    assert.ok(valid.canonical);

    // 2. User home directory is denied
    assert.throws(
      () => validateWorkspaceFolder(homedir(), dataDir),
      /Choose a specific project folder, rather than your home or a system folder/i,
    );

    // 3. System root and system directories are denied
    for (const sysPath of ["/", "/System", "/usr", "/bin", "/sbin", "/Applications", "/private/etc"]) {
      if (existsSync(sysPath)) {
        assert.throws(
          () => validateWorkspaceFolder(sysPath, dataDir),
          /system folder|Choose a specific project folder/i,
        );
      }
    }

    // 4. Application data directory is denied
    assert.throws(
      () => validateWorkspaceFolder(dataDir, dataDir),
      /Application data directory cannot be selected as a workspace folder/i,
    );

    // 5. Child inside app data directory is denied
    const dataChild = path.join(dataDir, "child");
    mkdirSync(dataChild, { recursive: true });
    assert.throws(
      () => validateWorkspaceFolder(dataChild, dataDir),
      /Application data directory cannot be selected as a workspace folder/i,
    );

    // 6. Non-existent path is denied
    const nonExistent = path.join(root, "does-not-exist");
    assert.throws(
      () => validateWorkspaceFolder(nonExistent, dataDir),
      /does not exist or cannot be accessed/i,
    );

    // 7. Relative path is denied
    assert.throws(
      () => validateWorkspaceFolder("relative/path", dataDir),
      /Enter an absolute path/i,
    );

    // 8. Symlink pointing to forbidden directory (e.g. home) is rejected
    const symlinkToHome = path.join(root, "link-to-home");
    symlinkSync(homedir(), symlinkToHome);
    assert.throws(
      () => validateWorkspaceFolder(symlinkToHome, dataDir),
      /Choose a specific project folder/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stale bindings, revocation and deleted folders fail closed", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-stale-data-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-sec-stale-proj-"));

  try {
    const registry = new WorkspaceRegistry(dataDir);
    const project = await registry.createProject("Stale Test", projDir);

    // Bind session
    await registry.bindSession("chat-stale-1", {
      folder: projDir,
      projectId: project.id,
      mode: "copy_review",
    });
    const binding = registry.getBinding("chat-stale-1");
    assert.equal(binding?.accessState, "admitted");

    // Dispatch scope verifies successfully while valid
    const scope1 = registry.verifyDispatchScope("chat-stale-1");
    assert.equal(scope1.ok, true);

    // Dispatch scope rejects with stale revision
    const scopeStaleRev = registry.verifyDispatchScope("chat-stale-1", 999);
    assert.equal(scopeStaleRev.ok, false);
    assert.match(scopeStaleRev.error, /revision changed/i);

    // Unbind session - subsequent calls fail closed
    await registry.unbindSession("chat-stale-1");
    assert.equal(registry.getBinding("chat-stale-1"), undefined);
    assert.equal(registry.resolveEffectiveWorkspace("chat-stale-1"), "");
    const scopeUnbound = registry.verifyDispatchScope("chat-stale-1");
    assert.equal(scopeUnbound.ok, false);
    assert.match(scopeUnbound.error, /No folder workspace is bound/i);

    // Re-bind session 2, then delete folder from disk
    await registry.bindSession("chat-stale-2", {
      folder: projDir,
      projectId: project.id,
      mode: "copy_review",
    });
    rmSync(projDir, { recursive: true, force: true });

    // Revalidation detects missing folder and marks binding invalid
    const reval = await registry.revalidateBindings();
    assert.equal(reval.valid, false);
    assert.equal(reval.staleSessions.includes("chat-stale-2"), true);

    const binding2 = registry.getBinding("chat-stale-2");
    assert.equal(binding2?.accessState, "missing");

    // Effective workspace throws on invalid/missing binding
    assert.throws(() => registry.resolveEffectiveWorkspace("chat-stale-2"), /Folder workspace access is missing/i);

    // Dispatch scope rejects invalid/missing binding
    const scopeInvalid = registry.verifyDispatchScope("chat-stale-2");
    assert.equal(scopeInvalid.ok, false);
    assert.match(scopeInvalid.error, /Folder workspace access is missing/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cross-chat Realm ID injection is strictly rejected in registry", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-cross-data-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-sec-cross-proj-"));

  try {
    const registry = new WorkspaceRegistry(dataDir);
    const project = await registry.createProject("Cross Chat Test", projDir);

    await registry.bindSession("chat-A", { folder: projDir, projectId: project.id });
    await registry.bindSession("chat-B", { folder: projDir, projectId: project.id });

    // Allocate Realm for chat-A
    await registry.setRealmId("chat-A", "realm-aaa111");
    // Allocate Realm for chat-B
    await registry.setRealmId("chat-B", "realm-bbb222");

    // chat-A accessing chat-A realm is allowed
    const aCheck = registry.verifySessionRealmAccess("chat-A", "realm-aaa111");
    assert.equal(aCheck.ok, true);

    // chat-B attempting to access chat-A realm is denied
    const crossCheck = registry.verifySessionRealmAccess("chat-B", "realm-aaa111");
    assert.equal(crossCheck.ok, false);
    assert.match(crossCheck.error, /does not belong to session/i);

    // chat-A attempting to access arbitrary unallocated realm is denied
    const unallocatedCheck = registry.verifySessionRealmAccess("chat-A", "realm-random999");
    assert.equal(unallocatedCheck.ok, false);

    // Unbound chat attempting to access any realm is denied
    const unboundCheck = registry.verifySessionRealmAccess("chat-unbound", "realm-aaa111");
    assert.equal(unboundCheck.ok, false);
    assert.match(unboundCheck.error, /No workspace binding found/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("cross-chat Realm operations through server endpoints are rejected with 403", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-srv-data-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-sec-srv-proj-"));
  writeFileSync(path.join(projDir, "file.txt"), "hello world\n");

  const app = await startAppServer({
    dataDir,
    access: "open",
    sandboxBin: helper,
  });

  const api = async (route: string, method = "GET", value?: unknown) => {
    const res = await app.request(
      new Request(`http://localhost${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
    return { status: res.status, ok: res.ok, body: await res.json() as any };
  };

  try {
    // Bind session-A and session-B to projDir
    await api("/api/workspaces/bindings/session-A", "POST", { folder: projDir });
    await api("/api/workspaces/bindings/session-B", "POST", { folder: projDir });

    // Ensure realm for session-A
    const ensureA = await api("/api/workspaces/bindings/session-A/realm/ensure", "POST");
    assert.equal(ensureA.status, 200);
    const realmA = ensureA.body.realmId;
    assert.ok(realmA);

    // Ensure realm for session-B
    const ensureB = await api("/api/workspaces/bindings/session-B/realm/ensure", "POST");
    assert.equal(ensureB.status, 200);
    const realmB = ensureB.body.realmId;
    assert.ok(realmB);
    assert.notEqual(realmA, realmB);

    // 1. Session-B endpoint with Session-A realmId in query is rejected with 403
    const revRes = await api(`/api/workspaces/bindings/session-B/realm/review?realmId=${realmA}`, "GET");
    assert.equal(revRes.status, 403);
    assert.match(revRes.body.error, /Cross-chat Realm access denied/i);

    // 2. Session-B apply with Session-A realmId in body is rejected with 403
    const applyRes = await api("/api/workspaces/bindings/session-B/realm/apply", "POST", {
      realmId: realmA,
      fingerprint: "0".repeat(64),
      paths: ["file.txt"],
    });
    assert.equal(applyRes.status, 403);
    assert.match(applyRes.body.error, /Cross-chat Realm access denied/i);

    // 3. Session-B undo with Session-A realmId in body is rejected with 403
    const undoRes = await api("/api/workspaces/bindings/session-B/realm/undo", "POST", {
      realmId: realmA,
      transactionId: "tx-dummy",
      paths: ["file.txt"],
    });
    assert.equal(undoRes.status, 403);
    assert.match(undoRes.body.error, /Cross-chat Realm access denied/i);

    // 4. Testing SandboxRealms.execute with session-B context attempting realmA
    await app.workspaces?.withSession("session-B", async () => {
      await assert.rejects(
        async () => {
          await app.realms?.execute("snapshot_realm", { realmId: realmA });
        },
        /Access denied: Realm '.*' does not belong to session 'session-B'/i,
      );

      await assert.rejects(
        async () => {
          await app.realms?.execute("promote_realm", {
            realmId: realmA,
            fingerprint: "0".repeat(64),
            paths: ["file.txt"],
          });
        },
        /Access denied: Realm '.*' does not belong to session 'session-B'/i,
      );
    });
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("environment scrubbing prevents leaking sensitive variables to sandboxed command", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-env-data-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-sec-env-proj-"));

  // Set sensitive variables in parent environment
  process.env.OPENAI_API_KEY = "mock-sensitive-openai-secret-key-12345";
  process.env.TELEGRAM_BOT_TOKEN = "mock-telegram-bot-token-987654321";
  process.env.VAK_SIDE_KEY = "sidecar-private-token-98765";

  const app = await startAppServer({
    dataDir,
    access: "open",
    sandboxBin: helper,
  });

  try {
    const project = await app.workspaces?.createProject("Env Scrub Test", projDir);
    await app.workspaces?.bindSession("env-session", {
      folder: projDir,
      projectId: project!.id,
      mode: "copy_review",
    });

    // Ensure realm for env-session
    const ensureRes = await app.request(
      new Request("http://localhost/api/workspaces/bindings/env-session/realm/ensure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(ensureRes.status, 200);
    const { realmId } = await ensureRes.json() as any;

    // Execute /usr/bin/env in realm
    const runRes = await app.realms?.exec(realmId, "/usr/bin/env", []);
    const stdout = runRes?.result?.stdout ?? "";

    assert.ok(stdout.length > 0, "Expected output from /usr/bin/env");
    assert.equal(stdout.includes("OPENAI_API_KEY"), false, "OPENAI_API_KEY must not leak to sandbox");
    assert.equal(stdout.includes("TELEGRAM_BOT_TOKEN"), false, "TELEGRAM_BOT_TOKEN must not leak to sandbox");
    assert.equal(stdout.includes("VAK_SIDE_KEY"), false, "VAK_SIDE_KEY must not leak to sandbox");
    assert.equal(stdout.includes("mock-sensitive"), false, "Secret values must not leak to sandbox");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.VAK_SIDE_KEY;
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("network connection is denied inside seatbelt sandbox execution", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-sec-net-data-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-sec-net-proj-"));

  try {
    // Attempt outbound TCP connection via nc inside runSandboxCommand
    // Seatbelt sandbox denies network socket operations
    const netRes = await runSandboxCommand(
      helper,
      projDir,
      "/usr/bin/nc",
      ["-z", "-w", "1", "1.1.1.1", "80"],
      projDir,
      5000,
    );

    // Should fail with non-zero exit code due to network denial
    assert.notEqual(netRes.code, 0, "Network command should fail in sandbox");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("missing or invalid sandbox helper fails closed without executing", async () => {
  const missingBin = path.join(tmpdir(), "nonexistent-vaksb-binary");
  const dummyDir = mkdtempSync(path.join(tmpdir(), "vak-sec-missing-"));
  const refusal = process.platform === "darwin"
    ? /supervised sandbox helper is required/i
    : /OS-isolated command execution requires macOS\. No command was run\./i;
  const realmRefusal = process.platform === "darwin"
    ? /supervised sandbox helper is required|ENOENT/i
    : /Realm execution requires macOS Seatbelt\./i;

  try {
    await assert.rejects(
      async () => {
        await runSandboxCommand(missingBin, dummyDir, "/bin/echo", ["hello"]);
      },
      refusal,
    );

    const realms = new SandboxRealms({
      binaryPath: missingBin,
      enabled: () => true,
      workspace: () => dummyDir,
      dataDir: dummyDir,
    });

    await assert.rejects(
      async () => {
        await realms.list();
      },
      realmRefusal,
    );
  } finally {
    rmSync(dummyDir, { recursive: true, force: true });
  }
});

test("workspace scope is conveyed to folder-workspace skill and instructions in bound sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-ws-context-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "vak-ws-proj-"));
  const app = await startAppServer({
    dataDir: dir,
    transcriptsDir: path.join(dir, "transcripts"),
    access: "open",
    port: 0,
    transport: "http",
  });

  const api = async (route: string, method = "GET", value?: unknown) => {
    const res = await app.request(
      new Request(`http://localhost${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
    return { status: res.status, ok: res.ok, body: (await res.json()) as any };
  };

  try {
    // 1. Bind session-bound to projDir
    await api("/api/workspaces/bindings/session-bound", "POST", { folder: projDir, mode: "copy_review" });

    const b = app.workspaces?.getBinding("session-bound");
    assert.ok(b);
    assert.equal(b.accessState, "admitted");

    // 2. Test Skills.tools with workspace scope resolver
    const skills = new Skills(dir);
    const tools = skills.tools({
      session: "session-bound",
      getWorkspaceScope: (sess) => {
        const binding = app.workspaces?.getBinding(sess);
        if (!binding) return "No project folder is admitted for this chat session.";
        return `Admitted project folder: "${binding.folder}"\nMode: ${binding.mode}`;
      },
    });
    const useSkill = tools.find((t) => t.spec.name === "use_skill");
    assert.ok(useSkill);

    // Call use_skill with folder-workspace
    const outBound = await useSkill.execute({ names: ["folder-workspace"] }, { callId: "c1" });
    assert.match(String(outBound), /Admitted project folder/);
    assert.match(String(outBound), new RegExp(projDir));
    assert.match(String(outBound), /copy_review/);

    // Call use_skill for unbound session
    const toolsUnbound = skills.tools({
      session: "session-unbound",
      getWorkspaceScope: (sess) => {
        const binding = app.workspaces?.getBinding(sess);
        if (!binding) return "No project folder is admitted for this chat session.";
        return `Admitted project folder: "${binding.folder}"\nMode: ${binding.mode}`;
      },
    });
    const useSkillUnbound = toolsUnbound.find((t) => t.spec.name === "use_skill");
    const outUnbound = await useSkillUnbound!.execute({ names: ["folder-workspace"] }, { callId: "c2" });
    assert.match(String(outUnbound), /No project folder is admitted/);
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});
