// Sandboxed Dynamic Applications Library Page.
// Displays installed hosted applications, volume footprints, and launch controls.

import { $, api, el } from "./core.ts";
import { icon } from "./icons.ts";
import { openAdminConsole } from "./backend.ts";
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
  #openSurfaceInCanvas: (surface: Record<string, unknown>, title: string) => void;
  #toggleSidebar: () => void;
  #onClose?: () => void;

  constructor(
    openSurfaceInCanvas: (surface: Record<string, unknown>, title: string) => void,
    toggleSidebar: () => void,
    onClose?: () => void
  ) {
    this.#openSurfaceInCanvas = openSurfaceInCanvas;
    this.#toggleSidebar = toggleSidebar;
    this.#onClose = onClose;

    const navBtn = $("open-apps");
    if (navBtn) {
      navBtn.append(icon("cpu", 17), "Apps");
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
        this.close();
      }
    });

    window.addEventListener("vak:app-installed", () => {
      if (!this.#page.hidden) void this.refresh();
    });
  }

  visible(): boolean {
    return !this.#page.hidden;
  }

  close(): void {
    if (this.#page.hidden) return;
    this.#page.hidden = true;
    $("workspace").hidden = false;
    document.body.classList.remove("in-apps");
    $("open-apps")?.setAttribute("aria-current", "false");
    window.dispatchEvent(new Event("vak:apps-closed"));
    this.#onClose?.();
  }

  async open(): Promise<void> {
    this.#page.hidden = false;
    $("workspace").hidden = true;
    $("artifacts-page").hidden = true;
    $("schedule-page").hidden = true;
    document.body.classList.add("in-apps");
    $("open-apps")?.setAttribute("aria-current", "page");
    window.dispatchEvent(new Event("vak:apps-opened"));

    this.#renderShell();
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
        grid.innerHTML = `<div class="artifact-empty"><h2>Failed to load apps</h2><p>${(err as Error).message}</p></div>`;
      }
    }
  }

  #renderShell(): void {
    const toggle = el("button", {
      type: "button",
      className: "icon-btn artifacts-sidebar",
      title: "Show sidebar",
      "aria-label": "Show sidebar",
      onclick: this.#toggleSidebar,
    }, icon("sidebar"));

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
    }, icon("sliders", 14), " Fleet Console");

    const addRefBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => void this.#installDefaultApp(),
      title: "Install reference portfolio risk application",
    }, icon("plus", 14), " Add Reference App");

    this.#page.replaceChildren(
      el("div", { className: "artifacts-top", "data-tauri-drag-region": "" }, toggle, back),
      el("div", { className: "artifacts-body" },
        el("header", { className: "artifacts-intro" },
          el("div", { className: "artifacts-mark" }, icon("cpu", 24)),
          el("h1", { id: "apps-title", tabIndex: -1, textContent: "Hosted Applications" }),
          el("p", { textContent: "Persistent hosted applications executing in isolated sandboxes with zero LLM per-action overhead." })
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
          <p>Deploy an application from any Canvas dashboard or click below to install the reference app.</p>
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
          el("div", {},
            el("div", { className: "artifact-cover app-cover" },
              el("span", { className: "artifact-kind", textContent: app.category.toUpperCase() }),
              el("span", {
                className: `app-status ${isRunning ? "live" : ""}`,
                textContent: isRunning ? "● RUNNING" : "IDLE",
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
                el("span", { textContent: `📦 ${formatBytes(app.storageBytes)}` }),
                el("span", { textContent: `⚡ ${app.triggerCount} trigger${app.triggerCount === 1 ? "" : "s"}` })
              )
            )
          ),
          el("div", { className: "app-card-foot" },
            el("button", {
              type: "button",
              className: "ghost small app-btn-open",
              onclick: () => void this.#launchApp(app.id),
            }, "▶ Open"),
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

  async #launchApp(appId: string): Promise<void> {
    try {
      const details = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
      if (details.surface) {
        this.close();
        this.#openSurfaceInCanvas(details.surface, details.manifest.name);
      } else {
        alert(`App '${details.manifest.name}' is running in worker pool. No interactive surface declared.`);
      }
    } catch (err) {
      alert(`Failed to launch app: ${(err as Error).message}`);
    }
  }

  async #runTrigger(appId: string): Promise<void> {
    try {
      const details = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
      const triggerId = details.manifest.triggers[0]?.id ?? "market-poll";
      const res = await api<{ ok: boolean; action: string; durationMs: number }>(
        `/api/apps/${encodeURIComponent(appId)}/triggers/${encodeURIComponent(triggerId)}/run`,
        { method: "POST" }
      );
      alert(`Trigger '${res.action}' executed successfully in ${res.durationMs}ms`);
      await this.refresh();
    } catch (err) {
      alert(`Failed to run trigger: ${(err as Error).message}`);
    }
  }

  async #deleteApp(appId: string, appName: string): Promise<void> {
    if (!confirm(`Are you sure you want to delete '${appName}' and its persistent data volume?`)) {
      return;
    }
    try {
      await api(`/api/apps/${encodeURIComponent(appId)}`, { method: "DELETE" });
      await this.refresh();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }

  async #installDefaultApp(): Promise<void> {
    try {
      await api("/api/apps", {
        method: "POST",
        body: JSON.stringify({
          manifest: {
            id: "portfolio-risk-dashboard",
            name: "Portfolio Risk Monitor",
            version: "1.0.0",
            description: "Real-time VaR and sensitivity calculator with dynamic asset rebalancing",
            author: "Vakyartha Team",
            category: "finance",
            icon: "chart",
            entrypoints: {
              backend: "server.ts",
              surface: "surface.json",
            },
            runtime: {
              engine: "node24",
              memoryLimitMb: 256,
              maxStorageMb: 512,
              cpuTimeLimitSec: 60,
            },
            entitlements: {
              network: { mode: "airgap", allowedDomains: [] },
              mcpTools: [],
              storage: { sqlite: true, duckdb: false },
            },
            triggers: [
              {
                id: "market-poll",
                kind: "cron",
                expression: "*/5 * * * *",
                action: "pollMarket",
                maxDurationSec: 30,
              },
            ],
          },
          files: {
            "server.ts": "// Application logic\nconsole.log('Portfolio Risk Monitor online');\n",
            "surface.json": JSON.stringify({
              id: "portfolio-risk-surface",
              version: 1,
              title: "Portfolio Risk Monitor",
              nodes: [
                {
                  id: "exec-strip",
                  type: "grid",
                  props: { columns: 3 },
                  children: [
                    { id: "var95", type: "metric", props: { label: "1-Day VaR (95%)", value: "$41,122", tone: "caution" } },
                    { id: "var99", type: "metric", props: { label: "1-Day VaR (99%)", value: "$58,157", tone: "critical" } },
                    { id: "sharpe", type: "metric", props: { label: "Sharpe Ratio", value: "1.84", tone: "positive" } },
                  ],
                },
                {
                  id: "allocation-table",
                  type: "table",
                  props: {
                    columns: [
                      { key: "asset", label: "Asset Class" },
                      { key: "weight", label: "Weight" },
                      { key: "value", label: "Market Value" },
                    ],
                    data: [
                      { asset: "US Equities (S&P 500)", weight: "45%", value: "$450,000" },
                      { asset: "Global Equities (MSCI World)", weight: "25%", value: "$250,000" },
                      { asset: "US Treasuries (7-10 Year)", weight: "20%", value: "$200,000" },
                      { asset: "Alternative Assets / Cash", weight: "10%", value: "$100,000" },
                    ],
                  },
                },
              ],
            }),
          },
        }),
      });
      await this.refresh();
    } catch (err) {
      alert(`Install failed: ${(err as Error).message}`);
    }
  }
}
