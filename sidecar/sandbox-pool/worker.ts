// Vakyartha Sandboxed Worker Process Entrypoint.
// Runs as an independent child process (jailed via Seatbelt when spawned with vaksb).
// Communicates with Host Supervisor over framed line-delimited JSON-RPC on stdio.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { decodeIpcMessage, encodeIpcMessage, type IpcMessage } from "../../shared/sandbox-pool.ts";

let slotId = "uninitialized";
let tenantId: string | null = null;
let workloadClass: string | null = null;
let workspaceDir: string | null = null;
let isSuspended = false;
let stateData: Record<string, unknown> = {};

function send(msg: Omit<IpcMessage, "v">): void {
  try {
    process.stdout.write(encodeIpcMessage({ v: 1, ...msg }));
  } catch {
    /* parent pipe closed */
  }
}

function emitLog(level: "info" | "warn" | "error" | "debug", message: string): void {
  send({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "emit_log",
    tenantId: tenantId ?? undefined,
    payload: { level, message, at: new Date().toISOString() },
  });
}

function flushStateToDisk(): boolean {
  if (!workspaceDir) return false;
  try {
    mkdirSync(workspaceDir, { recursive: true });
    const target = path.join(workspaceDir, "state.json");
    const tmp = `${target}.tmp`;
    const payload = {
      tenantId,
      workloadClass,
      savedAt: new Date().toISOString(),
      state: stateData,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, target);
    return true;
  } catch (err) {
    emitLog("error", `Failed to flush state to disk: ${(err as Error).message}`);
    return false;
  }
}

function loadStateFromDisk(): void {
  if (!workspaceDir) return;
  const target = path.join(workspaceDir, "state.json");
  if (!existsSync(target)) return;
  try {
    const raw = readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.state === "object") {
      stateData = parsed.state ?? {};
    }
  } catch (err) {
    emitLog("warn", `Could not rehydrate state: ${(err as Error).message}`);
  }
}

// Intercept unhandled errors so process emits structured log before exiting
process.on("uncaughtException", (err) => {
  emitLog("error", `Uncaught exception in worker [${slotId}]: ${err.stack || err.message}`);
  flushStateToDisk();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  emitLog("error", `Unhandled rejection in worker [${slotId}]: ${String(reason)}`);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const msg = decodeIpcMessage(line);
  if (!msg) return;

  switch (msg.type) {
    case "init": {
      slotId = String(msg.payload?.slotId ?? "slot-0");
      emitLog("info", `Worker initialized in slot ${slotId} (PID: ${process.pid})`);
      send({ id: msg.id, type: "init_ack", payload: { slotId, pid: process.pid } });
      break;
    }

    case "lease": {
      tenantId = String(msg.payload?.tenantId ?? "");
      workloadClass = String(msg.payload?.workloadClass ?? "chat");
      workspaceDir = String(msg.payload?.workspaceDir ?? "");
      if (workspaceDir) {
        mkdirSync(workspaceDir, { recursive: true });
        loadStateFromDisk();
      }
      emitLog("info", `Leased slot ${slotId} to tenant ${tenantId} (${workloadClass})`);
      send({ id: msg.id, type: "lease_ack", tenantId, payload: { leased: true } });
      break;
    }

    case "ping": {
      const mem = process.memoryUsage();
      send({
        id: msg.id,
        type: "pong",
        tenantId: tenantId ?? undefined,
        payload: {
          slotId,
          pid: process.pid,
          rssBytes: mem.rss,
          heapUsed: mem.heapUsed,
          isSuspended,
        },
      });
      break;
    }

    case "prepare_hibernate": {
      emitLog("info", `Hibernating slot ${slotId} for tenant ${tenantId}...`);
      const ok = flushStateToDisk();
      send({
        id: msg.id,
        type: "flushed",
        tenantId: tenantId ?? undefined,
        payload: { ready: true, statePersisted: ok },
      });
      break;
    }

    case "suspend": {
      isSuspended = true;
      flushStateToDisk();
      send({ id: msg.id, type: "suspend_ack", payload: { suspended: true } });
      break;
    }

    case "resume": {
      isSuspended = false;
      send({ id: msg.id, type: "resume_ack", payload: { resumed: true } });
      break;
    }

    case "dispatch_action": {
      const { controlId, value, action } = msg.payload ?? {};
      emitLog("info", `Action dispatched on ${controlId}: ${action ?? value}`);
      // Update in-memory state
      if (controlId) {
        stateData[controlId] = value;
      }
      // Emit reactive surface patch back to Canvas
      send({
        id: msg.id,
        type: "surface_patch",
        tenantId: tenantId ?? undefined,
        payload: {
          op: "update",
          controlId,
          value,
          updatedAt: new Date().toISOString(),
        },
      });
      break;
    }

    case "teardown": {
      emitLog("info", `Worker ${slotId} teardown initiated.`);
      flushStateToDisk();
      process.exit(0);
      break;
    }

    default:
      break;
  }
});

// Periodic heartbeat metric (every 10s if not suspended)
setInterval(() => {
  if (isSuspended) return;
  const mem = process.memoryUsage();
  send({
    id: `metric-${Date.now()}`,
    type: "emit_metric",
    tenantId: tenantId ?? undefined,
    payload: {
      slotId,
      pid: process.pid,
      rssBytes: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
  });
}, 10_000).unref();
