---
name: daily-news
description: Prepare a current daily news digest or headline dashboard for a selected date, region and topics using accessible sources.
license: MIT
compatibility: Works with text summaries, news readers, web search tools, and interactive digest canvases.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# Daily News Digest & Headline Reviews

Methodology for compiling accurate, sourced daily news digests, executive media briefings and topic-focused headline roundups.

## Overview & Chaining

- **Purpose**: Use this skill when asked to summarize today's news, compile a morning briefing on a specific industry, or produce an interactive headline dashboard.
- **Skill chaining**:
  - Load `research-brief` when a specific developing news story requires in-depth multi-source investigation and evidence analysis.
  - Load `interactive-ui` when an interactive news canvas with topic tabs or source filters is requested.
  - The required `surface-design` skill governs card layout, source typography and spoken audio briefings.

## News Gathering & Source Discipline

1. **Verify temporal & regional context**:
   - Establish the exact date, target region and topics from the request.
   - Use offered web search or reader tools to retrieve live reporting. If live search tools are unavailable, clearly state that real-time news cannot be retrieved and operate solely from supplied text.
   - **Critical rule**: Never invent headlines, quote fabricated press releases, or synthesize current events from model training memory.
2. **Deduplication & Event clustering**:
   - Cluster multiple reports covering the same underlying event into a single cohesive story item.
   - Note when differing outlets report conflicting details (e.g. differing casualty figures or financial estimates).
3. **Temporal separation**:
   - Differentiate the **event occurrence time**, the **article publication timestamp**, and the **retrieval timestamp**.
4. **Classification discipline**:
   - Clearly delineate verified factual developments from corporate announcements, speculative rumors, and opinion/editorial commentary.

## Liquid Canvas Architecture for News Digests

Choose a content-driven composition with the shared `surface-design` guidance. A single column or a full-width analytical panel can be appropriate. The following are optional patterns; include only sections and indicators that answer the requested question, with no required tier or column count:

1. **Morning Briefing Headline & 3-Column Scope Strip**:
   - **Spoken lead**: 1–2 sentences clearly summarizing the leading headline of the day so audio speech is immediate.
   - **Coverage metrics**: 3-column metric strip (`grid` with `props: { columns: 3, minItemWidth: "xs" }`):
     - `Stories Covered`: e.g. "8 key stories"
     - `Publishers Cited`: e.g. "FT, Reuters, Nature"
     - `Retrieval Freshness`: e.g. "Oct 28, 2026 · 08:30 UTC"
2. **Fluid Multi-Column Topic Grid**:
   - Fluid news grid (`grid` with `props: { columns: 3, minItemWidth: "sm" }` or `columns: 2` on narrower containers):
     - Each news item is formatted as a structured card (`card` with `props: { maxWidth: "md" }`):
       - Category badge (e.g. `tone: "neutral"`)
       - Headline (`subheading`)
       - Publisher & Timestamp (`caption`)
       - Core Story Summary (2–3 sentences)
       - Why It Matters (`text`)
     - Cards tile cleanly in multi-column rows without stretched single-column bloat.
3. **Granular Event Timeline & Source Attribution Table**:
   - **Timeline Table**: Chronological table (`section` with `table`, `maxWidth: "full"`):
     - Columns: `Time (UTC)`, `Topic`, `Headline`, `Publisher`, `Status`.

## Dual Spoken & Visual Projection

- **Spoken audio harmony**: In spoken projections, refer to publishers by natural names (e.g. "According to the Associated Press...") rather than reciting raw HTTP URLs.
- **Top headline clarity**: Ensure that the first sentence of the digest functions as a standalone, clear audio news flash when read aloud.
- **Tone & Style**: Never inject raw CSS or hex codes; use semantic tones (`positive` for confirmed resolutions, `caution` for developing/unverified stories, `critical` for urgent security/breaking events).
