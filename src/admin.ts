// Vakyartha Mini-Cloud Admin & Observability Console Client
// Powers the dual-delivery (Native Window & Loopback Web App) admin panel.

import type { FleetSnapshot, WorkerSlotSummary } from "../shared/sandbox-pool.ts";
import type { AppSummary } from "../sidecar/sandbox-pool/app-registry.ts";
import { connect, engineFetch, inTauri, type Backend } from "./backend.ts";
import { applyAppearance } from "./theme.ts";
import { icon } from "./icons.ts";
import { chooseReferenceApp } from "./reference-apps.ts";
import { estimateCost } from "../shared/finops.ts";

// Apply Vakyartha theme & tokens immediately
applyAppearance();

window.addEventListener("storage", (e) => {
  if (e.key?.startsWith("vak:appearance:")) {
    applyAppearance();
  }
});

let activeTab = "fleet";
let token: string | null = null;
let backend: Backend = { url: "", token: "" };
let abortController = new AbortController();
let cachedApps: AppSummary[] = [];

// Determine base API headers and auth token
function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const activeToken = token || backend.token;
  if (activeToken) {
    headers["authorization"] = `Bearer ${activeToken}`;
  }
  return headers;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const targetUrl = inTauri ? `${backend.url}${path}` : path;
  const headers = { ...getApiHeaders(), ...(options.headers as Record<string, string>) };
  return engineFetch(targetUrl, { ...options, headers });
}

function ask(text: string, ok = "Continue"): Promise<boolean> {
  const dialog = document.getElementById("ask") as HTMLDialogElement | null;
  if (!dialog) return Promise.resolve(true);
  const textEl = document.getElementById("ask-text");
  const okBtn = document.getElementById("ask-ok") as HTMLButtonElement | null;
  if (textEl) textEl.textContent = text;
  if (okBtn) okBtn.textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true })
  );
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;
function notify(message: string, isError = false): void {
  const status = document.getElementById("admin-connection-status");
  if (!status) return;
  clearTimeout(notifyTimer);
  status.textContent = message;
  status.className = `admin-badge ${isError ? "disconnected" : "live"}`;
  notifyTimer = setTimeout(() => {
    status.textContent = "Connected";
    status.className = "admin-badge live";
  }, 3500);
}

async function streamSse(
  path: string,
  onMessage: (data: string) => void,
  onState: (connected: boolean) => void
): Promise<void> {
  while (!abortController.signal.aborted) {
    try {
      const targetUrl = inTauri ? `${backend.url}${path}` : path;
      const res = await engineFetch(targetUrl, {
        signal: abortController.signal,
        headers: getApiHeaders(),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      onState(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!abortController.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          for (const line of evt.split("\n")) {
            if (line.startsWith("data: ")) {
              onMessage(line.slice(6));
            }
          }
        }
      }
    } catch {
      if (abortController.signal.aborted) return;
      onState(false);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// -----------------------------------------------------------------------------
// Workbenches & Navigation
// -----------------------------------------------------------------------------

function switchTab(tabName: string): void {
  activeTab = tabName;
  document.querySelectorAll("#admin-sidebar-nav .admin-nav-item").forEach((btn) => {
    btn.setAttribute("aria-current", btn.getAttribute("data-tab") === tabName ? "page" : "false");
  });
  document.querySelectorAll(".admin-workbench").forEach((wb) => {
    wb.classList.toggle("active", wb.id === `workbench-${tabName}`);
  });

  if (tabName === "fleet") void refreshFleet();
  if (tabName === "apps") void refreshApps();
  if (tabName === "finops") void refreshFinops();
}

function setupSidebarIcons(): void {
  const iconMap: Record<string, string> = {
    "admin-icon-fleet": "cpu",
    "admin-icon-apps": "form",
    "admin-icon-logs": "page",
    "admin-icon-finops": "sliders",
    "admin-icon-security": "shield",
  };
  for (const [id, glyph] of Object.entries(iconMap)) {
    const el = document.getElementById(id);
    if (el) el.replaceChildren(icon(glyph, 16));
  }
  const refreshBtn = document.getElementById("admin-refresh-btn");
  if (refreshBtn && !refreshBtn.querySelector("svg")) {
    refreshBtn.prepend(icon("clock", 13), " ");
  }
  const restartBtn = document.getElementById("admin-restart-pool-btn");
  if (restartBtn && !restartBtn.querySelector("svg")) {
    restartBtn.prepend(icon("stop", 13), " ");
  }
}

// -----------------------------------------------------------------------------
// 1. Fleet & Worker Pool Manager
// -----------------------------------------------------------------------------

async function refreshFleet(): Promise<void> {
  try {
    const res = await apiFetch("/api/admin/fleet");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fleet: FleetSnapshot = await res.json();
    renderFleet(fleet);
  } catch (err) {
    console.error("Failed to fetch fleet snapshot:", err);
  }
}

function renderFleet(fleet: FleetSnapshot): void {
  const activeEl = document.getElementById("metric-active-slots");
  const standbyEl = document.getElementById("metric-standby-slots");
  const hibernatedEl = document.getElementById("metric-hibernated-tenants");
  const rssEl = document.getElementById("metric-total-rss");

  if (activeEl) activeEl.textContent = `${fleet.activeCount} / ${fleet.maxActiveWorkers}`;
  if (standbyEl) standbyEl.textContent = `${fleet.standbyCount}`;
  if (hibernatedEl) hibernatedEl.textContent = `${fleet.hibernatedCount}`;
  if (rssEl) rssEl.textContent = "Not measured";

  const container = document.getElementById("slots-grid-container");
  if (!container) return;

  if (fleet.slots.length === 0) {
    container.innerHTML = `<div class="empty-state">No worker slots currently allocated.</div>`;
    return;
  }

  container.innerHTML = fleet.slots
    .map((slot) => {
      const isHibernated = slot.state === "hibernated";
      const isStandby = slot.state === "standby";
      const isActive = slot.state === "active" || slot.state === "leased";

      return `
      <div class="slot-card ${slot.state}">
        <div class="slot-header">
          <span class="slot-title">
            <span class="slot-dot">●</span> ${slot.slotId}
          </span>
          <span class="slot-state-badge ${slot.state}">${slot.state}</span>
        </div>
        <div class="slot-body">
          <div class="slot-item">
            <span class="slot-item-label">Tenant ID:</span>
            <span class="slot-item-value">${slot.tenantId ? escapeHtml(slot.tenantId) : "<em>Unassigned</em>"}</span>
          </div>
          <div class="slot-item">
            <span class="slot-item-label">Workload Class:</span>
            <span class="slot-item-value">${slot.workloadClass ?? "None"}</span>
          </div>
          <div class="slot-item">
            <span class="slot-item-label">OS Process PID:</span>
            <span class="slot-item-value">${slot.pid ?? "None"}</span>
          </div>
          <div class="slot-item">
            <span class="slot-item-label">Memory RSS:</span>
            <span class="slot-item-value">${slot.rssBytes === null ? "Not measured" : formatBytes(slot.rssBytes)}</span>
          </div>
        </div>
        <div class="slot-actions">
          ${
            isActive
              ? `<button type="button" class="ghost small app-btn-danger" data-action="hibernate" data-slot="${slot.slotId}">Hibernate</button>`
              : ""
          }
        </div>
      </div>
    `;
    })
    .join("");

  // Attach hibernate action handlers
  container.querySelectorAll('button[data-action="hibernate"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const slotId = btn.getAttribute("data-slot");
      if (!slotId) return;
      btn.setAttribute("disabled", "true");
      btn.textContent = "Flushing...";
      try {
        await apiFetch(`/api/admin/fleet/slots/${encodeURIComponent(slotId)}/hibernate`, {
          method: "POST",
        });
        await refreshFleet();
      } catch (err) {
        notify(`Failed to hibernate slot: ${(err as Error).message}`, true);
        btn.removeAttribute("disabled");
        btn.textContent = "Hibernate";
      }
    });
  });
}

// -----------------------------------------------------------------------------
// 2. Hosted Dynamic Apps Workbench
// -----------------------------------------------------------------------------

async function refreshApps(): Promise<void> {
  try {
    const res = await apiFetch("/api/apps");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedApps = await res.json();
    renderAppsTable(cachedApps);
  } catch (err) {
    console.error("Failed to fetch apps list:", err);
  }
}

function renderAppsTable(apps: AppSummary[]): void {
  const tbody = document.getElementById("apps-table-body");
  const countLabel = document.getElementById("apps-count-label");
  if (countLabel) countLabel.textContent = `${apps.length} application${apps.length === 1 ? "" : "s"}`;
  if (!tbody) return;

  if (apps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No dynamic applications currently installed.</td></tr>`;
    return;
  }

  tbody.innerHTML = apps
    .map(
      (app) => `
    <tr>
      <td>
        <div class="app-info-cell">
          <span class="app-name">${escapeHtml(app.name)}</span>
          <span class="app-id">${escapeHtml(app.id)} · v${escapeHtml(app.version)}</span>
        </div>
      </td>
      <td><span class="admin-badge">${escapeHtml(app.category)}</span></td>
      <td>Node.js 26 (ESM)</td>
      <td>${formatBytes(app.storageBytes)}</td>
      <td>${app.triggerCount} trigger${app.triggerCount === 1 ? "" : "s"}</td>
      <td>
        <span class="admin-badge ${app.isRunning ? "live" : ""}">${app.isRunning ? "RUNNING" : "STOPPED"}</span>
      </td>
      <td>
        <div style="display: flex; gap: 6px;">
          ${app.triggerCount > 0 ? `<button type="button" class="ghost small" data-action="run-trigger" data-id="${app.id}">Run Poll</button>` : ""}
          <button type="button" class="ghost small app-btn-danger" data-action="uninstall-app" data-id="${app.id}">Delete</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  tbody.querySelectorAll('button[data-action="run-trigger"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      btn.textContent = "Running...";
      try {
        const res = await apiFetch(`/api/apps/${encodeURIComponent(id)}/triggers/market-poll/run`, {
          method: "POST",
        });
        const out = await res.json();
        notify(`Trigger '${out.action}' executed in ${out.durationMs}ms`);
        await refreshApps();
        await refreshFleet();
      } catch (err) {
        notify(`Failed to execute trigger: ${(err as Error).message}`, true);
      } finally {
        btn.textContent = "Run Poll";
      }
    });
  });

  tbody.querySelectorAll('button[data-action="uninstall-app"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      const ok = await ask(`Are you sure you want to delete application '${id}' and its persistent data volume?`, "Delete");
      if (!ok) return;
      try {
        notify(`Deleting application '${id}'…`);
        await apiFetch(`/api/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
        notify(`Application '${id}' deleted`);
        await refreshApps();
        await refreshFleet();
      } catch (err) {
        notify(`Failed to delete application: ${(err as Error).message}`, true);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// 3. Streaming Telemetry & Logs Workbench
// -----------------------------------------------------------------------------

function setupStreams(): void {
  const connStatus = document.getElementById("admin-connection-status");

  // Telemetry SSE Stream
  void streamSse(
    "/api/admin/telemetry/stream",
    (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "snapshot" || parsed.type === "heartbeat") {
          renderFleet(parsed.data || parsed.fleet);
        }
      } catch {}
    },
    (connected) => {
      if (connStatus) {
        connStatus.textContent = connected ? "Live Connected" : "Reconnecting...";
        connStatus.className = connected ? "admin-badge live" : "admin-badge disconnected";
      }
    }
  );

  // Logs SSE Stream
  void streamSse(
    "/api/admin/logs/stream",
    (data) => {
      try {
        const logData = JSON.parse(data);
        appendTerminalLog(logData);
      } catch {}
    },
    () => {}
  );
}

function appendTerminalLog(entry: {
  level?: string;
  slotId?: string;
  tenantId?: string;
  message?: string;
  at?: string;
}): void {
  const terminal = document.getElementById("admin-terminal");
  if (!terminal) return;

  const filter = (document.getElementById("logs-level-filter") as HTMLSelectElement)?.value ?? "all";
  const level = (entry.level || "info").toLowerCase();
  if (filter !== "all" && filter !== level) return;

  const search = (document.getElementById("logs-search-filter") as HTMLInputElement)?.value.toLowerCase();
  const msg = entry.message || JSON.stringify(entry);
  if (search && !msg.toLowerCase().includes(search)) return;

  const line = document.createElement("div");
  line.className = "log-line";

  const timeStr = entry.at ? new Date(entry.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  line.innerHTML = `
    <span class="log-timestamp">[${timeStr}]</span>
    <span class="log-level ${escapeHtml(level)}">[${escapeHtml(level.toUpperCase())}]</span>
    ${entry.slotId ? `<span class="log-slot">[${escapeHtml(String(entry.slotId))}${entry.tenantId ? ` · ${escapeHtml(String(entry.tenantId))}` : ""}]</span>` : ""}
    <span class="log-message">${escapeHtml(msg)}</span>
  `;

  terminal.appendChild(line);
  while (terminal.children.length > 1000) terminal.firstElementChild?.remove();

  const autoscroll = (document.getElementById("logs-autoscroll") as HTMLInputElement)?.checked ?? true;
  if (autoscroll) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

// -----------------------------------------------------------------------------
// 4. FinOps Workbench
// -----------------------------------------------------------------------------

async function refreshFinops(): Promise<void> {
  try {
    const res = await apiFetch("/api/finops");
    if (!res.ok) return;
    const data = await res.json();
    const totalCostEl = document.getElementById("finops-total-cost");
    if (totalCostEl) {
      const costs = data.turns.map((turn: Parameters<typeof estimateCost>[0]) => estimateCost(turn, data.rates));
      totalCostEl.textContent = costs.length && costs.every((value: number | undefined) => value !== undefined)
        ? `$${costs.reduce((sum: number, value: number) => sum + value, 0).toFixed(4)} estimated`
        : "Unknown";
    }
  } catch (err) {
    console.error("Failed to fetch FinOps data:", err);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// -----------------------------------------------------------------------------
// App Initialization
// -----------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  try {
    backend = await connect();
  } catch (err) {
    console.error("Backend connect failed:", err);
  }

  // Read token from URL query params if present
  const params = new URLSearchParams(window.location.search);
  const qToken = params.get("token");
  if (qToken) {
    token = qToken;
  }

  setupSidebarIcons();

  // Setup tab listeners
  document.querySelectorAll("#admin-sidebar-nav .admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      if (tab) switchTab(tab);
    });
  });

  // Setup header action buttons
  document.getElementById("admin-refresh-btn")?.addEventListener("click", () => {
    if (activeTab === "fleet") void refreshFleet();
    if (activeTab === "apps") void refreshApps();
    if (activeTab === "finops") void refreshFinops();
  });

  document.getElementById("admin-restart-pool-btn")?.addEventListener("click", async () => {
    const ok = await ask("Are you sure you want to restart the sandbox worker pool? Active slots will be gracefully flushed.", "Restart Pool");
    if (!ok) return;
    try {
      await apiFetch("/api/admin/fleet/restart", { method: "POST" });
      notify("Worker pool restarted successfully");
      await refreshFleet();
    } catch (err) {
      notify(`Failed to restart worker pool: ${(err as Error).message}`, true);
    }
  });

  document.getElementById("install-app-btn")?.addEventListener("click", async () => {
    try {
      const entries = await (await apiFetch("/api/apps/builtin")).json();
      const installed = await (await apiFetch("/api/apps")).json();
      const id = await chooseReferenceApp(entries, installed.map((a: AppSummary) => a.id));
      if (!id) return;
      notify("Installing reference app…");
      const res = await apiFetch(`/api/apps/builtin/${encodeURIComponent(id)}`, { method: "POST", body: "{}" });
      if (res.ok) {
        notify("Reference app installed successfully!");
        await refreshApps();
        await refreshFleet();
      } else {
        const err = await res.json();
        notify(`Failed to install app: ${err.error || res.status}`, true);
      }
    } catch (err) {
      notify(`Installation error: ${(err as Error).message}`, true);
    }
  });

  // Setup terminal controls
  document.getElementById("logs-clear-btn")?.addEventListener("click", () => {
    const terminal = document.getElementById("admin-terminal");
    if (terminal) terminal.innerHTML = `<div class="terminal-welcome">Console log buffer cleared.</div>`;
  });

  document.getElementById("apps-search-input")?.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    const filtered = cachedApps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)
    );
    renderAppsTable(filtered);
  });

  // Initial load
  await refreshFleet();
  setupStreams();
});

