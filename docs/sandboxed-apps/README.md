# Executable local apps

Vakyartha's mini-cloud builds, hosts and executes local applications. Chat and Studio author the package; ordinary code performs published actions and refreshes. A model is involved when building or changing behavior, not on every interaction.

Start with the [runtime contract](RUNTIME-CONTRACT.md), which defines the supported interface, persistence, permissions and limits.

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Intent, ownership, execution and data flow |
| [Operations and lifecycle](OPERATIONS-AND-LIFECYCLE.md) | Create, rehearse, publish, run, schedule, recover and remove |
| [Original review](REVIEW-2026-10-28.md) | Baseline defects and reproduced failures; historical evidence |
| [Handover](../HANDOVER.md) / [Evaluation](../EVALUATION.md#executable-local-app-runtime--2026-10-28) | Current verification and open outcomes |
| [ADR-048](../ADR.md#adr-048-bounded-executable-app-invocations-and-reviewed-publication-2026-10-28) | Accepted runtime boundary, superseding ADR-047 |

The earlier warm-worker/daemon design is superseded. Persistent filesystem databases, file watchers, raw network/model brokers, strict CPU/RSS/disk quotas and latency guarantees are not current capabilities. The primary-provider authoring gate remains open; runtime checks do not certify model-generated applications. Source changes have not replaced the installed app.
