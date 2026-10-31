export interface SandboxStatus {
  platform: string;
  /** Desktop only: Rust runs commands and Realms; web mode cannot. */
  native: boolean;
  helper: { available: boolean; compatible: boolean; realms: boolean; path: string; version?: string; error?: string };
  /** The Sandbox page folder as Rust stores it; filled in by the window, not the worker. */
  workspace: { path: string; valid: boolean; error?: string };
  execution: { enabled: boolean; policy: string; status: string };
}
