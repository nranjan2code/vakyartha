// Realm state, locking and promotion belong to vak-sandbox. This adapter only
// validates tool arguments and invokes its bounded public CLI contract.
import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { sandboxHelper, validateSandboxWorkspace } from "./sandbox-status.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface RealmSummary { realm_id: string; base_path: string | null; workspace: string; created_at: string; status: string; last_transaction: string | null; entries: number; bytes: number }
export interface RealmReview { realm_id: string; fingerprint: string; total: number; offset: number; next_offset: number; can_promote: boolean; changes: { path: string; before: { kind: string; hash: string; bytes: number; mode: number } | null; after: { kind: string; hash: string; bytes: number; mode: number } | null; conflict: boolean; blocked: boolean }[] }
type Args = Record<string, unknown>;
const realmId = (value: unknown) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Provide a valid Realm ID."); return value; };
const relative = (value: unknown) => { if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512 || path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.includes("\0")) throw new Error("Use a relative path inside the Realm."); return value; };
const offset = (value: unknown) => { if (value === undefined) return 0; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Offset must be a nonnegative integer."); return value; };

function cli(binary: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 45000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, { cwd, env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: cwd, TMPDIR: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined, settled = false;
    const stop = (error: Error) => { if (!failure) { failure = error; child.kill("SIGTERM"); } };
    const timer = setTimeout(() => stop(new Error(`Realm operation exceeded its ${Math.round(timeoutMs / 1000)} second limit. Inspect its status before retrying.`)), timeoutMs);
    const abort = () => stop(new Error("Realm operation cancelled. Inspect its status before retrying."));
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) return stop(new Error("Realm response exceeded 256 KiB. Use paged review or file reads.")); if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8"); };
    child.stdout.on("data", (part: Buffer) => collect("stdout", part)); child.stderr.on("data", (part: Buffer) => collect("stderr", part));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { if (settled) return; settled = true; cleanup(); reject(error); });
    child.once("close", code => { if (settled) return; settled = true; cleanup(); if (failure) return reject(failure); if (code !== 0) return reject(new Error(stderr.trim() || `Realm helper exited with code ${code}.`)); try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Sandbox helper returned an invalid Realm receipt.")); } });
  });
}

export class SandboxRealms {
  readonly options: { binaryPath: string; dataDir: string; enabled: () => boolean; workspace: () => string; workspaces?: WorkspaceRegistry };
  private realmLocks = new Map<string, Promise<unknown>>();

  constructor(options: SandboxRealms["options"]) { this.options = options; }

  private async withRealmLock<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.realmLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.realmLocks.set(id, prev.then(() => gate, () => gate));
    try {
      await prev;
      return await op();
    } finally {
      release();
      if (this.realmLocks.get(id) === gate) {
        this.realmLocks.delete(id);
      }
    }
  }

  private async call(args: string[], signal?: AbortSignal, timeoutMs = 45000): Promise<unknown> {
    if (!this.options.enabled() && !["list", "status", "snapshot", "read"].includes(args[0] ?? "")) throw new Error("Sandbox execution is disabled. No Realm operation was performed.");
    if (process.platform !== "darwin") throw new Error("Realm execution requires macOS Seatbelt.");
    if (!(await sandboxHelper(this.options.binaryPath)).compatible) throw new Error("A supervised sandbox helper is required. Rebuild or reinstall it before accessing Realms.");
    const store = path.join(this.options.dataDir, "sandbox");
    await mkdir(store, { recursive: true, mode: 0o700 });
    return cli(this.options.binaryPath, ["--store", store, "realm", ...args], this.options.dataDir, signal, timeoutMs);
  }
  async list(signal?: AbortSignal): Promise<RealmSummary[]> {
    const value = await this.call(["list"], signal);
    if (!Array.isArray(value)) throw new Error("Invalid Realm list.");
    return value as RealmSummary[];
  }
  async create(projectPath?: string, signal?: AbortSignal): Promise<{ realm_id: string; base_path: string }> {
    const raw = projectPath ?? this.options.workspace().trim();
    if (!raw) throw new Error("No folder workspace is admitted for this chat. Select 'Work in folder' to enable workspace tools.");
    const project = validateSandboxWorkspace(raw);
    return (await this.call(["create", `--project=${project}`], signal)) as { realm_id: string; base_path: string };
  }
  async status(id: string, signal?: AbortSignal): Promise<any> {
    return this.call(["status", realmId(id)], signal);
  }
  async exec(id: string, command: string, args: string[], cwd = ".", signal?: AbortSignal, timeoutMs = 45000): Promise<any> {
    return this.withRealmLock(id, () => this.call(["exec", realmId(id), `--cwd=${relative(cwd)}`, "--", command, ...args], signal, timeoutMs));
  }
  async snapshot(id: string, offsetVal = 0, signal?: AbortSignal): Promise<RealmReview> {
    return (await this.withRealmLock(id, () => this.call(["snapshot", realmId(id), `--offset=${offset(offsetVal)}`], signal))) as RealmReview;
  }
  async read(id: string, filePath: string, offsetVal = 0, original = false, signal?: AbortSignal): Promise<any> {
    return this.call(["read", `--offset=${offset(offsetVal)}`, ...(original ? ["--original"] : []), "--", realmId(id), relative(filePath)], signal);
  }
  async promote(id: string, fingerprint: string, paths: string[], signal?: AbortSignal): Promise<any> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !paths.length || paths.length > 200) throw new Error("Provide the current review fingerprint and all reviewed paths (at most 200 changes).");
    return this.withRealmLock(id, () => this.call(["promote", realmId(id), `--fingerprint=${fingerprint}`, ...paths.map(p => `--paths=${relative(p)}`)], signal));
  }
  async rollback(id: string, transactionId: string, paths: string[], signal?: AbortSignal): Promise<any> {
    if (!paths.length || paths.length > 200) throw new Error("Provide the affected paths from the receipt.");
    return this.withRealmLock(id, () => this.call(["rollback", realmId(id), realmId(transactionId), ...paths.map(p => `--paths=${relative(p)}`)], signal));
  }
  async recover(id: string, paths: string[], signal?: AbortSignal): Promise<any> {
    if (!paths.length || paths.length > 200) throw new Error("Provide the affected paths from the receipt or current recovery status.");
    return this.withRealmLock(id, () => this.call(["recover", realmId(id), ...paths.map(p => `--paths=${relative(p)}`)], signal));
  }
  async destroy(id: string, signal?: AbortSignal): Promise<any> {
    return this.withRealmLock(id, () => this.call(["destroy", realmId(id)], signal));
  }
  async execute(name: string, args: Args, signal?: AbortSignal): Promise<unknown> {
    if (name === "list_realms") return this.list(signal);
    const rawWorkspace = this.options.workspace().trim();
    if (!rawWorkspace) throw new Error("No folder workspace is admitted for this chat. Select 'Work in folder' to enable workspace tools.");
    const project = validateSandboxWorkspace(rawWorkspace);
    const activeSession = this.options.workspaces?.currentSession()?.session;

    if (activeSession && this.options.workspaces) {
      const binding = this.options.workspaces.getBinding(activeSession);
      if (binding?.mode === "direct") {
        throw new Error("This chat is operating in direct in-place editing mode. Commands write directly to the project folder; Realm staging and promotion are not used.");
      }
    }

    if (name === "create_realm") {
      const created = (await this.call(["create", `--project=${project}`], signal)) as { realm_id: string };
      if (activeSession && this.options.workspaces) {
        await this.options.workspaces.setRealmId(activeSession, created.realm_id);
      }
      return created;
    }

    let id: string;
    if (typeof args.realmId === "string" && args.realmId) {
      id = realmId(args.realmId);
      if (activeSession && this.options.workspaces) {
        const access = this.options.workspaces.verifySessionRealmAccess(activeSession, id);
        if (!access.ok) throw new Error(access.error);
      }
    } else if (activeSession && this.options.workspaces) {
      const bound = this.options.workspaces.getBinding(activeSession);
      if (bound?.realmId) {
        id = bound.realmId;
      } else if (bound?.projectId && bound?.shared) {
        const proj = this.options.workspaces.getProject(bound.projectId);
        if (proj?.sharedRealmId) {
          id = proj.sharedRealmId;
          await this.options.workspaces.setRealmId(activeSession, id);
        } else {
          const created = (await this.call(["create", `--project=${project}`], signal)) as { realm_id: string };
          await this.options.workspaces.setRealmId(activeSession, created.realm_id);
          id = created.realm_id;
        }
      } else {
        const created = (await this.call(["create", `--project=${project}`], signal)) as { realm_id: string };
        await this.options.workspaces.setRealmId(activeSession, created.realm_id);
        id = created.realm_id;
      }
    } else {
      id = realmId(args.realmId);
    }

    const status = (await this.call(["status", id], signal)) as { realm?: RealmSummary };
    if (!status.realm?.base_path || (await realpath(status.realm.base_path)) !== project) {
      throw new Error("This Realm belongs to a different project. Restore that project setting before using it.");
    }

    if (name === "realm_status") return status;
    if (name === "snapshot_realm") return this.withRealmLock(id, () => this.call(["snapshot", id, `--offset=${offset(args.offset)}`], signal));
    if (name === "read_realm_file") return this.call(["read", `--offset=${offset(args.offset)}`, ...(args.original === true ? ["--original"] : []), "--", id, relative(args.path)], signal);
    if (name === "run_in_realm") {
      const command = args.command, argv = args.args;
      if (typeof command !== "string" || !command || command.length > 256 || command.startsWith("-") || !Array.isArray(argv) || argv.length > 64 || argv.some(a => typeof a !== "string" || Buffer.byteLength(a) > 4096) || Buffer.byteLength(JSON.stringify(argv)) > 16384) throw new Error("Provide a command and at most 64 string arguments, no more than 16 KiB total.");
      const timeoutSec = typeof args.timeout_seconds === "number" && args.timeout_seconds >= 1 && args.timeout_seconds <= 300
        ? args.timeout_seconds
        : 45;
      const timeoutMs = (timeoutSec + 5) * 1000;
      return this.withRealmLock(id, () => this.call(["exec", id, `--cwd=${relative(args.workingDirectory ?? ".")}`, "--", command, ...argv], signal, timeoutMs));
    }
    if (name === "promote_realm") {
      if (typeof args.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(args.fingerprint) || !Array.isArray(args.paths) || !args.paths.length || args.paths.length > 200) throw new Error("Provide the current review fingerprint and all reviewed paths (at most 200 changes).");
      const paths = (args.paths as unknown[]).map(p => relative(p));
      return this.withRealmLock(id, () => this.call(["promote", id, `--fingerprint=${args.fingerprint}`, ...paths.map(p => `--paths=${p}`)], signal));
    }
    if (name === "rollback_realm" || name === "recover_realm") {
      if (!Array.isArray(args.paths) || args.paths.length > 200) throw new Error("Provide the affected paths from the receipt or current recovery status.");
      const paths = args.paths.map(p => `--paths=${relative(p)}`);
      return this.withRealmLock(id, () => this.call(name === "rollback_realm" ? ["rollback", id, realmId(args.transactionId), ...paths] : ["recover", id, ...paths], signal));
    }
    if (name === "destroy_realm") {
      const res = await this.withRealmLock(id, () => this.call(["destroy", id], signal));
      if (activeSession && this.options.workspaces) {
        await this.options.workspaces.clearRealmId(activeSession);
      }
      return res;
    }
    throw new Error(`Unknown Realm operation: ${name}`);
  }
}

const string = (description: string) => ({ type: "string", description });
const realm = { realmId: string("ID returned by create_realm or list_realms.") };
const schemas: [string, string, string, Record<string, unknown>, string[], boolean][] = [
  ["create_realm", "Create an isolated project workspace", "Copy the configured project into a durable Realm. Commands can write there across calls; the original stays unchanged until reviewed promotion.", {}, [], true],
  ["list_realms", "List retained workspaces", "List durable Realms and their original project, status and last promotion receipt.", {}, [], true],
  ["realm_status", "Inspect a Realm", "Inspect a retained Realm before resuming work. Interrupted work requires explicit recovery; never replay a command automatically.", realm, ["realmId"], true],
  ["run_in_realm", "Run in an isolated Realm", "Execute in the same durable copy across calls. Network denied, 30 seconds and 32 KiB output per call. Writes persist in the copy, not the original.", { ...realm, command: string("Executable name or absolute path; no implicit shell."), args: { type: "array", items: { type: "string" }, maxItems: 64 }, workingDirectory: string("Relative directory, default dot.") }, ["realmId", "command", "args"], false],
  ["snapshot_realm", "Review Realm changes", "Record a review fingerprint and return up to 20 changes per page. Read all pages and relevant file contents before requesting promotion. At most 200 changed paths can be promoted together.", { ...realm, offset: { type: "integer", minimum: 0 } }, ["realmId"], true],
  ["read_realm_file", "Read a Realm file", "Read up to 16 KiB by byte offset. Set original=true to inspect its original-project version. Lossy text is marked; do not treat it as exact binary content.", { ...realm, path: string("Relative file path."), offset: { type: "integer", minimum: 0 }, original: { type: "boolean" } }, ["realmId", "path"], true],
  ["promote_realm", "Apply reviewed Realm changes to the project", "Write exactly the reviewed candidate back to the original project. Supply the latest fingerprint and ALL paths in review order. Conflicts, stale reviews, protected files and path escapes are refused. Returns a rollback receipt.", { ...realm, fingerprint: string("Exact SHA-256 fingerprint returned by snapshot_realm."), paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 } }, ["realmId", "fingerprint", "paths"], false],
  ["rollback_realm", "Undo a Realm promotion", "Restore backups for this Realm's most recent promotion. Refuses to overwrite later project edits. Returns an operation receipt.", { ...realm, transactionId: string("Most recent committed promotion receipt ID."), paths: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["realmId", "transactionId", "paths"], false],
  ["recover_realm", "Recover interrupted Realm work", "Roll back interrupted promotion from its journal and allow inspection/resumption. Never re-executes a command. Conflicting original-project edits require manual resolution.", { ...realm, paths: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["realmId", "paths"], false],
  ["destroy_realm", "Discard a Realm workspace", "Delete this isolated copy after recovery checks. Does not undo promotion. Promotion receipts and backups remain retained.", realm, ["realmId"], false],
];
export const realmTools = schemas.map(([name, title, description, properties, required, readOnly]) => ({ name, title, description, inputSchema: { type: "object", additionalProperties: false, properties, required }, annotations: { title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false as const } }));
