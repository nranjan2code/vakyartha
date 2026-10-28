---
name: portfolio-risk-dashboard
description: Operational skill for monitoring, rebalancing, and running quantitative risk checks on the Portfolio Risk Dashboard application.
license: MIT
compatibility: Installed locally in Vakyartha Sandboxed Applications.
---

# Operating Portfolio Risk Dashboard

Use this procedure when querying, rebalancing, or reviewing metrics on the `portfolio-risk-dashboard` application.

## Inspecting Application Status
1. Check running status via `GET /api/apps/portfolio-risk-dashboard`.
2. Inspect current values for 1-day 95% VaR, Sharpe ratio, and expected return.

## Triggering Strategy Rebalance
To update the allocation model between conservative, balanced, or aggressive:
- Dispatch action to control `select-risk-profile` with the chosen strategy value.
- Review the returned patches to verify that Value-at-Risk reflects the adjusted volatility.

