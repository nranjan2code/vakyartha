# Skills and execution responsibilities

This document describes how existing Vakyartha skills help people build and maintain this reference app. It is documentation, not a loader manifest or an authority grant. The runnable package is `app.json` + TypeScript + `surface.json`; opening it or clicking a control requires no skill selection or model call.

| Skill | Use when | Responsibility |
| --- | --- | --- |
| `app-authoring` | Constructing or adapting a package in chat/Studio | Inert complete source, declared backend/tools, reviewed publication; no imaginary executable refresh |
| `app-operator` | Opening, running or scheduling a published app | Existing app lifecycle and explicit schedule controls; inspect receipts |
| `app-maintainer` | Changing calculations, schemas or presentation | Read actual package first, preserve state and independent surfaces, rehearse and review |
| `app-debugger` plus `debug-error` | Diagnosing a failed source, SQL, action or view | Freeze original inputs/receipts, trace the earliest failing boundary and verify the original outcome |
| `app-admin` | Diagnosing sandbox/pool failure | Existing console/readiness/recovery; no fallback host execution |
| `nse-mcp` | Researching available source tools | Discover actual enabled tool schemas and inspect successful data; historical examples may be stale |
| `market-dashboard` → `dashboard` | Choosing analysis and visual hierarchy | Session, return window, source freshness, exact values and chart suitability |
| `interactive-ui` | Authoring bindings, forms and actions | Canonical pointers, mapped record views and exact submitted controls |
| `surface-design` (required) | Every authored surface | Semantic measures, responsive peer panels, typography, chart and spoken readability |
| `sandbox` → `shell-command` | Explicitly rehearsing other source tasks | Existing governed command integration; no new execution authority |

The arrows describe procedural reuse when enabled and needed; they are not automatic dependencies or hidden provider requests. See `docs/SKILLS.md` and `docs/SKILL-AUTHORING.md` for activation, updates and public projection contracts. This package does not seed or rewrite those built-ins.

## Suggested authoring requests

- “Open the Market Terminal package and explain where source observations, SQL and projection updates are owned.”
- “Add a supported comparison using the existing dated records; preserve the source ledger, independent surfaces and control behavior.”
- “Review this package's declared tools and numerical assumptions before changing its schema.”

A request to refresh a published app should use the published action, not generate a new market report. A request to modify source should create a reviewable draft, not silently replace the running package. Rehearsal has no external-tool access; use `recalculate` against the isolated empty/synthetic database to check SQL mechanics. A successful rehearsal does not prove NSE connectivity or financial correctness.
