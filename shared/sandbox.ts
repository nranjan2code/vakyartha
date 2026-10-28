export interface SandboxStatus {
  enabled: boolean;
  processIsolationEnabled: boolean;
  restartRequired: boolean;
  platform: string;
  helper: { available: boolean; compatible: boolean; realms: boolean; path: string; version?: string; error?: string };
  workspace: { path: string; valid: boolean; error?: string };
  execution: { enabled: boolean; policy: string; status: string };
}
