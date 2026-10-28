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
        grid.innerHTML = `<div class="artifact-empty"><h2>Could not load applications</h2><p>${(err as Error).message}</p></div>`;
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
          el("p", { textContent: "Sandboxed persistent applications running with dedicated state and sub-millisecond local execution." })
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
      this.#activeApp = details;
      this.#renderRunnerView(details);
    } catch (err) {
      this.#feedback(`Could not launch app: ${(err as Error).message}`, true);
    }
  }

  #closeActiveApp(): void {
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

    this.#page.replaceChildren(header, surfaceMount);

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

      surfaceEl.addEventListener("vak-change", async (e: Event) => {
        const detail = (e as CustomEvent<{ surface: string; path: string; value: unknown }>).detail;
        try {
          const res = await api<{ patches?: any[] }>(`/api/apps/${encodeURIComponent(app.manifest.id)}/action`, {
            method: "POST",
            body: JSON.stringify({
              controlId: detail.path.replace(/^\//, ""),
              value: detail.value,
            }),
          });
          if (res && Array.isArray(res.patches)) {
            store.update({ surface: snapshot.id, nodes: res.patches });
            surfaceEl.refresh();
          }
        } catch (err) {
          console.warn("App change dispatch failed:", err);
        }
      });

      surfaceEl.addEventListener("vak-action", async (e: Event) => {
        const detail = (e as CustomEvent<VakActionDetail>).detail;
        try {
          const res = await api<{ patches?: any[] }>(`/api/apps/${encodeURIComponent(app.manifest.id)}/action`, {
            method: "POST",
            body: JSON.stringify({
              action: detail.action?.action ?? "click",
              controlId: detail.action?.source,
              value: detail.action?.data ?? detail.data,
            }),
          });
          if (res && Array.isArray(res.patches)) {
            store.update({ surface: snapshot.id, nodes: res.patches });
            surfaceEl.refresh();
          }
        } catch (err) {
          console.warn("App action dispatch failed:", err);
        }
      });

      surfaceMount.append(surfaceEl);
    } else {
      surfaceMount.append(el("div", { className: "artifact-empty" },
        el("h2", { textContent: "No interactive surface declared" }),
        el("p", { textContent: "This application runs as a background process daemon without a visual canvas." })
      ));
    }
  }

  async #runTrigger(appId: string): Promise<void> {
    try {
      this.#feedback("Running background poll…");
      const details = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
      const triggerId = details.manifest.triggers[0]?.id ?? "market-poll";
      const res = await api<{ ok: boolean; action: string; durationMs: number }>(
        `/api/apps/${encodeURIComponent(appId)}/triggers/${encodeURIComponent(triggerId)}/run`,
        { method: "POST" }
      );
      this.#feedback(`Trigger '${res.action}' executed in ${res.durationMs}ms`);
      if (this.#activeApp && this.#activeApp.manifest.id === appId) {
        const updated = await api<AppDetails>(`/api/apps/${encodeURIComponent(appId)}`);
        this.#activeApp = updated;
      } else {
        await this.refresh();
      }
    } catch (err) {
      this.#feedback(`Trigger failed: ${(err as Error).message}`, true);
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
                id: "recalculate-risk",
                kind: "cron",
                expression: "*/5 * * * *",
                action: "recalculateMetrics",
                maxDurationSec: 30,
              },
            ],
          },
          files: {
            "server.ts": `export function computePortfolioVaR(portfolioValue: number, confidenceLevel: number, volatility: number, timeHorizonDays = 1): number {
  const z = confidenceLevel >= 0.99 ? 2.326 : 1.645;
  return portfolioValue * z * volatility * Math.sqrt(timeHorizonDays);
}
export function rebalanceWeights(riskTolerance: number): number[] {
  const norm = Math.max(0, Math.min(100, riskTolerance)) / 100;
  const equities = Math.round(20 + 60 * norm);
  const bonds = Math.round(50 - 35 * norm);
  const commodities = Math.round(15 - 5 * norm);
  const cash = 100 - (equities + bonds + commodities);
  return [equities, bonds, commodities, cash];
}
export function handleAction(controlId: string, value: unknown): Record<string, unknown> {
  const riskTolerance = typeof value === "number" ? value : 65;
  const weights = rebalanceWeights(riskTolerance);
  const portfolioVal = 124500;
  const annualizedVol = 0.08 + (weights[0] / 100) * 0.14;
  const dailyVol = annualizedVol / Math.sqrt(252);
  const var95 = computePortfolioVaR(portfolioVal, 0.95, dailyVol, 1);
  const expectedReturn = (4.0 + (weights[0] / 100) * 12.0).toFixed(1);
  const sharpe = ((Number(expectedReturn) - 4.5) / (annualizedVol * 100)).toFixed(2);
  return {
    op: "batch_update",
    controlId,
    value,
    patches: [
      { id: "card-var-95", props: { value: "$" + var95.toFixed(2) } },
      { id: "card-expected-return", props: { value: expectedReturn + "%" } },
      { id: "card-sharpe", props: { value: sharpe } },
      { id: "chart-section", props: { series: [{ name: "Allocation %", values: weights }] } }
    ]
  };
}
`,
            "surface.json": JSON.stringify({
              id: "portfolio-risk-dashboard",
              version: 1,
              title: "Portfolio Risk & Quantitative Analysis",
              data: { riskTolerance: 65 },
              nodes: [
                {
                  id: "root",
                  type: "stack",
                  props: { direction: "vertical", gap: 16 },
                  children: ["kpi-metrics", "controls-section", "chart-section"],
                },
                {
                  id: "kpi-metrics",
                  type: "grid",
                  props: { columns: 4, gap: 12 },
                  children: ["card-total-val", "card-var-95", "card-sharpe", "card-expected-return"],
                },
                {
                  id: "card-total-val",
                  type: "stat",
                  props: { label: "Portfolio Value", value: "$124,500.00", delta: "+4.2%" },
                },
                {
                  id: "card-var-95",
                  type: "stat",
                  props: { label: "Value-at-Risk (95% 1-Day)", value: "$2,850.00", tone: "warn" },
                },
                {
                  id: "card-sharpe",
                  type: "stat",
                  props: { label: "Sharpe Ratio", value: "1.84", tone: "positive" },
                },
                {
                  id: "card-expected-return",
                  type: "stat",
                  props: { label: "Expected Annual Return", value: "14.2%" },
                },
                {
                  id: "controls-section",
                  type: "card",
                  props: { title: "Interactive Risk Sensitivity" },
                  children: ["slider-risk-tolerance"],
                },
                {
                  id: "slider-risk-tolerance",
                  type: "slider",
                  props: { label: "Risk Tolerance Level", min: 0, max: 100, value: 65, step: 5, bind: "/riskTolerance" },
                },
                {
                  id: "chart-section",
                  type: "chart",
                  props: {
                    kind: "donut",
                    title: "Asset Allocation Weights",
                    labels: ["US Large Cap Equities", "Govt Bonds", "Gold / Commodities", "Cash Reserves"],
                    series: [{ name: "Allocation %", values: [55, 25, 12, 8] }],
                  },
                },
              ],
            }),
          },
        }),
      });
      await this.refresh();
      this.#feedback("Installed Reference App");
    } catch (err) {
      this.#feedback(`Install failed: ${(err as Error).message}`, true);
    }
  }
}
