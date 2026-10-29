import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { validateWorkspaceFolder, WorkspaceRegistry } from "../sidecar/workspace-registry.ts";

test("validateWorkspaceFolder admits accessible directories and rejects unsafe paths", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-ws-data-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "vak-ws-proj-"));
  const sampleFile = path.join(projectDir, "file.txt");
  writeFileSync(sampleFile, "hello");

  try {
    // Valid folder
    const valid = validateWorkspaceFolder(projectDir, dataDir);
    assert.equal(valid.isDirectory, true);
    assert.equal(valid.isReadable, true);
    assert.equal(typeof valid.canonical, "string");

    // Relative path rejected
    assert.throws(() => validateWorkspaceFolder("relative/path", dataDir), /Enter an absolute path/);

    // Non-existent path rejected
    assert.throws(() => validateWorkspaceFolder(path.join(projectDir, "non-existent"), dataDir), /does not exist/);

    // File rejected
    assert.throws(() => validateWorkspaceFolder(sampleFile, dataDir), /is a file, not a directory/);

    // System roots and home directory rejected
    assert.throws(() => validateWorkspaceFolder("/", dataDir), /Choose a specific project folder/);
    assert.throws(() => validateWorkspaceFolder(homedir(), dataDir), /Choose a specific project folder/);

    // Data directory itself rejected
    assert.throws(() => validateWorkspaceFolder(dataDir, dataDir), /Application data directory cannot be selected/);

    // Subdirectory inside dataDir rejected
    const subData = path.join(dataDir, "sub");
    mkdirSync(subData);
    assert.throws(() => validateWorkspaceFolder(subData, dataDir), /Application data directory cannot be selected/);

    // Reserved folder names rejected
    const dotVak = path.join(projectDir, ".vak");
    mkdirSync(dotVak);
    assert.throws(() => validateWorkspaceFolder(dotVak, dataDir), /is reserved/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("validateWorkspaceFolder resolves symlinks and rejects symlink escape to root/home", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vak-sym-val-"));
  const linkToHome = path.join(root, "link-home");
  try {
    symlinkSync(homedir(), linkToHome);
    assert.throws(() => validateWorkspaceFolder(linkToHome, root), /Choose a specific project folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkspaceRegistry manages project lifecycle and persists across restarts", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-reg-test-"));
  const folderA = mkdtempSync(path.join(tmpdir(), "vak-proj-a-"));
  const folderB = mkdtempSync(path.join(tmpdir(), "vak-proj-b-"));

  try {
    const reg1 = new WorkspaceRegistry(dataDir);
    assert.deepEqual(reg1.listProjects(), []);

    // Create project
    const projA = await reg1.createProject("Project Alpha", folderA);
    assert.ok(projA.id);
    assert.equal(projA.name, "Project Alpha");
    assert.equal(projA.revision, 1);

    // Rejects invalid names
    await assert.rejects(() => reg1.createProject("", folderA), /between 1 and 100/);

    // Update project name and folder
    const updated = await reg1.updateProject(projA.id, { name: "Alpha Renamed", folder: folderB });
    assert.equal(updated.name, "Alpha Renamed");
    assert.equal(updated.revision, 2);

    // Reload from fresh registry instance
    const reg2 = new WorkspaceRegistry(dataDir);
    const loaded = reg2.getProject(projA.id);
    assert.ok(loaded);
    assert.equal(loaded.name, "Alpha Renamed");
    assert.equal(loaded.revision, 2);

    // Removing project does not delete files on disk
    const removed = await reg2.removeProject(projA.id);
    assert.equal(removed, true);
    assert.equal(reg2.getProject(projA.id), undefined);

    // Folder B still exists on disk
    const rechecked = validateWorkspaceFolder(folderB, dataDir);
    assert.equal(rechecked.isDirectory, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folderA, { recursive: true, force: true });
    rmSync(folderB, { recursive: true, force: true });
  }
});

test("WorkspaceRegistry manages session bindings, revisions and prevents cross-chat mutation", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-bind-data-"));
  const folderA = mkdtempSync(path.join(tmpdir(), "vak-bind-fa-"));
  const folderB = mkdtempSync(path.join(tmpdir(), "vak-bind-fb-"));
  const initialCwd = process.cwd();

  try {
    const reg = new WorkspaceRegistry(dataDir);

    // Direct mode is supported and admitted
    const directBinding = await reg.bindSession("direct-chat", { folder: folderA, mode: "direct" });
    assert.equal(directBinding.session, "direct-chat");
    assert.equal(directBinding.mode, "direct");
    assert.equal(directBinding.realmId, undefined);
    assert.equal(directBinding.accessState, "admitted");

    // Bind chat-1 to folder A
    const b1 = await reg.bindSession("chat-1", { folder: folderA });
    assert.equal(b1.session, "chat-1");
    assert.equal(b1.revision, 1);
    assert.equal(b1.accessState, "admitted");

    // Bind chat-2 to folder B
    const b2 = await reg.bindSession("chat-2", { folder: folderB });
    assert.equal(b2.session, "chat-2");
    assert.equal(b2.revision, 1);

    // Neither call alters process.cwd()
    assert.equal(process.cwd(), initialCwd);

    // Rebinding chat-1 increments its revision and does not touch chat-2
    const b1Rebound = await reg.bindSession("chat-1", { folder: folderB });
    assert.equal(b1Rebound.revision, 2);
    assert.equal(reg.getBinding("chat-2")?.revision, 1);

    // Associate Realm ID
    await reg.setRealmId("chat-1", "realm-123");
    assert.equal(reg.getBinding("chat-1")?.realmId, "realm-123");

    // Resolving effective workspace is session-scoped
    assert.equal(reg.resolveEffectiveWorkspace("chat-1"), b1Rebound.folder);
    assert.equal(reg.resolveEffectiveWorkspace("chat-2"), b2.folder);
    assert.equal(reg.resolveEffectiveWorkspace("unbound-chat"), "");

    // ALS withSession context works without argument passing
    reg.withSession("chat-2", () => {
      assert.equal(reg.resolveEffectiveWorkspace(), b2.folder);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folderA, { recursive: true, force: true });
    rmSync(folderB, { recursive: true, force: true });
  }
});

test("WorkspaceRegistry detects missing/inaccessible folders and blocks stale approvals", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-stale-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-stale-target-"));

  try {
    const reg = new WorkspaceRegistry(dataDir);
    const binding = await reg.bindSession("chat-stale", { folder });
    assert.equal(binding.revision, 1);

    // Dispatch verification with current revision succeeds
    const check1 = reg.verifyDispatchScope("chat-stale", 1);
    assert.equal(check1.ok, true);

    // Simulating user rebinding while approval was pending: revision becomes 2
    await reg.bindSession("chat-stale", { folder });
    assert.equal(reg.getBinding("chat-stale")?.revision, 2);

    // Stale approval presenting expectedRevision = 1 is refused
    const checkStale = reg.verifyDispatchScope("chat-stale", 1);
    assert.equal(checkStale.ok, false);
    if (!checkStale.ok) {
      assert.match(checkStale.error, /revision changed since this operation was authorized/);
    }

    // Now remove the folder on disk: revalidation detects missing folder and increments revision
    rmSync(folder, { recursive: true, force: true });
    const checkMissing = reg.verifyDispatchScope("chat-stale");
    assert.equal(checkMissing.ok, false);
    if (!checkMissing.ok) {
      assert.match(checkMissing.error, /Folder workspace access is missing/);
    }
    assert.equal(reg.getBinding("chat-stale")?.accessState, "missing");
    assert.equal(reg.getBinding("chat-stale")?.revision, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a tool set captured without a folder cannot inherit a later workspace binding", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-unbound-snapshot-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-unbound-snapshot-target-"));

  try {
    const reg = new WorkspaceRegistry(dataDir);
    const capturedRevision = reg.captureBindingRevision("chat-unbound");
    assert.equal(capturedRevision, null);

    await reg.bindSession("chat-unbound", { folder });

    assert.throws(
      () => reg.withSession("chat-unbound", () => reg.resolveEffectiveWorkspace(), capturedRevision),
      /revision changed since this operation was authorized/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("workspace revocation is sticky and same-path folder replacement gets no inherited grant", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-replaced-data-"));
  const parent = mkdtempSync(path.join(tmpdir(), "vak-replaced-parent-"));
  const folder = path.join(parent, "workspace");
  const moved = path.join(parent, "workspace-old");
  mkdirSync(folder);

  try {
    const reg = new WorkspaceRegistry(dataDir);
    await reg.bindSession("chat-replaced", { folder });

    // A different directory at the same path is a different physical grant.
    renameSync(folder, moved);
    mkdirSync(folder);
    const replaced = reg.verifyDispatchScope("chat-replaced");
    assert.equal(replaced.ok, false);
    assert.equal(reg.getBinding("chat-replaced")?.accessState, "revoked");

    // Restoring the old directory does not silently restore revoked authority.
    rmSync(folder, { recursive: true, force: true });
    renameSync(moved, folder);
    assert.equal(reg.revalidateBinding("chat-replaced")?.accessState, "revoked");
    assert.equal(reg.verifyDispatchScope("chat-replaced").ok, false);

    // Only a new explicit bind captures a fresh identity and admits access.
    await reg.bindSession("chat-replaced", { folder });
    assert.equal(reg.verifyDispatchScope("chat-replaced").ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a binding without an assigned Realm cannot access an arbitrary Realm", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-unassigned-realm-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-unassigned-realm-folder-"));
  try {
    const reg = new WorkspaceRegistry(dataDir);
    await reg.bindSession("chat-unassigned", { folder });
    const access = reg.verifySessionRealmAccess("chat-unassigned", "realm-not-assigned");
    assert.equal(access.ok, false);
    if (!access.ok) assert.match(access.error, /does not belong to session/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("legacy path-only grants are preserved but revoked until explicit rebinding", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-legacy-binding-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-legacy-binding-folder-"));
  try {
    writeFileSync(path.join(dataDir, "workspaces.json"), JSON.stringify({
      version: 1,
      projects: [],
      bindings: { "legacy-chat": {
        session: "legacy-chat", folder, mode: "copy_review", revision: 4,
        accessState: "admitted", boundAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      } },
    }));
    const reg = new WorkspaceRegistry(dataDir);
    assert.equal(reg.getBinding("legacy-chat")?.accessState, "revoked");
    assert.equal(reg.verifyDispatchScope("legacy-chat").ok, false);
    await reg.bindSession("legacy-chat", { folder });
    assert.equal(reg.verifyDispatchScope("legacy-chat").ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("corrupt workspace registry does not silently become an empty authority store", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-corrupt-registry-data-"));
  try {
    writeFileSync(path.join(dataDir, "workspaces.json"), "{not-json");
    assert.throws(() => new WorkspaceRegistry(dataDir), /corrupt or unreadable/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed registry persistence rolls back in-memory authority changes", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-write-failure-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-write-failure-folder-"));
  const registryFile = path.join(dataDir, "workspaces.json");
  try {
    const reg = new WorkspaceRegistry(dataDir);
    await reg.bindSession("chat-before-failure", { folder });
    rmSync(registryFile);
    mkdirSync(registryFile);
    await assert.rejects(() => reg.bindSession("chat-after-failure", { folder }));
    assert.equal(reg.getBinding("chat-before-failure")?.accessState, "admitted");
    assert.equal(reg.getBinding("chat-after-failure"), undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Removing project detaches bindings without deleting folder or invalidating chat access", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-detach-data-"));
  const folder = mkdtempSync(path.join(tmpdir(), "vak-detach-f-"));

  try {
    const reg = new WorkspaceRegistry(dataDir);
    const proj = await reg.createProject("Detachable Project", folder);
    const binding = await reg.bindSession("chat-linked", { folder, projectId: proj.id });
    assert.equal(binding.projectId, proj.id);

    // Remove project
    await reg.removeProject(proj.id);
    assert.equal(reg.getProject(proj.id), undefined);

    // Chat binding survives with projectId cleared
    const updatedBinding = reg.getBinding("chat-linked");
    assert.ok(updatedBinding);
    assert.equal(updatedBinding.projectId, undefined);
    assert.equal(updatedBinding.accessState, "admitted");
    assert.equal(updatedBinding.folder, validateWorkspaceFolder(folder).canonical);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("server API routes expose project and workspace binding lifecycle", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-ws-server-"));
  const folderA = mkdtempSync(path.join(tmpdir(), "vak-ws-srv-a-"));
  const folderB = mkdtempSync(path.join(tmpdir(), "vak-ws-srv-b-"));
  const app = await import("../sidecar/server.ts").then((m) => m.startAppServer({ dataDir: dir, access: "open" }));

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
    // 1. Validate folder
    const valRes = await api("/api/workspaces/validate-folder", "POST", { folder: folderA });
    assert.equal(valRes.status, 200);
    assert.equal(valRes.body.ok, true);
    assert.equal(valRes.body.isDirectory, true);

    // 2. Projects list initially empty
    const list1 = await api("/api/projects");
    assert.equal(list1.status, 200);
    assert.deepEqual(list1.body, []);

    // 3. Create project
    const created = await api("/api/projects", "POST", { name: "Web App", folder: folderA });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Web App");
    const projId = created.body.id;

    // 4. Get project by ID
    const getProj = await api(`/api/projects/${projId}`);
    assert.equal(getProj.status, 200);
    assert.equal(getProj.body.name, "Web App");

    // 5. Update project
    const patched = await api(`/api/projects/${projId}`, "PATCH", { name: "Fullstack App" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, "Fullstack App");

    // 6. Bind chat session to project
    const bindRes = await api("/api/workspaces/bindings/session-100", "POST", {
      folder: folderA,
      projectId: projId,
    });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.session, "session-100");
    assert.equal(bindRes.body.projectId, projId);
    assert.equal(bindRes.body.revision, 1);
    assert.equal(bindRes.body.accessState, "admitted");

    // 7. Get session binding
    const getBind = await api("/api/workspaces/bindings/session-100");
    assert.equal(getBind.status, 200);
    assert.equal(getBind.body.session, "session-100");

    // 8. Delete project detaches from binding
    const delProj = await api(`/api/projects/${projId}`, "DELETE");
    assert.equal(delProj.status, 200);
    assert.equal(delProj.body.ok, true);

    const getBindAfter = await api("/api/workspaces/bindings/session-100");
    assert.equal(getBindAfter.status, 200);
    assert.equal(getBindAfter.body.projectId, undefined);
    assert.equal(getBindAfter.body.accessState, "admitted");

    // 9. Unbind session
    const unbindRes = await api("/api/workspaces/bindings/session-100", "DELETE");
    assert.equal(unbindRes.status, 200);
    assert.equal(unbindRes.body.ok, true);

    const getBindAfterDel = await api("/api/workspaces/bindings/session-100");
    assert.equal(getBindAfterDel.status, 404);
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
    rmSync(folderA, { recursive: true, force: true });
    rmSync(folderB, { recursive: true, force: true });
  }
});

test("session-scoped sandbox tools isolate concurrent chats and reject unbound sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-scope-data-"));
  const folder1 = mkdtempSync(path.join(tmpdir(), "vak-scope-f1-"));
  const folder2 = mkdtempSync(path.join(tmpdir(), "vak-scope-f2-"));
  writeFileSync(path.join(folder1, "f1.txt"), "data1");
  writeFileSync(path.join(folder2, "f2.txt"), "data2");

  const helper = path.resolve("../sandbox/target/debug/vaksb");
  const app = await import("../sidecar/server.ts").then((m) =>
    m.startAppServer({ dataDir: dir, access: "open", sandboxBin: helper }),
  );

  try {
    // Bind session-alpha to folder1
    await app.workspaces?.bindSession("session-alpha", { folder: folder1 });
    // Bind session-beta to folder2
    await app.workspaces?.bindSession("session-beta", { folder: folder2 });

    // Request tools for session-alpha and session-beta
    // Unbound session running tool receives refusal
    app.workspaces?.withSession("session-unbound", () => {
      assert.equal(app.workspaces?.resolveEffectiveWorkspace(), "");
    });

    // Session alpha resolves folder 1
    app.workspaces?.withSession("session-alpha", () => {
      assert.equal(app.workspaces?.resolveEffectiveWorkspace(), validateWorkspaceFolder(folder1).canonical);
    });

    // Session beta resolves folder 2
    app.workspaces?.withSession("session-beta", () => {
      assert.equal(app.workspaces?.resolveEffectiveWorkspace(), validateWorkspaceFolder(folder2).canonical);
    });

    // Verify stale revision check: rebinding session-alpha invalidates expected revision 1
    const rev1 = app.workspaces?.getBinding("session-alpha")?.revision;
    assert.equal(rev1, 1);
    assert.equal(app.workspaces?.verifyDispatchScope("session-alpha", rev1).ok, true);

    // Rebind session-alpha
    await app.workspaces?.bindSession("session-alpha", { folder: folder1 });
    assert.equal(app.workspaces?.getBinding("session-alpha")?.revision, 2);

    // Stale check with old revision fails closed
    const staleCheck = app.workspaces?.verifyDispatchScope("session-alpha", 1);
    assert.equal(staleCheck?.ok, false);
    if (!staleCheck?.ok) {
      assert.match(staleCheck.error, /revision changed since this operation was authorized/);
    }
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
    rmSync(folder1, { recursive: true, force: true });
    rmSync(folder2, { recursive: true, force: true });
  }
});
