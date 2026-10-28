// Dynamic Hosted App Registry & Trigger Scheduler.
// Manages application lifecycle in <dataDir>/apps/, embedded storage volumes,
// Canvas UI action dispatch, and autonomous background cron scheduling.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAppManifest, type AppManifest, type AppTrigger } from "../../shared/app-manifest.ts";
import type { SandboxPoolManager } from "./pool-manager.ts";

export interface AppSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  category: AppManifest["category"];
  icon: string;
  isRunning: boolean;
  storageBytes: number;
  triggerCount: number;
  lastExecutedAt: string | null;
}

export interface AppDetails {
  manifest: AppManifest;
  workspaceDir: string;
  isRunning: boolean;
  storageBytes: number;
  state: Record<string, unknown>;
  surface?: Record<string, unknown>;
  lastExecutedAt: string | null;
}

function computeDirectorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += computeDirectorySize(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

export function matchCronField(val: number, field: string): boolean {
  const f = field.trim();
  if (f === "*") return true;
  if (f.startsWith("*/")) {
    const step = Number(f.slice(2));
    return Number.isInteger(step) && step > 0 && val % step === 0;
  }
  if (f.includes(",")) {
    return f.split(",").some((part) => matchCronField(val, part));
  }
  if (f.includes("-")) {
    const [start, end] = f.split("-").map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && val >= start! && val <= end!;
  }
  return Number(f) === val;
}

export function isCronMatch(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [min, hour, day, month, dow] = parts;
  return (
    matchCronField(date.getMinutes(), min!) &&
    matchCronField(date.getHours(), hour!) &&
    matchCronField(date.getDate(), day!) &&
    matchCronField(date.getMonth() + 1, month!) &&
    matchCronField(date.getDay(), dow!)
  );
}

export class AppRegistry {
  private readonly dataDir: string;
  private readonly appsDir: string;
  private readonly pool: SandboxPoolManager;
  private readonly seedBuiltins: boolean;
  private readonly apps = new Map<string, AppManifest>();
  private readonly lastExecuted = new Map<string, string>();
  private schedulerTimer?: NodeJS.Timeout;

  constructor(options: { dataDir: string; pool: SandboxPoolManager; seedBuiltins?: boolean }) {
    this.dataDir = options.dataDir;
    this.appsDir = path.join(this.dataDir, "apps");
    this.pool = options.pool;
    this.seedBuiltins = options.seedBuiltins ?? false;
  }

  async init(): Promise<void> {
    mkdirSync(this.appsDir, { recursive: true });
    if (this.seedBuiltins) {
      this.seedBuiltinApps();
    }
    this.reloadApps();

    // Start background cron scheduler checking every 30 seconds
    this.schedulerTimer = setInterval(() => {
      this.checkSchedules().catch(() => {});
    }, 30_000);
    this.schedulerTimer.unref();
  }

  private seedBuiltinApps(): void {
    const candidateDirs = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "builtin-apps"),
      path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin-apps"),
      path.join(process.cwd(), "sidecar", "builtin-apps"),
      path.join(process.cwd(), "resources", "builtin-apps"),
    ];
    const sourceDir = candidateDirs.find((d) => existsSync(d));
    if (!sourceDir) return;

    try {
      for (const item of readdirSync(sourceDir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const target = path.join(this.appsDir, item.name);
        if (!existsSync(target)) {
          cpSync(path.join(sourceDir, item.name), target, { recursive: true });
        }
      }
    } catch {}
  }

  reloadApps(): void {
    this.apps.clear();
    if (!existsSync(this.appsDir)) return;

    for (const item of readdirSync(this.appsDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const manifestPath = path.join(this.appsDir, item.name, "app.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
        const manifest = parseAppManifest(raw);
        this.apps.set(manifest.id, manifest);
      } catch (err) {
        /* skipped invalid manifest */
      }
    }
  }

  listApps(): AppSummary[] {
    const out: AppSummary[] = [];
    const snapshot = this.pool.getFleetSnapshot();
    const activeTenantIds = new Set(
      snapshot.slots.filter((s) => s.state === "active" || s.state === "leased").map((s) => s.tenantId)
    );

    for (const app of this.apps.values()) {
      const appFolder = path.join(this.appsDir, app.id);
      out.push({
        id: app.id,
        name: app.name,
        version: app.version,
        description: app.description,
        category: app.category,
        icon: app.icon,
        isRunning: activeTenantIds.has(app.id),
        storageBytes: computeDirectorySize(appFolder),
        triggerCount: app.triggers.length,
        lastExecutedAt: this.lastExecuted.get(app.id) ?? null,
      });
    }

    return out;
  }

  getApp(id: string): AppDetails | null {
    const manifest = this.apps.get(id);
    if (!manifest) return null;

    const workspaceDir = path.join(this.appsDir, id);
    const snapshot = this.pool.getFleetSnapshot();
    const isRunning = snapshot.slots.some(
      (s) => s.tenantId === id && (s.state === "active" || s.state === "leased")
    );

    let state: Record<string, unknown> = {};
    const stateFile = path.join(workspaceDir, "state.json");
    if (existsSync(stateFile)) {
      try {
        state = JSON.parse(readFileSync(stateFile, "utf8")).state ?? {};
      } catch {}
    }

    let surface: Record<string, unknown> | undefined;
    if (manifest.entrypoints.surface) {
      const surfFile = path.join(workspaceDir, manifest.entrypoints.surface);
      if (existsSync(surfFile)) {
        try {
          surface = JSON.parse(readFileSync(surfFile, "utf8"));
        } catch {}
      }
    }

    return {
      manifest,
      workspaceDir,
      isRunning,
      storageBytes: computeDirectorySize(workspaceDir),
      state,
      surface,
      lastExecutedAt: this.lastExecuted.get(id) ?? null,
    };
  }

  async installApp(manifestRaw: unknown, files: Record<string, string> = {}): Promise<AppDetails> {
    const manifest = parseAppManifest(manifestRaw);
    const appDir = path.join(this.appsDir, manifest.id);
    mkdirSync(appDir, { recursive: true });
    mkdirSync(path.join(appDir, "data"), { recursive: true });
    mkdirSync(path.join(appDir, "logs"), { recursive: true });

    // Write manifest
    writeFileSync(path.join(appDir, "app.json"), JSON.stringify(manifest, null, 2), "utf8");

    // Write auxiliary code and surface files
    for (const [relPath, content] of Object.entries(files)) {
      const target = path.join(appDir, relPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }

    this.apps.set(manifest.id, manifest);
    return this.getApp(manifest.id)!;
  }

  async deleteApp(id: string): Promise<boolean> {
    const app = this.apps.get(id);
    if (!app) return false;

    // Hibernate and terminate slot if active
    const snapshot = this.pool.getFleetSnapshot();
    const slot = snapshot.slots.find((s) => s.tenantId === id);
    if (slot) {
      await this.pool.hibernate(slot.slotId);
    }

    const appDir = path.join(this.appsDir, id);
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }

    this.apps.delete(id);
    this.lastExecuted.delete(id);
    return true;
  }

  async dispatchAction(appId: string, controlId: string, value: unknown, action?: string): Promise<any> {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`App '${appId}' is not installed.`);

    const appDir = path.join(this.appsDir, appId);
    // Ensure worker slot is leased for this app
    await this.pool.lease(appId, "app", appDir);

    const patch = await this.pool.dispatchAction(appId, controlId, value, action);
    this.lastExecuted.set(appId, new Date().toISOString());
    return patch;
  }

  async runTrigger(appId: string, triggerId: string): Promise<{ ok: boolean; action: string; durationMs: number }> {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`App '${appId}' is not installed.`);

    const trigger = app.triggers.find((t) => t.id === triggerId);
    if (!trigger) throw new Error(`Trigger '${triggerId}' not declared in app '${appId}'.`);

    const start = Date.now();
    const appDir = path.join(this.appsDir, appId);
    await this.pool.lease(appId, "app", appDir);

    await this.pool.dispatchAction(appId, `trigger:${trigger.id}`, { triggerId, kind: trigger.kind }, trigger.action);
    const durationMs = Date.now() - start;
    this.lastExecuted.set(appId, new Date().toISOString());

    return { ok: true, action: trigger.action, durationMs };
  }

  async checkSchedules(now = new Date()): Promise<void> {
    for (const app of this.apps.values()) {
      for (const trig of app.triggers) {
        if (trig.kind === "cron" && trig.expression) {
          if (isCronMatch(trig.expression, now)) {
            // Anti-thundering herd: avoid triggering more than once in the same minute
            const last = this.lastExecuted.get(`${app.id}:${trig.id}`);
            const currentMin = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
            if (last === currentMin) continue;

            this.lastExecuted.set(`${app.id}:${trig.id}`, currentMin);
            this.runTrigger(app.id, trig.id).catch(() => {});
          }
        }
      }
    }
  }

  shutdown(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }
  }
}

