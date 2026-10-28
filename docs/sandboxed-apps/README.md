# Sandboxed Applications & Runtime Pool

This directory houses the formal Enterprise Architecture specifications for Vakyartha's **Multi-Tenant Pooled Sandbox Runtime**, **Full-Lifecycle Dynamic Hosted Applications**, and **Tray-Launched Admin & Observability Console** (the "Mini-Cloud" model).

## Implementation & Source Tree Reference

The entire architecture is implemented directly without stubs or mocks:

* **Schemas & IPC Contracts:**
  * [`shared/app-manifest.ts`](../../shared/app-manifest.ts): Strict package manifest parser and validator (`parseAppManifest`).
  * [`shared/sandbox-pool.ts`](../../shared/sandbox-pool.ts): Core pool contracts, states (`active`, `standby`, `idle`, `suspended`, `hibernated`), framed JSON-RPC message framing, and fleet snapshots.
* **Pool Orchestrator & Workers:**
  * [`sidecar/sandbox-pool/worker.ts`](../../sidecar/sandbox-pool/worker.ts): Sandboxed child process entrypoint with atomic `state.json` write-renaming, reactive action dispatch, and stdout/stderr telemetry.
  * [`sidecar/sandbox-pool/pool-manager.ts`](../../sidecar/sandbox-pool/pool-manager.ts): Pool manager orchestrating pre-warmed standby runners, bounded concurrency (`maxActiveWorkers: 3`), LRU eviction, heartbeat ping probes, workstation sleep/wake clock jump detection (`elapsed > 45s`), and graceful teardown.
  * [`sidecar/sandbox-pool/app-registry.ts`](../../sidecar/sandbox-pool/app-registry.ts): Hosted app catalog, `<dataDir>/apps/` storage footprint calculation, and autonomous background cron scheduling (`isCronMatch`).
* **Admin & Observability Console:**
  * [`admin.html`](../../admin.html), [`src/admin.ts`](../../src/admin.ts), [`src/admin.css`](../../src/admin.css): 5-workbench administrative panel supporting dual delivery (Tauri native window or loopback web app) with live Server-Sent Events (SSE).
  * [`sidecar/server.ts`](../../sidecar/server.ts): Bound REST & SSE streaming endpoints (`/api/admin/fleet`, `/api/admin/telemetry/stream`, `/api/admin/logs/stream`, `/api/apps`).
  * [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs): System tray menu item ("Admin & Observability Console...", `Cmd+Shift+A`).
* **Built-in Reference Application:**
  * [`sidecar/builtin-apps/portfolio-risk/`](../../sidecar/builtin-apps/portfolio-risk/): Complete financial risk workbench calculating parametric VaR (95%/99%), Sharpe ratio, and asset allocation with `< 16ms` local Canvas reactive surface updates.
* **Test Suites (209 Passing Tests):**
  * [`test/app-manifest.test.ts`](../../test/app-manifest.test.ts): Unit tests for manifest validation and quota clamping.
  * [`test/sandbox-pool.test.ts`](../../test/sandbox-pool.test.ts): Multi-process integration tests for slot leasing, LRU eviction, and shutdown.
  * [`test/app-registry.test.ts`](../../test/app-registry.test.ts): Integration tests for app installation, Canvas actions, and cron matching.
  * [`test/admin-api.test.ts`](../../test/admin-api.test.ts): Real end-to-end HTTP API tests for fleet and app management.
  * [`test/builtin-apps.test.ts`](../../test/builtin-apps.test.ts): Verification tests for reference app calculations.

* [**`ARCHITECTURE.md`**](ARCHITECTURE.md): The comprehensive technical specification covering:
  1. **Strategic Rationale & Tenancy Model:** Workload classes (Session tenants, Artifact App tenants, Job tenants), preemption, and fair-share scheduling.
  2. **System Topology & Boundaries:** Decoupling between the trusted Host Supervisor, the untrusted Seatbelt-jailed workers, and the dedicated Admin Console.
  3. **The Shared Sandbox Runtime Pool (`WorkerPool`):** Process economics, bounded concurrency (`maxActiveWorkers = 3`), pre-warmed standby runners, and sub-150ms hibernation/wake state machines.
  4. **The 4-Tier Dynamic Artifact App Stack:** Presentation (Canvas 3-Tier liquid layout), compute daemon (Node/Python), embedded storage (SQLite/DuckDB volumes), and autonomous cron triggers.
  5. **Formal Manifest Specification (`app.json`):** Declarative runtime limits, network entitlements, MCP tools, and triggers.
  6. **Supervisor-to-Worker IPC Contract:** Framed JSON-RPC 2.0 protocol spanning Control, Event, Brokered Services, and Telemetry planes.
  7. **Information & Data Architecture:** Virtual app volumes (`<dataDir>/apps/<id>/`), SQLite WAL mode, and the single-writer persistence rule.
  8. **Zero-Trust Security Architecture (STRIDE Analysis):** Zero-Key Sandbox rule, kernel Seatbelt containment, and brokered credential proxies.
  9. **Desktop Observability & FinOps Governance:** 4 golden signals, CPU/RSS throttling, and cumulative token budget circuit breakers.
  10. **The Mini-Cloud Admin & Observability Console:**
      * **macOS System Tray Launcher:** Dynamic status badge (`● 2 Active | 1 Standby`), quick hibernation/restart actions, and one-click console access.
      * **Dual Delivery Modes:** Dedicated native Tauri secondary window (`label: "admin"`, private pipes) or detached web application in default browser (`http://127.0.0.1:<port>/admin` with bearer token).
      * **Five Workbenches:** Fleet & Pool Manager, Tenant & Dynamic App Inventory, Centralized Streaming Log Aggregator, FinOps & Spend Governor, and Zero-Trust Security & Audit Inspector.
      * **Admin API & Real-time SSE Stream:** Contract for streaming logs and metrics at 1 Hz.
  11. **Enterprise Reference Deployments:** Real-world patterns for Live Financial Dashboards, Data Engineering Workbenches, and Developer CI portals.
  12. **Workstation Physical Lifecycle (Sleep, Wake, Abrupt Shutdown & Cold Boot):**
      * **macOS Power Integration:** Subscribing to native `NSWorkspaceWillSleepNotification` and `NSWorkspaceDidWakeNotification`.
      * **Pre-Sleep Suspend Protocol:** Bounded 1-second pre-sleep flush window with forced SQLite WAL checkpoints.
      * **Wakeup & Recovery:** Clock skew reconciliation, anti-thundering-herd cron coalescing (preventing burst runs), and worker socket health probing.
      * **Abrupt Power Loss Durability:** Zero-corruption guarantees via atomic write-rename (`state.json.tmp` -> `state.json`), SQLite crash durability, and transaction-bound Realm rollback (ADR-045).
      * **Graceful 4-Second Shutdown Waterfall:** Coordinated 5-step teardown waterfall between Tauri native shell, Supervisor, and child workers before hard SIGKILL watchdog fallback.
      * **Cold Boot Sweep:** Automatic orphan cleanup of `/tmp/vakyartha-sandbox-*` snapshots and lazy pool initialization.
  13. **Failure Modes, Recovery & NFRs:** FMEA matrix, automated recovery actions, and non-functional latency/memory guarantees.
  14. **Phased Roadmap & Acceptance Gates:** Formal gates required before code promotion.
