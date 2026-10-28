// Formal Application Manifest Schema and Validator for Dynamic Artifact Apps
// in Vakyartha's Mini-Cloud platform. Validates package configuration, runtime
// quotas, brokered entitlements, and autonomous triggers.

export interface AppEntrypoints {
  /** Relative path to backend daemon entrypoint (e.g. server.ts or main.py) */
  backend?: string;
  /** Relative path to initial Canvas Surface JSON schema */
  surface?: string;
}

export interface AppRuntimeLimits {
  engine: "node24" | "python3" | "shell";
  memoryLimitMb: number;
  cpuTimeLimitSec: number;
  maxStorageMb: number;
}

export interface AppNetworkEntitlements {
  mode: "airgap" | "brokered";
  allowedDomains: string[];
}

export interface AppStorageEntitlements {
  sqlite?: boolean;
  duckdb?: boolean;
}

export interface AppEntitlements {
  network: AppNetworkEntitlements;
  mcpTools: string[];
  storage: AppStorageEntitlements;
}

export interface AppTrigger {
  id: string;
  kind: "cron" | "file-watcher";
  expression?: string;
  watchPath?: string;
  action: string;
  maxDurationSec: number;
}

export interface AppManifest {
  $schema?: string;
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  category: "finance" | "analytics" | "developer" | "productivity" | "utilities" | "custom";
  entrypoints: AppEntrypoints;
  runtime: AppRuntimeLimits;
  entitlements: AppEntitlements;
  triggers: AppTrigger[];
}

const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i;

function cleanString(val: unknown, maxLen = 256): string {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

function assertSafeRelativePath(relPath: unknown, fieldName: string): string {
  const p = cleanString(relPath, 256);
  if (!p) throw new Error(`${fieldName} cannot be empty`);
  if (p.startsWith("/") || p.startsWith("\\") || p.includes("..") || p.includes("\0")) {
    throw new Error(`${fieldName} must be a safe relative path without directory traversal: ${p}`);
  }
  return p;
}

export function parseAppManifest(raw: unknown): AppManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Application manifest must be a non-null JSON object.");
  }

  const obj = raw as Record<string, unknown>;

  const id = cleanString(obj.id, 64).toLowerCase();
  if (!IDENTIFIER_RE.test(id)) {
    throw new Error(`Invalid app id '${obj.id}'. Must be 2-64 lowercase alphanumeric, dash or underscore.`);
  }

  const name = cleanString(obj.name, 128);
  if (!name) throw new Error("App name is required.");

  const version = cleanString(obj.version, 32);
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid semver version '${obj.version}'. Expected format X.Y.Z.`);
  }

  const description = cleanString(obj.description, 1024);
  const author = cleanString(obj.author, 128);
  const icon = cleanString(obj.icon, 64) || "app";

  const rawCat = cleanString(obj.category, 32).toLowerCase();
  const validCategories = ["finance", "analytics", "developer", "productivity", "utilities", "custom"] as const;
  const category = (validCategories.includes(rawCat as any) ? rawCat : "custom") as AppManifest["category"];

  // Entrypoints
  const rawEntry = (obj.entrypoints && typeof obj.entrypoints === "object" && !Array.isArray(obj.entrypoints))
    ? (obj.entrypoints as Record<string, unknown>)
    : {};
  
  const entrypoints: AppEntrypoints = {};
  if (rawEntry.backend) entrypoints.backend = assertSafeRelativePath(rawEntry.backend, "entrypoints.backend");
  if (rawEntry.surface) entrypoints.surface = assertSafeRelativePath(rawEntry.surface, "entrypoints.surface");
  if (!entrypoints.backend && !entrypoints.surface) {
    throw new Error("App must declare at least one entrypoint (backend or surface).");
  }

  // Runtime Limits
  const rawRuntime = (obj.runtime && typeof obj.runtime === "object" && !Array.isArray(obj.runtime))
    ? (obj.runtime as Record<string, unknown>)
    : {};

  const rawEngine = cleanString(rawRuntime.engine, 32).toLowerCase();
  const validEngines = ["node24", "python3", "shell"] as const;
  const engine = (validEngines.includes(rawEngine as any) ? rawEngine : "node24") as AppRuntimeLimits["engine"];

  const memoryLimitMb = Math.max(32, Math.min(Number(rawRuntime.memoryLimitMb) || 256, 1024));
  const cpuTimeLimitSec = Math.max(5, Math.min(Number(rawRuntime.cpuTimeLimitSec) || 60, 300));
  const maxStorageMb = Math.max(16, Math.min(Number(rawRuntime.maxStorageMb) || 512, 2048));

  const runtime: AppRuntimeLimits = { engine, memoryLimitMb, cpuTimeLimitSec, maxStorageMb };

  // Entitlements
  const rawEnt = (obj.entitlements && typeof obj.entitlements === "object" && !Array.isArray(obj.entitlements))
    ? (obj.entitlements as Record<string, unknown>)
    : {};

  const rawNet = (rawEnt.network && typeof rawEnt.network === "object" && !Array.isArray(rawEnt.network))
    ? (rawEnt.network as Record<string, unknown>)
    : {};

  const netMode = rawNet.mode === "airgap" ? "airgap" : "brokered";
  const allowedDomains: string[] = [];
  if (Array.isArray(rawNet.allowedDomains)) {
    for (const d of rawNet.allowedDomains) {
      const cleaned = cleanString(d, 253).toLowerCase();
      if (DOMAIN_RE.test(cleaned) && !allowedDomains.includes(cleaned)) {
        allowedDomains.push(cleaned);
      }
    }
  }

  const mcpTools: string[] = [];
  if (Array.isArray(rawEnt.mcpTools)) {
    for (const t of rawEnt.mcpTools) {
      const toolName = cleanString(t, 64);
      if (toolName && !mcpTools.includes(toolName)) mcpTools.push(toolName);
    }
  }

  const rawStorage = (rawEnt.storage && typeof rawEnt.storage === "object" && !Array.isArray(rawEnt.storage))
    ? (rawEnt.storage as Record<string, unknown>)
    : {};

  const entitlements: AppEntitlements = {
    network: { mode: netMode, allowedDomains },
    mcpTools,
    storage: {
      sqlite: Boolean(rawStorage.sqlite ?? true),
      duckdb: Boolean(rawStorage.duckdb ?? false),
    },
  };

  // Triggers
  const triggers: AppTrigger[] = [];
  if (Array.isArray(obj.triggers)) {
    for (const item of obj.triggers) {
      if (!item || typeof item !== "object") continue;
      const trig = item as Record<string, unknown>;
      const trigId = cleanString(trig.id, 64);
      if (!IDENTIFIER_RE.test(trigId)) continue;
      const kind = trig.kind === "file-watcher" ? "file-watcher" : "cron";
      const action = cleanString(trig.action, 64);
      if (!action) continue;
      const maxDurationSec = Math.max(1, Math.min(Number(trig.maxDurationSec) || 30, 300));
      
      const parsed: AppTrigger = {
        id: trigId,
        kind,
        action,
        maxDurationSec,
      };

      if (kind === "cron") {
        parsed.expression = cleanString(trig.expression, 64) || "0 * * * *";
      } else {
        parsed.watchPath = assertSafeRelativePath(trig.watchPath, `triggers[${trigId}].watchPath`);
      }
      triggers.push(parsed);
    }
  }

  return {
    $schema: cleanString(obj.$schema, 256) || undefined,
    id,
    version,
    name,
    description,
    author,
    icon,
    category,
    entrypoints,
    runtime,
    entitlements,
    triggers,
  };
}
