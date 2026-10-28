# Enterprise Architecture Blueprint: Vakyartha "Mini-Cloud"
## Multi-Tenant Pooled Sandbox Runtime & Full-Lifecycle Dynamic Artifact Applications

> **Document Class:** Enterprise Architecture Blueprint & Technical Specification  
> **Target Platform:** Vakyartha Desktop Runtime (macOS Tauri + Node sidecar + `vak-sandbox`)  
> **Architecture Status:** Proposed / Comprehensive Review Phase (Target Release 0.3.0)  
> **Authors:** Enterprise Architecture Working Group & Core System Architects  
> **Last Updated:** October 2026  

---

## Table of Contents
1. [Executive Summary & Strategic Rationale](#1-executive-summary--strategic-rationale)
2. [Enterprise Architecture Taxonomy & Tenancy Model](#2-enterprise-architecture-taxonomy--tenancy-model)
3. [System Architecture & Runtime Boundaries](#3-system-architecture--runtime-boundaries)
4. [The Shared Sandbox Runtime Pool (`WorkerPool`)](#4-the-shared-sandbox-runtime-pool-workerpool)
5. [The Anatomy of a Dynamic Artifact App](#5-the-anatomy-of-a-dynamic-artifact-app)
6. [Formal Application Manifest Specification (`app.json`)](#6-formal-application-manifest-specification-appjson)
7. [Supervisor-to-Worker IPC Protocol Specification](#7-supervisor-to-worker-ipc-protocol-specification)
8. [End-to-End Application Lifecycle Management](#8-end-to-end-application-lifecycle-management)
9. [Information & Data Architecture (Storage, DBs & Concurrency)](#9-information--data-architecture-storage-dbs--concurrency)
10. [Zero-Trust Security Architecture & Threat Model (STRIDE)](#10-zero-trust-security-architecture--threat-model-stride)
11. [Desktop Observability, Telemetry & FinOps Governance](#11-desktop-observability-telemetry--finops-governance)
12. [High-Impact Enterprise Scenarios & Reference Deployments](#12-high-impact-enterprise-scenarios--reference-deployments)
13. [Failure Modes, Circuit Breakers & Non-Functional Requirements (NFRs)](#13-failure-modes-circuit-breakers--non-functional-requirements-nfrs)
14. [Phased Implementation Roadmap & Evaluation Gates](#14-phased-implementation-roadmap--evaluation-gates)

---

## 1. Executive Summary & Strategic Rationale

### 1.1 The Paradigm Shift: From Text Generator to Local Micro-Cloud
Traditional conversational AI systems are ephemeral request-response generators: a prompt enters, a completion returns, and the compute boundary vanishes. While adequate for superficial copy-editing, this paradigm fundamentally fails to deliver the business value of enterprise software, which requires:
* **Continuous State:** Retaining structured domain records, indices, and transactions across user sessions.
* **Autonomous Compute:** Executing background polling, statistical analysis, data cleaning, and ETL pipelines without an active user prompt.
* **Interactive UI Projections:** Responsive, data-bound interfaces (forms, metrics strips, paired analytics charts, editable grids) that recalculate with zero-latency without invoking round-trip LLM tokens.
* **Strict Data Sovereignty:** Running completely on-device without leaking sensitive operational databases or corporate credentials to third-party cloud hosts.

Vakyartha is uniquely positioned to bridge this gap. Because Vakyartha already controls a **native desktop runtime, private OS pipes (ADR-044), a liquid Canvas projection engine, and an OS-level Seatbelt sandbox (`vak-sandbox`)**, we can evolve Vakyartha into a **Local Mini-Cloud Platform**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   VAKYARTHA MINI-CLOUD                                 │
├──────────────────────────┬──────────────────────────┬──────────────────────────────────┤
│  1. Tenant Workspaces    │  2. Pooled Node Runtimes │  3. Full Software Capabilities   │
│  - Isolated per chat/app │  - Pre-warmed runners    │  - Backend Node/Python code      │
│  - Seatbelt jail (vaksb) │  - Dynamic slot leasing  │  - Local DB (SQLite / DuckDB)    │
│  - Virtual storage disks │  - Fast hibernation/wake │  - Background crons & watchers   │
├──────────────────────────┼──────────────────────────┼──────────────────────────────────┤
│  4. Canvas App Hosting   │  5. Cloud Observability  │  6. Zero-Trust Secrets Broker    │
│  - Liquid 3-tier layout  │  - Real-time stream logs │  - Sandbox never sees raw keys   │
│  - Bidirectional events  │  - CPU/RAM/FinOps meters │  - Brokered LLM token streaming  │
│  - Artifacts library     │  - Health probes & heal  │  - Whitelisted network egress    │
└──────────────────────────┴──────────────────────────┴──────────────────────────────────┘
```

### 1.2 Enterprise Architectural Principles
1. **Zero-Trust Compute Isolation:** All generated code and dynamic applications are untrusted by default. They execute under strict OS-level kernel confinement (macOS Seatbelt) with no ambient network or filesystem reach.
2. **Deterministic Resource Caps:** Local execution must never degrade the host OS or exhaust workstation memory. Concurrency is strictly bounded by dynamic pooling and fast hibernation.
3. **Canonical Data Separation:** Presentation, application logic, and persistence are cleanly decoupled. The UI is a projection of state, not the state itself.
4. **No Framework Contamination:** The underlying Projection framework (`framework/`) remains a clean upstream dependency. All pooling, micro-cloud orchestration, and app lifecycle management reside strictly in Vakyartha's product tier.

---

## 2. Enterprise Architecture Taxonomy & Tenancy Model

The Vakyartha Mini-Cloud defines three distinct **Workload Classes** operating concurrently within a unified resource pool:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           TENANCY & WORKLOAD TAXONOMY                                   │
├───────────────────────┬─────────────────────────────┬───────────────────────────────────┤
│ Workload Class        │ Primary Characteristics     │ Execution & Lifecycle Model       │
├───────────────────────┼─────────────────────────────┼───────────────────────────────────┤
│ Class 1:              │ Turn-based, interactive     │ - Leases worker slot during turn  │
│ Conversational Chat   │ dialogue with AI assistant. │ - Runs in-sandbox file/bash tools │
│ (Session Tenant)      │ Ephemeral compute bursts.   │ - Immediate hibernation on idle   │
├───────────────────────┼─────────────────────────────┼───────────────────────────────────┤
│ Class 2:              │ Stateful, reactive micro-   │ - Leases worker slot when viewed  │
│ Hosted Dynamic App    │ software on Canvas (e.g.    │ - Embedded DB (SQLite/DuckDB)     │
│ (Artifact App Tenant) │ live analytics dashboard).  │ - Wakes on cron/timer triggers    │
├───────────────────────┼─────────────────────────────┼───────────────────────────────────┤
│ Class 3:              │ Headless, batch processing  │ - Background queue execution      │
│ Autonomous Automation │ (e.g. nightly ETL, sync).   │ - Bounded execution allowance     │
│ (Job Tenant)          │ Non-interactive run.        │ - Yields priority to user focus   │
└───────────────────────┴─────────────────────────────┴───────────────────────────────────┘
```

### 2.1 Scheduling Priority & Fair-Share Policy
When resource pool contention occurs, the scheduler enforces strict preemption:
* **Priority 0 (P0 - Real-Time Interactive):** The currently focused Chat or Canvas App in the desktop UI. Guaranteed zero-latency compute slot.
* **Priority 1 (P1 - Background Reactive):** Open canvas apps in background tabs. Eligible for memory trimming and event loop throttling.
* **Priority 2 (P2 - Batch Automation):** Headless tasks and scheduled crons. Queued; executed only when free worker slots exist; immediately yielded if a P0 request arrives.

---

## 3. System Architecture & Runtime Boundaries

The architecture enforces a strict two-tier separation between the **Host Supervisor Daemon (Trusted Realm)** and the **Sandboxed App Workers (Untrusted Execution Realm)**:

```mermaid
graph TD
    UI[Tauri Desktop Shell & Canvas UI] <-->|Main-Window IPC & Private Anonymous Pipes| Supervisor[Host Supervisor Daemon]
    
    subgraph Trusted Realm ["Host Supervisor Daemon (Trusted Realm)"]
        KeyStore["Keychain Vault (API Keys & Credentials)"]
        PoolMgr["Sandbox Worker Pool Manager"]
        Broker["Brokered Network Proxy & Firewall"]
        LLMProxy["Model Token Streaming Broker"]
        MCPGateway["Shared MCP Gateway (Stateless)"]
        FinOps["Global FinOps & Cost Ledger"]
        Registry["Catalog & App/Session Index"]
    end

    Supervisor <-->|Authenticated Local UDS / Stdio Pipes| PoolMgr
    
    subgraph Untrusted Realm ["Shared Sandbox Runtime Pool (OS Seatbelt Contained)"]
        Slot1["Worker Slot 1 (P0: Active Chat)\n- Node.js Runtime\n- Local Workspace Volume\n- Local SurfaceStore"]
        Slot2["Worker Slot 2 (P1: Dynamic Dashboard App)\n- Node/Python Daemon\n- Embedded DuckDB / SQLite\n- Canvas Reactive Bridge"]
        Slot3["Worker Slot 3 (Standby Warm Runner)\n- Instant Lease (<50ms)"]
    end

    PoolMgr -->|Slot Lease / Eviction / Freeze| Slot1
    PoolMgr -->|Slot Lease / Eviction / Freeze| Slot2
    PoolMgr -->|Pre-warm / Recycle| Slot3

    subgraph Storage Volumes ["Virtual Storage Volumes (<dataDir>/)"]
        Vol1[("<dataDir>/chats/<id>/workspace/")]
        Vol2[("<dataDir>/apps/<id>/workspace/")]
    end

    Slot1 -.->|File I/O strictly jailed| Vol1
    Slot2 -.->|File I/O strictly jailed| Vol2
```

---

## 4. The Shared Sandbox Runtime Pool (`WorkerPool`)

### 4.1 Process Economics & Pool Sizing
On a standard developer workstation (16GB–32GB RAM), spawning unmanaged Node.js runtimes causes severe degradation:
* Base Node V8 engine RSS: **~35MB–55MB** per process.
* Running 20 independent chat/app processes consumes **~1.0GB+ RAM**, creates dozens of OS IPC threads, and exhausts file descriptors.

The **Sandbox Worker Pool** solves this with **deterministic slot bounds**:

```typescript
export interface PoolConfig {
  /** Maximum concurrent running sandboxed OS child processes (default: 3) */
  maxActiveWorkers: number;
  /** Number of pre-warmed idle workers held in standby for instant leasing (default: 1) */
  standbyWorkers: number;
  /** Time of inactivity before a worker transitions from Active -> Idle (default: 5 min) */
  idleTimeoutMs: number;
  /** Time of inactivity before an Idle worker is flushed and Hibernated (default: 15 min) */
  hibernationTimeoutMs: number;
  /** Maximum RSS memory threshold per worker before warning/force-trim (default: 256 MiB) */
  maxWorkerRssBytes: number;
}
```

### 4.2 Pool Worker State Machine

```mermaid
stateDiagram-v2
    [*] --> Standby: Pre-warmed by Pool Manager
    Standby --> Leased: User selects Chat or opens Dynamic App
    Leased --> Active: Running Turn / Serving UI Interactions
    Active --> Idle: Inactivity Timer (5m)
    Idle --> Suspended: Memory trimmed / GC forced
    Suspended --> Hibernated: Flushed to Disk / Slot Evicted (15m)
    Hibernated --> Leased: User returns (Instant Wake <150ms)
    Active --> Terminating: Explicit user close or app deletion
    Hibernated --> Destroyed: Evicted from volume
    Terminating --> Standby: Sanitized & Recycled
```

### 4.3 Hibernation & Hydration Protocol
When an app or chat is evicted to make room for a higher-priority tenant:
1. **Pre-Eviction Notice (`worker.prepare_hibernate`):** The Supervisor notifies the worker.
2. **Persistence Flush:**
   * The app closes or checkpoints its embedded SQLite/DuckDB database (ensuring WAL log is clean).
   * SurfaceStore snapshots the active Canvas state to `state.json`.
   * Any pending file buffers are committed.
3. **Graceful SIGTERM & Slot Reclamation:** The worker confirms flush completion within 500ms; the Supervisor terminates the child process and marks the slot available.
4. **Fast Wakeup (<150ms):** When the user reopens the app, a pre-warmed standby worker immediately mounts the tenant's workspace folder, loads `state.json`, re-establishes the UI stream, and resumes execution seamlessly.

---

## 5. The Anatomy of a Dynamic Artifact App

A **Dynamic Artifact App** is a complete, self-contained micro-application managed by the Vakyartha platform.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       DYNAMIC ARTIFACT APP STACK                       │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Presentation Tier (Liquid Canvas Surface / Interactive UI)          │
│    - 3-Tier liquid layout (Executive strip, paired charts, data table) │
│    - Reactive controls (sliders, date pickers, dropdowns, forms)       │
│    - Real-time updates via streaming Surface Diff patches              │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Backend Compute Tier (Sandboxed Node.js / Python Daemon)            │
│    - Headless application logic executing in vak-sandbox Seatbelt      │
│    - Local API endpoints or event handlers                             │
│    - Custom algorithms, financial models, data aggregations            │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Storage & Data Tier (Virtual App Volume)                            │
│    - Isolated directory: `<dataDir>/apps/<app-id>/`                    │
│    - Embedded databases: SQLite, DuckDB, Parquet, or JSON files        │
│    - Versioned Realm snapshots (rollback, history, audit trail)        │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Autonomous Infrastructure Tier (Triggers & Scheduling)              │
│    - Background polling crons (e.g. hourly market scrape)              │
│    - File-watcher triggers (re-run on local file change)               │
│    - FinOps budget circuit breakers (kill run if compute > limit)      │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Deep Architectural Comparison

| Dimension | Standard Chat Session | Static Code Artifact | Dynamic Hosted App |
| :--- | :--- | :--- | :--- |
| **Compute Execution** | Turn-based model steps | Inert read-only view | Stateful, long-running Node/Python event loop |
| **User Interaction** | Prompt/Answer dialogue | Copy/paste code block | Bidirectional UI controls (filters, forms, buttons) |
| **Data Engine** | Transient prompt tokens | None | Embedded SQLite / DuckDB / Parquet engine |
| **Background Work** | Prohibited | Impossible | Autonomous crons, polling, and file-watchers |
| **UI Projection** | Chat message bubbles | Static preview frame | Full liquid Canvas app (container queries, 3-tier) |
| **Update Latency** | 2–10 seconds (LLM inference) | N/A | **< 16 ms** (Local backend state calculation) |

---

## 6. Formal Application Manifest Specification (`app.json`)

Every Dynamic Artifact App is declared via an immutable, declarative package manifest:

```json
{
  "$schema": "https://vakyartha.dev/schemas/v1/app-manifest.json",
  "id": "portfolio-analytics",
  "version": "1.0.0",
  "name": "Live Portfolio & Risk Analytics",
  "description": "Real-time stock & crypto portfolio analytics with local DuckDB caching.",
  "author": "Nisheeth Ranjan",
  "icon": "chart-candlestick",
  "category": "finance",
  
  "entrypoints": {
    "backend": "server.ts",
    "surface": "canvas-layout.json"
  },

  "runtime": {
    "engine": "node24",
    "memoryLimitMb": 256,
    "cpuTimeLimitSec": 60,
    "maxStorageMb": 512
  },

  "entitlements": {
    "network": {
      "mode": "brokered",
      "allowedDomains": [
        "api.coingecko.com",
        "query1.finance.yahoo.com"
      ]
    },
    "mcpTools": [
      "nse-market-data",
      "filesystem-workspace"
    ],
    "storage": {
      "sqlite": true,
      "duckdb": true
    }
  },

  "triggers": [
    {
      "id": "market-sync",
      "kind": "cron",
      "expression": "*/15 9-16 * * 1-5",
      "action": "syncMarketData",
      "maxDurationSec": 30
    }
  ]
}
```

---

## 7. Supervisor-to-Worker IPC Protocol Specification

Communication between the trusted Host Supervisor and the untrusted Sandboxed Worker occurs over an authenticated, framed **JSON-RPC 2.0 over anonymous Unix Domain Socket (UDS)** or private parent stdio pipes.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        IPC PROTOCOL SCHEMA                             │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Control Plane:                                                      │
│    - supervisor -> worker: init({ id, workspaceDir, config })          │
│    - supervisor -> worker: lease({ tenantId, priority })               │
│    - supervisor -> worker: prepare_hibernate()                         │
│    - worker -> supervisor: flushed({ status: "ready" })                │
│    - supervisor -> worker: teardown()                                  │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Event Plane (Canvas UI Projections):                                │
│    - supervisor -> worker: dispatch_action({ controlId, value })       │
│    - worker -> supervisor: surface_patch({ op: "replace", diff })      │
│    - worker -> supervisor: surface_toast({ kind: "success", msg })     │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Brokered Services Plane (Zero-Trust Outbound):                      │
│    - worker -> supervisor: broker_fetch({ url, method, body })         │
│    - worker -> supervisor: broker_llm_stream({ messages, model })      │
│    - worker -> supervisor: broker_mcp_call({ server, tool, args })     │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Telemetry Plane:                                                    │
│    - worker -> supervisor: emit_metric({ cpu, rss, eventLag })         │
│    - worker -> supervisor: emit_log({ level, message, context })       │
│    - worker -> supervisor: emit_audit({ action, target, bytes })       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 8. End-to-End Application Lifecycle Management

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as AI Co-Pilot / Skill Studio
    participant Sup as Host Supervisor
    participant Pool as Sandbox Runtime Pool
    participant Worker as Sandboxed App Worker
    participant Canvas as Canvas UI

    User->>Agent: "Create a Live Portfolio Dashboard"
    Agent->>Sup: Generate App Package (app.json, server.ts, surface.json)
    
    rect rgb(240, 248, 255)
        note over Sup,Worker: Phase 1: Rehearsal & Verification
        Sup->>Pool: Request Ephemeral Verification Slot
        Pool->>Worker: Run Dry-Run Verification Run
        Worker-->>Sup: Verification Passed (Zero syntax/runtime errors)
    end
    
    Sup->>Canvas: Display "Deploy Application" Approval Card
    User->>Canvas: Click "Deploy to Canvas"
    
    rect rgb(240, 255, 240)
        note over Sup,Canvas: Phase 2: Provisioning & Live Mounting
        Sup->>Pool: Provision Permanent App Volume (<dataDir>/apps/portfolio/)
        Pool->>Worker: Lease Slot & Launch App Daemon
        Worker->>Worker: Initialize SQLite / DuckDB Tables
        Worker->>Sup: Send Initial Surface Layout (surface_patch)
        Sup->>Canvas: Mount Reactive 3-Tier Canvas Surface
    end

    rect rgb(255, 250, 240)
        note over User,Worker: Phase 3: Zero-Latency Local Reactivity
        User->>Canvas: Adjust Slider "Risk Tolerance: Aggressive"
        Canvas->>Sup: Send Control Event (dispatch_action)
        Sup->>Worker: Forward Action to App Worker
        Worker->>Worker: Query Local DuckDB & Recalculate Risk (1.2ms)
        Worker-->>Sup: Send Patch Diff (Update 2 Charts, 1 Table)
        Sup-->>Canvas: Apply DOM Patches (<16ms, Zero LLM tokens)
    end

    rect rgb(245, 245, 245)
        note over Pool,Worker: Phase 4: Autonomous Hibernation & Wake
        User->>Canvas: Navigates away (App idle for 15 mins)
        Pool->>Worker: Send prepare_hibernate()
        Worker->>Worker: Checkpoint DB WAL & Flush State
        Worker-->>Pool: flushed({ ready: true })
        Pool->>Worker: Terminate Child Process (Slot Freed)
        User->>Canvas: Returns to Portfolio tab 2 hours later
        Pool->>Worker: Instant Wake (<150ms) -> Restores Live State
    end
```

---

## 9. Information & Data Architecture (Storage, DBs & Concurrency)

### 9.1 Tenant Directory Structure
Every Dynamic App owns an isolated, dedicated directory volume:

```text
<dataDir>/apps/<app-id>/
├── app.json             # Immutable package manifest
├── server.ts            # Application logic entrypoint
├── surface.json         # Base Canvas projection schema
├── state.json           # Serialized UI state and draft models
├── data/                # Persistent database directory (Seatbelt read/write)
│   ├── app.sqlite       # Local relational state / transactions
│   ├── app.sqlite-wal   # Write-Ahead Log
│   └── analytics.duckdb # Columnar analytical store
├── logs/                # Rotated execution and audit journals
│   └── execution.jsonl  # Live stdout/stderr and trace logs
└── artifacts/           # App-generated exports (PDFs, Parquet, CSVs)
```

### 9.2 Concurrency & Single-Writer Rule
To comply strictly with Vakyartha's **Single Persistence Owner** rule (ADR-001 / ADR-044):
* **Workspace Isolation:** Only the active App Worker process writes to its own `data/` directory. The Host Supervisor never writes inside the tenant volume directly.
* **Database Engine Standards:**
  * **Relational / Transactional:** SQLite running in `WAL` (Write-Ahead Logging) mode with `PRAGMA synchronous = NORMAL`.
  * **Analytical / Large-Scale:** DuckDB or Apache Parquet files for columnar querying.
* **Zero Cross-Contamination:** No application process can open or access a peer tenant's database directory.

---

## 10. Zero-Trust Security Architecture & Threat Model (STRIDE)

Dynamic code execution inside an AI desktop application requires enterprise-grade defense-in-depth:

```mermaid
graph LR
    subgraph Jailed Sandbox ["vak-sandbox Seatbelt Boundary"]
        AppCode["Untrusted App Code\n(Node.js / Python)"]
        LocalDisk[("<dataDir>/apps/<id>/\nONLY Accessible Path")]
    end

    subgraph Host Supervisor ["Supervisor (Trusted Outside Sandbox)"]
        KeyStore["Keychain (API Keys)"]
        Broker["Brokered Network Proxy"]
        Firewall["URL / Domain Whitelist"]
        AuditLog[("audit.jsonl (Tamper-evident)")]
    end

    AppCode -.->|Direct Network Socket| Denied((BLOCKED BY KERNEL))
    AppCode -.->|Read ~/.ssh or ~/.aws| DeniedFile((BLOCKED BY KERNEL))
    AppCode <-->|Read / Write| LocalDisk

    AppCode -->|1. Request Fetch via IPC| Broker
    Broker -->|2. Check Whitelist & Strip Cookies| Firewall
    Firewall -->|3. Signed HTTPS Fetch| RemoteAPI[External Web / API]
    Broker -->|4. Return Sanitized Payload| AppCode
    Broker -.->|Log Transaction| AuditLog

    AppCode -->|1. Request Model Completion| Broker
    Broker -->|2. Attach API Key from Vault| KeyStore
    Broker -->|3. Stream Tokens Back| AppCode
    Broker -.->|Log Token Spending| AuditLog
```

### 10.1 STRIDE Threat Analysis Matrix

| Threat Category | Potential Attack Vector | Vakyartha Mitigation Mechanism |
| :--- | :--- | :--- |
| **Spoofing** | Rogue app attempts to impersonate another tenant | Each worker process is assigned a cryptographic session token on startup; IPC requests validate the session token against the tenant ID. |
| **Tampering** | Malicious script modifies host configurations or peer app databases | macOS Seatbelt denies write operations outside `<dataDir>/apps/<app-id>/`. System roots (`/bin`, `/System`) are read-only; user directories (`~/.ssh`, `~/.aws`) are blocked. |
| **Repudiation** | App executes unauthorized tool calls and denies them | The Supervisor maintains an append-only, tamper-evident audit ledger (`audit.jsonl`) recording every tool invocation and network request. |
| **Information Disclosure** | Untrusted package steals user API keys (`OPENAI_API_KEY`) | **Zero-Key Sandbox Rule:** The app worker's environment variables contain zero credentials. API keys reside exclusively in the Supervisor's Keychain vault. |
| **Denial of Service** | Infinite loop consumes 100% CPU or exhausts host RAM | Pool manager enforces `--max-old-space-size=256` and runs a watchdog thread that SIGTERMs any process exceeding CPU/RAM quotas. |
| **Elevation of Privilege** | Sandboxed code attempts kernel exploit or binary execution | Executable execution is restricted to the bundled Node binary; spawning unauthorized binaries or loading unsigned native `.node` addons is blocked by Seatbelt. |

---

## 11. Desktop Observability, Telemetry & FinOps Governance

### 11.1 The Desktop Telemetry Console
Users and administrators have real-time visibility into every running app:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      APP OBSERVABILITY DASHBOARD                       │
├────────────────────────────────────────────────────────────────────────┤
│ [STATUS: RUNNING]   Uptime: 2h 14m   PID: 84920 (Jailed in vaksb)     │
├────────────────────────────────────────────────────────────────────────┤
│ METRICS:                                                               │
│   CPU: 0.4% [━━────────────]        RAM (RSS): 42.1 MB [━━━──────────] │
│   Disk I/O: 1.2 MB written          FinOps: $0.004 (2 model calls)     │
├────────────────────────────────────────────────────────────────────────┤
│ LIVE STREAMING CONSOLE (stdout / stderr / audit):                      │
│   [11:45:02] [INFO] SQLite connection initialized (portfolio.db)       │
│   [11:45:03] [INFO] Cron job registered: 'fetch-rates' every 60m       │
│   [11:45:04] [IPC]  Surface rendered: 3 tiers, 4 metric cards, 1 chart │
│   [11:46:12] [NET]  Broker fetch -> api.coingecko.com (200 OK, 142ms)  │
│   [11:46:12] [DIFF] Surface updated: BTC +1.4%, ETH -0.2%             │
└────────────────────────────────────────────────────────────────────────┘
```

### 11.2 The Four Golden Signals on Desktop
1. **Latency:** Local UI interaction-to-render round-trip time (target: **< 16 ms**).
2. **Traffic:** Number of user UI interactions and scheduled background events per minute.
3. **Errors:** Count of unhandled exceptions, failed network fetches, or database query errors.
4. **Saturation:** Percentage of memory quota (`current_rss / 256MB`) and event loop lag.

### 11.3 FinOps Cost Accounting & Hard Circuit Breakers
* Every model token invoked by a background trigger or summarization job is attributed to the specific app ID.
* The app manifest defines a monthly budget limit (e.g. `$2.00 / month`).
* If the limit is reached, background LLM triggers halt gracefully, and a notification alerts the user to review spending.

---

## 12. High-Impact Enterprise Scenarios & Reference Deployments

### Reference Deployment 1: Dynamic Financial & Risk Analytics Portal
* **Persona:** Financial Analyst / Independent Investor.
* **Architecture:**
  * **Backend:** Node.js worker with embedded DuckDB columnar engine.
  * **Data Pipeline:** Scheduled cron polls market APIs via Brokered Gateway.
  * **Projection:** Liquid Canvas surface rendering real-time portfolio weights, VaR (Value-at-Risk) estimates, and paired candlestick charts.
  * **Value Unlocked:** Instant interactive parameter tweaking (re-weighting portfolio via sliders) without incurring API token costs or latency.

### Reference Deployment 2: Local ETL & Data Engineering Workbench
* **Persona:** Data Scientist / Business Operations Lead.
* **Architecture:**
  * **Backend:** Sandboxed Python script executing DuckDB/Polars.
  * **Input:** User drops dirty 500MB CSV/Parquet files into the workspace folder.
  * **Processing:** Deduplication, schema normalization, outlier detection.
  * **Projection:** Paginated virtual data table on Canvas with instantaneous filtering and one-click clean file export.

### Reference Deployment 3: Developer CI & Quality Dashboard
* **Persona:** Software Engineer / Tech Lead.
* **Architecture:**
  * **Backend:** Node.js worker monitoring local git worktrees.
  * **Workflow:** Runs local test suites inside disposable Seatbelt snapshots on every git commit.
  * **Projection:** Interactive test coverage visualizer, flamegraphs, and failure triage workbench.

---

## 13. Failure Modes, Circuit Breakers & Non-Functional Requirements (NFRs)

### 13.1 Failure Mode & Effects Analysis (FMEA)

| Failure Mode | Root Cause | Impact | Automated Recovery Action |
| :--- | :--- | :--- | :--- |
| **Worker OOM** | Memory leak in user script exceeds 256 MiB | Process terminated by OS kernel | Pool manager intercepts exit code, frees worker slot, flags app as "Crashed (OOM)", and surfaces one-click debug action to user. |
| **Infinite CPU Loop** | Rogue `while(true)` without async yielding | 100% CPU core utilization | Watchdog timer detects sustained CPU > 90% for 30s; issues SIGKILL; applies exponential restart backoff. |
| **Corrupt SQLite WAL** | Abrupt power loss during write | Database unreadable | SQLite auto-recovers from WAL on next boot; if unrecoverable, Realm journal rolls back to last valid transaction snapshot. |
| **API Key Exfiltration Attempt** | Prompt injection attacks try to read keys | Critical security threat | **Zero Impact:** Environment contains no keys; outbound network requests without whitelisted broker authorization are dropped by OS kernel. |

### 13.2 Non-Functional Requirements (NFRs)
* **NFR-1 (UI Latency):** Canvas action-to-DOM patch latency must remain **< 16 ms** for 95% of local interactions.
* **NFR-2 (Startup Time):** Waking a hibernated app must complete in **< 150 ms**.
* **NFR-3 (Memory Footprint):** Total idle memory consumption of the Pool Manager (including standby worker) must not exceed **120 MiB**.
* **NFR-4 (Disk Footprint):** App volume size is capped at **512 MiB** hard limit.

---

## 14. Phased Implementation Roadmap & Evaluation Gates

```mermaid
gantt
    title Vakyartha Mini-Cloud Implementation Roadmap
    dateFormat  YYYY-MM-DD
    section Phase 1: IPC & Pool Foundation
    IPC Protocol Contract & Schema Definition :done, 2026-11-01, 7d
    Sandbox Worker Pool Manager Prototype      :active, 2026-11-08, 10d
    Worker Hibernation & Slot Leasing Tests    :2026-11-18, 7d
    section Phase 2: Per-Chat Sandbox Isolation
    Migrate Chat Sessions to Pooled Workers    :2026-11-25, 10d
    Zero-Trust Secrets Broker Integration      :2026-12-05, 7d
    Seatbelt Jailing & Security Verification   :2026-12-12, 7d
    section Phase 3: Dynamic Hosted Apps
    App Manifest (app.json) & Packaging Engine :2026-12-19, 7d
    Canvas Reactive IPC Bridge (surface_patch) :2026-12-26, 10d
    Embedded SQLite & DuckDB Volume Support    :2027-01-05, 10d
    section Phase 4: Observability & Studio
    Desktop Telemetry Console (Logs & Metrics) :2027-01-15, 7d
    Skill Studio YOLO Synthesis for Full Apps  :2027-01-22, 10d
    End-to-End Evaluation & Release Gating     :2027-02-01, 7d
```

### Evaluation & Acceptance Gates (Before Promotion to Production)
1. **Gate 1 (Security Proof):** `scripts/sandbox-security-check.ts` must prove that untrusted app code cannot access host filesystem paths (`~/.ssh`, `.env`) or open raw TCP sockets.
2. **Gate 2 (Resource Concurrency):** `scripts/pool-concurrency-check.ts` must prove that opening 20 concurrent chats/apps keeps total host memory under 200 MiB via automatic slot leasing and LRU hibernation.
3. **Gate 3 (Reactivity Benchmark):** WebKit performance tests must prove that slider/form actions update the Canvas surface in `< 16 ms` without LLM model requests.
