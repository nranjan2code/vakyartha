// Vakyartha Mini-Cloud Admin & Observability Console Client
// Powers the dual-delivery (Native Window & Loopback Web App) admin panel.

import type { FleetSnapshot, WorkerSlotSummary } from "../shared/sandbox-pool.ts";
import type { AppSummary } from "../sidecar/sandbox-pool/app-registry.ts";

let activeTab = "fleet";
let token: string | null = null;
let eventSourceLogs: EventSource | null = null;
let eventSourceTelemetry: EventSource | null = null;
let cachedApps: AppSummary[] = [];

// Determine base API headers and auth token
function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...getApiHeaders(), ...(options.headers as Record<string, string>) };
  return fetch(path, { ...options, headers });
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
  document.querySelectorAll(".admin-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  document.querySelectorAll(".admin-workbench").forEach((wb) => {
    wb.classList.toggle("active", wb.id === `workbench-${tabName}`);
  });

  if (tabName === "fleet") void refreshFleet();
  if (tabName === "apps") void refreshApps();
  if (tabName === "finops") void refreshFinops();
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
  if (rssEl) rssEl.textContent = formatBytes(fleet.totalRssBytes);

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
            <span class="slot-item-value">${formatBytes(slot.rssBytes)}</span>
          </div>
        </div>
        <div class="slot-actions">
          ${
            isActive
              ? `<button type="button" class="admin-action-btn danger small" data-action="hibernate" data-slot="${slot.slotId}">Hibernate</button>`
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
        alert(`Failed to hibernate slot: ${(err as Error).message}`);
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
      <td>Node.js 24 (ESM)</td>
      <td>${formatBytes(app.storageBytes)}</td>
      <td>${app.triggerCount} trigger${app.triggerCount === 1 ? "" : "s"}</td>
      <td>
        <span class="admin-badge ${app.isRunning ? "live" : ""}">${app.isRunning ? "RUNNING" : "STOPPED"}</span>
      </td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button type="button" class="admin-action-btn small danger" data-action="uninstall-app" data-id="${app.id}">Delete</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  tbody.querySelectorAll('button[data-action="uninstall-app"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id || !confirm(`Are you sure you want to delete application '${id}' and its persistent data volume?`)) {
        return;
      }
      try {
        await apiFetch(`/api/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
        await refreshApps();
        await refreshFleet();
      } catch (err) {
        alert(`Failed to delete application: ${(err as Error).message}`);
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
  try {
    const sseUrl = token ? `/api/admin/telemetry/stream?token=${encodeURIComponent(token)}` : `/api/admin/telemetry/stream`;
    eventSourceTelemetry = new EventSource(sseUrl);

    eventSourceTelemetry.onopen = () => {
      if (connStatus) {
        connStatus.textContent = "Live Connected";
        connStatus.className = "admin-badge live";
      }
    };

    eventSourceTelemetry.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === "snapshot" || parsed.type === "heartbeat") {
          renderFleet(parsed.data || parsed.fleet);
        }
      } catch {}
    };

    eventSourceTelemetry.onerror = () => {
      if (connStatus) {
        connStatus.textContent = "Reconnecting...";
        connStatus.className = "admin-badge disconnected";
      }
    };
  } catch (err) {
    console.error("Telemetry stream setup error:", err);
  }

  // Logs SSE Stream
  try {
    const sseLogsUrl = token ? `/api/admin/logs/stream?token=${encodeURIComponent(token)}` : `/api/admin/logs/stream`;
    eventSourceLogs = new EventSource(sseLogsUrl);

    eventSourceLogs.onmessage = (event) => {
      try {
        const logData = JSON.parse(event.data);
        appendTerminalLog(logData);
      } catch {}
    };
  } catch (err) {
    console.error("Logs stream setup error:", err);
  }
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
    <span class="log-level ${level}">[${level.toUpperCase()}]</span>
    ${entry.slotId ? `<span class="log-slot">[${entry.slotId}${entry.tenantId ? ` · ${entry.tenantId}` : ""}]</span>` : ""}
    <span class="log-message">${escapeHtml(msg)}</span>
  `;

  terminal.appendChild(line);

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
    if (totalCostEl && typeof data.totalSpend === "number") {
      totalCostEl.textContent = `$${data.totalSpend.toFixed(4)}`;
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
  // Read token from URL query params if present
  const params = new URLSearchParams(window.location.search);
  const qToken = params.get("token");
  if (qToken) {
    token = qToken;
  }

  // Setup tab listeners
  document.querySelectorAll(".admin-nav-btn").forEach((btn) => {
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
    if (!confirm("Are you sure you want to restart the sandbox worker pool? Active slots will be gracefully flushed.")) {
      return;
    }
    try {
      await apiFetch("/api/admin/fleet/restart", { method: "POST" });
      await refreshFleet();
    } catch (err) {
      alert(`Failed to restart worker pool: ${(err as Error).message}`);
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
