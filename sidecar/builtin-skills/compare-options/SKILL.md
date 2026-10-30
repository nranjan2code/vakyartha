---
name: compare-options
description: Use when the user is choosing between options, products, plans or approaches.
license: MIT
compatibility: Works with text chat, markdown tables, and interactive comparison canvases.
metadata:
  author: nranjan2code
  version: "1.5"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Structured Tradeoff & Options Comparison

Systematic evaluation framework for comparing products, frameworks, architecture choices, vendors and competing strategic approaches.

## Overview & Chaining

- **Purpose**: Use this skill when asked to evaluate alternatives, decide between competing options, weigh tradeoffs, or prepare an objective recommendation.
- **Skill chaining**:
  - Load `decision-eval` or `decision-chain` to objectively score candidate options and trade-offs against user constraints using the System 1 decision engine rather than generating speculative reasoning tokens.
  - Load `interactive-ui` when rendering an interactive comparison matrix, weighted scoring model, or bound criteria sliders.
  - The required `surface-design` skill governs table layout, comparison cards, typography and spoken harmony.
  - Load `research-brief` if comprehensive background investigation across external sources is needed before comparison.

## Comparison Methodology

1. **Define the candidate options**:
   - Establish comparable baselines across all alternatives (e.g. comparable product tiers, license models or release versions).
   - Ensure competing candidates are evaluated against the same standard.
2. **Establish explicit criteria**:
   - Determine the user's priorities, technical constraints, budget, timeline and must-have requirements.
   - Separate non-negotiable hard constraints from desirable nice-to-have preferences.
3. **Compile the objective feature matrix**:
   - Evaluate each option across identical criteria columns (e.g. Performance, Cost, Complexity, Ecosystem, Maintenance).
   - Ground entries in verified specifications, documented capabilities and checked pricing.
   - Explicitly mark absent or unverified information as `Unknown`; never assume an unmentioned capability exists.
4. **Analyze tradeoffs & risks**:
   - Highlight the decisive pros and cons of each alternative.
   - Explain what is sacrificed when selecting one option over another (e.g. trading off ease of setup for long-term scalability).
5. **Provide a reasoned recommendation**:
   - Recommend a specific path if requested, clearly linking the choice to the user's stated priorities.
   - Outline alternative scenarios where a secondary option would be preferred.

## Objectivity & Styling Guardrails

- **Zero bias**: Treat all candidates with equal analytical rigor. Do not write dismissive assessments of viable alternatives.
- **Fact vs opinion**: Distinguish verified benchmarks and official limits from marketing claims or community sentiment.
