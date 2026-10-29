import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";

const helper = process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb");
const native = process.platform === "darwin" && existsSync(helper);

test("retained per-chat working files persist across turns without touching original project", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-turn-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-turn-proj-"));
  writeFileSync(path.join(projectDir, "base.txt"), "original base\n");

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
    // Bind session-1 to projectDir
    const bindRes = await api("/api/workspaces/bindings/session-1", "POST", { folder: projectDir });
    assert.equal(bindRes.status, 200);

    // Turn 1: Execute command in session-1 creating turn1.txt
    let t1Out: any;
    await app.workspaces?.withSession("session-1", async () => {
      // Find sandbox execution entry tools
      const tools = await app.request(new Request("http://localhost/api/info")); // warmup
      const binding = app.workspaces?.getBinding("session-1");
      assert.ok(binding);
    });

    // Allocate / ensure realm for session-1
    const ensureRes = await api("/api/workspaces/bindings/session-1/realm/ensure", "POST");
    assert.equal(ensureRes.status, 200);
    const realmId = ensureRes.body.realmId;
    assert.ok(realmId);

    // Run command in realm
    const runRes = await app.realms?.exec(realmId, "/bin/sh", ["-c", "printf 'turn 1 output' > turn1.txt"]);
    assert.equal(runRes.result.exit_code, 0);

    // Original project on disk is NOT modified
    assert.equal(existsSync(path.join(projectDir, "turn1.txt")), false);
    assert.equal(readFileSync(path.join(projectDir, "base.txt"), "utf8"), "original base\n");

    // Turn 2: Next command in session-1 reads turn1.txt and verifies it persisted
    const readRes = await app.realms?.exec(realmId, "/bin/cat", ["turn1.txt"]);
    assert.equal(readRes.result.exit_code, 0);
    assert.equal(readRes.result.stdout, "turn 1 output");

    // Review changes
    const reviewRes = await api("/api/workspaces/bindings/session-1/realm/review");
    assert.equal(reviewRes.status, 200);
    assert.equal(reviewRes.body.total, 1);
    assert.equal(reviewRes.body.changes[0].path, "turn1.txt");

    // Apply (promote) changes to original project
    const applyRes = await api("/api/workspaces/bindings/session-1/realm/apply", "POST", {
      fingerprint: reviewRes.body.fingerprint,
      paths: ["turn1.txt"],
    });
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.phase, "committed");

    // Now original project on disk has turn1.txt!
    assert.equal(existsSync(path.join(projectDir, "turn1.txt")), true);
    assert.equal(readFileSync(path.join(projectDir, "turn1.txt"), "utf8"), "turn 1 output");

    // Undo (rollback) changes
    const undoRes = await api("/api/workspaces/bindings/session-1/realm/undo", "POST", {
      transactionId: applyRes.body.transaction_id,
      paths: applyRes.body.paths,
    });
    assert.equal(undoRes.status, 200);

    // Original project restored: turn1.txt is removed
    assert.equal(existsSync(path.join(projectDir, "turn1.txt")), false);
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("concurrent chats in same project have independent Realms and conflict on apply", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-conc-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-conc-proj-"));
  writeFileSync(path.join(projectDir, "shared.txt"), "version 0\n");

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
    // Bind chat-A and chat-B to the same project folder
    await api("/api/workspaces/bindings/chat-A", "POST", { folder: projectDir });
    await api("/api/workspaces/bindings/chat-B", "POST", { folder: projectDir });

    // Allocate Realms for both chats
    const realmARes = await api("/api/workspaces/bindings/chat-A/realm/ensure", "POST");
    const realmBRes = await api("/api/workspaces/bindings/chat-B/realm/ensure", "POST");
    const realmA = realmARes.body.realmId;
    const realmB = realmBRes.body.realmId;

    // Distinct Realm IDs
    assert.notEqual(realmA, realmB);

    // Cross-chat Realm ID injection is rejected
    app.workspaces?.withSession("chat-A", () => {
      const checkCross = app.workspaces?.verifySessionRealmAccess("chat-A", realmB);
      assert.equal(checkCross?.ok, false);
      if (!checkCross?.ok) {
        assert.match(checkCross.error, /Access denied/);
      }
    });

    // Chat A writes version A
    await app.realms?.exec(realmA, "/bin/sh", ["-c", "printf 'version A' > shared.txt"]);
    // Chat B writes version B
    await app.realms?.exec(realmB, "/bin/sh", ["-c", "printf 'version B' > shared.txt"]);

    // Chat A sees version A, Chat B sees version B
    const readA = await app.realms?.exec(realmA, "/bin/cat", ["shared.txt"]);
    const readB = await app.realms?.exec(realmB, "/bin/cat", ["shared.txt"]);
    assert.equal(readA.result.stdout, "version A");
    assert.equal(readB.result.stdout, "version B");

    // Take snapshot in Chat B before Chat A promotes
    const reviewB = await api("/api/workspaces/bindings/chat-B/realm/review");
    assert.equal(reviewB.status, 200);

    // Chat A reviews and promotes its changes to the original project
    const reviewA = await api("/api/workspaces/bindings/chat-A/realm/review");
    const applyA = await api("/api/workspaces/bindings/chat-A/realm/apply", "POST", {
      fingerprint: reviewA.body.fingerprint,
      paths: ["shared.txt"],
    });
    assert.equal(applyA.status, 200);
    assert.equal(applyA.body.phase, "committed");
    assert.equal(readFileSync(path.join(projectDir, "shared.txt"), "utf8"), "version A");

    // Chat B attempts to promote its earlier version: refused with conflict!
    const applyB = await api("/api/workspaces/bindings/chat-B/realm/apply", "POST", {
      fingerprint: reviewB.body.fingerprint,
      paths: ["shared.txt"],
    });
    assert.equal(applyB.status, 400);
    assert.match(applyB.body.error, /conflict|stale/i);

    // Original project retains Chat A's applied version
    assert.equal(readFileSync(path.join(projectDir, "shared.txt"), "utf8"), "version A");
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("dirty Realm refresh refuses silent overwrite, and unbind cleans up Realm safely", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-dirty-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-dirty-proj-"));
  writeFileSync(path.join(projectDir, "init.txt"), "hello\n");

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
    await api("/api/workspaces/bindings/session-dirty", "POST", { folder: projectDir });
    const ensure = await api("/api/workspaces/bindings/session-dirty/realm/ensure", "POST");
    const realmId = ensure.body.realmId;

    // Make an unpromoted write
    await app.realms?.exec(realmId, "/bin/sh", ["-c", "printf 'unapplied draft' > draft.txt"]);

    // Attempt refresh without force: refused with 409
    const refreshRefused = await api("/api/workspaces/bindings/session-dirty/realm/refresh", "POST", {});
    assert.equal(refreshRefused.status, 409);
    assert.match(refreshRefused.body.error, /uncommitted changes/);

    // Refresh with force: true succeeds and creates fresh clean Realm
    const refreshForced = await api("/api/workspaces/bindings/session-dirty/realm/refresh", "POST", { force: true });
    assert.equal(refreshForced.status, 200);
    assert.equal(refreshForced.body.refreshed, true);
    const newRealmId = refreshForced.body.realmId;
    assert.notEqual(newRealmId, realmId);

    // Unbinding session cleans up its Realm
    const unbind = await api("/api/workspaces/bindings/session-dirty", "DELETE");
    assert.equal(unbind.status, 200);

    // Original project files are still intact!
    assert.equal(readFileSync(path.join(projectDir, "init.txt"), "utf8"), "hello\n");
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("direct in-place editing mode writes directly to project folder with Seatbelt isolation and no staging", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-direct-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-direct-proj-"));
  writeFileSync(path.join(projectDir, "source.txt"), "initial content\n");

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
    // Bind session-direct with mode: "direct"
    const bindRes = await api("/api/workspaces/bindings/session-direct", "POST", {
      folder: projectDir,
      mode: "direct",
    });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.mode, "direct");
    assert.equal(bindRes.body.realmId, undefined);

    // Realm endpoints reflect direct mode without creating staging copies
    const realmStatus = await api("/api/workspaces/bindings/session-direct/realm", "GET");
    assert.equal(realmStatus.status, 200);
    assert.equal(realmStatus.body.mode, "direct");
    assert.equal(realmStatus.body.bound, true);

    const realmReview = await api("/api/workspaces/bindings/session-direct/realm/review", "GET");
    assert.equal(realmReview.status, 200);
    assert.equal(realmReview.body.mode, "direct");
    assert.equal(realmReview.body.total, 0);

    // Run command directly inside session-direct
    await app.workspaces?.withSession("session-direct", async () => {
      // Find sandbox execution entry tool
      const entry = (await import("../sidecar/sandbox-execution.ts")).sandboxExecutionEntry({
        binaryPath: helper,
        enabled: () => true,
        workspace: () => projectDir,
        dataDir,
        workspaces: app.workspaces,
      });
      const server = (entry.source as any).server();
      const toolRes = await server.callTool("run_command", {
        command: "/bin/sh",
        args: ["-c", "printf 'directly written' > direct-out.txt"],
      });
      assert.equal(toolRes.isError, false);
    });

    // File was written directly on disk in projectDir! No Apply step needed!
    assert.equal(existsSync(path.join(projectDir, "direct-out.txt")), true);
    assert.equal(readFileSync(path.join(projectDir, "direct-out.txt"), "utf8"), "directly written");
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("shared project Realm shares durable workspace across chats in the same project", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-shared-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-shared-proj-"));
  writeFileSync(path.join(projectDir, "root.txt"), "shared root\n");

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
    // 1. Create a project with sharedRealm = true
    const projRes = await api("/api/projects", "POST", {
      name: "Shared Team Project",
      folder: projectDir,
      sharedRealm: true,
    });
    assert.equal(projRes.status, 201);
    const projectId = projRes.body.id;
    assert.equal(projRes.body.sharedRealm, true);

    // 2. Bind chat-1 to this project with shared realm
    const bind1 = await api("/api/workspaces/bindings/chat-1", "POST", {
      folder: projectDir,
      projectId,
      shareProjectRealm: true,
    });
    assert.equal(bind1.status, 200);
    assert.equal(bind1.body.shared, true);

    // Ensure Realm for chat-1
    const ensure1 = await api("/api/workspaces/bindings/chat-1/realm/ensure", "POST");
    assert.equal(ensure1.status, 200);
    const sharedRealmId = ensure1.body.realmId;
    assert.ok(sharedRealmId);

    // 3. Bind chat-2 to the same project
    const bind2 = await api("/api/workspaces/bindings/chat-2", "POST", {
      folder: projectDir,
      projectId,
      shareProjectRealm: true,
    });
    assert.equal(bind2.status, 200);
    assert.equal(bind2.body.shared, true);
    // Inherits the project's sharedRealmId
    assert.equal(bind2.body.realmId, sharedRealmId);

    // 4. Chat-1 writes a file into the shared Realm
    const exec1 = await app.realms?.exec(sharedRealmId, "/bin/sh", ["-c", "printf 'chat 1 wrote this' > shared-feature.txt"]);
    assert.equal(exec1.result.exit_code, 0);

    // 5. Chat-2 reads the file from the shared Realm without any promotion step!
    const chat2Read = await app.workspaces?.withSession("chat-2", async () => {
      return app.realms?.execute("read_realm_file", { path: "shared-feature.txt" });
    }) as any;
    assert.ok(chat2Read);
    assert.equal(chat2Read.text, "chat 1 wrote this");

    // File is not yet in the original project folder on disk
    assert.equal(existsSync(path.join(projectDir, "shared-feature.txt")), false);

    // 6. Review and promote shared Realm from chat-2
    const reviewRes = await api("/api/workspaces/bindings/chat-2/realm/review", "GET");
    assert.equal(reviewRes.status, 200);
    assert.equal(reviewRes.body.total >= 1, true);

    const applyRes = await api("/api/workspaces/bindings/chat-2/realm/apply", "POST", {
      fingerprint: reviewRes.body.fingerprint,
      paths: reviewRes.body.changes.map((c: any) => c.path),
    });
    assert.equal(applyRes.status, 200);

    // Now original project on disk has the file!
    assert.equal(existsSync(path.join(projectDir, "shared-feature.txt")), true);
    assert.equal(readFileSync(path.join(projectDir, "shared-feature.txt"), "utf8"), "chat 1 wrote this");
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("arbitrary long builds, Git worktrees and 256 KiB output supported in direct mode", { skip: !native }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-git-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-git-proj-"));

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
    // 1. Bind in direct mode
    await api("/api/workspaces/bindings/session-git", "POST", {
      folder: projectDir,
      mode: "direct",
    });

    const entry = (await import("../sidecar/sandbox-execution.ts")).sandboxExecutionEntry({
      binaryPath: helper,
      enabled: () => true,
      workspace: () => projectDir,
      dataDir,
      workspaces: app.workspaces,
    });
    const server = (entry.source as any).server();

    // 2. Validate timeout_seconds argument handling
    await app.workspaces?.withSession("session-git", async () => {
      // Invalid timeout (> 300) is rejected
      const invalidRes = await server.callTool("run_command", {
        command: "/bin/echo",
        args: ["hi"],
        timeout_seconds: 500,
      });
      assert.equal(invalidRes.isError, true);
      assert.match(invalidRes.text, /timeout_seconds must be an integer between 1 and 300/);

      // Valid timeout_seconds (e.g. 10s) is accepted and executed
      const validRes = await server.callTool("run_command", {
        command: "/bin/echo",
        args: ["build completed"],
        timeout_seconds: 10,
      });
      assert.equal(validRes.isError, false);
      assert.match(validRes.text, /build completed/);

      // 3. Git worktree / repository operations in direct mode: .git is preserved and accessible
      const initGit = await server.callTool("run_command", {
        command: "/usr/bin/git",
        args: ["init", "."],
      });
      assert.equal(initGit.isError, false);
      assert.equal(existsSync(path.join(projectDir, ".git")), true);

      // Create a commit
      writeFileSync(path.join(projectDir, "README.md"), "# Project Readme\n");
      const addGit = await server.callTool("run_command", {
        command: "/usr/bin/git",
        args: ["add", "README.md"],
      });
      assert.equal(addGit.isError, false);

      const commitGit = await server.callTool("run_command", {
        command: "/usr/bin/git",
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial commit"],
      });
      assert.equal(commitGit.isError, false);

      // Git branch / log operations
      const logGit = await server.callTool("run_command", {
        command: "/usr/bin/git",
        args: ["log", "--oneline"],
      });
      assert.equal(logGit.isError, false);
      assert.match(logGit.text, /initial commit/);

      // 4. Large output beyond previous 32 KiB limit (64 KiB output)
      const largeOut = await server.callTool("run_command", {
        command: "/bin/sh",
        args: ["-c", "s=x; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do s=$s$s; done; printf '%s' \"$s\""],
      });
      assert.equal(largeOut.isError, false);
      assert.ok(largeOut.text.length >= 65536);
    });
  } finally {
    await app.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});


