// App invocation capacity and host-owned status. Null measurements are unknown.

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
  rssBytes: number | null;
  cpuPercent: number | null;
}

export interface PoolConfig {
  /** Concurrent supervised invocations, default 3; no warm processes. */
  maxActiveWorkers: number;
  sandboxBin?: string;
  enabled?: () => boolean;
  nodeBin?: string;
  workerScript?: string;
}

export interface FleetSnapshot {
  activeCount: number;
  standbyCount: number;
  hibernatedCount: number;
  maxActiveWorkers: number;
  totalRssBytes: number | null;
  slots: WorkerSlotSummary[];
}

