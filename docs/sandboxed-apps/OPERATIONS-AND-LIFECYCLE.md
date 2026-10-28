# Sandboxed Applications & Runtime Pool: Operations & Lifecycle Guide

This guide is the authoritative operational manual and runbook for Vakyartha's **Multi-Tenant Pooled Sandboxed Runtime**, **Full-Lifecycle Dynamic Hosted Applications**, and **Tray-Launched Admin & Observability Console** (the "Mini-Cloud" model).

---

## 1. Executive Summary & Runtime Topology

Vakyartha executes untrusted agent-authored code, long-running dynamic applications (Artifact Apps), and background scheduled tasks within a **governed, multi-tenant sandboxed runtime pool**. Rather than launching unconstrained OS processes that exhaust workstation memory and file descriptors, the runtime enforces deterministic slot bounds, sub-millisecond local Canvas reactivity, and hardware-aware workstation lifecycle management.

### Key Architectural Metrics:
* **Active Concurrency Bound:** Exactly **3 concurrent active OS worker processes** (`maxActiveWorkers = 3`).
* **Instant Lease Latency:** `< 50 ms` from pre-warmed idle standby runner.
* **Hibernation Wakeup Latency:** `< 150 ms` state rehydration from disk.
* **Canvas Reactive Action-to-Patch Latency:** `< 16 ms` (Zero model tokens consumed).
* **Workstation Sleep/Wake Detection:** Automatic event loop skew reconciliation (`elapsed > 45s`).
* **Graceful Shutdown Deadline:** 4.0-second coordinated waterfall before hard watchdog fallback.
* **Zero Dependencies:** Pure TypeScript, ESM, Node 24 native execution, zero third-party container SDKs.

---

## 2. Worker Pool Lifecycle Operations (`SandboxPoolManager`)

The pool manager (`sidecar/sandbox-pool/pool-manager.ts`) manages worker slots across five discrete states:

```
                  ┌──────────────┐
                  │   STANDBY    │ (Pre-warmed, 0 tenant mounted)
                  └──────┬───────┘
                         │ Lease (< 50ms)
                         ▼
                  ┌──────────────┐
       ┌─────────►│    ACTIVE    │ (Turn running or UI serving)
       │          └──────┬───────┘
       │                 │ Inactivity (5 min)
       │                 ▼
       │          ┌──────────────┐
Wake   │          │     IDLE     │ (Warm in memory, GC forced)
(<150ms)          └──────┬───────┘
       │                 │ Concurrency pressure / Inactivity (15 min)
       │                 ▼
       │          ┌──────────────┐
       └──────────┤  HIBERNATED  │ (Process exited, state on disk)
                  └──────────────┘
                         │ (System sleep / lid close)
                         ▼
                  ┌──────────────┐
                  │  SUSPENDED   │ (Event loop paused, WAL flushed)
                  └──────────────┘
```

### 2.1 Deterministic Slot Allocation & Pre-Warming
* The pool automatically boots **1 pre-warmed standby worker slot** at startup.
* When a user selects a chat or opens a dynamic app, `pool.lease(tenantId, tenantKind, workspaceDir)` immediately assigns the standby worker to that tenant in `< 50ms`, mounts the tenant volume, loads `state.json`, and asynchronously spawns a fresh standby runner to replenish the reserve.

### 2.2 Least-Recently-Used (LRU) Eviction & Preemption
* When a request arrives and `activeSlots.length >= maxActiveWorkers` (3), the pool evicts the least-recently-used slot:
  1. Identifies the candidate with the oldest `lastActivity` timestamp.
  2. Dispatches `worker.prepare_hibernate` over stdio IPC.
  3. Worker checkpoints SQLite WAL and serializes `state.json`.
  4. Pool claims worker acknowledgment, terminates the process, marks the tenant as `hibernated`, and allocates the freed slot to the incoming tenant.

### 2.3 Heartbeat Probing & Health Checks
* The pool executes an autonomous health sweep every 30 seconds.
* Active worker slots receive an IPC `ping` frame. If a worker fails to reply within 5 seconds or exceeds its 256 MiB RSS memory ceiling, the pool initiates an emergency process recycle (`SIGKILL`), records an incident to `audit.jsonl`, and flags the slot for clean rehydration.

---

## 3. Dynamic Hosted Applications (`AppRegistry`)

Dynamic Hosted Applications turn static code artifacts into persistent, stateful micro-applications running on the user's desktop.

### 3.1 Tenant Directory Structure (`<dataDir>/apps/<app-id>/`)
Each application owns an isolated workspace on disk:
```text
<dataDir>/apps/<app-id>/
├── app.json             # Declarative immutable package manifest
├── server.ts            # Application logic entrypoint (sandboxed daemon)
├── surface.json         # Base 3-tier liquid Canvas projection layout
├── state.json           # Serialized UI state and reactive control values
├── data/                # Persistent database directory (Seatbelt contained)
│   ├── app.sqlite       # Relational transactions (WAL mode)
│   └── analytics.duckdb # Columnar analytical store
├── logs/                # Audit journals and worker execution traces
│   └── execution.jsonl  # Live stdout/stderr log feed
└── artifacts/           # Exported deliverables (PDF, Parquet, CSV)
```

### 3.2 Manifest Schema & Strict Validation (`shared/app-manifest.ts`)
The engine enforces strict validation via `parseAppManifest()`:
* **Directory Traversal Prevention:** Entrypoints and trigger actions containing `..`, absolute paths, leading slashes, or NUL (`\0`) characters are strictly rejected with HTTP 400.
* **Quota Clamping:** Runaway manifest quotas are clamped to platform boundaries:
  - Memory: min 32 MiB, default 256 MiB, max 512 MiB.
  - Storage: min 16 MiB, default 512 MiB, max 2048 MiB.
  - CPU time limit: min 5s, default 60s, max 300s.
* **Airgap Default:** Network entitlement defaults to airgap (`mode: "airgap"`, empty domain whitelist).

### 3.3 Zero-Latency Canvas Reactive Bridge
User interactions with Canvas controls (sliders, date pickers, dropdowns, buttons) dispatch directly to the worker daemon:
```
[User Action in Canvas] ──> [Supervisor stdio IPC] ──> [Sandboxed App Worker]
                                                                │
[Local DOM Patch Applied] <── [surface_patch Diff] <─────────────┘
  (Total Round-Trip: < 16ms | Model Tokens Consumed: 0)
```
1. Canvas fires `dispatch_action({ controlId, value, action })`.
2. Supervisor routes the action to the leased worker slot.
3. Worker executes the business logic (e.g. querying DuckDB, computing VaR), mutates local state, and yields a `surface_patch`.
4. Surface diff is applied to the live Canvas DOM in under 16ms.

### 3.4 Autonomous Zero-Dependency Background Crons
* Apps declare scheduled triggers in `app.json`:
  ```json
  {
    "id": "market-poll",
    "kind": "cron",
    "expression": "*/5 * * * *",
    "action": "pollMarket",
    "maxDurationSec: 30
  }
  ```
* `isCronMatch(expression, date)` evaluates 5-field cron syntax (`minute hour day-of-month month day-of-week`) supporting wildcards (`*`), steps (`*/5`), lists (`1,15,30`), and exact values with zero external dependencies.
* Background scheduler polls every 60 seconds, leases a slot, runs the declared action, commits changes, and frees the worker.

---

## 4. Hardware Physical Lifecycle & Workstation Realities

Laptops and developer workstations experience chaotic physical events: sudden lid closure, system sleep, wall-clock jumps, battery exhaustion, and abrupt shutdowns. The Mini-Cloud platform handles these deterministically.

### 4.1 Sleep & Lid-Close Detection
* In Node.js, event loops freeze when macOS hardware suspends.
* The pool's 30-second interval monitors monotonic elapsed time:
  ```typescript
  const elapsed = now - this.lastHeartbeat;
  if (elapsed > 45_000) {
    // Hardware was suspended! Clock jumped by elapsed ms.
    await this.wakeAndReconcile();
  }
  ```
* On detection, the pool enters the **Wake & Reconcile** protocol.

### 4.2 Pre-Sleep Suspend Protocol
When native macOS power notifications (`NSWorkspaceWillSleepNotification`) fire:
1. Pool broadcasts `worker.suspend` to all active workers.
2. Every open SQLite database executes `PRAGMA wal_checkpoint(TRUNCATE)`.
3. Workers serialize active Canvas states to `state.json`.
4. Timers and schedulers are paused.

### 4.3 Wakeup & Anti-Thundering-Herd Cron Coalescing
When hardware resumes from sleep:
1. **Clock Skew Reconciliation:** Computes `time_delta = Date.now() - last_sleep_timestamp`.
2. **Anti-Thundering-Herd Coalescing:** If a laptop was asleep for 12 hours, an hourly cron could attempt to fire 12 runs simultaneously, causing severe CPU and token budget spikes. The scheduler enforces **Coalesced Catch-up**:
   * Fires **at most one** catch-up execution.
   * Advances the schedule pointer directly to the next upcoming natural wall-clock interval.
3. **Worker Socket Probing:** Issues `worker.ping` over stdio pipes. Stalled or wedged processes are terminated (`SIGKILL`) and cleanly rehydrated from `state.json` in `< 150 ms`.

### 4.4 Abrupt Power Loss & Crash Durability
In the event of sudden battery depletion or hard kernel panic:
* **Atomic State Writes:** All JSON state files use the **Atomic Write-Rename Pattern**:
  ```typescript
  fs.writeFileSync("state.json.tmp", data, "utf8");
  fs.renameSync("state.json.tmp", "state.json");
  ```
  A power failure mid-write cannot corrupt the canonical state file.
* **SQLite WAL Durability:** Databases run with `PRAGMA synchronous = NORMAL` and Write-Ahead Logging. On reboot, SQLite replays intact transactions from WAL and discards uncommitted frames cleanly.
* **Cold Boot Sweep:** On cold launch, the engine sweeps `/tmp/` and purges any abandoned temporary directories (`vakyartha-sandbox-*`), verifies SQLite database integrity, and boots a clean single standby worker.

### 4.5 Coordinated 4-Second Graceful Shutdown Waterfall
When the user quits (`Cmd+Q` or Menu Bar Tray → Quit), Tauri coordinates a 5-stage waterfall before exit:
1. **T + 0.00s:** Tauri intercepts quit; starts native 4.0-second watchdog; closes supervisor stdin pipe.
2. **T + 0.20s:** Supervisor detects stdin EOF; refuses new incoming user turns; broadcasts `worker.prepare_shutdown`.
3. **T + 0.60s:** Workers flush SQLite WAL checkpoints (`TRUNCATE`), write-rename `state.json`, and acknowledge.
4. **T + 1.50s:** Supervisor issues `SIGTERM` to all worker child processes and commits global registries.
5. **T + 2.40s:** Supervisor process exits with code 0.
6. **T + 4.00s:** Hard watchdog fallback: Tauri shell force-terminates any remaining processes (`SIGKILL`).

---

## 5. Mini-Cloud Admin & Observability Console (`admin.html`)

The Admin Console provides centralized fleet observability and runtime governance.

### 5.1 Dual Delivery Architecture
* **Mode A (Dedicated Native Window):**
  - Spawns a dedicated native Tauri webview window (`label: "admin"`, 1100×720px) via `show_admin`.
  - Connects over private anonymous IPC pipes (ADR-044) with zero open network ports.
  - Keyboard shortcut: `Cmd+Shift+A` or macOS Menu Bar Tray → "Admin & Observability Console...".
* **Mode B (Detached Browser Web App):**
  - Navigates default browser to `http://127.0.0.1:<port>/admin` with bearer token.
  - Used for multi-monitor workstation tiling, external debugging, and browser devtools.

### 5.2 Five Operational Workbenches
1. **Fleet & Pool Manager:** Live visual cards for Slot 1, 2, and 3; real-time CPU % and RSS memory gauges; one-click `[Hibernate Slot]` and `[Force Restart Pool]` controls.
2. **Tenant & Dynamic App Inventory:** Comprehensive list of all installed apps and chat sessions; storage volume sizes (`<dataDir>/apps/<id>/`); trigger run controls; app uninstall action.
3. **Real-Time Streaming Log Terminal:** Virtualized high-throughput log terminal connected to `/api/admin/logs/stream` (SSE); live stdout, stderr, and IPC traces; log level filters (`DEBUG`, `INFO`, `WARN`, `ERROR`).
4. **FinOps Spend Governor:** Granular cost attribution per app and chat; token consumption tracking; live budget gauges with 80% warnings and 100% circuit breaker stops.
5. **Zero-Trust Security Inspector:** STRIDE audit monitor; Seatbelt kernel containment verification; filesystem read/write boundary checks; brokered network outbound requests ledger.

### 5.3 Administrative REST & Streaming API Endpoints
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/admin/fleet` | `GET` | Current fleet snapshot (active slots, standby, hibernated, CPU/RSS). |
| `/api/admin/fleet/slots/:id/hibernate` | `POST` | Manually evict and hibernate an active worker slot. |
| `/api/admin/fleet/restart` | `POST` | Gracefully restart all worker processes in the pool. |
| `/api/admin/lifecycle/suspend` | `POST` | Simulate hardware sleep / suspend protocol. |
| `/api/admin/lifecycle/wake` | `POST` | Simulate hardware wake & clock skew reconciliation. |
| `/api/admin/telemetry/stream` | `GET` | SSE stream emitting fleet metrics and snapshots at 1 Hz. |
| `/api/admin/logs/stream` | `GET` | SSE stream emitting live worker stdout/stderr/trace logs. |
| `/api/apps` | `GET` | List all installed dynamic applications. |
| `/api/apps` | `POST` | Install a dynamic application package (`manifest` + `files`). |
| `/api/apps/:id` | `GET` | Get app manifest, runtime status, and disk storage usage. |
| `/api/apps/:id` | `DELETE` | Uninstall application and delete isolated tenant volume. |
| `/api/apps/:id/action` | `POST` | Dispatch Canvas control action to app daemon. |
| `/api/apps/:id/triggers/:triggerId/run` | `POST` | Manually execute a declared cron or event trigger. |
| `/api/apps/:id/state` | `GET` | Retrieve current persisted reactive UI state (`state.json`). |

---

## 6. Built-in Reference Application: Portfolio Risk (`sidecar/builtin-apps/portfolio-risk/`)

The platform includes a production reference application demonstrating full-lifecycle dynamic app capabilities:
* **Package Structure:**
  - `app.json`: Manifest declaring `portfolio-risk`, `finance` category, Node 24 runtime, and `market-poll` cron trigger.
  - `surface.json`: 3-tier liquid Canvas layout: Executive KPI metric strip (Portfolio Value, VaR 95%, Sharpe Ratio), Paired Distribution & Sensitivity Charts, and Asset Allocation Table.
  - `server.ts`: Parametric normal distribution VaR engine:
    $$\text{VaR}_\alpha = V_p \times z_\alpha \times \sigma_p \times \sqrt{\Delta t}$$
    Calculates dynamic 95% ($z = 1.6449$) and 99% ($z = 2.3263$) risk metrics and Sharpe ratios in `< 1.2ms`.
* **Reactive Controls:**
  - Slider `slider-risk-tolerance` (0–100): dynamically rebalances Equity, Fixed Income, and Alternative asset allocation weights.
  - Dropdown `select-horizon`: shifts time horizon between 1 day, 10 days, and 30 days.
  - Total latency: `< 1.2ms` compute time, `< 16ms` Canvas DOM patch application.

---

## 7. Verification & Automated Quality Gates

Every component of the sandboxed runtime is continuously verified across 610 automated tests and real WebKit harnesses without mocks or stubs:

```bash
# 1. App Unit and Integration Test Suites (211 passed, 0 failed)
npm test

# 2. Upstream Projection Framework Tests (399 passed, 0 failed)
npm run test:framework

# 3. TypeScript Strict Typecheck (0 errors)
npm run typecheck

# 4. Vite Production Multi-Page Bundle (index.html + admin.html)
npm run build

# 5. Rust Native Tauri Shell Tests (3 passed, 0 failed)
cargo test --manifest-path src-tauri/Cargo.toml --lib

# 6. Real WebKit Canvas & Multi-Surface Smoke Checks
node scripts/canvas-check.ts
```

---

## 8. Incident Response & Troubleshooting Runbook

| Symptom | Diagnostic Check | Remediation |
| :--- | :--- | :--- |
| **Worker process hung or unresponsive** | Check `/api/admin/fleet` for slot in `active` state with high CPU or last activity > 60s. | Click `[Hibernate Slot]` or POST `/api/admin/fleet/slots/:id/hibernate`. The pool will SIGKILL the hung worker and rehydrate from `state.json`. |
| **App manifest rejected with 400** | Inspect supervisor error log for `directory traversal detected`. | Ensure all entrypoints and triggers in `app.json` use relative paths without `..`, leading slashes, or NUL bytes. |
| **Missed cron runs after laptop sleep** | Check `logs/execution.jsonl` for `coalescing missed crons`. | Expected behavior: the anti-thundering-herd policy fires at most one catch-up run and advances to the next wall-clock window. |
| **Admin Console fails to open** | Verify Tauri window handler or loopback port. | Use `Cmd+Shift+A` or launch browser via `http://127.0.0.1:<port>/admin` with bearer token from Keychain. |
