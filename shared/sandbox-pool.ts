// Shared types and IPC contracts for Vakyartha's Sandbox Runtime Pool.
// Manages multi-tenant worker leasing, states, telemetry, and framed JSON-RPC.

export type WorkloadClass = "chat" | "app" | "job";

export type WorkerSlotState =
  | "standby"
  | "leased"
  | "active"
  | "idle"
  | "suspended"
  | "hibernated"
  | "terminating"
  | "destroyed";

export interface WorkerSlotSummary {
  slotId: string;
  pid: number | null;
  state: WorkerSlotState;
  tenantId: string | null;
  workloadClass: WorkloadClass | null;
  workspaceDir: string | null;
  leasedAt: number | null;
  lastActiveAt: number | null;
  rssBytes: number;
  cpuPercent: number;
}

export interface PoolConfig {
  /** Maximum concurrent running sandboxed OS child processes (default: 3) */
  maxActiveWorkers: number;
  /** Number of pre-warmed idle workers held in standby for instant leasing (default: 1) */
  standbyWorkers: number;
  /** Time of inactivity before an active worker transitions to idle (default: 5 min) */
  idleTimeoutMs: number;
  /** Time of inactivity before an idle worker is flushed and hibernated (default: 15 min) */
  hibernationTimeoutMs: number;
  /** Maximum RSS memory threshold per worker before warning/force-trim (default: 256 MiB) */
  maxWorkerRssBytes: number;
  /** Custom Node binary path (defaults to process.execPath) */
  nodeBin?: string;
  /** Custom worker script path */
  workerScript?: string;
}

export interface FleetSnapshot {
  activeCount: number;
  standbyCount: number;
  hibernatedCount: number;
  totalRssBytes: number;
  slots: WorkerSlotSummary[];
}

// -----------------------------------------------------------------------------
// IPC Message Contracts (JSON-RPC over stdio / UDS)
// -----------------------------------------------------------------------------

export type IpcMessageType =
  // Control Plane
  | "init"
  | "init_ack"
  | "lease"
  | "lease_ack"
  | "prepare_hibernate"
  | "flushed"
  | "suspend"
  | "suspend_ack"
  | "resume"
  | "resume_ack"
  | "ping"
  | "pong"
  | "teardown"
  // Event Plane (Canvas UI)
  | "dispatch_action"
  | "surface_patch"
  | "surface_toast"
  // Brokered Services Plane
  | "broker_fetch"
  | "broker_fetch_res"
  | "broker_llm_stream"
  | "broker_llm_chunk"
  // Telemetry Plane
  | "emit_metric"
  | "emit_log"
  | "emit_audit";

export interface IpcMessage {
  v: 1;
  id: string;
  type: IpcMessageType;
  tenantId?: string;
  payload?: any;
  error?: string;
}

export function encodeIpcMessage(msg: IpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

export function decodeIpcMessage(line: string): IpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.v === 1 && typeof parsed.id === "string" && typeof parsed.type === "string") {
      return parsed as IpcMessage;
    }
  } catch {
    /* unparseable frame */
  }
  return null;
}
