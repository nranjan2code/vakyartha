# Sandboxed Applications & Runtime Pool

This directory documents Vakyartha's architectural vision for **Pooled Sandboxed Runtimes** and **Full-Lifecycle Dynamic Hosted Applications** (the "Mini-Cloud" model).

## Documents

* [**ARCHITECTURE.md**](ARCHITECTURE.md): The primary architectural blueprint covering:
  * The Supervisor / Worker Pool model (managing shared worker processes for chats and hosted apps).
  * The Anatomy of a Dynamic Artifact App (Presentation tier, backend compute daemon, embedded database, background triggers).
  * End-to-end lifecycle management (drafting, verification, deployment, hibernation, self-healing).
  * Cloud-grade desktop observability (streaming logs, CPU/RSS metrics, FinOps cost attribution).
  * Zero-trust security, networking proxy, and secrets brokering.
  * Real-world scenarios (live financial dashboards, local ETL data pipelines, developer workbenches, automated briefing portals).
  * Non-negotiable principles and verification criteria.

