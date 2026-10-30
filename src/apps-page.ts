import { CollectionPage, pageControls } from './pagination.ts';
import type { AppConnection } from '../shared/app-connections.ts';
// Sandboxed Dynamic Applications Workbench Page.
// Manages application lifecycle in isolated child runtimes with dedicated full-view execution.

import { $, api, ask, el } from "./core.ts";
import { icon } from "./icons.ts";
import { chooseReferenceApp } from "./reference-apps.ts";
import type { AppManifest } from "../shared/app-manifest.ts";
import { openAdminConsole } from "./backend.ts";
import { basicCatalog, type SurfaceSnapshot, SurfaceStore } from "@vak/core";
import type { VakActionDetail, VakSurfaceElement } from "@vak/web";
import { surfaceMode } from "./theme.ts";
import { resolveMedia } from "./media.ts";
import type { AppSummary, AppDetails } from "../sidecar/sandbox-pool/app-registry.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class AppsPage {
  #page = $("apps-page");
  #query = "";
  #paging = new CollectionPage();
  #apps: AppSummary[] = [];
  #activeApp: AppDetails | null = null;
  #opening = 0;
  #activeStore: SurfaceStore | null = null;
  #viewCache = new Map<string, { store: SurfaceStore; element: VakSurfaceElement; scroll: number }>();
  #poll?: ReturnType<typeof setInterval>;
  #dirty = false;
  #pending = Promise.resolve();
  #toggleSidebar: () => void;
  #onClose?: () => void;
  #connections: AppConnection[] = [];
  #resumeSettings?: { appId: string; surface: string };
  #feedbackTimer?: ReturnType<typeof setTimeout>;

  constructor(
    toggleSidebar: () => void,
    onClose?: () => void
  ) {
    this.#toggleSidebar = toggleSidebar;
    this.#onClose = onClose;

    const navBtn = $("open-apps");
    if (navBtn) {
      navBtn.replaceChildren(icon("cpu", 17), document.createTextNode("Apps"));
      navBtn.addEventListener("click", () => void this.open());
    }

    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        !this.#page.hidden &&
        $("settings").hidden &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        if (this.#activeApp) {
          this.#closeActiveApp();
        } else {
          this.close();
        }
      }
    });

    window.addEventListener("vak:settings-closed", () => {
      const resume = this.#resumeSettings; this.#resumeSettings = undefined;
      if (resume) void Promise.resolve().then(async () => { await this.open(); await this.runApp(resume.appId, resume.surface); }).catch(error => this.#feedback(`Could not return to app: ${(error as Error).message}`, true));
      else if (this.#activeApp) void this.#refreshConnections();
    });
    window.addEventListener("vak:app-installed", () => {
      if (!this.#page.hidden && !this.#activeApp) void this.refresh();
    });
    window.addEventListener("vak:app-updated", () => {
      if (!this.#page.hidden && !this.#activeApp) void this.refresh();
    });
    window.addEventListener("vak:app-deleted", () => {
      if (!this.#page.hidden && !this.#activeApp) void this.refresh();
    });
  }

  visible(): boolean {
    return !this.#page.hidden;
  }

  close(showWorkspace = true): void {
    this.#opening++;
    clearInterval(this.#poll);
    if (this.#page.hidden) return;
    this.#activeApp = null;
    this.#activeStore = null;
    this.#page.hidden = true;
    if (showWorkspace) $("workspace").hidden = false;
    document.body.classList.remove("in-apps");
    $("open-apps")?.setAttribute("aria-current", "false");
    window.dispatchEvent(new Event("vak:apps-closed"));
    this.#onClose?.();
  }

  async open(): Promise<void> {
    this.#opening++;
    clearInterval(this.#poll);
    const studioEl = document.getElementById("skills-studio-page");
    if (studioEl) studioEl.hidden = true;
    document.body.classList.remove("in-skill-studio");
    this.#activeApp = null;
    this.#activeStore = null;
    this.#page.hidden = false;
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("schedule-page").hidden = true;
    document.body.classList.add("in-apps");
    $("open-apps")?.setAttribute("aria-current", "page");
    window.dispatchEvent(new Event("vak:apps-opened"));

    this.#renderCatalogShell();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const grid = document.getElementById("apps-catalog-grid");
    if (grid) {
      grid.innerHTML = `<div class="artifact-skeleton" aria-hidden="true"></div><div class="artifact-skeleton" aria-hidden="true"></div>`;
    }

    try {
      this.#apps = await api<AppSummary[]>("/api/apps");
      this.#renderGrid();
    } catch (err) {
      if (grid) {
        grid.replaceChildren(el("p", { textContent: `Could not load applications: ${(err as Error).message}` }));
      }
    }
  }

  #renderCatalogShell(): void {
    const toggle = el("button", {
      type: "button",
      className: "icon-btn artifacts-sidebar",
      title: "Show sidebar",
      "aria-label": "Show sidebar",
      onclick: this.#toggleSidebar,
    }, icon("sidebar", 18));

    const back = el("button", {
      type: "button",
      className: "ghost small",
      textContent: "Back to chats",
      onclick: () => this.close(),
    });

    const search = el("input", {
      id: "apps-search",
      type: "search",
      value: this.#query,
      placeholder: "Search applications by name, ID or category…",
      "aria-label": "Search applications",
      oninput: (e: Event) => {
        this.#query = (e.target as HTMLInputElement).value.toLowerCase();
        this.#renderGrid();
      },
    });

    const fleetBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void openAdminConsole(),
      title: "Open Mini-Cloud Admin & Observability Console (⌘⇧A)",
    }, icon("sliders", 14), document.createTextNode(" Fleet Console"));

    const addRefBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void this.#installDefaultApp(),
      title: "Browse documented reference applications",
    }, icon("plus", 14), document.createTextNode(" Add Reference App"));

    this.#page.replaceChildren(
      el("div", { className: "artifacts-top", "data-tauri-drag-region": "" }, toggle, back),
      el("div", { className: "artifacts-body" },
        el("header", { className: "artifacts-intro" },
          el("div", { className: "artifacts-mark" }, icon("cpu", 24)),
          el("h1", { id: "apps-title", tabIndex: -1, textContent: "Apps" }),
          el("p", { textContent: "Your apps, saved data and refresh status." })
        ),
        el("div", { className: "artifacts-search-row" },
          el("div", { className: "artifact-search" }, icon("search", 18), search),
          fleetBtn,
          addRefBtn
        ),
        el("div", { className: "artifacts-results", id: "apps-results", role: "status" }),
        el("div", { id: "apps-catalog-grid", className: "artifacts-grid" })
      )
    );
  }

  #renderGrid(): void {
    const grid = document.getElementById("apps-catalog-grid");
    const resultsEl = document.getElementById("apps-results");
    if (!grid) return;

    const filtered = this.#apps.filter(
      (a) =>
        a.name.toLowerCase().includes(this.#query) ||
        a.id.toLowerCase().includes(this.#query) ||
        a.category.toLowerCase().includes(this.#query)
    );

    const updateCount = this.#apps.filter((a) => a.updateAvailable).length;
    if (resultsEl) {
      resultsEl.textContent = `${filtered.length} application${filtered.length === 1 ? "" : "s"}${filtered.length !== this.#apps.length ? ` · ${this.#apps.length} total` : ""}${updateCount > 0 ? ` · ${updateCount} update${updateCount === 1 ? "" : "s"} available` : ""}`;
    }

    document.getElementById("apps-pages")?.remove();
    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="artifact-empty">
          <h2>No applications installed</h2>
          <p>Build and publish an app in Studio, or create a draft from Canvas.</p>
          <button type="button" class="ghost" id="empty-install-app-btn">Install Reference App</button>
        </div>
      `;
      document.getElementById("empty-install-app-btn")?.addEventListener("click", () => void this.#installDefaultApp());
      return;
    }

    grid.replaceChildren(
      ...this.#paging.slice(filtered, this.#query).map((app) => {
        const isRunning = app.isRunning;
        const hasUpdate = Boolean(app.updateAvailable);
        return el("div", { className: "artifact-card app-card" },
          el("div", { className: "artifact-cover app-cover" },
            el("span", { className: "artifact-kind", textContent: app.category.toUpperCase() }),
            hasUpdate
              ? el("span", {
                  className: "app-badge-update",
                  title: app.latestVersion ? `Version ${app.latestVersion} available` : "Update available",
                  textContent: app.latestVersion ? `v${app.latestVersion} Update` : "Update available",
                })
              : el("span", {
                  className: `app-status ${isRunning ? "live" : ""}`,
                  textContent: isRunning ? "Running" : "Idle",
                }),
            el("span", { className: "artifact-symbol app-symbol" },
              icon(app.category === "finance" ? "chart" : "cpu", 28)
            )
          ),
          el("div", { className: "artifact-card-body" },
            el("strong", { textContent: app.name }),
            el("p", {
              className: "app-desc",
              textContent: app.description,
            }),
            el("div", { className: "app-stats" },
              el("span", {}, icon("folder", 12), document.createTextNode(` ${formatBytes(app.storageBytes)}`)),
              el("span", {}, icon("clock", 12), document.createTextNode(` ${app.triggerCount} trigger${app.triggerCount === 1 ? "" : "s"}`)),
              hasUpdate
                ? el("span", { className: "app-stat-update" }, icon("spark", 12), document.createTextNode(app.hasDraft ? " Draft update" : " Shipped update"))
                : false
            )
          ),
          el("div", { className: "app-card-foot" },
            hasUpdate
              ? el("button", {
                  type: "button",
                  className: "primary small app-btn-update",
                  title: `Update ${app.name} to latest version`,
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    const target = e.currentTarget as HTMLButtonElement;
                    void this.#updateApp(app.id, app.name, target);
                  },
                }, icon("refresh", 13), document.createTextNode(" Update"))
              : false,
            el("button", {
              type: "button",
              className: "ghost small app-btn-open",
              onclick: () => void this.runApp(app.id),
            }, "Open"),
            app.triggerCount > 0
              ? el("button", {
                  type: "button",
                  className: "icon-action", title: "Refresh", "aria-label": `Refresh ${app.name}`,
                  onclick: () => void this.#runTrigger(app.id),
                }, icon("refresh", 15))
              : false,
            el("button", {
              type: "button",
              className: "icon-action app-btn-danger", title: "Delete app", "aria-label": `Delete ${app.name}`,
              onclick: () => void this.#deleteApp(app.id, app.name),
            }, icon("trash", 15))
          )
        );
      })
    );
    document.getElementById('apps-pages')?.remove();
    const pages = pageControls(this.#paging, filtered.length, 'Applications', () => this.#renderGrid()); pages.id = 'apps-pages'; grid.after(pages);
  }

  #feedback(message: string, isError = false): void {
    const resultsEl = document.getElementById("apps-results");
    if (!resultsEl) return;
    clearTimeout(this.#feedbackTimer);
    resultsEl.textContent = message;
    resultsEl.classList.toggle("error", isError);
    this.#feedbackTimer = setTimeout(() => {
      resultsEl.classList.remove("error");
      this.#renderGrid();
    }, 3500);
  }

  async #updateApp(id: string, name: string, btn?: HTMLButtonElement): Promise<void> {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Updating…";
    }
    try {
      await api<AppDetails>(`/api/apps/${encodeURIComponent(id)}/update`, { method: "POST" });
      this.#feedback(`Updated ${name} to latest version.`);
      window.dispatchEvent(new CustomEvent("vak:app-updated", { detail: { id } }));
      await this.refresh();
      if (this.#activeApp && this.#activeApp.manifest.id === id) {
        await this.runApp(id);
      }
    } catch (err) {
      this.#feedback(`Failed to update ${name}: ${(err as Error).message}`, true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Update";
      }
    }
  }

  async runApp(appId: string, surface?: string): Promise<void> {
    const opening = ++this.#opening;
    try {
      const [details, connections] = await Promise.all([api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`), api<AppConnection[]>(`/api/apps/${encodeURIComponent(appId)}/connections`)]);
      if (opening !== this.#opening) return;
      this.#viewCache.clear();
      this.#connections = connections;
      if (surface && details.surfaces?.[surface]) details.surface = details.surfaces[surface] as unknown as Record<string, unknown>;
      this.#activeApp = details; this.#dirty = false;
      this.#renderRunnerView(details);
      clearInterval(this.#poll);
      this.#poll = setInterval(() => { void this.#refreshActive(); }, 2000);
    } catch (err) {
      if (opening !== this.#opening) return;
      const message = `Could not launch app: ${(err as Error).message}`;
      const status = document.getElementById("app-run-status");
      if (status) status.textContent = message;
      this.#feedback(message, true);
    }
  }

  #closeActiveApp(): void {
    this.#opening++;
    clearInterval(this.#poll);
    this.#activeApp = null;
    this.#activeStore = null;
    this.#renderCatalogShell();
    void this.refresh();
  }

  #renderRunnerView(app: AppDetails): void {
    const isRunning = app.isRunning;

    const back = el("button", {
      type: "button",
      id: "app-runner-back",
      className: "quiet back",
      onclick: () => this.#closeActiveApp(),
      title: "Back to applications catalog",
    }, icon("arrow", 15), document.createTextNode(" Apps"));

    const pollBtn = el("button", {
      type: "button",
      className: "icon-action",
      onclick: () => void this.#runTrigger(app.manifest.id),
      title: "Refresh", "aria-label": "Refresh",
    }, icon("refresh", 16));

    const consoleBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void openAdminConsole(),
      title: "Open Fleet Console (⌘⇧A)",
    }, icon("sliders", 13), document.createTextNode(" Fleet Console"));

    const hasUpdate = Boolean(this.#apps.find((a) => a.id === app.manifest.id)?.updateAvailable);
    const updateRunnerBtn = hasUpdate
      ? el("button", {
          type: "button",
          className: "primary small app-runner-update",
          onclick: (e: MouseEvent) => {
            const target = e.currentTarget as HTMLButtonElement;
            void this.#updateApp(app.manifest.id, app.manifest.name, target);
          },
          title: "Update this application to latest version",
        }, icon("refresh", 13), document.createTextNode(" Update Available"))
      : false;

    const header = el("div", { className: "app-runner-top", "data-tauri-drag-region": "" },
      back,
      el("div", { className: "app-runner-head-info" },
        el("span", { className: "app-runner-icon" }, icon(app.manifest.category === "finance" ? "chart" : "cpu", 20)),
        el("h1", { className: "app-runner-name", textContent: app.manifest.name }),
        el("span", { className: `app-status ${isRunning ? "live" : ""}`, textContent: isRunning ? "Running" : "Idle" })
      ),
      el("div", { className: "app-runner-actions" }, ...(updateRunnerBtn ? [updateRunnerBtn] : []), ...(app.manifest.triggers.length ? [pollBtn] : []))
    );

    const surfaceMount = el("div", { className: "app-runner-content" });
    surfaceMount.addEventListener("input", () => { this.#dirty = true; });
    const status = el("p", { id: "app-run-status", role: "status", "aria-live": "polite" });
    const actions = header.querySelector(".app-runner-actions")!;
    if (app.run?.status === "failed" || app.run?.status === "uncertain") status.textContent = app.run.error || app.run.status;
    if (app.run?.status === "uncertain") actions.append(el("button", { type: "button", className: "ghost small", textContent: "Review uncertain run", onclick: async () => {
      if (!await ask(`Run ${app.run!.id} has uncertain external effects. Inspect the integration call log and external target before continuing. Acknowledging will leave schedules paused and will not replay the operation.`, "Acknowledge reviewed effects")) return;
      try {
        const next = await api<AppDetails>(`/api/apps/${encodeURIComponent(app.manifest.id)}/recover`, { method: "POST", body: JSON.stringify({ runId: app.run!.id }) });
        this.#activeApp = next; this.#renderRunnerView(next);
      } catch (error) { status.textContent = (error as Error).message; }
    } }));
    const schedule = el("button", { type: "button", className: "ghost small", textContent: app.scheduling ? "Pause schedule" : "Enable schedule", onclick: async () => {
      try {
        if (!app.scheduling && !await ask("Enable this app's declared schedules? Runs use its declared tools only when their integration policy permits unattended access.", "Enable")) return;
        const updated = await api<AppDetails>(`/api/apps/${encodeURIComponent(app.manifest.id)}/schedule`, { method: "POST", body: JSON.stringify({ enabled: !app.scheduling }) });
        this.#activeApp = updated; this.#renderRunnerView(updated);
      } catch (error) { status.textContent = (error as Error).message; }
    } });
    const operations = el("details", { className: "app-runner-operations" },
      el("summary", { textContent: "Manage" }),
      el("div", { className: "app-runner-menu" }, consoleBtn, ...(app.manifest.triggers.length ? [schedule] : [])));
    actions.append(el("button", { type: "button", className: "icon-action", title: "App settings", "aria-label": "App settings", onclick: () => void this.#openAppSettings() }, icon("sliders", 16)), operations);
    const navigation = el("nav", { className: "app-surface-nav", "aria-label": "App views" });
    if (Object.keys(app.surfaces ?? {}).length > 1) {
      const navigate = (id: string) => {
        // The canonical owner can advance while a view is open; never rebuild from a stale closure.
        const current = this.#activeApp;
        if (!current || current.manifest.id !== app.manifest.id || !current.surfaces?.[id]) return;
        const previous = String(current.surface?.id ?? "");
        const cached = this.#viewCache.get(previous);
        if (cached) cached.scroll = surfaceMount.scrollTop;
        current.surface = current.surfaces[id] as unknown as Record<string, unknown>;
        this.#renderRunnerView(current);
      };
      for (const [id, snap] of Object.entries(app.surfaces!)) navigation.append(el("button", {
        type: "button", textContent: snap.title || id, "aria-pressed": String(id === app.surface?.id),
        onclick: () => navigate(id),
      }));
    }

    const connectionNotice = el("div", { id: "app-connection-notice", className: "app-connection-notice" });
    this.#page.replaceChildren(header, navigation, connectionNotice, status, surfaceMount);
    this.#renderConnections();

    if (app.surface) {
      const cached = this.#viewCache.get(String(app.surface.id));
      const store = cached?.store ?? new SurfaceStore(basicCatalog);
      this.#activeStore = store;
      const rawSnap = app.surface as unknown as SurfaceSnapshot;
      const snapshot: SurfaceSnapshot = {
        id: rawSnap.id || app.manifest.id,
        title: rawSnap.title || app.manifest.name,
        version: rawSnap.version ?? 1,
        data: rawSnap.data ?? {},
        nodes: Array.isArray(rawSnap.nodes) ? rawSnap.nodes : [],
      };
      if (!cached || store.snapshot(snapshot.id)?.version !== snapshot.version) store.load(snapshot);

      const surfaceEl = cached?.element ?? document.createElement("vak-surface") as VakSurfaceElement;
      surfaceEl.mediaResolver = resolveMedia;
      surfaceMode(surfaceEl);
      if (!cached) surfaceEl.attach(store, snapshot.id);

      const dispatch = (body: Record<string, unknown>) => {
        this.#dirty = true;
        this.#pending = this.#pending.then(async () => {
          this.#dirty = true;
          if (this.#activeApp?.manifest.id !== app.manifest.id) return;
          const liveStatus = document.getElementById("app-run-status")!;
          liveStatus.textContent = "Running…";
          try {
            if (app.manifest.triggers.some(t => t.action === body.action) && !await this.#dataReady(app.manifest.id)) return;
            const res = await api<{ revision: number; surfaces: Record<string, SurfaceSnapshot>; focusSurface?: string }>(`/api/apps/${encodeURIComponent(app.manifest.id)}/action`, {
              method: "POST", body: JSON.stringify({ ...body, surface: snapshot.id, revision: this.#activeApp?.revision })
            });
            if (this.#activeApp?.manifest.id !== app.manifest.id) return;
            this.#activeApp.revision = res.revision; this.#activeApp.surfaces = res.surfaces;
            const next = res.surfaces[snapshot.id];
            if (next) { store.load(next); surfaceEl.refresh(); }
            const selected = String(this.#activeApp.surface?.id ?? "");
            if (res.surfaces[selected]) this.#activeApp.surface = res.surfaces[selected] as unknown as Record<string, unknown>;
            for (const [id, view] of this.#viewCache) {
              const snap = res.surfaces[id];
              if (snap && id !== snapshot.id) { view.store.load(snap); view.element.refresh(); }
            }
            this.#dirty = false; liveStatus.textContent = "Saved";
            if (res.focusSurface && res.surfaces[res.focusSurface]) {
              this.#activeApp.surface = res.surfaces[res.focusSurface] as unknown as Record<string, unknown>;
              this.#renderRunnerView(this.#activeApp);
            }
          } catch (error) { liveStatus.textContent = `${(error as Error).message}. Your local edits are retained; reopen to load saved state.`; }
          finally { this.#dirty = false; surfaceEl.releaseAction(); }
        });
      };
      if (!cached) surfaceEl.addEventListener("vak-change", (event: Event) => {
        event.stopPropagation();
        const detail = (event as CustomEvent<{ path: string; value: unknown }>).detail;
        dispatch({ controlId: detail.path, value: detail.value });
      });
      if (!cached) surfaceEl.addEventListener("vak-action", (event: Event) => {
        event.stopPropagation();
        const detail = (event as CustomEvent<VakActionDetail>).detail;
        if (detail.action.action === "dictate_note") {
          window.dispatchEvent(new CustomEvent("vak:start-dictation"));
          return;
        }
        dispatch({ controlId: detail.action.source, value: detail.action.data ?? detail.data, action: detail.action.action });
      });

      this.#viewCache.set(snapshot.id, { store, element: surfaceEl, scroll: cached?.scroll ?? 0 });
      surfaceMount.append(surfaceEl);
      surfaceMount.scrollTop = cached?.scroll ?? 0;
    } else {
      surfaceMount.append(el("div", { className: "artifact-empty" },
        el("h2", { textContent: "No interactive surface declared" }),
        el("p", { textContent: "This application runs as a background process daemon without a visual canvas." })
      ));
    }
  }

  #renderConnections(): void {
    const notice = document.getElementById("app-connection-notice");
    if (!notice) return;
    const blocked = this.#connections.filter(c => !c.ready);
    notice.hidden = !blocked.length;
    notice.replaceChildren(...(blocked.length ? [
      el("div", {}, el("strong", { textContent: "Data connection needs setup" }), el("p", { textContent: blocked.map(c => `${c.integrationName}: ${c.reason}`).join(" ") })),
      el("button", { type: "button", className: "ghost small", textContent: "Open app settings", onclick: () => void this.#openAppSettings() }),
    ] : []));
  }
  async #dataReady(id: string): Promise<boolean> {
    const rows = await api<AppConnection[]>(`/api/apps/${encodeURIComponent(id)}/connections`);
    if (rows.every(c => c.ready)) return true;
    if (this.#activeApp?.manifest.id !== id) await this.runApp(id);
    this.#connections = rows; this.#renderConnections();
    const status = document.getElementById("app-run-status");
    if (status) status.textContent = "Refresh needs connection setup. No data was fetched.";
    await this.#openAppSettings();
    return false;
  }
  async #refreshConnections(): Promise<void> {
    const id = this.#activeApp?.manifest.id;
    if (!id) return;
    try { const rows = await api<AppConnection[]>(`/api/apps/${encodeURIComponent(id)}/connections`); if (this.#activeApp?.manifest.id === id) { this.#connections = rows; this.#renderConnections(); } } catch { /* Retry when settings opens. */ }
  }
  async #openAppSettings(): Promise<void> {
    const app = this.#activeApp;
    if (!app) return;
    await this.#refreshConnections();
    const dialog = el("dialog", { className: "app-settings-dialog", "aria-label": `${app.manifest.name} settings` });
    const close = () => { dialog.close(); dialog.remove(); };
    const body = el("div", { className: "app-settings-body" });
    body.append(el("h3", { textContent: "Connections and access" }), el("p", { className: "muted", textContent: "This app can request only its declared tools. Integration permissions apply globally; this page does not grant access. Ask/off tools cannot run unattended." }));
    if (!this.#connections.length) body.append(el("p", { textContent: "No external connections required." }));
    for (const c of this.#connections) body.append(el("section", { className: "app-settings-connection" },
      el("strong", { textContent: `${c.integrationName} · ${c.title}` }), el("p", { textContent: `${c.ready ? "Ready" : "Needs setup"} · ${c.policy}. ${c.reason}` }),
      el("button", { type: "button", className: "ghost small", textContent: "Configure integration", onclick: async () => { this.#resumeSettings = { appId: app.manifest.id, surface: String(app.surface?.id ?? "") }; close(); const {openSettings} = await import("./settings.ts"); await openSettings(c.integrationId ? `integration:${c.integrationId}` : "integrations"); } })));
    body.append(el("h3", { textContent: "Refresh and operation" }), el("p", { textContent: app.manifest.triggers.length ? `Scheduling ${app.scheduling ? "on" : "off"}. Requires an awake, running host and permitted data tools. Missed intervals are skipped.` : "No background schedule declared." }));
    for (const t of app.manifest.triggers) body.append(el("p", { textContent: `${t.id}: ${t.expression} · ${t.action}` }));
    if (app.manifest.triggers.length) body.append(el("button", { type: "button", className: "ghost small", textContent: app.scheduling ? "Pause scheduling" : "Enable scheduling", disabled: !app.scheduling && this.#connections.some(c => !c.ready), onclick: async () => { try { this.#activeApp = await api<AppDetails>(`/api/apps/${app.manifest.id}/schedule`, { method: "POST", body: JSON.stringify({ enabled: !app.scheduling }) }); close(); this.#renderRunnerView(this.#activeApp); } catch (e) { operationStatus.textContent = (e as Error).message; } } }));
    const operationStatus = el("p", { role: "status", textContent: app.run ? `Last run: ${app.run.status}${app.run.error ? ` · ${app.run.error}` : ""}` : "No run recorded." }); body.append(operationStatus);
    body.append(el("h3", { textContent: "Data and package" }), el("p", { textContent: `Version ${app.manifest.version} · ${formatBytes(app.storageBytes)} saved · ${app.manifest.entitlements.storage.duckdb ? "bounded DuckDB snapshot and app state" : "app state"}. Existing data is preserved during reviewed updates.` }));
    body.append(el("button", { type: "button", className: "ghost small", textContent: "Review source and documentation", onclick: async () => { close(); const {openSkillStudio} = await import("./skills-studio.ts"); this.close(false); await openSkillStudio(app.manifest.id, () => this.runApp(app.manifest.id), async () => { await this.refresh(); }, "app"); } }));
    body.append(el("h3", { textContent: "App preferences" }), el("p", { textContent: "Source lists, reporting criteria and other domain preferences are maintained in the app's own views." }));
    for (const [id, view] of Object.entries(app.surfaces ?? {})) body.append(el("button", { type: "button", className: "ghost small", textContent: `Open ${view.title || id}`, onclick: () => { close(); const current = this.#activeApp; if (current?.surfaces?.[id]) { current.surface = current.surfaces[id] as unknown as Record<string, unknown>; this.#renderRunnerView(current); } } }));
    dialog.append(el("header", {}, el("h2", { textContent: `${app.manifest.name} settings` }), el("button", { type: "button", className: "icon-action", title: "Close settings", "aria-label": "Close settings", onclick: close }, icon("close", 16))), body);
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); }); document.body.append(dialog); dialog.showModal();
  }

  async #refreshActive(): Promise<void> {
    const active = this.#activeApp;
    if (!active || this.#page.hidden || this.#dirty) return;
    try {
      const next = await api<AppDetails>(`/api/apps/${encodeURIComponent(active.manifest.id)}`);
      if (this.#activeApp !== active || this.#dirty || next.revision === active.revision) return;
      const selected = String(active.surface?.id ?? "");
      const snap = next.surfaces?.[selected];
      if (snap && this.#activeStore) { this.#activeStore.load(snap); this.#page.querySelector<VakSurfaceElement>("vak-surface")?.refresh(); next.surface = snap as unknown as Record<string, unknown>; }
      this.#activeApp = next;
    } catch { /* A later refresh retries without overwriting local input. */ }
  }

  async #runTrigger(appId: string): Promise<void> {
    const status = document.getElementById("app-run-status");
    if (status) status.textContent = "Refreshing…";
    try {
      if (!await this.#dataReady(appId)) return;
      this.#feedback("Running background poll…");
      const details = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
      const triggerId = details.manifest.triggers[0]?.id ?? "market-poll";
      const res = await api<{ ok: boolean; action: string; durationMs: number }>(
        `/api/apps/${encodeURIComponent(appId)}/triggers/${encodeURIComponent(triggerId)}/run`,
        { method: "POST" }
      );
      this.#feedback(`Trigger '${res.action}' executed in ${res.durationMs}ms`);
      if (status) status.textContent = `Refreshed (${res.durationMs} ms)`;
      if (this.#activeApp && this.#activeApp.manifest.id === appId) {
        await this.#refreshActive();
      } else {
        await this.refresh();
      }
    } catch (err) {
      this.#feedback(`Trigger failed: ${(err as Error).message}`, true);
      if (status) status.textContent = (err as Error).message;
    }
  }

  async #deleteApp(appId: string, appName: string): Promise<void> {
    const ok = await ask(`Are you sure you want to delete application “${appName}” and its persistent data volume?`, "Delete");
    if (!ok) return;

    try {
      this.#feedback(`Deleting “${appName}”…`);
      await api(`/api/apps/${encodeURIComponent(appId)}`, { method: "DELETE" });
      window.dispatchEvent(new CustomEvent("vak:app-deleted", { detail: appId }));
      await this.refresh();
      this.#feedback(`Deleted “${appName}”`);
    } catch (err) {
      this.#feedback(`Delete failed: ${(err as Error).message}`, true);
    }
  }

  async #installDefaultApp(): Promise<void> {
    try {
      const entries = await api<AppManifest[]>("/api/apps/builtin");
      const id = await chooseReferenceApp(entries, this.#apps.map(a => a.id));
      if (!id) return;
      this.#feedback("Installing reference app…");
      await api(`/api/apps/builtin/${encodeURIComponent(id)}`, { method: "POST", body: "{}" });
      await this.refresh();
      this.#feedback("Installed reference app");
    } catch (err) {
      this.#feedback(`Install failed: ${(err as Error).message}`, true);
    }
  }
}
