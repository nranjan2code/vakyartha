---
name: write-article
description: Author, structure, and polish long-form articles, news analyses, investigative essays, whitepapers, guides, feature stories, or digital publications with rich Canvas layouts, media, and source citations.
license: MIT
compatibility: Works across text chat, long-form canvas surfaces, media attachments, and voice projection.
metadata:
  author: nranjan2code
  version: "1.0"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# Long-Form Article & Publication Authoring

Comprehensive, domain-neutral methodology for drafting, structuring, and polishing publication-grade articles, essays, investigative reports, technical guides, whitepapers, and digital features on the Canvas.

## Overview & Skill Chaining

- **Purpose**: Use this skill when asked to write, draft, adapt, or structure an article, analysis, long-form essay, opinion piece, whitepaper, guide, newsletter post, or feature story.
- **Skill chaining**:
  - The required `surface-design` skill governs typography hierarchy, responsive container clamping (`maxWidth: "md"` or `"lg"`), card structure, and dual visual/spoken presentation.
  - Load `interactive-ui` via `use_skill` when the article includes interactive controls: section tabs (`tabs`), filterable comparison tables (`table`), or feedback buttons.
  - Load `research-brief` via `use_skill` when investigating complex topics, sourcing literature, or building an evidence matrix.
  - Load `daily-news` via `use_skill` when composing news-driven analyses, daily roundups, or timely event explainers.
  - Load `compare-options` via `use_skill` when authoring comparative reviews, product evaluations, or multi-option analyses.
  - Load `data-review` via `use_skill` when the article centers on empirical datasets or tabular statistics.
  - Load `explain-simply` via `use_skill` when translating dense technical, financial, or academic concepts for a general audience.
- **Reference files**:
  - Read `references/article-archetypes.md` via `read_skill_file` for structural patterns across journalism, essays, whitepapers, tutorials, and newsletters.
  - Read `references/article-surface-templates.json` via `read_skill_file` for validated Projection surface schemas across standard, split, and tabbed canvas layouts.

## Core Editorial Craft & Structural Disciplines

Every article must follow a deliberate architecture calibrated to its format:

1. **Headline & Subtitle (The Hook & Promise)**:
   - **Headline**: Informative, specific, and engaging without deceptive clickbait. Clearly signal the subject and primary insight.
   - **Deck / Subtitle**: 1–2 sentences summarizing the central premise, context, or consequence.
   - **Byline & Metadata**: Explicitly state publication date, estimated reading time (e.g. `6 min read`), topic tags, and author/source attribution.
2. **Executive Takeaways / Key Points**:
   - Provide an upfront "At a Glance" or "Key Takeaways" callout (`alert` with tone `info` or a compact summary card) containing 3–4 bulleted core insights. This enables executive scanning before deep reading.
3. **Structured Body & Section Pacing**:
   - Organize into logical sections (`section` containers or distinct markdown headings) with clear thematic focus.
   - Break up dense prose: keep paragraphs between 2–4 sentences.
   - Use pull-quotes (`text` with `variant: "quote"`) for poignant statements, central theses, or notable quotes.
   - Ground quantitative arguments in visible data anchors: stat highlights (`stat`), trend indicators, or clean comparative tables.
4. **Counterpoint, Nuance & Analytical Balance**:
   - Address counter-arguments, dissenting data points, limitations, or alternative interpretations.
   - Differentiate verified empirical facts from corporate announcements, analyst projections, and editorial opinions.
5. **Synthesis & Outlook**:
   - Conclude with a forward-looking synthesis, strategic takeaway, or actionable summary rather than merely restating previous sentences.

## Media, Imagery & Visual Embeddings

When visual or multimedia context enhances the article:

1. **Hero Visuals**: Place a high-quality hero image or media banner directly beneath the headline and byline using an `image` node (`props: { src, alt }`) or `media` node (`props: { kind: "image", uri, description, caption }`).
2. **Inline Figures & Visual Breakouts**:
   - Embed charts (`chart`), architecture diagrams, or focused figures between narrative sections to illustrate specific claims.
   - Always supply descriptive `alt` text and an explicit caption or credit.
3. **Galleries & Photo Essays**:
   - Use `gallery` nodes (`props: { images: [{ src, alt }] }`) for multi-image comparisons, photo journalism, or visual step-by-step examples.
4. **Audio & Narration Players**:
   - When accompanying the article with spoken narration, podcast excerpts, or interviews, integrate a `media` node (`props: { kind: "audio", uri, description }`).
5. **Security & Media Bounds**:
   - Media references must use secure public URLs (`https://`) or verified local media asset paths (`/media/...`). Never expose credentials, local file system paths, or unverified download scripts.

## Canvas Layout Architecture & Dual Projection

Articles must never be dumped as monolithic plain text into the chat scroll. Apply Vakyartha's placement and projection rules:

1. **Canvas Placement**:
   - Long reads (exceeding 1,500 characters) belong on the Canvas.
   - Author the complete article as a Projection surface using `vak_render`.
   - In the chat thread, provide only a concise companion card: headline, reading time, thesis statement, 2–3 sentence executive summary, and key takeaways.
2. **Responsive Measure Clamping**:
   - Prose must never stretch 100% across wide desktop monitors.
   - Always clamp the outer article stack or reading column to `maxWidth: "lg"` (960px) or `maxWidth: "md"` (720px) to preserve comfortable typographic measure (60–80 characters per line).
3. **Canvas Surface Composition Archetypes**:
   - **Standard Editorial Stack**: Outer `stack` (`maxWidth: "lg"`) containing Headline (`headline`), Deck (`lead`), Metadata bar, Hero image/media, Takeaways `alert`, sequential `section` nodes with body prose and pull-quotes, and a Sources footer.
   - **Split Analytical Layout**: A `split` container (`ratio: [2, 1]`) with the main article prose in the 2/3 primary column, and the 1/3 sidebar containing key statistics (`stat`), author notes, glossary, and reference links.
   - **Tabbed Multi-Chapter Layout**: A `tabs` container for comprehensive whitepapers, investigative series, or technical guides (e.g., `Overview`, `Deep Dive`, `Data & Sources`, `Conclusions`).
4. **Dual Projection (Voice & Spoken Audio)**:
   - Voice audio projects the headline, deck, and executive takeaways as an executive audio briefing.
   - Audio projections omit raw URLs, markdown footnote numbers, and tabular data rows, ensuring natural speech synthesis.

## Sourcing, Fact Discipline & Ethics

1. **Temporal Context**: Explicitly date the article, the events described, and source retrieval times.
2. **Direct Attribution**: Attribute quotes, figures, and proprietary claims to named sources with accessible hyperlinks where available.
3. **No Fabricated Facts**: Never invent sources, statistics, dates, or quotations. If a data point is unverified or unavailable, state the limitation openly.
