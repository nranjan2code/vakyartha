import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SandboxPoolManager } from "../sidecar/sandbox-pool/pool-manager.ts";

test("sandbox worker pool boots with pre-warmed standby runner and leases slots", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-pool-test-"));
  const pool = new SandboxPoolManager({
    maxActiveWorkers: 2,
    standbyWorkers: 1,
    idleTimeoutMs: 1000,
    hibernationTimeoutMs: 2000,
  });

  t.after(async () => {
    await pool.shutdown(2000);
    rmSync(tmp, { recursive: true, force: true });
  });

  await pool.start();

  // 1. Verify pre-warmed standby runner exists
  const initialSnap = pool.getFleetSnapshot();
  assert.equal(initialSnap.standbyCount, 1, "Expected 1 standby worker in pool");
  assert.equal(initialSnap.activeCount, 0, "Expected 0 active workers initially");

  // 2. Lease slot to tenant-1
  const ws1 = path.join(tmp, "chats", "chat-1", "workspace");
  const slot1 = await pool.lease("chat-1", "chat", ws1);
  assert.equal(slot1.tenantId, "chat-1");
  assert.equal(slot1.state, "active");

  const leasedSnap = pool.getFleetSnapshot();
  assert.equal(leasedSnap.activeCount, 1);

  // 3. Dispatch an interactive action to tenant-1
  const patch = await pool.dispatchAction("chat-1", "slider-risk", 75, "change");
  assert.equal(patch.controlId, "slider-risk");
  assert.equal(patch.value, 75);

  // 4. Verify state persistence on hibernation
  await pool.hibernate(slot1.slotId);
  const statePath = path.join(ws1, "state.json");
  assert.ok(existsSync(statePath), "Expected state.json to be flushed to disk upon hibernation");
  const savedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(savedState.state["slider-risk"], 75);

  // 5. Wake tenant-1 and verify state rehydration
  const rehydratedSlot = await pool.wake("chat-1");
  assert.equal(rehydratedSlot.tenantId, "chat-1");
  assert.equal(rehydratedSlot.state, "active");
});

test("sandbox worker pool enforces LRU slot eviction under concurrency pressure", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-pool-lru-"));
  const pool = new SandboxPoolManager({
    maxActiveWorkers: 2, // Maximum 2 active slots
    standbyWorkers: 1,
  });

  t.after(async () => {
    await pool.shutdown(2000);
    rmSync(tmp, { recursive: true, force: true });
  });

  await pool.start();

  // Lease 2 active slots (fills capacity)
  const wsA = path.join(tmp, "apps", "app-a", "workspace");
  const wsB = path.join(tmp, "apps", "app-b", "workspace");
  const wsC = path.join(tmp, "apps", "app-c", "workspace");

  await pool.lease("app-a", "app", wsA);
  await new Promise((r) => setTimeout(r, 50));
  await pool.lease("app-b", "app", wsB);

  const snapBefore = pool.getFleetSnapshot();
  assert.equal(snapBefore.activeCount, 2);

  // Lease a 3rd tenant: exceeds maxActiveWorkers (2) -> App A (LRU) must be evicted & hibernated
  await pool.lease("app-c", "app", wsC);

  const snapAfter = pool.getFleetSnapshot();
  assert.equal(snapAfter.activeCount, 2, "Active count must remain bounded at maxActiveWorkers");
  assert.equal(snapAfter.hibernatedCount, 1, "App A must be recorded as hibernated");

  // State of App A must be written to disk
  assert.ok(existsSync(path.join(wsA, "state.json")), "App A state must be written to disk upon LRU eviction");
});

test("sandbox worker pool coordinates workstation suspend, wake, and graceful shutdown", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-pool-lifecycle-"));
  const pool = new SandboxPoolManager({
    maxActiveWorkers: 2,
    standbyWorkers: 1,
  });

  await pool.start();

  const ws = path.join(tmp, "chats", "chat-life", "workspace");
  await pool.lease("chat-life", "chat", ws);

  // 1. Test Suspend (Lid Close / Sleep)
  await pool.suspendAll();
  const suspendedSnap = pool.getFleetSnapshot();
  assert.ok(suspendedSnap.slots.some((s) => s.state === "suspended"));

  // 2. Test Wake and Reconcile (Lid Open)
  await pool.wakeAndReconcile();
  const wakeSnap = pool.getFleetSnapshot();
  assert.ok(wakeSnap.slots.some((s) => s.state === "active" && s.tenantId === "chat-life"));

  // 3. Test Graceful Shutdown Waterfall
  await pool.shutdown(2000);
  const finalSnap = pool.getFleetSnapshot();
  assert.equal(finalSnap.slots.length, 0, "All slots must be cleaned up after shutdown");

  rmSync(tmp, { recursive: true, force: true });
});

