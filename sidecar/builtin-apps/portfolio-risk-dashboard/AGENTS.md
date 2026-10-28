# AGENTS.md — Portfolio Risk Dashboard

Architectural specification and operating contract for AI agents and humans managing this application.

## Application Identity
- **ID:** `portfolio-risk-dashboard`
- **Category:** `finance`
- **Runtime:** Sandboxed Node.js 24 airgapped worker runtime (`memory: 256MB`, `cpu: 60s`, `storage: 512MB`).
- **Isolation:** Seatbelt sandboxed child process, zero network access, local state only.

## Surface Contract (`surface.json`)
The interactive surface is rendered using the Vakyartha `@vak/core` component catalog.

### Visual Nodes
- **`root`**: Vertical stack containing KPI strip, strategy selector, and allocation chart.
- **`kpi-metrics`**: 4-column responsive stat grid:
  - `card-total-val`: Fixed benchmark portfolio baseline (`$124,500.00`).
  - `card-var-95`: Parametric 1-day Value-at-Risk at 95% confidence (`$2,850.00`).
  - `card-sharpe`: Annualized Sharpe Ratio over risk-free rate (`1.84`).
  - `card-expected-return`: Annualized projected return percentage (`14.2%`).
- **`controls-section`**: Strategy selector wrapper.
  - `select-risk-profile`: Bound to `/riskProfile`. Options:
    - `conservative`: 25% equities, 41% bonds, 14% gold, 20% cash.
    - `balanced`: 59% equities, 27% bonds, 12% gold, 2% cash (Default).
    - `aggressive`: 71% equities, 20% bonds, 11% gold, -2% cash.
- **`chart-section`**: Donut visualization showing allocation breakdown across asset classes.

## Action Protocol (`server.ts`)
Interactions from the UI trigger zero-LLM RPC dispatches directly to the sandboxed worker:
- **Handler:** `export function handleAction(controlId: string, value: unknown)`
- **Response Format:**
  ```json
  {
    "op": "batch_update",
    "controlId": "select-risk-profile",
    "value": "conservative",
    "patches": [
      { "id": "card-var-95", "props": { "value": "$1,420.50" } },
      { "id": "card-expected-return", "props": { "value": "7.0%" } },
      { "id": "card-sharpe", "props": { "value": "2.10" } },
      { "id": "chart-section", "props": { "series": [{ "name": "Allocation %", "values": [25, 41, 14, 20] }] } }
    ]
  }
  ```

## Background Triggers
- **ID:** `recalculate-risk`
- **Schedule:** `*/5 * * * *` (every 5 minutes)
- **Action:** `recalculateMetrics`

## Maintenance Instructions for Agents
1. To modify calculations: edit formulas in `server.ts`. Never introduce external network calls (runtime is airgapped).
2. To modify UI controls: ensure node types and prop definitions conform to `@vak/core` basicCatalog (`stat`, `select`, `chart`, `grid`, `stack`).
3. To test actions: execute `POST /api/apps/portfolio-risk-dashboard/action` with payload `{ "controlId": "select-risk-profile", "value": "conservative" }`.

