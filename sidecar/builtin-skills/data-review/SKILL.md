---
name: data-review
description: Inspect supplied tabular records, CSV or JSON for data quality, trends and requested summaries; use dashboard for an operational overview.
license: MIT
compatibility: Works with tabular CSV, JSON, and structured query snapshots.
metadata:
  author: nranjan2code
  version: "1.3"
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

## Liquid Canvas Architecture for Data Audits

Never stretch single profiling charts, narrow sample tables, or short audit notes across 100% of a wide canvas. Structure the data audit canvas into three adaptive tiers:

1. **Tier 1: Data Hygiene Strip & Spoken Takeaway**:
   - **Spoken lead**: 1–2 sentences clearly summarizing total records processed, data completeness rate, and primary data anomalies identified so voice projection is immediate.
   - **KPI grid**: 4-column metric strip (`grid` with `props: { columns: 4, minItemWidth: "xs" }`):
     - `Total Records`: e.g. "12,450 rows"
     - `Valid / Clean`: e.g. "98.2%" (`tone: "positive"`)
     - `Missing / Nulls`: e.g. "184 cells (1.5%)" (`tone: "caution"`)
     - `Flagged Anomalies`: e.g. "23 records" (`tone: "critical"`)
2. **Tier 2: Paired 2-Column Profiling Grid**:
   - Paired visual grid (`grid` with `props: { columns: 2, minItemWidth: "sm" }`):
     - **Left**: Missing Values per Column (`bar` chart, `props: { maxWidth: "md" }`).
     - **Right**: Category / Value Distribution (`pie` or `stacked` bar chart, `props: { maxWidth: "md" }`).
   - Never stretch single profiling charts across 100% of the canvas. Clamping to `maxWidth: "md"` or pairing in 2-column tracks preserves readable bar heights and undistorted pie circles.
3. **Tier 3: Granular Flagged Records Table & Clamped Correction Form**:
   - **Flagged Records Table**: Full-width dense inspection table (`section` with `table`, `maxWidth: "full"`, searchable and sortable, with pagination).
   - **Correction Form**: Clamped correction or filter form (`form` with `maxWidth: "md"`), allowing user inspection or approval of corrections.

## Style & Presentation Guardrails

- **Tone & Style**: Never inject raw CSS or hex codes; use semantic tones (`positive` for clean data, `caution` for missing values, `critical` for duplicates or schema breaks).
- **Separation of Concerns**: Separate source facts from proposed corrections; do not mutate raw records without explicit approval.
