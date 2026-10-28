---
name: trip-planner
description: Use when the user plans a trip, holiday, outing or itinerary.
license: MIT
compatibility: Works with text chat, itinerary tables, travel budgets, and interactive trip canvases.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit use_skill
---

# Trip & Travel Itinerary Planning

Methodology for designing practical, well-paced travel itineraries, vacation schedules and trip logistics.

## Overview & Chaining

- **Purpose**: Use this skill when asked to plan a vacation, design a city break itinerary, organize day trips, or coordinate travel logistics.
- **Skill chaining**:
  - Load `interactive-ui` when rendering an interactive day-by-day travel itinerary with editable plans.
  - The required `surface-design` skill governs schedule tables, attraction cards, map/location layouts and spoken briefings.
  - Load `budget-helper` when the user requires detailed travel expense tracking, cost category allocation and currency conversions.

## Travel Planning Methodology

1. **Clarify travel parameters**:
   - Establish destination, dates/season, trip duration, origin, and party composition (solo, couple, family with children, group of friends).
   - Identify travel style (budget, mid-range, luxury, cultural, adventure, relaxation) and any physical mobility or dietary constraints.
2. **Geographic clustering**:
   - Group attractions and activities by neighborhood, district or geographic corridor to minimize transit time and backtracking.
   - Account for transit connections between cities, airports and accommodations.
3. **Pacing & Realistic buffering**:
   - Limit major activities to 2–3 per day to prevent traveler burnout.
   - Allocate realistic transit buffers, meal times, and spontaneous exploration.
   - Account for arrival exhaustion, jet lag and departure logistics.
4. **Logistics & Practical requirements**:
   - Note key operational details: typical museum closing days (e.g. Mondays in Europe), advance ticket booking requirements, seasonal weather, and local transit passes.
   - Provide rainy-day indoor alternatives for outdoor attractions.

## Adaptive Itinerary Canvas Layout

Never stretch simple travel checklists or short schedules across 100% of a wide desktop canvas. Structure the itinerary adaptively:

1. **Trip Overview & Metric Strip**:
   - Lead with destination, dates, party size, and pacing style.
   - Follow with a fluid `grid` (`props: { columns: 4, minItemWidth: "sm" }`):
     - Total Days.
     - Major Cities / Bases.
     - Planned Highlights / Key Bookings.
     - Estimated Trip Budget (per person or total).
2. **Day-by-Day Itinerary Tier**:
   - Render a structured table in a clean `section` (`props: { title: "Day-by-Day Schedule & Route" }`). Table uses `maxWidth: "full"` with columns: `Day / Date`, `Neighborhood / Area`, `Morning Activity`, `Afternoon Activity`, `Evening & Dining`.
   - Alternatively, for weekend getaways (2–3 days), use a 2- or 3-column `grid` with daily cards (`maxWidth: "lg"`).
3. **Logistics & Pre-Trip Checklist**:
   - Render pre-departure preparations (passports, transit passes, bookings, packing essentials) inside a clamped container (`maxWidth: "md"`, 720px) with interactive checkboxes (`bind: "/checklist/0/done"`).

## Style & Theming Guide

- **Semantic Tones**: Use `tone: "info"` for transit/flight details; `tone: "success"` for confirmed bookings; `tone: "warning"` for advance reservation alerts or visa deadlines. Never use raw hex codes or inline CSS.
- **Dual Projection**: Lead with a concise 1–2 sentence finding stating destination, travel dates, and the trip's geographic anchors. Spoken gist mode reads this first sentence in isolation.

## Truthfulness & Booking Guardrails

- **Estimate transparency**: Clearly distinguish estimated costs and typical prices from live, verified quotes or seasonal surge rates.
- **No phantom bookings**: Generating an itinerary does not book flights, reserve hotel rooms, purchase transit tickets, or schedule tours.
- **Live information verification**: Recommend checking official venue websites for current opening hours, seasonal closures, and construction detours before traveling.
