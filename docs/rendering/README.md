# Universal Rendering Architecture: Surfaces, Canvas & Projections

This directory contains the comprehensive technical architecture specification for Vakyartha and the Projection framework's universal rendering subsystem:

* **[END-TO-END-ARCHITECTURE.md](END-TO-END-ARCHITECTURE.md)**: The definitive engineering document detailing:
  1. **Executive Summary & Architectural Axioms:** The "Ask any model, get an interface" paradigm, canonical AST state decoupling, universal multi-surface parity, and zero-token client recalculation.
  2. **Runtime Taxonomy & Boundary Responsibilities:** The three runtime realms (WebKit Desktop Shell, Native Rust Host, and Node 24 LTS Engine Sidecar) governed by private anonymous stdio pipes (ADR-044).
  3. **The Canonical Surface AST & Data Model:** Formal TypeScript schema, typed node taxonomy (Metrics/KPIs, Tables with auto-alignment, 8 SVG chart families, 2-way reactive forms, complex workspaces, and structural containers), and the canonical `SurfaceStore`.
  4. **End-to-End Rendering Pipeline:** Sequence and architecture flows from model token emission to Web Component mounting, local sorting/filtering, and action event dispatch.
  5. **Canvas Placement Engine & Liquid Layout Mechanics:** Deterministic placement heuristics (`src/placement.ts`), chat thread reference cards, and the 3-Tier liquid layout hierarchy driven by CSS Container Queries (`container-type: inline-size`).
  6. **Web Component Architecture (`<vak-surface>`) & Shadow DOM Styling:** Encapsulated Shadow DOM lifecycle, token inheritance, the responsive font-scaling bridge (`--vak-font-size: var(--base)`), 6 enterprise theme palettes, and automated numeric column alignment.
  7. **Multi-Surface Projection Engines:** Channel lowering and degradation algorithms across Telegram (Bot API 10.3 drafts & compact tables), Slack (Block Kit 2026 table blocks & modals), Discord (Components V2 container primitives & monospace tables), and Voice (SSML delta narration & spoken Q&A flows).
  8. **Extended Canvas Ecosystem:** Seamless integration with Sandboxed Dynamic Micro-Apps (`docs/sandboxed-apps/`), Skill Studio visual authoring, and media player projections.
  9. **State Synchronization & Event Lifecycle:** Reactive 2-way bindings, active input focus preservation during live streaming, and `vak-action` event bubbling.
  10. **Zero-Trust Security & Verification Gates:** Strict CSP, loopback-only connections, sandboxed file exports (`save_canvas`), and the mandatory 6-step regression verification test suite.

---

## Key Source Files in the Rendering Pipeline

### 1. Framework Tier (`framework/packages/`)
- [`framework/packages/core/src/surface.ts`](../../framework/packages/core/src/surface.ts): Core Surface AST schemas, type definitions, and validator.
- [`framework/packages/web/src/surface-element.ts`](../../framework/packages/web/src/surface-element.ts): `<vak-surface>` Custom Element implementation, Shadow DOM lifecycle, auto-alignment pass, and SVG chart renderers.
- [`framework/packages/web/src/styles.ts`](../../framework/packages/web/src/styles.ts): Encapsulated component styles, container query rules, and CSS custom property token mappings.
- [`framework/packages/telegram/src/project.ts`](../../framework/packages/telegram/src/project.ts): Telegram Bot API 10.3 projector and priority lowering.
- [`framework/packages/slack/src/project.ts`](../../framework/packages/slack/src/project.ts): Slack Block Kit 2026 projector and modal dialogue builder.
- [`framework/packages/discord/src/project.ts`](../../framework/packages/discord/src/project.ts): Discord Components V2 container projector.

### 2. Application Tier (`src/`, `src-tauri/`, `sidecar/`)
- [`src/canvas.ts`](../../src/canvas.ts): Desktop Canvas shell orchestrator, view modes (Preview/Text/Markdown), picker, and history stack.
- [`src/placement.ts`](../../src/placement.ts): Sizing thresholds and automatic thread vs. canvas placement engine.
- [`src/app.css`](../../src/app.css): Application design tokens, theme palette series (`--vak-series-1..6`), and the `--vak-font-size: var(--base)` responsive bridge.
- [`src/voice/read-aloud.ts`](../../src/voice/read-aloud.ts): Spoken voice projection, KPI narration, and speech synthesizer.
- [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs): Native Markdown canvas export (`save_canvas`).
- [`framework/packages/core/src/surface.ts`](../../framework/packages/core/src/surface.ts): Canonical in-memory `SurfaceStore`; framework host/session ownership governs persistence, not a separate app surface store.

### 3. Automated Verification Suites
- [`scripts/canvas-check.ts`](../../scripts/canvas-check.ts): WebKit smoke check validating 14 interactive canvas steps across desktop (1100px) and mobile (620px) viewports.
- [`scripts/surface-design-check.ts`](../../scripts/surface-design-check.ts): Multi-viewport validation of mixed 3-tier liquid layouts and all 8 SVG chart types.
- [`scripts/skills-check.ts`](../../scripts/skills-check.ts): Verification of reviewed built-in skills, theme consistency, and responsive layouts.

