---
name: meal-plan
description: Use when the user wants meal ideas, a weekly menu, recipes from what they have, or a shopping list.
license: MIT
compatibility: Works with text chat, weekly meal matrices, shopping lists, and interactive recipe canvases.
metadata:
  author: nranjan2code
  version: "1.5"
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

## Health & Safety Guardrails

- **Culinary guidance**: Clarify that meal planning provides culinary inspiration, not clinical dietetics or medical nutrition therapy.
- **Allergen diligence**: Rigorously honor declared food allergies and flag potential cross-contamination risks or hidden allergen sources (e.g. gluten in standard soy sauce).
