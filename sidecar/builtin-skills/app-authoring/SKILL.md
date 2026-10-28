---
name: app-authoring
description: Author, scaffold, create, and compose persistent sandboxed applications with dedicated interactive surfaces and local server logic.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.0"
---

# Authoring Hosted Applications

Use this procedure when designing, scaffolding, or implementing persistent sandboxed applications in Vakyartha.

Applications in Vakyartha execute inside isolated Node 24 child runtimes with dedicated storage volumes and visual surfaces, running with zero LLM per-action overhead.

## Application Structure
Every hosted application resides in its own isolated directory `<dataDir>/apps/<id>/` and must contain:
1. **`app.json`**: Manifest declaring identity, runtime limits, entitlements, and triggers.
2. **`surface.json`**: Visual surface tree conforming to `@vak/core` `basicCatalog` nodes (`stack`, `grid`, `stat`, `card`, `select`, `chart`, `table`, `form`, `input`, `button`).
3. **`server.ts`**: Backend daemon exporting `handleAction(controlId, value)` and trigger handlers.
4. **`AGENTS.md`**: Self-documenting architectural contract explaining purpose, node IDs, formulas, and action schemas.
5. **`SKILL.md`**: Operational procedure for agents managing this specific app.

## Scaffolding an Application
To scaffold a new application via the engine API:
```http
POST /api/apps
Content-Type: application/json

{
  "manifest": {
    "id": "my-app-id",
    "version": "1.0.0",
    "name": "My App Name",
    "description": "Clear explanation of application purpose",
    "author": "Author Name",
    "category": "finance",
    "icon": "chart",
    "entrypoints": {
      "backend": "server.ts",
      "surface": "surface.json"
    },
    "runtime": {
      "engine": "node24",
      "memoryLimitMb": 256,
      "cpuTimeLimitSec": 60,
      "maxStorageMb": 512
    },
    "entitlements": {
      "network": { "mode": "airgap", "allowedDomains": [] },
      "mcpTools": [],
      "storage": { "sqlite": true, "duckdb": false }
    },
    "triggers": [
      {
        "id": "periodic-sync",
        "kind": "cron",
        "expression": "*/15 * * * *",
        "action": "syncData",
        "maxDurationSec": 30
      }
    ]
  },
  "files": {
    "surface.json": "...",
    "server.ts": "...",
    "AGENTS.md": "...",
    "SKILL.md": "..."
  }
}
```

## Surface Design Rules
- Always use valid node types from `@vak/core` `basicCatalog`.
- Prefer `stack` for vertical page layout and `grid` for metric KPI cards.
- Controls like `select` must include `label`, `bind`, and `options` with `{ label, value }` objects.
- Charts must specify valid kinds (`donut`, `bar`, `line`) with `labels` and `series`.

