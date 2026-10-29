import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type WorkspaceMode = "copy_review" | "direct";
export type WorkspaceAccessState = "admitted" | "revoked" | "missing" | "inaccessible";

export interface Project {
  id: string;
  name: string;
  folder: string;
  revision: number;
  sharedRealm?: boolean;
  sharedRealmId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceBinding {
  session: string;
  projectId?: string;
  folder: string;
  /** Filesystem object identity captured when the user explicitly binds this folder. */
  folderIdentity?: string;
  mode: WorkspaceMode;
  realmId?: string;
  shared?: boolean;
  revision: number;
  accessState: WorkspaceAccessState;
  boundAt: string;
  updatedAt: string;
}

interface WorkspaceRegistryData {
  version: 1;
  projects: Project[];
  bindings: Record<string, WorkspaceBinding>;
}

export interface FolderValidationResult {
  canonical: string;
  isDirectory: boolean;
  isReadable: boolean;
  isWritable: boolean;
}

/**
 * Validates a folder for workspace admission. Rejects relative paths, non-directories,
 * system roots, the user's home folder root, and private app data directories.
 */
export function validateWorkspaceFolder(value: string, dataDir?: string): FolderValidationResult {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Enter a folder path.");
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error("Enter an absolute path to a project folder.");
  }

  let canonical: string;
  try {
    canonical = realpathSync(trimmed);
  } catch {
    throw new Error("This folder does not exist or cannot be accessed.");
  }

  let stat;
  try {
    stat = statSync(canonical);
  } catch {
    throw new Error("Could not inspect the folder status.");
  }

  if (!stat.isDirectory()) {
    throw new Error("The selected path is a file, not a directory. Select a project folder.");
  }

  let isReadable = false;
  let isWritable = false;
  try {
    accessSync(canonical, constants.R_OK | constants.X_OK);
    isReadable = true;
  } catch {
    throw new Error("This folder cannot be read. Choose an accessible project folder.");
  }

  try {
    accessSync(canonical, constants.W_OK);
    isWritable = true;
  } catch {
    // Read-only folders can be inspected but direct writes or certain workflows will be restricted.
    isWritable = false;
  }

  // Reject system roots and home directory itself
  const userHome = realpathSyncSafe(homedir());
  const rawDeniedRoots = [
    "/",
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/tmp",
    "/private",
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/Users",
    "/home",
    userHome,
  ];
  const deniedRoots = new Set(rawDeniedRoots.map(p => realpathSyncSafe(p)));

  if (deniedRoots.has(canonical)) {
    throw new Error("Choose a specific project folder, rather than your home or a system folder.");
  }

  // Reject app-private directories
  if (dataDir) {
    const canonicalDataDir = realpathSyncSafe(dataDir);
    if (canonical === canonicalDataDir || canonical.startsWith(`${canonicalDataDir}${path.sep}`)) {
      throw new Error("Application data directory cannot be selected as a workspace folder.");
    }
  }

  const baseName = path.basename(canonical);
  if ([".vak", ".git", ".ssh", ".aws"].includes(baseName)) {
    throw new Error(`The folder name '${baseName}' is reserved for configuration or metadata.`);
  }

  return {
    canonical,
    isDirectory: true,
    isReadable,
    isWritable,
  };
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function physicalIdentityOf(dev: bigint, ino: bigint, birthtimeNs: bigint): string | undefined {
  // Include object creation time so deleting and recreating a directory cannot
  // inherit a grant if its filesystem later reuses an inode number.
  if (dev === 0n || ino === 0n || birthtimeNs === 0n) return undefined;
  return `${dev.toString(16)}:${ino.toString(16)}:${birthtimeNs.toString(16)}`;
}

export class WorkspaceRegistry {
  private readonly dataDir: string;
  private readonly file: string;
  private projects = new Map<string, Project>();
  private bindings = new Map<string, WorkspaceBinding>();
  private committedProjects = new Map<string, Project>();
  private committedBindings = new Map<string, WorkspaceBinding>();
  private sessionContext = new AsyncLocalStorage<{ session: string; revision?: number | null }>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "workspaces.json");
    this.load();
    this.snapshotCommitted();
  }

  /** Run asynchronous work within a specific session and revision context. */
  withSession<T>(session: string, work: () => T, revision?: number | null): T {
    return this.sessionContext.run({ session, revision }, work);
  }

  /** Get the current session and revision from AsyncLocalStorage, if active. */
  currentSession(): { session: string; revision?: number | null } | undefined {
    return this.sessionContext.getStore();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as WorkspaceRegistryData;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !parsed.bindings || typeof parsed.bindings !== "object") {
        throw new Error("unsupported registry shape");
      }
      for (const p of parsed.projects) {
        if (!p || typeof p.id !== "string" || typeof p.folder !== "string" || typeof p.name !== "string" || !Number.isSafeInteger(p.revision) || p.revision < 1) {
          throw new Error("invalid project entry");
        }
        this.projects.set(p.id, p);
      }
      for (const [s, value] of Object.entries(parsed.bindings)) {
        if (!value || typeof value !== "object") throw new Error("invalid binding entry");
        const b = value as WorkspaceBinding;
        if (typeof b.session !== "string" || b.session !== s || typeof b.folder !== "string" || !["copy_review", "direct"].includes(b.mode)
          || !Number.isSafeInteger(b.revision) || b.revision < 1
          || !["admitted", "revoked", "missing", "inaccessible"].includes(b.accessState)
          || (b.folderIdentity !== undefined && (typeof b.folderIdentity !== "string" || !/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(b.folderIdentity)))) {
          throw new Error("invalid binding entry");
        }
        // A path-only record predates physical identity binding. Preserve the
        // record, but require a fresh explicit grant before dispatch.
        if (!b.folderIdentity) {
          b.accessState = "revoked";
          b.revision += 1;
          b.updatedAt = new Date().toISOString();
        }
        this.bindings.set(s, b);
      }
    } catch {
      throw new Error("Workspace registry is corrupt or unreadable. Workspace access is disabled until its data is repaired.");
    }
  }

  private snapshotCommitted(): void {
    this.committedProjects = new Map(Array.from(this.projects, ([id, value]) => [id, structuredClone(value)]));
    this.committedBindings = new Map(Array.from(this.bindings, ([id, value]) => [id, structuredClone(value)]));
  }

  private persist(): void {
    const data: WorkspaceRegistryData = {
      version: 1,
      projects: Array.from(this.projects.values()),
      bindings: Object.fromEntries(this.bindings.entries()),
    };
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.snapshotCommitted();
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      this.projects = new Map(Array.from(this.committedProjects, ([id, value]) => [id, structuredClone(value)]));
      this.bindings = new Map(Array.from(this.committedBindings, ([id, value]) => [id, structuredClone(value)]));
      throw err;
    }
  }

  // --- Project Management ---

  async createProject(name: string, folder: string, sharedRealm = false): Promise<Project> {
    const trimmedName = (name ?? "").trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new Error("Project name must be between 1 and 100 characters.");
    }
    const { canonical } = validateWorkspaceFolder(folder, this.dataDir);
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: trimmedName,
      folder: canonical,
      revision: 1,
      sharedRealm: Boolean(sharedRealm),
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.persist();
    return structuredClone(project);
  }

  getProject(id: string): Project | undefined {
    const p = this.projects.get(id);
    return p ? structuredClone(p) : undefined;
  }

  listProjects(): Project[] {
    return Array.from(this.projects.values()).map(p => structuredClone(p));
  }

  async updateProject(id: string, updates: { name?: string; folder?: string; sharedRealm?: boolean }): Promise<Project> {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project '${id}' not found.`);

    let changed = false;
    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (!trimmedName || trimmedName.length > 100) {
        throw new Error("Project name must be between 1 and 100 characters.");
      }
      p.name = trimmedName;
      changed = true;
    }

    if (updates.folder !== undefined) {
      const { canonical } = validateWorkspaceFolder(updates.folder, this.dataDir);
      if (canonical !== p.folder) {
        p.folder = canonical;
        p.revision += 1;
        changed = true;
      }
    }

    if (updates.sharedRealm !== undefined && updates.sharedRealm !== p.sharedRealm) {
      p.sharedRealm = updates.sharedRealm;
      changed = true;
    }

    if (changed) {
      p.updatedAt = new Date().toISOString();
      this.persist();
    }
    return structuredClone(p);
  }

  async setProjectSharedRealm(projectId: string, shared: boolean, realmId?: string): Promise<Project | undefined> {
    const p = this.projects.get(projectId);
    if (!p) return undefined;
    p.sharedRealm = shared;
    if (realmId) p.sharedRealmId = realmId;
    p.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(p);
  }

  /**
   * Removing a project never deletes the source folder or files on disk.
   * Existing chat bindings associated with this project have their projectId cleared
   * so they remain valid independent folder chats until explicitly re-scoped.
   */
  async removeProject(id: string): Promise<boolean> {
    if (!this.projects.has(id)) return false;
    this.projects.delete(id);

    // Detach project reference from existing bindings without invalidating their folder authority
    for (const binding of this.bindings.values()) {
      if (binding.projectId === id) {
        delete binding.projectId;
        binding.updatedAt = new Date().toISOString();
      }
    }

    this.persist();
    return true;
  }

  // --- Session Workspace Bindings ---

  async bindSession(session: string, opts: {
    folder: string;
    projectId?: string;
    mode?: WorkspaceMode;
    realmId?: string;
    shareProjectRealm?: boolean;
  }): Promise<WorkspaceBinding> {
    if (!session || typeof session !== "string") {
      throw new Error("Session ID is required for workspace binding.");
    }

    const mode: WorkspaceMode = opts.mode === "direct" ? "direct" : "copy_review";

    let projectRecord: Project | undefined;
    if (opts.projectId) {
      projectRecord = this.projects.get(opts.projectId);
      if (!projectRecord) throw new Error(`Project '${opts.projectId}' not found.`);
    }

    const { canonical } = validateWorkspaceFolder(opts.folder, this.dataDir);
    const physicalStat = statSync(canonical, { bigint: true });
    const physicalIdentity = physicalIdentityOf(physicalStat.dev, physicalStat.ino, physicalStat.birthtimeNs);
    if (!physicalIdentity) throw new Error("This filesystem cannot provide a stable folder identity. Workspace access is unavailable here.");
    const existing = this.bindings.get(session);
    const now = new Date().toISOString();

    const shared = mode === "direct" ? false : Boolean(opts.shareProjectRealm ?? projectRecord?.sharedRealm);
    if (shared && projectRecord) {
      const projectStat = statSync(projectRecord.folder, { bigint: true });
      const projectIdentity = physicalIdentityOf(projectStat.dev, projectStat.ino, projectStat.birthtimeNs);
      if (!projectIdentity || projectIdentity !== physicalIdentity) {
        throw new Error("A shared project Realm requires a binding to the project's current physical folder.");
      }
    }
    let targetRealmId = opts.realmId ?? (existing?.folderIdentity === physicalIdentity ? existing.realmId : undefined);

    // If sharing project Realm and project already has a realmId, adopt it
    if (shared && projectRecord?.sharedRealmId && mode !== "direct") {
      targetRealmId = projectRecord.sharedRealmId;
    }

    const nextRevision = existing ? existing.revision + 1 : 1;
    const binding: WorkspaceBinding = {
      session,
      projectId: opts.projectId,
      folder: canonical,
      folderIdentity: physicalIdentity,
      mode,
      realmId: mode === "direct" ? undefined : targetRealmId,
      shared,
      revision: nextRevision,
      accessState: "admitted",
      boundAt: existing?.boundAt ?? now,
      updatedAt: now,
    };

    this.bindings.set(session, binding);
    this.persist();
    return structuredClone(binding);
  }

  getBinding(session: string): WorkspaceBinding | undefined {
    const b = this.bindings.get(session);
    return b ? structuredClone(b) : undefined;
  }

  /** Capture the exact folder-binding state when an operation is admitted. */
  captureBindingRevision(session: string): number | null {
    return this.bindings.get(session)?.revision ?? null;
  }

  listBindings(): WorkspaceBinding[] {
    return Array.from(this.bindings.values()).map(b => structuredClone(b));
  }

  /**
   * Revalidates an existing session binding against the real filesystem.
   * If the folder was removed, permissions revoked, or replaced by another target,
   * updates the accessState and increments revision.
   */
  revalidateBinding(session: string): WorkspaceBinding | undefined {
    const b = this.bindings.get(session);
    if (!b) return undefined;

    // Loss of authority is sticky. A missing or revoked folder can only be
    // admitted again by an explicit bindSession operation from the user.
    if (b.accessState !== "admitted") return structuredClone(b);

    let newState: WorkspaceAccessState = b.accessState;
    try {
      const canonical = realpathSync(b.folder);
      if (canonical !== b.folder) {
        newState = "revoked";
      } else {
        const stat = statSync(canonical, { bigint: true });
        if (!stat.isDirectory()) {
          newState = "missing";
        } else {
          const identity = physicalIdentityOf(stat.dev, stat.ino, stat.birthtimeNs);
          if (!b.folderIdentity || identity !== b.folderIdentity) {
            newState = "revoked";
          } else {
            try {
              accessSync(canonical, constants.R_OK | constants.X_OK);
              newState = "admitted";
            } catch {
              newState = "inaccessible";
            }
          }
        }
      }
    } catch {
      try {
        statSync(b.folder);
        newState = "inaccessible";
      } catch {
        newState = "missing";
      }
    }

    if (newState !== b.accessState) {
      b.accessState = newState;
      b.revision += 1;
      b.updatedAt = new Date().toISOString();
      this.persist();
    }

    return structuredClone(b);
  }

  /**
   * Revalidates all session bindings across the registry.
   * Returns whether all are valid and lists sessions whose bindings are no longer admitted.
   */
  async revalidateBindings(): Promise<{ valid: boolean; staleSessions: string[] }> {
    const staleSessions: string[] = [];
    for (const session of this.bindings.keys()) {
      const b = this.revalidateBinding(session);
      if (b && b.accessState !== "admitted") {
        staleSessions.push(session);
      }
    }
    return { valid: staleSessions.length === 0, staleSessions };
  }

  async setRealmId(session: string, realmId: string): Promise<WorkspaceBinding | undefined> {
    const b = this.bindings.get(session);
    if (!b) return undefined;
    if (b.mode === "direct") throw new Error("Direct workspace bindings cannot own a Realm.");
    if (typeof realmId !== "string" || !realmId.trim()) throw new Error("Realm ID is required.");
    if (b.realmId && b.realmId !== realmId) {
      throw new Error("This workspace is already assigned to another Realm. Detach it explicitly before assigning a new Realm.");
    }
    b.realmId = realmId;
    b.updatedAt = new Date().toISOString();

    // If session is part of a project with sharedRealm, record sharedRealmId on project
    if (b.projectId && b.shared) {
      const proj = this.projects.get(b.projectId);
      if (proj) {
        proj.sharedRealmId = realmId;
        proj.updatedAt = new Date().toISOString();
      }
    }

    this.persist();
    return structuredClone(b);
  }

  async clearRealmId(session: string): Promise<WorkspaceBinding | undefined> {
    const b = this.bindings.get(session);
    if (!b) return undefined;
    delete b.realmId;
    b.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(b);
  }

  /**
   * Prevents cross-chat Realm ID injection: ensures the requested Realm ID
   * belongs to this session's binding or its project's shared Realm.
   */
  verifySessionRealmAccess(session: string, requestedRealmId: string): { ok: true } | { ok: false; error: string } {
    const b = this.revalidateBinding(session);
    if (!b) {
      return { ok: false, error: "No workspace binding found for this session." };
    }
    if (b.accessState !== "admitted") {
      return { ok: false, error: `Workspace access is ${b.accessState}; Realm access is suspended.` };
    }
    let allowed = false;
    if (b.realmId && b.realmId === requestedRealmId) {
      allowed = true;
    } else if (b.projectId && b.shared && (!b.realmId || b.realmId === requestedRealmId)) {
      const proj = this.getProject(b.projectId);
      if (proj?.sharedRealmId && proj.sharedRealmId === requestedRealmId) {
        allowed = true;
      }
    }
    if (!allowed) {
      return { ok: false, error: `Access denied: Realm '${requestedRealmId}' does not belong to session '${session}'.` };
    }
    return { ok: true };
  }

  async revokeBinding(session: string, reason: WorkspaceAccessState = "revoked"): Promise<WorkspaceBinding | undefined> {
    const b = this.bindings.get(session);
    if (!b) return undefined;
    if (b.accessState !== reason) {
      b.accessState = reason;
      b.revision += 1;
      b.updatedAt = new Date().toISOString();
      this.persist();
    }
    return structuredClone(b);
  }

  async unbindSession(session: string): Promise<boolean> {
    if (!this.bindings.has(session)) return false;
    this.bindings.delete(session);
    this.persist();
    return true;
  }

  /**
   * Verifies that the given session is authorized for file/command execution.
   * If expectedRevision is provided, validates that the binding has not changed
   * (e.g. while awaiting approval).
   */
  verifyDispatchScope(session: string, expectedRevision?: number | null): { ok: true; binding: WorkspaceBinding } | { ok: false; error: string } {
    const b = this.revalidateBinding(session);
    if (!b) {
      return { ok: false, error: "No folder workspace is bound to this chat session." };
    }
    if (b.accessState !== "admitted") {
      return { ok: false, error: `Folder workspace access is ${b.accessState}. Re-select an accessible folder.` };
    }
    if (expectedRevision !== undefined && (expectedRevision === null || b.revision !== expectedRevision)) {
      return { ok: false, error: "The workspace binding revision changed since this operation was authorized. Re-authorize the operation." };
    }
    return { ok: true, binding: b };
  }

  /**
   * Resolves the effective workspace path for tool execution.
   * Returns empty string if the session has no folder workspace bound.
   * Throws an error if the binding is in a revoked, missing or inaccessible state,
   * or if the revision is stale.
   */
  resolveEffectiveWorkspace(explicitSession?: string): string {
    const active = explicitSession ?? this.currentSession()?.session;
    if (!active) {
      return "";
    }
    const binding = this.getBinding(active);
    if (!binding) {
      return "";
    }
    const check = this.verifyDispatchScope(active, this.currentSession()?.revision);
    if (!check.ok) {
      throw new Error(check.error);
    }
    return check.binding.folder;
  }
}
