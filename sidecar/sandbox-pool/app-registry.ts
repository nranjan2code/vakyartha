// Dynamic Hosted App Registry & Trigger Scheduler.
// One host-owned record per app; package publication, domain state and
// projection updates share the same serialized persistence boundary.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basicCatalog, SurfaceStore, type SurfaceSnapshot } from "@vak/core";
import { appId, packageFiles, atomicJson, readBounded, fingerprint, legacyFiles } from "./package.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAppManifest, type AppManifest } from "../../shared/app-manifest.ts";
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
  scheduling?: boolean;
  isDraft?: boolean;
  isBuiltin?: boolean;
  updateAvailable?: boolean;
  latestVersion?: string;
  hasDraft?: boolean;
}

export interface AppDetails {
  manifest: AppManifest;
  workspaceDir: string;
  isRunning: boolean;
  storageBytes: number;
  state: Record<string, unknown>;
  surface?: Record<string, unknown>;
  surfaces?: Record<string, SurfaceSnapshot>;
  revision?: number;
  fingerprint?: string;
  scheduling?: boolean;
  run?: RecordState["run"];
  _supportingFiles?: { path: string; text: string }[];
  lastExecutedAt: string | null;
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

interface Package { manifest: AppManifest; files: Record<string, string> }
interface AppRun {
  id: string; status: "running" | "completed" | "failed" | "uncertain";
  error?: string; at: string;
  calls?: { name: string; argsHash: string; status: "attempted" | "completed" }[];
}
interface RecordState {
  published: Package; fingerprint: string; revision: number;
  state: Record<string, unknown>; database?: string; surfaces: Record<string, SurfaceSnapshot>;
  scheduling: boolean; lastMinutes: Record<string, string>; lastExecutedAt: string | null;
  run?: AppRun;
  history?: AppRun[];
}
export class AppRegistry {
  private readonly appsDir: string;
  private readonly recordsDir: string;
  private readonly draftsDir: string;
  private readonly pool: SandboxPoolManager;
  private readonly seedBuiltins: boolean;
  private readonly records = new Map<string, RecordState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private schedulerTimer?: NodeJS.Timeout;
  private closing = false;
  private checkingSchedules = false;
  private readonly callTool?: (app: AppManifest, name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  constructor(options: { dataDir: string; pool: SandboxPoolManager; seedBuiltins?: boolean; callTool?: AppRegistry["callTool"] }) {
    this.appsDir = path.join(options.dataDir, "apps");
    this.recordsDir = path.join(options.dataDir, "app-state");
    this.draftsDir = path.join(options.dataDir, "app-drafts");
    this.pool = options.pool; this.seedBuiltins = options.seedBuiltins ?? false; this.callTool = options.callTool;
  }
  private file(id: string): string { return path.join(this.recordsDir, `${appId(id)}.json`); }
  private save(id: string, record: RecordState): void { atomicJson(this.file(id), record); this.records.set(id, record); }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    appId(id);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private require(id: string): RecordState { appId(id); const r = this.records.get(id); if (!r) throw new Error("App not found"); return r; }
  private validate(manifestRaw: unknown, rawFiles: unknown): Package {
    const manifest = parseAppManifest(manifestRaw), files = packageFiles(rawFiles);
    if (manifest.runtime.engine !== "node24") throw new Error("Only node24 app execution is supported");
    if (manifest.entitlements.storage.sqlite) throw new Error("SQLite files are unsupported; use DuckDB or context.state for durable app data");
    if (manifest.entitlements.network.allowedDomains.length) throw new Error("Use governed MCP tools for remote data; direct network grants are unsupported");
    if (manifest.entrypoints.backend && (!/\.(ts|mjs|js)$/.test(manifest.entrypoints.backend) || !files[manifest.entrypoints.backend])) throw new Error("Declared backend source is missing or unsupported");
    if (manifest.entrypoints.surface && !files[manifest.entrypoints.surface]) throw new Error("Declared surface is missing");
    if (manifest.triggers.length && !manifest.entrypoints.backend) throw new Error("Triggers require executable backend code");
    for (const trigger of manifest.triggers) {
      if (trigger.kind !== "cron") throw new Error("File-watcher triggers are not supported");
      if (!/^[A-Za-z_$][\w$]*$/.test(trigger.action) || !validCron(trigger.expression ?? "")) throw new Error("Invalid trigger action or cron expression");
    }
    this.initialSurfaces({ manifest, files });
    return { manifest, files };
  }
  private initialSurfaces(pkg: Package): Record<string, SurfaceSnapshot> {
    if (!pkg.manifest.entrypoints.surface) return {};
    const raw = JSON.parse(pkg.files[pkg.manifest.entrypoints.surface]!);
    const snaps = Array.isArray(raw) ? raw : [raw];
    const out: Record<string, SurfaceSnapshot> = {};
    for (const value of snaps) {
      const snap = { ...value, id: value.id || pkg.manifest.id, version: value.version ?? 1, data: value.data ?? {} };
      if (!snap || typeof snap.id !== "string" || !Array.isArray(snap.nodes) || out[snap.id]) throw new Error("Invalid or duplicate app surface");
      const store = new SurfaceStore(basicCatalog);
      const errors = store.render({ surface: snap.id, title: snap.title, data: snap.data, nodes: snap.nodes }).filter(d => d.severity === "error");
      if (errors.length) throw new Error(`Invalid app surface: ${errors.slice(0, 4).map(d => d.message).join("; ")}`);
      out[snap.id] = store.snapshot(snap.id)!;
    }
    return out;
  }
  getBuiltinDir(): string | null {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [
      path.join(here, "..", "builtin-apps"),
      path.join(here, "builtin-apps"),
      path.join(here, "resources", "builtin-apps"),
    ].find(existsSync) ?? null;
  }
  getBuiltinSource(id: string): string | null {
    const dir = this.getBuiltinDir();
    if (!dir) return null;
    const folder = path.join(dir, id);
    return existsSync(path.join(folder, "app.json")) ? folder : null;
  }
  async init(): Promise<void> {
    mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 }); mkdirSync(this.draftsDir, { recursive: true, mode: 0o700 });
    this.reloadApps();
    this.importLegacyDrafts();
    if (this.seedBuiltins) {
      const marker = path.join(this.recordsDir, ".seeded-builtins.json");
      const seeded: string[] = existsSync(marker) ? JSON.parse(readBounded(marker)) : [];
      const source = this.getBuiltinDir();
      if (source) for (const dir of readdirSync(source, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        try {
          const folder = path.join(source, dir.name), raw = JSON.parse(readBounded(path.join(folder, "app.json")));
          if (!seeded.includes(raw.id) && !this.records.has(raw.id) && !existsSync(path.join(this.draftsDir, `${appId(raw.id)}.json`))) {
            await this.installApp(raw, legacyFiles(folder)); seeded.push(raw.id); atomicJson(marker, seeded);
          } else if (this.records.has(raw.id)) {
            const shippedFiles = legacyFiles(folder);
            const shippedFingerprint = fingerprint({ manifest: parseAppManifest(raw), files: packageFiles(shippedFiles) });
            const currentRecord = this.records.get(raw.id);
            if (currentRecord && currentRecord.fingerprint !== shippedFingerprint) {
              await this.updateApp(raw.id, raw, shippedFiles, undefined, true);
            }
          }
        } catch { /* Invalid built-ins do not authorize execution. */ }
      }
    }
    this.schedulerTimer = setInterval(() => { void this.checkSchedules().catch(() => {}); }, 30_000); this.schedulerTimer.unref();
  }
  listBuiltins(): AppManifest[] {
    const source = this.getBuiltinDir();
    if (!source) return [];
    return readdirSync(source, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(entry => {
      try { const manifest = parseAppManifest(JSON.parse(readBounded(path.join(source, entry.name, "app.json")))); return manifest.id === entry.name ? [manifest] : []; }
      catch { return []; }
    });
  }
  async installBuiltin(id: string): Promise<AppDetails> {
    appId(id);
    const source = this.getBuiltinSource(id);
    if (!source) throw new Error("Unknown bundled app");
    const raw = JSON.parse(readBounded(path.join(source, "app.json")));
    const files = legacyFiles(source);
    if (this.records.has(id)) {
      return this.updateApp(id, raw, files, undefined, true);
    }
    return this.installApp(raw, files);
  }
  private importLegacyDrafts(): void {
    const markerFile = path.join(this.recordsDir, ".legacy-imports.json");
    const imported: string[] = existsSync(markerFile) ? JSON.parse(readBounded(markerFile)) : [];
    if (!existsSync(this.appsDir)) return;
    for (const entry of readdirSync(this.appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || imported.includes(entry.name)) continue;
      const dir = path.join(this.appsDir, entry.name);
      try {
        const raw = JSON.parse(readBounded(path.join(dir, "app.json")));
        appId(raw.id);
        if (raw.id !== entry.name || this.records.has(raw.id) || existsSync(path.join(this.draftsDir, `${raw.id}.json`))) continue;
        // Import as inert source, never execute old code automatically. Existing
        // data/database files are preserved in the original directory.
        this.saveDraft(raw.id, { manifest: raw, files: legacyFiles(dir) });
        imported.push(entry.name); atomicJson(markerFile, imported);
      } catch { /* Keep unsupported legacy packages and their data untouched. */ }
    }
  }
  reloadApps(): void {
    this.records.clear();
    for (const name of readdirSync(this.recordsDir)) {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      try {
        const record = JSON.parse(readBounded(this.file(id))) as RecordState;
        record.published = this.validate(record.published.manifest, record.published.files);
        if (record.published.manifest.id !== id || record.fingerprint !== fingerprint(record.published)) throw new Error("Package integrity mismatch");
        if (record.run?.status === "running") { record.run.status = "uncertain"; record.scheduling = false; atomicJson(this.file(id), record); }
        this.records.set(id, record);
      } catch { /* Corrupt records remain on disk for inspection. */ }
    }
    // Legacy packages remain inert until explicitly republished. Do not auto-run
    // code copied by an older version which had no publication boundary.
  }
  listApps(): AppSummary[] {
    const builtinDir = this.getBuiltinDir();
    return [...this.records.values()].map(r => {
      let isBuiltin = false;
      let updateAvailable = false;
      let latestVersion: string | undefined;

      if (builtinDir) {
        const folder = path.join(builtinDir, r.published.manifest.id);
        if (existsSync(path.join(folder, "app.json"))) {
          isBuiltin = true;
          try {
            const raw = JSON.parse(readBounded(path.join(folder, "app.json")));
            const shippedFiles = legacyFiles(folder);
            const shippedFingerprint = fingerprint({ manifest: parseAppManifest(raw), files: packageFiles(shippedFiles) });
            if (r.fingerprint !== shippedFingerprint || r.published.manifest.version !== raw.version) {
              updateAvailable = true;
              latestVersion = raw.version;
            }
          } catch { /* ignore corrupted */ }
        }
      }

      const draftPath = path.join(this.draftsDir, `${appId(r.published.manifest.id)}.json`);
      let hasDraft = false;
      if (existsSync(draftPath)) {
        try {
          const draft = JSON.parse(readBounded(draftPath));
          if (draft && draft.fingerprint && draft.fingerprint !== r.fingerprint) {
            hasDraft = true;
            updateAvailable = true;
          }
        } catch { /* ignore */ }
      }

      return {
        id: r.published.manifest.id,
        name: r.published.manifest.name,
        version: r.published.manifest.version,
        description: r.published.manifest.description,
        category: r.published.manifest.category,
        icon: r.published.manifest.icon,
        isRunning: r.run?.status === "running",
        storageBytes: Buffer.byteLength(JSON.stringify(r)),
        triggerCount: r.published.manifest.triggers.length,
        lastExecutedAt: r.lastExecutedAt,
        scheduling: r.scheduling,
        isBuiltin,
        updateAvailable,
        latestVersion,
        hasDraft,
      };
    });
  }
  async updateAppToLatest(id: string): Promise<AppDetails> {
    appId(id);
    const builtinSource = this.getBuiltinSource(id);
    if (builtinSource) {
      return this.installBuiltin(id);
    }
    const draftPath = path.join(this.draftsDir, `${id}.json`);
    if (existsSync(draftPath)) {
      const draft = JSON.parse(readBounded(draftPath));
      if (draft && draft.fingerprint) {
        return this.publishDraft(id, draft.fingerprint);
      }
    }
    throw new Error("No update or draft available for this app");
  }
  getApp(id: string): AppDetails | null {
    appId(id); const r = this.records.get(id); if (!r) return null;
    return structuredClone({ manifest: r.published.manifest, workspaceDir: this.file(id), isRunning: r.run?.status === "running", storageBytes: Buffer.byteLength(JSON.stringify(r)), state: r.state, surface: Object.values(r.surfaces)[0] as unknown as Record<string, unknown>, surfaces: r.surfaces, lastExecutedAt: r.lastExecutedAt, revision: r.revision, fingerprint: r.fingerprint, scheduling: r.scheduling, run: r.run, history: r.history });
  }
  async installApp(manifestRaw: unknown, files: Record<string, string> = {}): Promise<AppDetails> {
    const pkg = this.validate(manifestRaw, files);
    return this.exclusive(pkg.manifest.id, async () => {
      if (this.records.has(pkg.manifest.id)) throw new Error("App already exists; use reviewed update");
      this.save(pkg.manifest.id, { published: pkg, fingerprint: fingerprint(pkg), revision: 1, state: {}, surfaces: this.initialSurfaces(pkg), scheduling: false, lastMinutes: {}, lastExecutedAt: null });
      return this.getApp(pkg.manifest.id)!;
    });
  }
  async updateApp(id: string, manifestRaw: unknown, files: Record<string, string> = {}, expected?: string, replaceFiles = false): Promise<AppDetails> {
    return this.exclusive(id, async () => {
      const r = this.require(id);
      if (expected !== undefined && expected !== r.fingerprint) throw new Error("App changed; review the current package before publishing");
      const pkg = this.validate({ ...r.published.manifest, ...(manifestRaw as object), id }, replaceFiles ? files : { ...r.published.files, ...files });
      this.save(id, { ...r, published: pkg, fingerprint: fingerprint(pkg), revision: r.revision + 1, surfaces: this.initialSurfaces(pkg), scheduling: false });
      return this.getApp(id)!;
    });
  }
  async deleteApp(id: string): Promise<boolean> {
    return this.exclusive(id, async () => {
      this.require(id);
      rmSync(this.file(id)); this.records.delete(id);
      rmSync(path.join(this.draftsDir, `${id}.json`), { force: true });
      return true;
    });
  }
  saveDraft(id: string, raw: { manifest: unknown; files: unknown; previous?: string; base?: string; manifestText?: string }): unknown {
    appId(id);
    const pkg = { manifest: parseAppManifest(raw.manifest), files: packageFiles(raw.files) };
    const manifestText = raw.manifestText ?? JSON.stringify(pkg.manifest, null, 2);
    if (typeof manifestText !== "string" || Buffer.byteLength(manifestText) > 65536) throw new Error("Manifest draft exceeds 64 KiB");
    if (pkg.manifest.id !== id) throw new Error("Draft identity mismatch");
    const file = path.join(this.draftsDir, `${id}.json`);
    const old = existsSync(file) ? JSON.parse(readBounded(file)) : undefined;
    if (old && raw.previous !== old.fingerprint) throw new Error("Draft changed; reload before saving");
    if (!old && this.records.has(id) && raw.base !== this.require(id).fingerprint) throw new Error("Published app changed; reload before starting its draft");
    const draft = { ...pkg, manifestText, fingerprint: fingerprint({ ...pkg, manifestText }), base: old?.base ?? this.records.get(id)?.fingerprint ?? null, savedAt: new Date().toISOString() };
    atomicJson(file, draft); return draft;
  }
  listDrafts(): AppSummary[] {
    return readdirSync(this.draftsDir).filter(name => /^[a-z0-9][a-z0-9_-]{1,63}\.json$/.test(name)).flatMap(name => {
      try {
        const draft = this.getDraft(name.slice(0, -5)), m = draft.manifest as AppManifest;
        return [{ id: m.id, name: m.name, version: m.version, description: m.description, category: m.category, icon: m.icon, isRunning: false, storageBytes: 0, triggerCount: m.triggers.length, lastExecutedAt: null, isDraft: true }];
      } catch { return []; }
    });
  }
  getDraft(id: string): any {
    const file = path.join(this.draftsDir, `${appId(id)}.json`);
    if (existsSync(file)) return JSON.parse(readBounded(file));
    const r = this.require(id); return { ...structuredClone(r.published), manifestText: JSON.stringify(r.published.manifest, null, 2), fingerprint: null, base: r.fingerprint };
  }
  discardDraft(id: string): void { rmSync(path.join(this.draftsDir, `${appId(id)}.json`), { force: true }); }
  async publishDraft(id: string, expected: string): Promise<AppDetails> {
    const draft = this.getDraft(id);
    if (!expected || draft.fingerprint !== expected) throw new Error("Draft changed; review it before publishing");
    const manifest = JSON.parse(draft.manifestText ?? JSON.stringify(draft.manifest));
    if (manifest.id !== id) throw new Error("Manifest identity does not match its draft");
    const result = this.records.has(id) ? await this.updateApp(id, manifest, draft.files, draft.base, true) : await this.installApp(manifest, draft.files);
    if (this.getDraft(id).fingerprint === expected) this.discardDraft(id);
    return result;
  }
  async rehearse(id: string, expected: string, controlId: string, value: unknown): Promise<unknown> {
    const draft = this.getDraft(id);
    if (!expected || draft.fingerprint !== expected) throw new Error("Save and review the current draft");
    const pkg = this.validate(JSON.parse(draft.manifestText ?? JSON.stringify(draft.manifest)), draft.files);
    if (!pkg.manifest.entrypoints.backend) throw new Error("No executable backend");
    return this.pool.execute(id, { duckdb: pkg.manifest.entitlements.storage.duckdb, backend: pkg.manifest.entrypoints.backend, files: pkg.files, state: {}, surfaces: this.initialSurfaces(pkg), controlId, value });
  }
  async acknowledgeUncertain(id: string, runId: string): Promise<AppDetails> {
    return this.exclusive(id, async () => {
      const r = this.require(id);
      if (r.run?.id !== runId || r.run.status !== "uncertain") throw new Error("Execution receipt changed; reload before acknowledging");
      this.save(id, { ...r, scheduling: false, run: { ...r.run, status: "failed", error: "User reviewed uncertain effects; operation was not replayed" } });
      return this.getApp(id)!;
    });
  }
  async setScheduling(id: string, enabled: boolean): Promise<AppDetails> {
    return this.exclusive(id, async () => { const r = this.require(id); if (enabled && r.run?.status === "uncertain") throw new Error("Review uncertain execution before scheduling"); this.save(id, { ...r, scheduling: enabled }); return this.getApp(id)!; });
  }
  async dispatchAction(appId: string, controlId: string, value: unknown, action?: string, expectedRevision?: number, surface?: string): Promise<any> {
    if (!Number.isInteger(expectedRevision)) throw new Error("Current app revision is required");
    return this.execute(appId, controlId, value, action, false, expectedRevision, surface);
  }
  private async execute(id: string, controlId: string, value: unknown, action?: string, trigger = false, expectedRevision?: number, surface?: string): Promise<any> {
    return this.exclusive(id, async () => {
      if (this.closing) throw new Error("App runtime is shutting down");
      const original = this.require(id);
      if (original.run?.status === "uncertain") throw new Error("Previous app operation is uncertain; inspect its effects before continuing");
      if (expectedRevision !== undefined && expectedRevision !== original.revision) throw new Error("App changed; reload before submitting");
      if (surface && !original.surfaces[surface]) throw new Error("Unknown source surface");
      const manifest = original.published.manifest;
      if (!manifest.entrypoints.backend) throw new Error("This saved surface has no executable backend; build its app behavior before running actions");
      const run: AppRun = { id: randomUUID(), status: "running", at: new Date().toISOString(), calls: [] };
      const history = [...(original.history ?? []), ...(original.run ? [original.run] : [])].slice(-50);
      this.save(id, { ...original, run, history });
      let effectAttempted = false;
      try {
        const response = await this.pool.execute(id, { duckdb: manifest.entitlements.storage.duckdb, database: original.database, backend: manifest.entrypoints.backend, files: original.published.files, state: structuredClone(original.state), surfaces: structuredClone(original.surfaces), controlId, value, action, trigger, surface,
          timeoutMs: trigger ? manifest.triggers.find(t => t.action === action)!.maxDurationSec * 1000 : 30000,
          callTool: async (name, args, signal) => {
            if (!manifest.entitlements.mcpTools.includes(name) || !this.callTool) throw new Error("Tool is not declared or available for this app");
            effectAttempted = true;
            const call = { name, argsHash: fingerprint(args), status: "attempted" as "attempted" | "completed" };
            run.calls!.push(call); this.save(id, { ...original, run, history });
            const value = await this.callTool(manifest, name, args, signal);
            call.status = "completed"; this.save(id, { ...original, run, history });
            return value;
          },
        });
        const surfaces = structuredClone(original.surfaces);
        const result = response.result;
        if (result.focusSurface !== undefined && (typeof result.focusSurface !== "string" || !surfaces[result.focusSurface])) throw new Error("Unknown app focus surface");
        const updates = !Object.keys(surfaces).length ? [] : Array.isArray(result.updates) ? result.updates : [{ surface: Object.keys(surfaces)[0], nodes: result.patches ?? [], data: result.data }];
        for (const update of updates) {
          if (!update || typeof update.surface !== "string" || !surfaces[update.surface]) throw new Error("Unknown app surface");
          const store = new SurfaceStore(basicCatalog); store.load(surfaces[update.surface]!);
          const diagnostics = store.update({ surface: update.surface, nodes: update.nodes ?? [], data: update.data });
          if ([...diagnostics, ...store.lint(store.get(update.surface)!)].some(d => d.severity === "error")) throw new Error("App returned an invalid surface update");
          surfaces[update.surface] = store.snapshot(update.surface)!;
        }
        const record: RecordState = { ...original, history, state: response.state, database: response.database, surfaces, revision: original.revision + 1, lastExecutedAt: new Date().toISOString(), run: { ...run, status: "completed" } };
        this.save(id, record);
        return { ...result, revision: record.revision, surfaces: record.surfaces, run: record.run };
      } catch (error) {
        this.save(id, { ...original, history, scheduling: effectAttempted ? false : original.scheduling, run: { ...run, status: effectAttempted ? "uncertain" : "failed", error: (error as Error).message.slice(0, 2000) } }); throw error;
      }
    });
  }
  async runTrigger(id: string, triggerId: string): Promise<{ ok: boolean; action: string; durationMs: number }> {
    const trigger = this.require(id).published.manifest.triggers.find(t => t.id === triggerId);
    if (!trigger) throw new Error("Unknown app trigger");
    const start = Date.now(); await this.execute(id, `trigger:${triggerId}`, { triggerId }, trigger.action, true);
    return { ok: true, action: trigger.action, durationMs: Date.now() - start };
  }
  async checkSchedules(now = new Date()): Promise<void> {
    if (this.closing || this.checkingSchedules) return;
    this.checkingSchedules = true;
    try {
    for (const [id, r] of this.records) {
      if (!r.scheduling || this.locks.has(id)) continue;
      for (const t of r.published.manifest.triggers) {
        const minute = now.toISOString().slice(0, 16);
        if (!isCronMatch(t.expression ?? "", now) || r.lastMinutes[t.id] === minute) continue;
        await this.exclusive(id, async () => { const current = this.require(id); this.save(id, { ...current, lastMinutes: { ...current.lastMinutes, [t.id]: minute } }); });
        try { await this.runTrigger(id, t.id); } catch { /* Failure stays visible in the durable run receipt; no automatic retry. */ }
      }
    }
    } finally { this.checkingSchedules = false; }
  }
  async shutdown(): Promise<void> { this.closing = true; if (this.schedulerTimer) clearInterval(this.schedulerTimer); await Promise.allSettled(this.locks.values()); }
}
function validCron(value: string): boolean {
  const fields = value.trim().split(/\s+/), limits = [59, 23, 31, 12, 6];
  return fields.length === 5 && fields.every((field, i) => field.split(",").every(part => {
    if (part === "*") return true;
    if (/^\*\/[1-9]\d*$/.test(part)) return Number(part.slice(2)) <= limits[i]! + 1;
    return /^(\d+)(-\d+)?$/.test(part) && part.split("-").every(v => Number(v) <= limits[i]! && Number(v) >= (i === 2 || i === 3 ? 1 : 0));
  }));
}
