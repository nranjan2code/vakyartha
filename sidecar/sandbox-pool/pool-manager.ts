// Pool execution capacity, never uncontained warm processes. The existing helper
// owns process cleanup; every invocation receives a fresh disposable workspace.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, constants, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { FleetSnapshot, PoolConfig, WorkerSlotSummary, WorkloadClass } from "../../shared/sandbox-pool.ts";
import { runSandboxCommand } from "../sandbox-execution.ts";
import { stageDuckDB, databaseSnapshot } from "./database.ts";
import { readBounded, packageFiles, appId } from "./package.ts";

export interface AppInvocation {
  duckdb?: boolean; database?: string;
  backend: string; files: Record<string, string>; state: Record<string, unknown>;
  surfaces: Record<string, unknown>; controlId: string; value: unknown;
  action?: string; trigger?: boolean; surface?: string; timeoutMs?: number;
  callTool?: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}
export class SandboxPoolManager extends EventEmitter {
  private readonly config: Partial<PoolConfig>;
  private readonly slots = new Map<string, WorkerSlotSummary>();
  private readonly controllers = new Set<AbortController>();
  private active = 0;
  private queued = 0;
  private closed = false;
  private suspended = false;
  private sequence = 0;
  constructor(config: Partial<PoolConfig> = {}) {
    super();
    if (!Number.isInteger(config.maxActiveWorkers ?? 3) || (config.maxActiveWorkers ?? 3) < 1 || (config.maxActiveWorkers ?? 3) > 8) throw new Error("Invalid app concurrency bound");
    this.config = config;
  }
  async start(): Promise<void> { this.closed = false; }
  async lease(tenantId: string, workloadClass: WorkloadClass = "app", workspaceDir = ""): Promise<WorkerSlotSummary> {
    appId(tenantId);
    if (this.closed || this.suspended) throw new Error("App runtime is stopped or suspended");
    let slot = [...this.slots.values()].find(s => s.tenantId === tenantId);
    if (!slot) {
      slot = { slotId: `slot-${++this.sequence}`, tenantId, workloadClass, workspaceDir, state: "hibernated", pid: null, leasedAt: Date.now(), lastActiveAt: Date.now(), rssBytes: null, cpuPercent: null };
      this.slots.set(slot.slotId, slot);
    }
    return { ...slot };
  }
  async execute(tenantId: string, request: AppInvocation): Promise<{ result: Record<string, unknown>; state: Record<string, unknown>; database?: string }> {
    const lease = await this.lease(tenantId);
    const slot = this.slots.get(lease.slotId)!;
    if (this.queued >= 32) throw new Error("App execution queue is full");
    this.queued++;
    try {
      while (this.active >= (this.config.maxActiveWorkers ?? 3)) {
        if (this.closed || this.suspended) throw new Error("App runtime stopped while queued");
        await delay(20);
      }
    } finally { this.queued--; }
    if (slot.state === "active") throw new Error("App already has an active invocation");
    if (this.closed || this.suspended || this.config.enabled?.() === false) throw new Error("Sandbox execution is disabled");
    this.active++; slot.state = "active"; slot.lastActiveAt = Date.now();
    const controller = new AbortController(); this.controllers.add(controller);
    let workspace: string | undefined;
    try {
      workspace = mkdtempSync(path.join(tmpdir(), "vak-app-run-"));
      for (const [name, content] of Object.entries(packageFiles(request.files))) {
        const target = path.join(workspace, name); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, content, { flag: "wx", mode: 0o600 });
      }
      if (request.duckdb) {
        stageDuckDB(workspace);
        const snapshot = databaseSnapshot(request.database);
        if (snapshot) writeFileSync(path.join(workspace, ".vak-database.duckdb"), Buffer.from(snapshot, "base64"), { flag: "wx", mode: 0o600 });
      }
      const here = path.dirname(fileURLToPath(import.meta.url));
      const worker = this.config.workerScript ?? [path.join(here, "worker.mjs"), path.join(here, "worker.ts")].find(existsSync);
      if (!worker) throw new Error("App worker is missing");
      const runner = `.vak-worker${worker.endsWith(".ts") ? ".ts" : ".mjs"}`;
      writeFileSync(path.join(workspace, runner), readBounded(worker));
      writeFileSync(path.join(workspace, ".vak-request.json"), JSON.stringify({ ...request, files: undefined, callTool: undefined }));
      const run = runSandboxCommand(this.config.sandboxBin ?? process.env.VAK_SANDBOX_BIN ?? "vaksb", workspace, this.config.nodeBin ?? process.execPath, ["--disable-warning=ExperimentalWarning", runner], workspace, Math.min(request.timeoutMs ?? 30000, 30000), controller.signal);
      let done = false;
      const completion = run.finally(() => { done = true; controller.abort(new Error("App invocation finished")); });
      // File mailboxes adapt to the helper's intentionally closed target stdin.
      // Their fixed basenames are opened without following links; identities and
      // permissions always come from the host invocation, never target output.
      const broker = (async () => {
        let next = 0;
        while (!done) {
          if (this.config.enabled?.() === false) controller.abort(new Error("Sandbox access revoked"));
          const file = path.join(workspace!, ".vak-tool.json");
          if (existsSync(file)) {
            const msg = JSON.parse(readBounded(file, 16384));
            if (msg.id === next && next < 16) {
              next++;
              let reply: unknown;
              try {
                if (typeof msg.name !== "string" || !msg.args || typeof msg.args !== "object" || Array.isArray(msg.args) || !request.callTool) throw new Error("App tool access is unavailable");
                reply = { value: await request.callTool(msg.name, msg.args, controller.signal) };
              } catch (error) { reply = { error: (error as Error).message }; }
              const body = JSON.stringify(reply);
              if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Tool response exceeds 256 KiB");
              const fd = openSync(path.join(workspace!, `.vak-reply-${msg.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              try { writeFileSync(fd, body); } finally { closeSync(fd); }
            }
          }
          await delay(20);
        }
      })().catch(error => { controller.abort(error); throw error; });
      const settled = await Promise.allSettled([completion, broker]);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      const result = (settled[0] as PromiseFulfilledResult<Awaited<typeof run>>).value;
      this.emit("log", { slotId: slot.slotId, tenantId, level: result.code ? "error" : "info", message: result.stderr || result.stdout || "App invocation completed", at: new Date().toISOString() });
      if (result.code !== 0) throw new Error(`App execution failed (${result.code}): ${result.stderr.slice(0, 1000)}`);
      const response = JSON.parse(readBounded(path.join(workspace, ".vak-result.json"), 4 * 1024 * 1024));
      if (!response || !response.result || typeof response.result !== "object" || Array.isArray(response.result) || !response.state || typeof response.state !== "object" || Array.isArray(response.state)) throw new Error("Invalid app response");
      if (request.duckdb) response.database = databaseSnapshot(response.database);
      else if (response.database !== undefined) throw new Error("Undeclared database snapshot");
      return response;
    } finally {
      this.controllers.delete(controller); this.active--; slot.state = "hibernated";
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    }
  }
  async dispatchAction(..._args: unknown[]): Promise<any> { throw new Error("Dispatch requires a validated app package through AppRegistry"); }
  async hibernate(slotId: string): Promise<void> {
    const slot = this.slots.get(slotId); if (!slot) return;
    if (slot.state === "active") throw new Error("App is busy; retry after its invocation completes");
    slot.state = "hibernated";
  }
  async wake(tenantId: string): Promise<WorkerSlotSummary> { return this.lease(tenantId); }
  async suspendAll(): Promise<void> { this.suspended = true; for (const c of this.controllers) c.abort(new Error("App runtime suspended")); while (this.active) await delay(20); }
  async wakeAndReconcile(): Promise<void> { this.suspended = false; }
  async restart(): Promise<void> { await this.suspendAll(); this.slots.clear(); await this.wakeAndReconcile(); }
  async shutdown(_timeoutMs = 4000): Promise<void> { this.closed = true; await this.suspendAll(); this.slots.clear(); }
  getFleetSnapshot(): FleetSnapshot {
    return { activeCount: this.active, standbyCount: 0, hibernatedCount: [...this.slots.values()].filter(s => s.state === "hibernated").length, maxActiveWorkers: this.config.maxActiveWorkers ?? 3, totalRssBytes: null, slots: [...this.slots.values()].map(s => ({ ...s })) };
  }
}
