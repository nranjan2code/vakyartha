---
name: finance-dashboard
description: Build a business income, expense, cash-flow or budget-versus-actual dashboard from supplied financial records; use budget-helper for personal budgeting.
license: MIT
compatibility: Works with general ledger exports, financial spreadsheets, and canvas projection.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Financial Performance & Variance Dashboards

Rigorous financial analysis methodology for constructing income statements, expense breakdowns, cash-flow overviews and budget-versus-actual variance dashboards.

## Overview & Chaining

- **Purpose**: Use this skill when asked to analyze business financial statements, monitor operational budgets, evaluate department spending, or prepare executive financial reviews.
- **Skill chaining**:
  - Load `dashboard` and `interactive-ui` for multi-metric financial displays, variance mappings and filter forms.
  - The required `surface-design` skill governs financial table formatting, chart types and spoken summaries.
  - For personal budgeting, household savings or vacation spending, use `budget-helper` instead.

## Accounting Invariants & Basis Discipline

1. **Accounting basis**: Clarify whether financial records are prepared on a **Cash basis** (recognized upon receipt/disbursement) or an **Accrual basis** (recognized when earned/incurred).
2. **Distinct financial concepts**:
   - **Cash balance**: Liquid funds on hand; not equivalent to profit.
   - **Net income**: Operating revenue minus operating expenses, taxes, depreciation and interest.
   - **Gross profit vs Operating profit**: Maintain clear gross margin definitions (`Revenue - COGS`).
   - **Internal transfers**: Inter-account or inter-entity transfers are not operational revenue or expense.
3. **Multi-currency isolation**:
   - Never sum amounts across differing currencies (e.g. USD, EUR, GBP) without an explicit, dated foreign exchange rate.
   - Maintain separate currency columns or explicit conversion tables.
4. **Missing amounts**: Missing line items must be labeled as `Missing` or `Unknown`, never silently coerced to `0.00`.

## Budget vs Actual Variance Analysis

- **Dollar variance**: Calculate as `Actual - Budget`.
- **Percentage variance**: Calculate as `((Actual - Budget) / Budget) × 100`.
- **Directional interpretation**:
   - For **Revenue**: Positive variance is favorable; negative is unfavorable.
   - For **Expenses**: Negative variance is favorable (under budget); positive is unfavorable (over budget).
   - Clearly label variance as `Favorable` or `Unfavorable` rather than relying solely on +/- signs.

## Financial Dashboard Architecture

1. **Executive KPI Strip**:
   - Total Revenue (and vs Budget / Prior Period).
   - Gross Margin % (and Gross Profit).
   - Total Operating Expenses (OPEX).
   - Net Operating Income (EBITDA / Net Profit).
   - Ending Cash Balance.
2. **Analytical Visualizations**:
   - Variance chart: `bar` or `stacked` chart comparing Budget vs Actual spending across departments or cost centers.
   - Monthly trend: `line` or `area` chart tracking revenue and burn rate over the fiscal year.
3. **General Ledger / Category Detail Table**:
   - Structured table listing Account / Department, Category, Budget, Actual, Dollar Variance, and % Variance.

## Compliance & Export Boundaries

- **Review tool status**: State clearly that the dashboard is an operational review aid, not a certified audit, filed tax return or formal bank reconciliation.
- **Export receipts**: Generating a financial canvas does not export data to external accounting software (QuickBooks, NetSuite, Xero) without authorized integration tools and receipts.
