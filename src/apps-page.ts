// Sandboxed Dynamic Applications Workbench Page.
// Manages application lifecycle in isolated child runtimes with dedicated full-view execution.

import { $, api, ask, el } from "./core.ts";
import { icon } from "./icons.ts";
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
  #apps: AppSummary[] = [];
  #activeApp: AppDetails | null = null;
  #activeStore: SurfaceStore | null = null;
  #poll?: ReturnType<typeof setInterval>;
  #dirty = false;
  #pending = Promise.resolve();
  #toggleSidebar: () => void;
  #onClose?: () => void;
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
      title: "Install reference portfolio risk application",
    }, icon("plus", 14), document.createTextNode(" Add Reference App"));

    this.#page.replaceChildren(
      el("div", { className: "artifacts-top", "data-tauri-drag-region": "" }, toggle, back),
      el("div", { className: "artifacts-body" },
        el("header", { className: "artifacts-intro" },
          el("div", { className: "artifacts-mark" }, icon("cpu", 24)),
          el("h1", { id: "apps-title", tabIndex: -1, textContent: "Hosted Applications" }),
          el("p", { textContent: "Persistent local apps with sandboxed actions, saved state and direct data refresh." })
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

    if (resultsEl) {
      resultsEl.textContent = `${filtered.length} application${filtered.length === 1 ? "" : "s"}${filtered.length !== this.#apps.length ? ` · ${this.#apps.length} total` : ""}`;
    }

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
      ...filtered.map((app) => {
        const isRunning = app.isRunning;
        return el("div", { className: "artifact-card app-card" },
          el("div", { className: "artifact-cover app-cover" },
            el("span", { className: "artifact-kind", textContent: app.category.toUpperCase() }),
            el("span", {
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
              el("span", {}, icon("clock", 12), document.createTextNode(` ${app.triggerCount} trigger${app.triggerCount === 1 ? "" : "s"}`))
            )
          ),
          el("div", { className: "app-card-foot" },
            el("button", {
              type: "button",
              className: "ghost small app-btn-open",
              onclick: () => void this.runApp(app.id),
            }, "Open"),
            app.triggerCount > 0
              ? el("button", {
                  type: "button",
                  className: "ghost small",
                  onclick: () => void this.#runTrigger(app.id),
                }, "Run Poll")
              : false,
            el("button", {
              type: "button",
              className: "ghost small app-btn-danger",
              onclick: () => void this.#deleteApp(app.id, app.name),
            }, "Delete")
          )
        );
      })
    );
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

  async runApp(appId: string): Promise<void> {
    try {
      const details = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
      this.#activeApp = details; this.#dirty = false;
      this.#renderRunnerView(details);
      clearInterval(this.#poll);
      this.#poll = setInterval(() => { void this.#refreshActive(); }, 2000);
    } catch (err) {
      this.#feedback(`Could not launch app: ${(err as Error).message}`, true);
    }
  }

  #closeActiveApp(): void {
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
    }, icon("arrow", 15), document.createTextNode(" Back to apps"));

    const pollBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void this.#runTrigger(app.manifest.id),
      title: "Trigger scheduled background action",
    }, icon("clock", 13), document.createTextNode(" Run Poll"));

    const consoleBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void openAdminConsole(),
      title: "Open Fleet Console (⌘⇧A)",
    }, icon("sliders", 13), document.createTextNode(" Fleet Console"));

    const header = el("div", { className: "app-runner-top", "data-tauri-drag-region": "" },
      back,
      el("div", { className: "app-runner-head-info" },
        el("span", { className: "app-runner-icon" }, icon(app.manifest.category === "finance" ? "chart" : "cpu", 20)),
        el("h1", { className: "app-runner-name", textContent: app.manifest.name }),
        el("span", { className: `app-status ${isRunning ? "live" : ""}`, textContent: isRunning ? "Running" : "Idle" })
      ),
      el("div", { className: "app-runner-actions" }, pollBtn, consoleBtn)
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
    if (app.manifest.triggers.length) actions.append(schedule);
    if (Object.keys(app.surfaces ?? {}).length > 1) {
      const select = el("select", { "aria-label": "App surface" });
      for (const [id, snap] of Object.entries(app.surfaces!)) select.append(el("option", { value: id, textContent: snap.title || id }));
      select.value = String(app.surface?.id ?? "");
      select.onchange = () => { app.surface = app.surfaces![select.value] as unknown as Record<string, unknown>; this.#renderRunnerView(app); };
      actions.append(select);
    }

    this.#page.replaceChildren(header, status, surfaceMount);

    if (app.surface) {
      const store = new SurfaceStore(basicCatalog);
      this.#activeStore = store;
      const rawSnap = app.surface as unknown as SurfaceSnapshot;
      const snapshot: SurfaceSnapshot = {
        id: rawSnap.id || app.manifest.id,
        title: rawSnap.title || app.manifest.name,
        version: rawSnap.version ?? 1,
        data: rawSnap.data ?? {},
        nodes: Array.isArray(rawSnap.nodes) ? rawSnap.nodes : [],
      };
      store.load(snapshot);

      const surfaceEl = document.createElement("vak-surface") as VakSurfaceElement;
      surfaceEl.mediaResolver = resolveMedia;
      surfaceMode(surfaceEl);
      surfaceEl.attach(store, snapshot.id);

      const dispatch = (body: Record<string, unknown>) => {
        this.#dirty = true;
        this.#pending = this.#pending.then(async () => {
          this.#dirty = true;
          status.textContent = "Running…";
          try {
            const res = await api<{ revision: number; surfaces: Record<string, SurfaceSnapshot> }>(`/api/apps/${encodeURIComponent(app.manifest.id)}/action`, {
              method: "POST", body: JSON.stringify({ ...body, surface: snapshot.id, revision: this.#activeApp?.revision })
            });
            if (this.#activeApp?.manifest.id !== app.manifest.id) return;
            this.#activeApp.revision = res.revision; this.#activeApp.surfaces = res.surfaces;
            const next = res.surfaces[snapshot.id];
            if (next) { store.load(next); this.#activeApp.surface = next as unknown as Record<string, unknown>; surfaceEl.refresh(); }
            this.#dirty = false; status.textContent = "Saved";
          } catch (error) { status.textContent = `${(error as Error).message}. Your local edits are retained; reopen to load saved state.`; }
        });
      };
      surfaceEl.addEventListener("vak-change", (event: Event) => {
        const detail = (event as CustomEvent<{ path: string; value: unknown }>).detail;
        dispatch({ controlId: detail.path, value: detail.value });
      });
      surfaceEl.addEventListener("vak-action", (event: Event) => {
        const detail = (event as CustomEvent<VakActionDetail>).detail;
        dispatch({ controlId: detail.action.source, value: detail.action.data ?? detail.data, action: detail.action.action });
      });

      surfaceMount.append(surfaceEl);
    } else {
      surfaceMount.append(el("div", { className: "artifact-empty" },
        el("h2", { textContent: "No interactive surface declared" }),
        el("p", { textContent: "This application runs as a background process daemon without a visual canvas." })
      ));
    }
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
      this.#feedback("Installing Reference App…");
      await api("/api/apps/builtin/portfolio-risk-dashboard", { method: "POST", body: "{}" });
      await this.refresh();
      this.#feedback("Installed Reference App");
    } catch (err) {
      this.#feedback(`Install failed: ${(err as Error).message}`, true);
    }
  }
}
