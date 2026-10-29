import { api, ask, el, $ } from "./core.ts";
import { icon } from "./icons.ts";
import { pill } from "./ui.ts";
import { pickFolder } from "./backend.ts";

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
  mode: "copy_review" | "direct";
  realmId?: string;
  shared?: boolean;
  revision: number;
  accessState: "admitted" | "revoked" | "missing" | "inaccessible";
  boundAt: string;
  updatedAt: string;
}

export interface RealmReview {
  realm_id: string;
  fingerprint: string;
  total: number;
  offset: number;
  next_offset: number;
  can_promote: boolean;
  changes: {
    path: string;
    before: { kind: string; hash: string; bytes: number; mode: number } | null;
    after: { kind: string; hash: string; bytes: number; mode: number } | null;
    conflict: boolean;
    blocked: boolean;
  }[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function detectFileFormat(pathStr: string): { label: string; isBinary: boolean } {
  const ext = pathStr.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return { label: "PNG image", isBinary: true };
    case "jpg": case "jpeg": return { label: "JPEG image", isBinary: true };
    case "webp": return { label: "WebP image", isBinary: true };
    case "gif": return { label: "GIF image", isBinary: true };
    case "wav": return { label: "WAV audio", isBinary: true };
    case "mp3": return { label: "MP3 audio", isBinary: true };
    case "ogg": case "flac": return { label: "Audio", isBinary: true };
    case "mp4": return { label: "MP4 video", isBinary: true };
    case "webm": return { label: "WebM video", isBinary: true };
    case "pdf": return { label: "PDF document", isBinary: true };
    case "csv": return { label: "CSV data", isBinary: false };
    case "json": return { label: "JSON", isBinary: false };
    case "md": return { label: "Markdown", isBinary: false };
    default: return { label: ext.toUpperCase() || "File", isBinary: false };
  }
}

export class WorkspacesPanel {
  private barContainer: HTMLElement | null = null;
  private sidebarContainer: HTMLElement | null = null;
  private currentSession = "";
  private currentBinding: WorkspaceBinding | null = null;
  private onOpenChatHandler: ((id: string) => void) | null = null;
  private onNewProjectChatHandler: ((projectId: string, folder: string) => void) | null = null;
  private onRefreshHandler: (() => Promise<void>) | null = null;

  init(options: {
    bar: HTMLElement;
    sidebar: HTMLElement;
    onOpenChat: (id: string) => void;
    onNewProjectChat: (projectId: string, folder: string) => void;
    onRefresh: () => Promise<void>;
  }): void {
    this.barContainer = options.bar;
    this.sidebarContainer = options.sidebar;
    this.onOpenChatHandler = options.onOpenChat;
    this.onNewProjectChatHandler = options.onNewProjectChat;
    this.onRefreshHandler = options.onRefresh;
  }

  async updateForSession(sessionId: string): Promise<void> {
    this.currentSession = sessionId;
    if (!sessionId) {
      this.currentBinding = null;
      this.renderWorkspaceBar();
      return;
    }

    try {
      this.currentBinding = await api<WorkspaceBinding>(`/api/workspaces/bindings/${encodeURIComponent(sessionId)}`);
    } catch {
      this.currentBinding = null;
    }
    await this.renderWorkspaceBar();
  }

  getCurrentBinding(): WorkspaceBinding | null {
    return this.currentBinding;
  }

  private async renderWorkspaceBar(): Promise<void> {
    if (!this.barContainer) return;
    this.barContainer.replaceChildren();

    if (!this.currentSession) {
      this.barContainer.hidden = true;
      return;
    }

    this.barContainer.hidden = false;

    // Case 1: Session is not bound to any folder workspace
    if (!this.currentBinding || this.currentBinding.accessState !== "admitted") {
      const btn = el(
        "button",
        {
          type: "button",
          className: "workspace-admit-btn quiet",
          title: "Select a folder to enable sandboxed file tools and commands in this chat",
        },
        icon("folder", 16),
        el("span", { textContent: "Work in folder…" }),
      );
      btn.addEventListener("click", () => void this.showFolderDialog());
      this.barContainer.append(btn);
      return;
    }

    // Case 2: Session is admitted to a folder
    const b = this.currentBinding;
    const folderName = b.folder.split(/[\\/]/).filter(Boolean).pop() || b.folder;

    let modeText = "copy";
    let modeClass = "workspace-mode-pill";
    if (b.mode === "direct") {
      modeText = "direct";
      modeClass = "workspace-mode-pill direct";
    } else if (b.shared) {
      modeText = "shared";
      modeClass = "workspace-mode-pill shared";
    }

    const folderBadge = el(
      "div",
      { className: "workspace-info", title: `Canonical path: ${b.folder} (rev ${b.revision}) · ${b.mode === "direct" ? "Direct in-place" : "Isolated copy"}` },
      icon("folder", 14),
      el("strong", { className: "workspace-name", textContent: folderName }),
      el("span", { className: modeClass, textContent: modeText }),
    );

    const actions = el("div", { className: "workspace-actions" });

    // Probe review status if realm exists (only in copy_review mode)
    if (b.mode !== "direct" && b.realmId) {
      let review: RealmReview | null = null;
      try {
        review = await api<RealmReview>(`/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}/realm/review`);
      } catch {
        review = null;
      }

      if (review && review.total > 0) {
        const reviewBtn = el(
          "button",
          {
            type: "button",
            className: "primary small workspace-review-btn",
            title: "Inspect modified candidate files and apply them to the project folder",
          },
          icon("check", 12),
          el("span", { textContent: `${review.total} change${review.total === 1 ? "" : "s"}` }),
        );
        reviewBtn.addEventListener("click", () => void this.showReviewDrawer(review!));
        actions.append(reviewBtn);
      }
    }

    const refreshBtn = el(
      "button",
      {
        type: "button",
        className: "icon-btn workspace-btn",
        title: "Refresh working copy from original project folder",
      },
      icon("refresh", 13),
    );
    refreshBtn.addEventListener("click", async () => {
      try {
        await api(`/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}/realm/refresh`, {
          method: "POST",
          body: JSON.stringify({ force: false }),
        });
        await this.updateForSession(this.currentSession);
      } catch (err: any) {
        if (err.message?.includes("uncommitted changes")) {
          const force = await ask(
            "This chat has uncommitted changes in its working copy. Discard them and refresh from the original folder?",
            "Discard & Refresh",
          );
          if (force) {
            await api(`/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}/realm/refresh`, {
              method: "POST",
              body: JSON.stringify({ force: true }),
            });
            await this.updateForSession(this.currentSession);
          }
        } else {
          alert(err.message);
        }
      }
    });

    const unbindBtn = el(
      "button",
      {
        type: "button",
        className: "icon-btn workspace-btn",
        title: "Disconnect folder workspace from this chat",
      },
      icon("close", 13),
    );
    unbindBtn.addEventListener("click", async () => {
      if (await ask("Disconnect folder workspace from this chat? The original folder is not affected.", "Disconnect")) {
        await api(`/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}`, { method: "DELETE" });
        this.currentBinding = null;
        await this.updateForSession(this.currentSession);
        if (this.onRefreshHandler) await this.onRefreshHandler();
      }
    });

    actions.append(refreshBtn, unbindBtn);
    this.barContainer.append(folderBadge, actions);
  }

  // --- Sidebar Projects Rendering ---

  renderSidebar(projects: Project[], bindings: WorkspaceBinding[], sessions: { id: string; title: string; updated: string }[]): void {
    if (!this.sidebarContainer) return;
    this.sidebarContainer.replaceChildren();

    const head = el(
      "div",
      { className: "projects-head" },
      el("span", { className: "projects-title", textContent: "Projects" }),
      el(
        "button",
        {
          type: "button",
          className: "icon-btn small projects-add-btn",
          title: "Create project (⌘+P)",
          onclick: () => void this.showNewProjectDialog(),
        },
        icon("plus", 14),
      ),
    );
    this.sidebarContainer.append(head);

    if (!projects.length) {
      return;
    }

    const bindingsByProject = new Map<string, Set<string>>();
    for (const b of bindings) {
      if (b.projectId) {
        if (!bindingsByProject.has(b.projectId)) bindingsByProject.set(b.projectId, new Set());
        bindingsByProject.get(b.projectId)!.add(b.session);
      }
    }

    const sessionMap = new Map(sessions.map((s) => [s.id, s]));

    for (const project of projects) {
      const boundSessions = bindingsByProject.get(project.id) ?? new Set();
      const projItem = el("div", { className: "project-group" });

      const folderName = project.folder.split(/[\\/]/).filter(Boolean).pop() || project.folder;
      const projHeader = el(
        "div",
        { className: "project-row", title: `${project.folder}` },
        icon("folder", 16),
        el("span", { className: "project-name", textContent: project.name }),
        el(
          "button",
          {
            type: "button",
            className: "project-new-chat-btn icon-btn small",
            title: `New chat in ${project.name}`,
            onclick: (e) => {
              e.stopPropagation();
              if (this.onNewProjectChatHandler) {
                this.onNewProjectChatHandler(project.id, project.folder);
              }
            },
          },
          icon("plus", 13),
        ),
        el(
          "button",
          {
            type: "button",
            className: "project-del-btn icon-btn small",
            title: `Delete project ${project.name}`,
            onclick: async (e) => {
              e.stopPropagation();
              if (
                await ask(
                  `Remove project “${project.name}”? The source folder and its chats will not be deleted.`,
                  "Remove Project",
                )
              ) {
                await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
                if (this.onRefreshHandler) await this.onRefreshHandler();
              }
            },
          },
          icon("trash", 13),
        ),
      );

      const chatList = el("div", { className: "project-chats" });
      for (const sId of boundSessions) {
        const s = sessionMap.get(sId);
        if (!s) continue;
        const row = el(
          "div",
          { className: `chat project-chat${s.id === this.currentSession ? " active" : ""}` },
          el(
            "button",
            {
              type: "button",
              className: "open",
              title: s.title,
              onclick: () => this.onOpenChatHandler?.(s.id),
            },
            s.title,
          ),
        );
        chatList.append(row);
      }

      projItem.append(projHeader, chatList);
      this.sidebarContainer.append(projItem);
    }
  }

  // --- Folder Admission Dialog ---

  private async showFolderDialog(): Promise<void> {
    const dialog = el("dialog", { className: "workspace-modal" });
    const input = el("input", {
      type: "text",
      placeholder: "/Users/name/Projects/my-app",
      className: "workspace-input flex-1",
      "aria-label": "Absolute folder path",
    });
    const browseBtn = el(
      "button",
      {
        type: "button",
        className: "ghost small workspace-browse-btn",
        title: "Choose folder in Finder",
      },
      icon("folder", 14),
      el("span", { textContent: "Choose…" }),
    );
    const folderField = el("div", { className: "field-line" }, input, browseBtn);
    const probeFeedback = el("div", { className: "probe-feedback row-hint" });
    const admitBtn = el("button", { type: "submit", className: "primary", disabled: true, textContent: "Admit to Chat" });
    const cancelBtn = el("button", { type: "button", className: "ghost", textContent: "Cancel" });

    let admittedPath = "";

    const probe = async () => {
      const val = input.value.trim();
      if (!val) {
        probeFeedback.replaceChildren();
        admitBtn.disabled = true;
        return;
      }
      try {
        const res = await api<{ ok: boolean; canonical: string; isReadable: boolean; isWritable: boolean }>("/api/workspaces/validate-folder", {
          method: "POST",
          body: JSON.stringify({ folder: val }),
        });
        admittedPath = res.canonical;
        probeFeedback.replaceChildren(
          el("p", { className: "probe-ok text-ok", textContent: `✓ Accessible folder (${res.isWritable ? "read/write" : "read-only"} · Seatbelt isolated)` }),
          el("p", { className: "probe-path faint", textContent: res.canonical }),
        );
        admitBtn.disabled = false;
      } catch (err: any) {
        admitBtn.disabled = true;
        probeFeedback.replaceChildren(el("p", { className: "probe-bad text-bad", textContent: `✕ ${err.message}` }));
      }
    };

    browseBtn.addEventListener("click", async () => {
      const chosen = await pickFolder();
      if (chosen) {
        input.value = chosen;
        await probe();
      }
    });

    input.addEventListener("input", () => { void probe(); });

    cancelBtn.addEventListener("click", () => dialog.close());

    const modeSelect = el(
      "select",
      { className: "workspace-select", "aria-label": "Working mode" },
      el("option", { value: "copy_review", textContent: "Isolated copy (staged in Realm · review & apply)" }),
      el("option", { value: "direct", textContent: "Direct in-place editing (writes directly to original files)" }),
    );

    const form = el(
      "form",
      { method: "dialog", className: "workspace-form" },
      el("h3", { textContent: "Work in folder" }),
      el("p", { className: "row-hint", textContent: "Admit an accessible local project folder. Commands and edits operate within macOS Seatbelt isolation." }),
      folderField,
      modeSelect,
      probeFeedback,
      el("div", { className: "row-actions" }, cancelBtn, admitBtn),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!admittedPath) return;
      dialog.close();
      try {
        this.currentBinding = await api<WorkspaceBinding>(`/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}`, {
          method: "POST",
          body: JSON.stringify({ folder: admittedPath, mode: modeSelect.value }),
        });
        await this.renderWorkspaceBar();
        if (this.onRefreshHandler) await this.onRefreshHandler();
      } catch (err: any) {
        alert(err.message);
      }
    });

    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
  }

  // --- New Project Dialog ---

  private async showNewProjectDialog(): Promise<void> {
    const dialog = el("dialog", { className: "workspace-modal" });
    const nameInput = el("input", { type: "text", placeholder: "Project name", className: "workspace-input" });
    const folderInput = el("input", { type: "text", placeholder: "/path/to/folder", className: "workspace-input flex-1" });
    const browseBtn = el(
      "button",
      {
        type: "button",
        className: "ghost small workspace-browse-btn",
        title: "Choose folder in Finder",
      },
      icon("folder", 14),
      el("span", { textContent: "Choose…" }),
    );
    const folderField = el("div", { className: "field-line" }, folderInput, browseBtn);
    const probeFeedback = el("div", { className: "probe-feedback row-hint" });
    const createBtn = el("button", { type: "submit", className: "primary", disabled: true, textContent: "Create Project" });
    const cancelBtn = el("button", { type: "button", className: "ghost", textContent: "Cancel" });

    let admittedPath = "";

    const probe = async () => {
      const val = folderInput.value.trim();
      if (!val) {
        probeFeedback.replaceChildren();
        createBtn.disabled = true;
        return;
      }
      try {
        const res = await api<{ ok: boolean; canonical: string }>("/api/workspaces/validate-folder", {
          method: "POST",
          body: JSON.stringify({ folder: val }),
        });
        admittedPath = res.canonical;
        probeFeedback.replaceChildren(el("p", { className: "probe-ok text-ok", textContent: `✓ ${res.canonical}` }));
        createBtn.disabled = !nameInput.value.trim();
      } catch (err: any) {
        createBtn.disabled = true;
        probeFeedback.replaceChildren(el("p", { className: "probe-bad text-bad", textContent: `✕ ${err.message}` }));
      }
    };

    browseBtn.addEventListener("click", async () => {
      const chosen = await pickFolder();
      if (chosen) {
        folderInput.value = chosen;
        if (!nameInput.value.trim()) {
          const parts = chosen.split(/[\\/]/).filter(Boolean);
          if (parts.length > 0) nameInput.value = parts[parts.length - 1]!;
        }
        await probe();
      }
    });

    nameInput.addEventListener("input", () => { createBtn.disabled = !nameInput.value.trim() || !admittedPath; });
    folderInput.addEventListener("input", () => { void probe(); });
    cancelBtn.addEventListener("click", () => dialog.close());

    const shareCheckbox = el("input", { type: "checkbox", id: "project-share-realm" });
    const shareLabel = el(
      "label",
      { className: "project-share-label row-hint", htmlFor: "project-share-realm" },
      shareCheckbox,
      el("span", { textContent: "Share working copy across chats in this project" }),
    );

    const form = el(
      "form",
      { method: "dialog", className: "workspace-form" },
      el("h3", { textContent: "New Project" }),
      el("p", { className: "row-hint", textContent: "Group chats around an admitted project directory." }),
      nameInput,
      folderField,
      shareLabel,
      probeFeedback,
      el("div", { className: "row-actions" }, cancelBtn, createBtn),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      dialog.close();
      try {
        await api("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            name: nameInput.value.trim(),
            folder: admittedPath,
            sharedRealm: shareCheckbox.checked,
          }),
        });
        if (this.onRefreshHandler) await this.onRefreshHandler();
      } catch (err: any) {
        alert(err.message);
      }
    });

    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
  }

  // --- Realm Review Drawer ---

  private async showReviewDrawer(review: RealmReview): Promise<void> {
    const dialog = el("dialog", { className: "workspace-review-dialog" });
    const content = el("div", { className: "review-content" });

    const header = el(
      "div",
      { className: "review-header" },
      el("h3", { textContent: `Workspace Review · ${review.total} modified path${review.total === 1 ? "" : "s"}` }),
      el("p", { className: "row-hint", textContent: "Review isolated candidate changes before applying them to original project files." }),
    );

    const changesList = el("div", { className: "review-changes-list" });
    for (const c of review.changes) {
      const statusLabel = c.conflict ? "Conflict" : !c.before ? "Added" : !c.after ? "Deleted" : "Modified";
      const statusTone = c.conflict ? "bad" : !c.before ? "ok" : "info";
      const fmt = detectFileFormat(c.path);

      let sizeDetail = "";
      if (c.after) {
        sizeDetail = formatBytes(c.after.bytes);
        if (c.before && c.before.bytes !== c.after.bytes) {
          sizeDetail = `${formatBytes(c.before.bytes)} → ${formatBytes(c.after.bytes)}`;
        }
      } else if (c.before) {
        sizeDetail = formatBytes(c.before.bytes);
      }

      const tags: HTMLElement[] = [];
      if (fmt.isBinary) tags.push(pill("Binary", "info"));
      tags.push(pill(statusLabel, statusTone));

      const item = el(
        "div",
        { className: "review-change-item" },
        el(
          "div",
          { className: "change-main" },
          el("code", { className: "change-path", textContent: c.path }),
          el("span", { className: "change-meta row-hint", textContent: `${fmt.label} · ${sizeDetail}` }),
        ),
        el("div", { className: "change-tags row-actions" }, ...tags),
      );
      changesList.append(item);
    }

    const applyBtn = el("button", {
      type: "button",
      className: "primary",
      disabled: !review.can_promote,
      textContent: "Apply Changes to Original",
    });

    const closeBtn = el("button", { type: "button", className: "ghost", textContent: "Close" });
    closeBtn.addEventListener("click", () => dialog.close());

    applyBtn.addEventListener("click", async () => {
      try {
        applyBtn.disabled = true;
        const receipt = await api<{ phase: string; transaction_id: string }>(
          `/api/workspaces/bindings/${encodeURIComponent(this.currentSession)}/realm/apply`,
          {
            method: "POST",
            body: JSON.stringify({
              fingerprint: review.fingerprint,
              paths: review.changes.map((c) => c.path),
            }),
          },
        );
        dialog.close();
        await this.updateForSession(this.currentSession);
        alert(`Changes committed successfully (receipt ${receipt.transaction_id.slice(0, 8)}).`);
      } catch (err: any) {
        alert(`Apply failed: ${err.message}`);
        applyBtn.disabled = false;
      }
    });

    content.append(header, changesList, el("div", { className: "row-actions" }, closeBtn, applyBtn));
    dialog.append(content);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
  }
}

