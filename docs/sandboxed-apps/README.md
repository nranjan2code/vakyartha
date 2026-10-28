# Sandboxed Applications & Runtime Pool

This directory houses the formal Enterprise Architecture specifications for Vakyartha's **Multi-Tenant Pooled Sandbox Runtime** and **Full-Lifecycle Dynamic Hosted Applications** (the "Mini-Cloud" model).

## Core Architecture Document

* [**`ARCHITECTURE.md`**](ARCHITECTURE.md): The comprehensive technical specification covering:
  1. **Strategic Rationale & Tenancy Model:** Workload classes (Session tenants, Artifact App tenants, Job tenants), preemption, and fair-share scheduling.
  2. **System Topology & Boundaries:** Clean decoupling between the trusted Host Supervisor and untrusted Seatbelt-jailed workers.
  3. **The Shared Sandbox Runtime Pool (`WorkerPool`):** Process economics, bounded concurrency (`maxActiveWorkers = 3`), pre-warmed standby runners, and sub-150ms hibernation/wake state machines.
  4. **The 4-Tier Dynamic Artifact App Stack:** Presentation (Canvas 3-Tier liquid layout), compute daemon (Node/Python), embedded storage (SQLite/DuckDB volumes), and autonomous cron triggers.
  5. **Formal Manifest Specification (`app.json`):** Declarative runtime limits, network entitlements, MCP tools, and triggers.
  6. **Supervisor-to-Worker IPC Contract:** Framed JSON-RPC 2.0 protocol spanning Control, Event, Brokered Services, and Telemetry planes.
  7. **Information & Data Architecture:** Virtual app volumes (`<dataDir>/apps/<id>/`), SQLite WAL mode, and the single-writer persistence rule.
  8. **Zero-Trust Security Architecture (STRIDE Analysis):** Zero-Key Sandbox rule, kernel Seatbelt containment, and brokered credential proxies.
  9. **Desktop Observability & FinOps Governance:** Live telemetry console, 4 golden signals, CPU/RSS throttling, and cumulative token budget circuit breakers.
  10. **Enterprise Reference Deployments:** Real-world patterns for Live Financial Dashboards, Data Engineering Workbenches, and Developer CI portals.
  11. **Failure Modes, Recovery & NFRs:** FMEA matrix, automated recovery actions, and non-functional latency/memory guarantees.
  12. **Phased Roadmap & Acceptance Gates:** Formal gates required before code promotion.
