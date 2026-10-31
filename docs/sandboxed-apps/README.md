# Executable local apps

Vakyartha builds, hosts and runs local applications. Chat, Canvas and Studio author a package; ordinary code then runs each action and refresh in a sandbox, with no model request per interaction.

**To build or change an app, start with [Building a Vakyartha app](../BUILDING-APPS.md).**

| Document | Purpose |
| --- | --- |
| [Building a Vakyartha app](../BUILDING-APPS.md) | The method: package, backend, interactions, views, host capabilities, testing, shipping |
| [Runtime contract](RUNTIME-CONTRACT.md) | Exact supported interface, persistence, permissions and limits |
| [Reference applications](../REFERENCE-APPS.md) | The five shipped packages and how they are verified |
| [Architecture](ARCHITECTURE.md) | Ownership, execution and data flow |
| [Operations and lifecycle](OPERATIONS-AND-LIFECYCLE.md) | Create, rehearse, publish, run, schedule, recover and remove |
| [Original review](REVIEW-2026-10-28.md) | Baseline defects found on 2026-10-28; historical evidence only |
| [ADR-048](../ADR.md#adr-048-bounded-executable-app-invocations-and-reviewed-publication-2026-10-28), ADR-049 | Accepted runtime boundary and bounded DuckDB snapshots |

Not supported: warm workers or daemons, persistent filesystem databases (beyond the bounded DuckDB snapshot), file watchers, raw network or model access from app code, and CPU/RSS/disk quotas. Current verification is in [Handover](../HANDOVER.md) and [Evaluation](../EVALUATION.md).
