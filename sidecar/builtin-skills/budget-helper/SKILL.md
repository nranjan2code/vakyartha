---
name: budget-helper
description: Use when the user wants to make a budget, track spending or plan savings.
license: MIT
compatibility: Works with text chat, household budgets, savings models, and interactive budget canvases.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Personal Budgeting & Spending Tracking

Framework for building practical personal budgets, tracking household expenses, planning savings goals and managing project or travel costs.

## Overview & Chaining

- **Purpose**: Use this skill when asked to create a household budget, organize personal spending categories, design a debt payoff plan, or track travel/event expenses.
- **Skill chaining**:
  - Load `interactive-ui` when rendering an interactive budget tracker with bound expense inputs and reactive totals.
  - The required `surface-design` skill governs layout, allocation pie/bar charts, metric cards and spoken summaries.
  - Use `finance-dashboard` when analyzing formal business accounting statements (P&L, cash flow, balance sheets) rather than personal finances.

## Budget Architecture & Methodology

1. **Clarify scope & timeframe**:
   - Establish whether the budget covers regular monthly household expenses, an annual financial plan, a specific trip, or a one-time event (e.g. wedding, home renovation).
   - Do not substitute a generic monthly household template for a requested trip or project budget.
2. **Track net inflows**:
   - Establish reliable net take-home income rather than gross pre-tax salaries.
   - Separate fixed recurring income from variable or seasonal side earnings.
3. **Categorize expenditures**:
   - **Fixed Essentials ("Needs")**: Rent/mortgage, debt minimums, utilities, insurance, essential groceries, healthcare, transit.
   - **Discretionary ("Wants")**: Dining out, subscriptions, recreation, hobbies, travel, shopping.
   - **Savings & Wealth ("Goals")**: Emergency fund contributions, retirement savings, investments, debt acceleration.
4. **Time & Currency discipline**:
   - Normalize recurring expenses to a common cadence (e.g. converting annual auto insurance to a monthly allocation: `Annual / 12`).
   - Keep different currencies strictly isolated unless an explicit exchange rate is provided.

## Integrity & Advisory Guardrails

- **Zero invented figures**: When income or expenses are unstated, ask for estimates or provide clear labeled placeholders.
- **Recalculation rigor**: Edits to bound category amounts require deterministic recalculation upon submission; do not claim sums balance without verified math.
- **Informational status**: Clarify that budgeting tools provide educational financial organization, not licensed investment, tax or debt settlement advice.
