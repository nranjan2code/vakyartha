---
name: daily-news
description: Prepare a current daily news digest or headline dashboard for a selected date, region and topics using accessible sources.
license: MIT
compatibility: Works with text summaries, news readers, web search tools, and interactive digest canvases.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: read_skill_file use_skill
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

## Digest Structure & Layout

Organize the news digest for rapid scanning:

1. **Executive Briefing**:
   - 2–3 sentences summarizing the dominant stories of the day and their immediate global or industry significance.
2. **Top Stories by Category**:
   - Group stories under logical headers (e.g. `Technology & AI`, `Business & Markets`, `Science & Health`, `Global Affairs`).
   - Format each news item with:
     - **Headline**: Clear, objective title without sensationalist clickbait.
     - **Timestamp & Attribution**: Named publisher (e.g. *The Financial Times*, *Reuters*, *Nature*) and publication date.
     - **Summary**: 2–3 sentences detailing what occurred, key numbers, and the confirmed outcome.
     - **Why It Matters**: Concise sentence on the operational or strategic significance.
3. **Open Questions & Developing Elements**:
   - Note developing situations where key facts remain unconfirmed pending official investigation.

## Dual Spoken & Visual Projection

- **Spoken audio harmony**: In spoken projections, refer to publishers by natural names (e.g. "According to the Associated Press...") rather than reciting raw HTTP URLs.
- **Top headline clarity**: Ensure that the first sentence of the digest functions as a standalone, clear audio news flash when read aloud.

## System Boundaries & Transparency

- **Freshness disclosure**: State the retrieval date and time explicitly at the top of the digest.
- **Static vs Live**: Clarify that a rendered digest reflects the news at the moment of generation; it is not a continuously updating live ticker unless linked to real-time integration tools.
