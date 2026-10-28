// Sandbox Worker Pool Manager.
// Orchestrates multi-tenant worker leasing, pre-warmed standby runners,
// LRU hibernation, crash detection, and workstation lifecycle hooks.

import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  decodeIpcMessage,
  encodeIpcMessage,
  type FleetSnapshot,
  type IpcMessage,
  type PoolConfig,
  type WorkerSlotState,
  type WorkerSlotSummary,
  type WorkloadClass,
} from "../../shared/sandbox-pool.ts";

interface ActiveSlot {
  slotId: string;
  child: ChildProcess;
  state: WorkerSlotState;
  tenantId: string | null;
  workloadClass: WorkloadClass | null;
  workspaceDir: string | null;
  leasedAt: number | null;
  lastActiveAt: number | null;
  rssBytes: number;
  cpuPercent: number;
  pendingRequests: Map<string, { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
}

export class SandboxPoolManager extends EventEmitter {
  private readonly config: PoolConfig;
  private readonly slots = new Map<string, ActiveSlot>();
  private readonly hibernatedTenants = new Map<string, { workloadClass: WorkloadClass; workspaceDir: string; hibernatedAt: number }>();
  private slotCounter = 0;
  private isRunning = false;
  private idleCheckTimer?: NodeJS.Timeout;

  constructor(config: Partial<PoolConfig> = {}) {
    super();
    const candidateWorker = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs"),
      path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts"),
      path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox-pool", "worker.ts"),
      path.join(process.cwd(), "sidecar", "sandbox-pool", "worker.ts"),
      path.join(process.cwd(), "resources", "worker.mjs"),
    ].find((p) => existsSync(p));

    this.config = {
      maxActiveWorkers: config.maxActiveWorkers ?? 3,
      standbyWorkers: config.standbyWorkers ?? 1,
      idleTimeoutMs: config.idleTimeoutMs ?? 5 * 60_000,
      hibernationTimeoutMs: config.hibernationTimeoutMs ?? 15 * 60_000,
      maxWorkerRssBytes: config.maxWorkerRssBytes ?? 256 * 1024 * 1024,
      nodeBin: config.nodeBin ?? process.execPath,
      workerScript: config.workerScript ?? candidateWorker ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts"),
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.replenishStandby();

    this.idleCheckTimer = setInterval(() => this.sweepIdleWorkers(), 30_000);
    this.idleCheckTimer.unref();
  }

  private async spawnWorkerSlot(): Promise<ActiveSlot> {
    const slotId = `slot-${++this.slotCounter}`;
    const child = spawn(
      this.config.nodeBin!,
      ["--disable-warning=ExperimentalWarning", this.config.workerScript!],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      }
    );

    const slot: ActiveSlot = {
      slotId,
      child,
      state: "standby",
      tenantId: null,
      workloadClass: null,
      workspaceDir: null,
      leasedAt: null,
      lastActiveAt: Date.now(),
      rssBytes: 0,
      cpuPercent: 0,
      pendingRequests: new Map(),
    };

    this.slots.set(slotId, slot);

    const rl = readline.createInterface({ input: child.stdout!, terminal: false });
    rl.on("line", (line) => this.handleWorkerLine(slot, line));

    child.stdin?.on("error", () => {
      // Handled silently: process pipe closed during shutdown or exit
    });

    child.stderr?.on("data", (chunk) => {
      this.emit("log", {
        slotId,
        tenantId: slot.tenantId,
        level: "error",
        message: chunk.toString().trim(),
        at: new Date().toISOString(),
      });
    });

    child.once("exit", (code, signal) => {
      this.handleWorkerExit(slot, code, signal);
    });

    // Initialize the worker
    await this.sendRequest(slot, "init", { slotId });
    return slot;
  }

  private handleWorkerLine(slot: ActiveSlot, line: string): void {
    const msg = decodeIpcMessage(line);
    if (!msg) return;

    // Check if this fulfills a pending request
    const pending = slot.pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      slot.pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.payload);
      return;
    }

    // Otherwise handle unsolicited events
    switch (msg.type) {
      case "emit_metric": {
        slot.rssBytes = Number(msg.payload?.rssBytes || slot.rssBytes);
        this.emit("metric", { slotId: slot.slotId, tenantId: slot.tenantId, ...msg.payload });
        break;
      }
      case "emit_log": {
        this.emit("log", { slotId: slot.slotId, tenantId: slot.tenantId, ...msg.payload });
        break;
      }
      case "emit_audit": {
        this.emit("audit", { slotId: slot.slotId, tenantId: slot.tenantId, ...msg.payload });
        break;
      }
      case "surface_patch": {
        this.emit("surface_patch", { slotId: slot.slotId, tenantId: slot.tenantId, ...msg.payload });
        break;
      }
      default:
        break;
    }
  }

  private handleWorkerExit(slot: ActiveSlot, code: number | null, signal: NodeJS.Signals | null): void {
    for (const [, req] of slot.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error(`Worker exited with code ${code} (${signal}) while awaiting response.`));
    }
    slot.pendingRequests.clear();

    const wasLeased = slot.tenantId !== null;
    const oldTenant = slot.tenantId;
    this.slots.delete(slot.slotId);

    this.emit("log", {
      slotId: slot.slotId,
      tenantId: oldTenant,
      level: code === 0 ? "info" : "warn",
      message: `Worker [${slot.slotId}] exited with code ${code} (signal: ${signal})`,
      at: new Date().toISOString(),
    });

    if (this.isRunning && !wasLeased) {
      this.replenishStandby().catch(() => {});
    }
  }

  private sendRequest(slot: ActiveSlot, type: IpcMessage["type"], payload?: any, timeoutMs = 5000): Promise<any> {
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pendingRequests.delete(id);
        reject(new Error(`IPC request '${type}' to slot [${slot.slotId}] timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      slot.pendingRequests.set(id, { resolve, reject, timer });
      const raw = encodeIpcMessage({ v: 1, id, type, tenantId: slot.tenantId ?? undefined, payload });
      if (!slot.child.stdin || slot.child.stdin.destroyed || !slot.child.stdin.writable) {
        clearTimeout(timer);
        slot.pendingRequests.delete(id);
        reject(new Error(`Slot [${slot.slotId}] stdin is not writable`));
        return;
      }
      try {
        slot.child.stdin.write(raw, (err) => {
          if (err) {
            clearTimeout(timer);
            slot.pendingRequests.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        slot.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private async replenishStandby(): Promise<void> {
    const standbyCount = [...this.slots.values()].filter((s) => s.state === "standby").length;
    const needed = this.config.standbyWorkers - standbyCount;
    for (let i = 0; i < needed; i++) {
      if (this.slots.size >= this.config.maxActiveWorkers + this.config.standbyWorkers) break;
      await this.spawnWorkerSlot();
    }
  }

  async lease(tenantId: string, workloadClass: WorkloadClass = "chat", workspaceDir?: string): Promise<WorkerSlotSummary> {
    const targetDir = workspaceDir || path.join(process.cwd(), ".vak", "chats", tenantId, "workspace");
    mkdirSync(targetDir, { recursive: true });

    // 1. Check if tenant already has an active or leased slot
    for (const slot of this.slots.values()) {
      if (slot.tenantId === tenantId) {
        slot.lastActiveAt = Date.now();
        slot.state = "active";
        return this.slotSummary(slot);
      }
    }

    // 2. If active slots are at or over capacity, evict the least-recently-used (LRU) worker
    const activeSlots = [...this.slots.values()].filter((s) => s.state === "active" || s.state === "leased" || s.state === "idle");
    if (activeSlots.length >= this.config.maxActiveWorkers) {
      const lru = activeSlots.sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0))[0];
      if (lru) {
        await this.hibernate(lru.slotId);
      }
    }

    // 3. Find an available standby worker or spawn a new one
    let slot = [...this.slots.values()].find((s) => s.state === "standby");
    if (!slot) {
      slot = await this.spawnWorkerSlot();
    }

    // 4. Bind the slot to the tenant
    slot.state = "leased";
    slot.tenantId = tenantId;
    slot.workloadClass = workloadClass;
    slot.workspaceDir = targetDir;
    slot.leasedAt = Date.now();
    slot.lastActiveAt = Date.now();
    this.hibernatedTenants.delete(tenantId);

    await this.sendRequest(slot, "lease", { tenantId, workloadClass, workspaceDir: targetDir });
    slot.state = "active";

    // Replenish standby runners in the background
    this.replenishStandby().catch(() => {});

    return this.slotSummary(slot);
  }

  async hibernate(slotId: string): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot || slot.state === "terminating" || slot.state === "hibernated") return;

    slot.state = "terminating";
    const tenantId = slot.tenantId;

    try {
      await this.sendRequest(slot, "prepare_hibernate", {}, 2000);
    } catch (err) {
      this.emit("log", {
        slotId,
        tenantId,
        level: "warn",
        message: `prepare_hibernate failed or timed out: ${(err as Error).message}`,
        at: new Date().toISOString(),
      });
    }

    if (tenantId && slot.workloadClass && slot.workspaceDir) {
      this.hibernatedTenants.set(tenantId, {
        workloadClass: slot.workloadClass,
        workspaceDir: slot.workspaceDir,
        hibernatedAt: Date.now(),
      });
    }

    // Terminate the child process
    try {
      slot.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  async wake(tenantId: string): Promise<WorkerSlotSummary> {
    const hibernated = this.hibernatedTenants.get(tenantId);
    return this.lease(tenantId, hibernated?.workloadClass ?? "chat", hibernated?.workspaceDir);
  }

  async dispatchAction(tenantId: string, controlId: string, value: unknown, action?: string): Promise<any> {
    const slot = [...this.slots.values()].find((s) => s.tenantId === tenantId);
    if (!slot) {
      throw new Error(`Cannot dispatch action: no active worker slot found for tenant '${tenantId}'`);
    }
    slot.lastActiveAt = Date.now();
    return this.sendRequest(slot, "dispatch_action", { controlId, value, action });
  }

  private lastLoopTime = Date.now();

  private sweepIdleWorkers(): void {
    const now = Date.now();
    const elapsed = now - this.lastLoopTime;
    this.lastLoopTime = now;

    // Detect system sleep/wake clock jumps (interval is 30s; if > 45s elapsed, system was suspended)
    if (elapsed > 45_000) {
      this.emit("log", {
        slotId: "SYSTEM",
        level: "warn",
        message: `System wake detected after ${Math.round(elapsed / 1000)}s suspension. Reconciling pool slots...`,
        at: new Date().toISOString(),
      });
      this.wakeAndReconcile().catch(() => {});
    }

    for (const slot of this.slots.values()) {
      if (slot.state === "active" && slot.lastActiveAt) {
        if (now - slot.lastActiveAt >= this.config.idleTimeoutMs) {
          slot.state = "idle";
        }
      } else if (slot.state === "idle" && slot.lastActiveAt) {
        if (now - slot.lastActiveAt >= this.config.hibernationTimeoutMs) {
          this.hibernate(slot.slotId).catch(() => {});
        }
      }
    }
  }

  // Workstation Lifecycle Hooks

  async suspendAll(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.state === "active" || slot.state === "idle") {
        slot.state = "suspended";
        promises.push(this.sendRequest(slot, "suspend", {}, 1000).catch(() => {}));
      }
    }
    await Promise.all(promises);
  }

  async wakeAndReconcile(): Promise<void> {
    const pings: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.state === "suspended" || slot.state === "active" || slot.state === "idle") {
        const wasSuspended = slot.state === "suspended";
        slot.state = "active";
        slot.lastActiveAt = Date.now();
        pings.push(
          this.sendRequest(slot, "ping", {}, 1000)
            .then(() => {
              if (wasSuspended) {
                return this.sendRequest(slot, "resume", {}, 1000);
              }
            })
            .catch(() => {
              // Worker hung during sleep: kill and clean
              this.hibernate(slot.slotId).catch(() => {});
            })
        );
      }
    }
    await Promise.all(pings);
    await this.replenishStandby();
  }

  async shutdown(timeoutMs = 4000): Promise<void> {
    this.isRunning = false;
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);

    const activeSlots = [...this.slots.values()];
    const flushPromises = activeSlots.map((slot) => {
      if (slot.state === "standby") {
        slot.child.kill("SIGTERM");
        return Promise.resolve();
      }
      return this.sendRequest(slot, "prepare_hibernate", {}, Math.min(timeoutMs - 1000, 2000))
        .catch(() => {})
        .finally(() => {
          slot.child.kill("SIGTERM");
        });
    });

    await Promise.race([
      Promise.all(flushPromises),
      new Promise((resolve) => setTimeout(resolve, timeoutMs - 500)),
    ]);

    // Hard fallback: force kill any remaining processes
    for (const slot of this.slots.values()) {
      try {
        slot.child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    this.slots.clear();
  }

  getFleetSnapshot(): FleetSnapshot {
    const slots = [...this.slots.values()].map((s) => this.slotSummary(s));
    const activeCount = slots.filter((s) => s.state === "active" || s.state === "leased").length;
    const standbyCount = slots.filter((s) => s.state === "standby").length;
    const hibernatedCount = this.hibernatedTenants.size;
    const totalRssBytes = slots.reduce((acc, s) => acc + s.rssBytes, 0);

    return {
      activeCount,
      standbyCount,
      hibernatedCount,
      maxActiveWorkers: this.config.maxActiveWorkers,
      totalRssBytes,
      slots,
    };
  }

  private slotSummary(slot: ActiveSlot): WorkerSlotSummary {
    return {
      slotId: slot.slotId,
      pid: slot.child.pid ?? null,
      state: slot.state,
      tenantId: slot.tenantId,
      workloadClass: slot.workloadClass,
      workspaceDir: slot.workspaceDir,
      leasedAt: slot.leasedAt,
      lastActiveAt: slot.lastActiveAt,
      rssBytes: slot.rssBytes,
      cpuPercent: slot.cpuPercent,
    };
  }
}
