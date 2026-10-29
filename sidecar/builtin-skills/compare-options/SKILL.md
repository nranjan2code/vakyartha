---
name: compare-options
description: Use when the user is choosing between options, products, plans or approaches.
license: MIT
compatibility: Works with text chat, markdown tables, and interactive comparison canvases.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Structured Tradeoff & Options Comparison

Systematic evaluation framework for comparing products, frameworks, architecture choices, vendors and competing strategic approaches.

## Overview & Chaining

- **Purpose**: Use this skill when asked to evaluate alternatives, decide between competing options, weigh tradeoffs, or prepare an objective recommendation.
- **Skill chaining**:
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

## Liquid Canvas Architecture for Option Comparisons

Choose a content-driven composition with the shared `surface-design` guidance. A single column or a full-width analytical panel can be appropriate. The following are optional patterns; include only sections and indicators that answer the requested question, with no required tier or column count:

1. **Recommendation Header & Decision Score Strip**:
   - **Spoken lead**: 1–2 sentences naming the recommended option, key rationale, and primary trade-off so audio briefings are instant.
   - **Scorecard grid**: 3-column or 4-column metric strip (`grid` with `props: { columns: 3, minItemWidth: "xs" }`):
     - `Top Recommendation`: e.g. "Option A (PostgreSQL)" (`tone: "positive"`)
     - `Est. Cost Delta`: e.g. "-$420 / mo" (`tone: "positive"`)
     - `Implementation Effort`: e.g. "Medium (2 weeks)" (`tone: "neutral"`)
2. **Balanced Multi-Column Candidate Grid**:
   - Fluid candidate grid (`grid` with `props: { columns: 3, minItemWidth: "sm" }` or `columns: 2` for two candidates):
     - Each candidate receives a balanced card (`card` with `props: { maxWidth: "md" }`) highlighting:
       - Candidate Name & Badge (e.g. `tone: "positive"` for "Recommended", `"neutral"` for "Alternative")
       - Primary Strengths (bullet points)
       - Key Limitations / Trade-offs
       - Pricing / Cost Tier
     - Cards remain balanced within the fluid grid tracks; never let an individual candidate card span 100% of the canvas.
3. **Granular Feature Matrix & Trade-off Scoring**:
   - **Feature Matrix Table**: Dense data table (`section` with `table`, `maxWidth: "full"`):
     - Columns: `Criterion / Capability`, `Option A`, `Option B`, `Option C`, `Evaluation / Winner`.
   - **Score Comparison Visual**: Clamped horizontal bar chart (`chart` with `props: { kind: "bar", maxWidth: "md" }`) comparing overall suitability scores, or paired with a criteria weight adjustment form (`form` with `maxWidth: "md"`).

## Objectivity & Styling Guardrails

- **Zero bias**: Treat all candidates with equal analytical rigor. Do not write dismissive assessments of viable alternatives.
- **Fact vs opinion**: Distinguish verified benchmarks and official limits from marketing claims or community sentiment.
- **Tone & Style**: Never inject raw CSS or hex codes; use semantic tones (`positive` for recommended/winning, `caution` for elevated risk or cost, `neutral` for baseline).
