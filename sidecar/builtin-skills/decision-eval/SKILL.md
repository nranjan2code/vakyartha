---
name: decision-eval
description: Use when evaluating discrete choices, verifying acceptance criteria, classifying data, or chaining multi-stage decisions.
license: MIT
compatibility: Works with text chat, tool calling, and structured evaluation tasks.
metadata:
  author: nranjan2code
  version: "1.0"
allowed-tools: use_skill
---

# Fast Decision Evaluation & Chaining

Provides high-speed System 1 decision scoring for discrete choices, criteria verification, and multi-stage classification using local decision models (d1-omni, laya).

## When to Use

1. **Option Scoring & Classification**:
   - Classifying code snippets into security categories (vulnerable, sanitized, unreviewed).
   - Evaluating user requests or generated outputs against acceptance criteria.
   - Deciding which visual surface kind (table, bar_chart, line_chart, form) best matches a dataset.
2. **Multi-Stage Decision Chaining**:
   - Chaining sequential decisions (Triage -> Operation -> Risk level -> Surface).
   - Fast probabilistic branching without generating speculative tokens.

## How to Apply

1. **Define Discrete Criteria**:
   - Provide explicit, mutually exclusive candidate choices with clear descriptions.
   - Example:
     - safe_read: "Does not modify or delete state; harmless inspection"
     - state_mutation: "Edits, updates, or writes files or databases"
     - external_egress: "Reaches out over the internet or sends data externally"
2. **Evaluate Calibrated Probability**:
   - Evaluate against the input state using single-pass probability scores.
   - If confidence is below 0.75, treat as ambiguous and default to asking the user or applying conservative safeguards.
