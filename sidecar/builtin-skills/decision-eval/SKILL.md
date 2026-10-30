---
name: decision-eval
description: Delegate discrete classification, criteria verification, security scoring, and option triage to the System 1 decision engine instead of guessing or generating speculative tokens.
license: MIT
compatibility: Works with all models, text chat, tool calling, and autonomous workflows.
metadata:
  author: nranjan2code
  version: "2.0"
allowed-tools: use_skill
---

# Discrete Decision Evaluation & Criteria Scoring

Provides deterministic, high-speed System 1 decision scoring for discrete choices, criteria verification, and option classification using local decision models (`d1-omni`, `laya`) or fast structured evaluators.

## 1. When to Use

Always delegate to this skill when evaluating choices that can be formulated as discrete, mutually exclusive options, rather than generating speculative chain-of-thought prose or guessing:

1. **Security & Mutation Risk Triage**:
   - Determining whether a proposed command or file edit is `read_only_safe`, `state_mutation`, or `network_egress`.
2. **Surface & Visualization Kind Selection**:
   - Selecting whether data is best projected as a `table`, `bar_chart`, `line_chart`, `stat_metric`, or `form_input`.
3. **Acceptance Criteria Verification**:
   - Checking whether an autonomous step or tool receipt fulfills user requirements (`criteria_satisfied`, `missing_evidence`, `blocked_or_error`).
4. **Code Quality & Defect Severity Triage**:
   - Classifying code review observations into discrete severity tiers (`critical_bug`, `performance_risk`, `style_hygiene`).
5. **Tradeoff & Option Scoring**:
   - Objective scoring of competing approaches against stated user constraints.

## 2. The 3 Golden Rules for Formulating Decision Criteria

To ensure the decision engine evaluates accurately without hallucination or ambiguity, follow these rules:

1. **Rule 1: Mutually Exclusive Candidates**:
   - Every candidate state must belong to exactly one choice. Choices must not overlap.
   - Good: `["read_only", "state_mutation", "network_egress"]`
   - Bad: `["read_file", "inspect_code", "read_package"]` (overlapping concepts).
2. **Rule 2: Concrete, Observable Criteria Descriptions**:
   - Describe observable indicators (e.g. *"modifies files on disk"*, *"touches network"*), never subjective adjectives (*"good"*, *"appropriate"*, *"optimal"*).
   - Good: `safe_read`: "Reads or inspects files, configs, or tables without changing state or opening network sockets"
   - Bad: `safe_read`: "A good and safe operation"
3. **Rule 3: Bounded Option Set**:
   - Keep options between 2 and 6 candidates. 3 to 4 candidates is the optimal sweet spot for calibrated probabilities.

## 3. Standard Decision Patterns

### Pattern A: Tool Execution & Security Triage

Use when validating a tool call or shell command before execution:

```
Criteria:
- read_only_safe: "Harmless inspection or reading of files, configs, or queries without modifying state or accessing the network"
- state_mutation: "Creates, updates, writes, or deletes files, database records, or system configuration"
- network_egress: "Opens remote sockets, fetches URLs, or sends data over the internet"
- dangerous_system: "Modifies root files, changes permissions, executes unvetted scripts, or bypasses sandboxes"
```

### Pattern B: Projection Surface Selection

Use before calling `vak_render` to select the mathematically appropriate surface kind for a dataset:

```
Criteria:
- table: "Tabular dataset with more than 4 records or multiple text/numeric attributes suitable for sorting and paging"
- bar_chart: "Comparing discrete categorical quantities (e.g. revenue per region, memory per process)"
- line_chart: "Continuous sequential or chronological time-series data showing change over time"
- stat_metric: "Single or dual headline KPI numbers, counts, or vital status badges"
- form_input: "Interactive configuration requiring user input, parameters, or action buttons"
```

### Pattern C: Output & Acceptance Verification

Use before declaring a user request or complex task finished:

```
Criteria:
- criteria_satisfied: "All explicit user requirements are verified with concrete receipts and matching data"
- missing_evidence: "Action claimed in text but lacking execution receipts, file contents, or verifiable output"
- constraint_violation: "Output contradicts specified user rules, budgets, or formatting constraints"
- runtime_error: "Execution encountered permission rejection, network failure, or crash"
```

## 4. Calibrated Confidence Thresholds

Interpret probability scores deterministically:

- **$\ge 0.85$ (High Confidence)**: Proceed autonomously along the winning path.
- **$0.70 \le \text{Score} < 0.85$ (Moderate Confidence)**: Proceed with conservative defaults; if the action is mutating or egress-related, ask for user confirmation.
- **$< 0.70$ (Ambiguous / Low Confidence)**: Do NOT guess. Formulate a concise clarifying question to the user detailing the ambiguous options.

## 5. Skill Chaining

- **`code-review`**: Chain with `decision-eval` to classify finding severity (`critical`, `major`, `minor`, `nit`) deterministically.
- **`compare-options`**: Chain with `decision-eval` to score trade-offs against user constraints.
- **`interactive-ui` & `surface-design`**: Chain with `decision-eval` to pick optimal surface kinds and color tones (`neutral`, `info`, `success`, `warning`, `danger`).
- **`decision-chain`**: For multi-stage sequential decisions with conditional branching, chain with `decision-chain`.
