---
name: meal-plan
description: Use when the user wants meal ideas, a weekly menu, recipes from what they have, or a shopping list.
license: MIT
compatibility: Works with text chat, weekly meal matrices, shopping lists, and interactive recipe canvases.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Meal Planning & Recipe Coordination

Systematic culinary framework for designing balanced weekly meal plans, pantry-driven recipes and organized grocery shopping lists.

## Overview & Chaining

- **Purpose**: Use this skill when asked to plan meals for the week, invent recipes using on-hand ingredients, reduce food waste, or generate an organized shopping list.
- **Skill chaining**:
  - Load `interactive-ui` when rendering an interactive weekly meal matrix with recipe details and interactive grocery checklists.
  - The required `surface-design` skill governs schedule grids, recipe cards, shopping tables and spoken audio briefings.
  - Load `budget-helper` when planning meals strictly within a constrained grocery budget or tracking per-meal costs.

## Meal Planning Methodology

1. **Establish dietary & lifestyle parameters**:
   - Clarify dietary requirements (vegetarian, vegan, gluten-free, low-carb, dairy-free, kosher, halal).
   - Identify critical allergies (peanuts, tree nuts, shellfish, soy, eggs, sesame).
   - Determine number of people/servings, available cooking equipment (oven, stovetop, air fryer, slow cooker), and time constraints for weeknight prep (e.g. $<30$ minutes).
2. **Ingredient cross-utilization**:
   - Design meals that reuse perishable fresh produce, herbs, and proteins across multiple dishes to minimize food waste and shopping costs.
   - Plan intentional leftovers (e.g. roasting extra chicken or vegetables on Sunday for Monday lunch).
3. **Pantry separation**:
   - Clearly delineate ingredients the user **already has on hand** from ingredients that **must be purchased**.
   - Do not assume exotic or expensive specialty spices exist unless confirmed by the user.
4. **Prep rhythm**:
   - Schedule faster, low-effort meals on busy weekdays and reserve more involved culinary projects for weekends.

## Liquid Canvas Architecture & Shopping Surfaces

Never stretch single recipe cards, short shopping lists, or simple meal cards across 100% of a wide canvas. Structure the meal planning canvas into three adaptive tiers:

1. **Tier 1: Weekly Overview Strip & Spoken Lead**:
   - Lead with a clear 1–2 sentence spoken summary naming the schedule cadence, dietary adherence, and total active prep time so voice projection is immediate.
   - 4-column metric strip (`grid` with `props: { columns: 4, minItemWidth: "xs" }`):
     - `Planned Meals`: e.g. "21 meals (7 days)"
     - `Est. Active Prep`: e.g. "5.5 hrs total"
     - `Grocery Items`: e.g. "28 items needed"
     - `Dietary Target`: e.g. "100% Gluten-Free" with semantic `tone: "positive"`

2. **Tier 2: Paired Weekly Matrix & Recipe Detail**:
   - Dual split layout (`split` with `props: { ratio: [2, 1] }`) or paired 2-column grid (`grid` with `props: { columns: 2, minItemWidth: "sm" }`):
     - **Left / Primary**: 7-Day Menu Matrix (`section` with `table`, `maxWidth: "full"`, columns for `Day`, `Breakfast`, `Lunch`, `Dinner`, and `Prep Time`).
     - **Right / Detail**: Clamped Recipe Highlight Card (`card` with `maxWidth: "md"`, detailing ingredients, prep steps, cooking time, dietary tags, and difficulty).

3. **Tier 3: Categorized Grocery Checklist & Prep Actions**:
   - Sectioned shopping list organized by standard supermarket aisles (`Fresh Produce`, `Proteins`, `Dairy / Refrigerated`, `Pantry Staples`, `Spices`).
   - Interactive bound checkboxes (`checkbox`, `bind: "/groceries/0/checked"`) for live shopping completion.
   - Clamped Quick-Add / Substitution Form (`form` with `maxWidth: "md"`).

## Health & Safety Guardrails

- **Culinary guidance**: Clarify that meal planning provides culinary inspiration, not clinical dietetics or medical nutrition therapy.
- **Allergen diligence**: Rigorously honor declared food allergies and flag potential cross-contamination risks or hidden allergen sources (e.g. gluten in standard soy sauce).
- **Tone & Style**: Never use raw CSS or hex values; use semantic tones (`positive` for compliant, `caution` for allergens or perishables).
