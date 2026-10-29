---
name: data-review
description: Inspect supplied tabular records, CSV or JSON for data quality, trends and requested summaries; use dashboard for an operational overview.
license: MIT
compatibility: Works with tabular CSV, JSON, and structured query snapshots.
metadata:
  author: nranjan2code
  version: "1.5"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# Data Quality & Tabular Inspection

Methodical procedure for auditing, profiling and validating structured datasets, CSV files and JSON records for anomalies, integrity and actionable insights.

## Overview & Chaining

- **Purpose**: Use this skill when inspecting tabular data, reviewing CSV/JSON uploads, auditing dataset hygiene, or computing verified statistical summaries.
- **Skill chaining**:
  - Load `interactive-ui` when an interactive audit surface, data table or chart is needed.
  - The required `surface-design` skill governs canvas layout and visual presentation.
  - Load `dashboard` if the user requires ongoing operational KPIs or executive monitoring rather than a data quality audit.

## Data Ingestion & Integrity Checks

1. **Schema & Header Verification**:
   - Inspect column names, delimiter consistency and row counts.
   - Clarify ambiguous header names or date conventions (e.g. `MM/DD/YYYY` vs `DD/MM/YYYY`) before drawing conclusions that depend on them.
2. **Missing & Null Values**:
   - Count and report null, empty or missing fields per column.
   - Never silently substitute `0`, `"N/A"` or default values for missing data without explicit instruction.
3. **Type Consistency**:
   - Flag columns with mixed types (e.g. numbers mixed with text strings like `"unknown"` or `"-"`).
   - Clean currency symbols, commas or whitespace in numerical columns while preserving raw source values.
4. **Duplicate & Key Audits**:
   - Check primary key uniqueness and identify duplicate rows. Report exact duplicate counts and sample rows.
5. **Outliers & Boundary Checks**:
   - Identify values falling outside expected physical or business ranges (e.g. negative ages, future completion dates).
   - Report outliers transparently; do not silently truncate or discard them.

## Statistical Summaries & Calculations

- **Accurate Aggregates**: Compute counts, sums, averages, medians, minimums and maximums using verified calculation tools or verified deterministic steps.
- **Scope Disclosure**: State exactly how many rows, dates or categories are included in each aggregate summary.
- **No Client Formula Hallucination**: Recognize that client tables display data but do not execute Excel-like formula strings. Calculations must be pre-computed or backed by tools.

## Style & Presentation Guardrails

- **Separation of Concerns**: Separate source facts from proposed corrections; do not mutate raw records without explicit approval.
