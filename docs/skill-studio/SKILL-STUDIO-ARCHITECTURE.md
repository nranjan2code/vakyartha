# Vakyartha Creator Studio: Architecture, UX, and Lifecycle Specification

The **Creator Studio** (`src/skills-studio.ts`) is Vakyartha's integrated development environment and visual workbench for authoring, orchestrating, and testing **Agent Skills packages** and **Sandboxed Dynamic Applications** (`app.json`, `server.ts`, `surface.json`).

---

## 1. System Overview & Core Pillars

In Vakyartha, skills and sandboxed apps are self-contained packages of instructions, schemas, executable handlers, and references that govern how the assistant understands domain procedures, chains capabilities, executes in Seatbelt sandboxes, binds canonical data, and projects reactive visual Canvas interfaces and spoken voice audio.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         VAKYARTHA CREATOR STUDIO                                       │
├───────────────────┬───────────────────┬───────────────────┬───────────────────┬────────────────────────┤
│ 1. Studio Hub &   │ 2. Spec & Code    │ 3. Interactive    │ 4. Responsive     │ 5. Governed            │
│    App Catalog    │    Editor         │    Flow DAG       │    Canvas Stage   │    vak-sandbox         │
└───────────────────┴───────────────────┴───────────────────┴───────────────────┴────────────────────────┘
```

1. **Unified Creator Hub & App Support**: Directly accessible from the sidebar (`✨ Studio`) and Settings. Manages both multi-file Agent Skills packages and Sandboxed Dynamic Applications with filter tabs (`All`, `Skills`, `Sandboxed Apps`, `Drafts`), search, and dedicated creation actions (`+ New Skill`, `+ New Sandboxed App`).
2. **Non-Destructive Multitasking & Continuous Auto-Save**: Seamlessly switch between active package editing and ongoing chat turns or New Chat without losing uncommitted state, open files, active tabs, or cursor position. Skill edits auto-save under `<dataDir>/skills/.drafts/<name>/`; app edits use inert `<dataDir>/app-drafts/<id>.json` records.
3. **Interactive Flow DAG (Directed Acyclic Graph)**: A native SVG-rendered visual dependency and execution graph illustrating the end-to-end pipeline from user intent through selection gates, capability boundaries, canonical stores, canvas surfaces, and voice projections.
4. **Responsive Canvas Staging & Linter**: Fluid container query testing (`320px`, `720px`, `960px`, `100% Fluid`) mounting live `<vak-surface>` Web Components with real package fixtures, layout compliance linting, and Dual Spoken Voice TTS auditioning.
5. **Governed Sandbox (`vak-sandbox`) Rehearsal**: Skill scripts use saved-source SHA-256 verification; app drafts use their exact package fingerprint. Both use bounded supervised execution. App rehearsal has no external-tool authority and does not commit live app state. Skill selection evaluation remains a separate `/api/skills/eval` operation.

---

## 2. Workbench Architecture & Navigation

### 2.1 The Studio Hub (Landing Overview)
Clicking `✨ Studio` in the sidebar lands on the Studio Hub. It displays installed capabilities, working drafts, and metadata:
- **Header**: Title, description, quick creation actions (`+ New Skill`, `+ New Sandboxed App`), and back-to-chat button.
- **Working Drafts Banner**: Automatically detects uncommitted working drafts across all packages with a one-click resumption shortcut.
- **Filter Row**: Quick filters (`All`, `Skills`, `Sandboxed Apps`, `Drafts`) and live search filtering.
- **Card Grid**: Responsive cards showing icons, versions, descriptions, `Built in` / `Yours`, `On` / `Off`, `Draft` / `Published`, and allowed tools.

### 2.2 The 2-Pane Editor Workbench
Opening any skill or application presents a clean, focused workbench:
- **Header Bar**: `← Studio Hub` button, item identifier, type pill (`Skill` / `Sandboxed App`), draft status pill, view switcher segmented control (`Spec & Code`, `Flow DAG`, `Live Preview`, `Sandbox & Tests`), and actions (`Discard Draft`, `Save Draft`, `Publish Skill` / `Publish App`, plus `Build with chat` for apps).
- **Left Rail (Package Explorer & Capabilities)**:
  - Multi-file package tree (`SKILL.md` or `app.json`, `surface.json`, `server.ts`, schemas, scripts, references).
  - Add File (`+`) and Delete File (`×`) controls with safe relative path enforcement.
  - Active capabilities card: allowed MCP tools for skills, and declared runtime settings and tool requirements for apps. CPU/RSS/storage fields are not enforced quotas; consult the app runtime contract.
- **Center Canvas**: Switches dynamically based on the active tab:
  1. **Spec & Code**: Vertical stacked form fields (name, description with live 1024-character counter, allowed tools tokens) and tab-indented monospace code editor.
  2. **Flow DAG**: Interactive visual SVG graph showing the complete pipeline.
  3. **Live Preview**: Responsive container stage with live canvas mount, surface linter, and voice TTS player.
  4. **Sandbox & Tests**: Disposable script rehearsal terminal and prompt selection gate verifier.

---

## 3. The Interactive Flow DAG Engine

Both skills and sandboxed applications are modeled as directed acyclic execution graphs:

```mermaid
flowchart LR
  subgraph SkillFlow["Skill Execution & Projection DAG"]
    Prompt["User Prompt\n(Semantic Intent)"] --> Gate["use_skill Gate\n(Model Selection)"]
    Gate --> Tools["Allowed Tools\n(read_skill_file / sandbox)"]
    Gate --> Chain["Chained Procedures\n(interactive-ui)"]
    Tools --> Store["Canonical Store\n(/records)"]
    Chain --> Store
    Store --> Surface["3-Tier Canvas Surface\n(Liquid Layout)"]
    Surface --> Voice["Dual Spoken Projection\n(TTS Audio)"]
  end
```

```mermaid
flowchart LR
  subgraph AppFlow["Sandboxed Dynamic App DAG"]
    Trigger["Cron / Action Trigger\n(Scheduled / Click)"] --> Worker["Sandboxed Worker\n(server.ts / Node 24)"]
    Worker --> Storage["Host-owned canonical JSON state"]
    Storage --> Canvas["Canvas Mount\n(surface.json)"]
  end
```

### Node Features & Interactive Authoring:
- **Clean SVG Cubic Bezier Connectors**: Smooth vector paths with directional arrowheads connecting nodes.
- **Status Badges & Icons**: Clear capability markers (`Trigger`, `Gate`, `Sandbox`, `Data`, `Visual`, `Spoken`).
- **Interactive Node Inspector**: Clicking any node opens the inspector drawer revealing the exact frontmatter, manifest constraints, or prompt match criteria governing that stage.
- **Cross-Screen Deep Links**: Node inspector actions (`✏️ Jump to Spec & Code`, `👁️ Preview in Canvas`, `🧪 Rehearse in Sandbox`) enable immediate navigation with targeted element focus.
- **DAG Direct Authoring Actions**:
  - `+ Add Tool`: Prompts for a tool name, validates it, appends it to `allowed-tools` in frontmatter, and updates DAG/Spec.
  - `+ Add Chained Skill`: Prompts for a target skill, embeds procedure linkage in `SKILL.md`, and redraws chained edges.
  - `+ Add Procedural Step`: Appends a structured operational stage (`## Step N: ...`) to the instructions.
  - Edits follow the selected package owner: skill draft directories or inert app draft records. Neither save publishes executable app code.

---

## 4. Multi-Tab Multitasking & Continuous Auto-Save

Authors frequently switch between authoring capabilities and running live chat turns:
1. **Debounced Background Auto-Save**: Editor changes trigger debounced saves to the selected package owner: `PUT /api/skills/:name/draft` for skills, `PUT /api/apps/:id/draft` for apps. App saves carry current draft/base fingerprints and retain incomplete source.
2. **Instant Tab Switching**: Switching to **New chat** or an existing conversation hides the Studio view non-destructively. All in-memory state, open files, active tabs, and breakpoints remain preserved.
3. **Seamless Resumption**: Clicking `✨ Studio` restores the active working stage instantly with zero reload latency or cursor reset.
4. **Draft Quarantine Invariant**: Skill discovery uses published instructions. App execution uses published packages; model writes request approval to stage inert app drafts, and Studio publication checks exact fingerprints. Canvas drafts retain source-chat lineage; Build with chat prepares an editable composer request there.

---

## 5. Visual Canvas & UI Layout Engine

The app owns where an interface is shown (`src/canvas.ts` and `src/placement.ts`). In Studio, authors can visually assemble, arrange, bind, and stress-test layouts:

### 5.1 The 3-Tier Liquid Layout Architecture
1. **Tier 1 (Executive Summary)**: Headline section & 4-column KPI metric strip (`columns: 4, minItemWidth: "sm"`).
2. **Tier 2 (Analytical Core)**: 2-column grid or proportional split (`split` with `ratio: [2, 1]`) pairing a primary trend chart with distribution.
3. **Tier 3 (Granular Details & Actions)**: Full-width dense detail table (`maxWidth: "full"`) and bounded action forms (`maxWidth: "md"`).

### 5.2 Container Query Viewports
The Studio toolbar features responsive container query toggles:
- **`320px` (Mobile)**: Simulates mobile view, sidebar popover, or Telegram inline widget.
- **`720px` (Form / Tablet)**: Clamped measure for forms and focal charts.
- **`960px` (Desktop)**: Standard analytics grid measure.
- **`100% Fluid`**: Dense tables expand across the entire monitor, while single charts stay cleanly clamped.

### 5.3 Surface Design Linter
Real-time linting catches design violations:
- **Aspect Ratio Distortion**: Flags single charts set to `maxWidth: 'full'` without container bounds.
- **Semantic Tone Compliance**: Flags hardcoded raw hex colors (`#...`) in favor of semantic tones (`positive`, `caution`, `critical`, `neutral`).
- **Standard Chart Verification**: Validates requests against the 8 standard chart kinds (`bar`, `stacked`, `line`, `area`, `pie`, `scatter`, `heatmap`, `radar`).

---

## 6. Governed Sandbox (`vak-sandbox`) Rehearsal

Skill scripts and app packages have separate rehearsal contracts:

- Skill scripts use bounded disposable helper execution with saved-source SHA-256 verification and report captured stdout/stderr and exit status.
- Apps rehearse the exact saved draft fingerprint, await the declared handler, and return its result without committing live app data. External-tool calls are unavailable in rehearsal.
- Published app actions/refreshes execute ordinary code without an LLM per action. Declared real-data tools use existing integration authority; credentials remain in the host, and Ask/off do not run unattended.
- A package diagram, declaration or successful rehearsal does not grant permissions or prove live source/calculation correctness. [Current app architecture](../sandboxed-apps/ARCHITECTURE.md), [contract](../sandboxed-apps/RUNTIME-CONTRACT.md) and [runbook](../sandboxed-apps/OPERATIONS-AND-LIFECYCLE.md) own those boundaries.

---

## 7. Implementation Architecture & Code Locations

| Capability | App / Sidecar Location | Role in Creator Studio |
| :--- | :--- | :--- |
| **Studio UI Shell** | `src/skills-studio.ts` / `src/app.css` | Studio Hub, 2-pane workbench, Flow DAG, breakpoint stage, terminal |
| **Skill Storage & Manifest** | `sidecar/skills.ts` | Frontmatter parser, package fingerprinting, draft quarantine |
| **Sandboxed Apps Registry** | `sidecar/sandbox-pool/app-registry.ts` | Dynamic app lifecycle, manifest validation, trigger scheduling |
| **Canvas & Surface Staging** | `src/canvas.ts` & `@vak/web` | Container query renderer, canonical data hot-reloading |
| **Dual Spoken Projection** | `@vak/core` (`lowerSurface`, `projectText`) | Spoken gist simulation, TTS playback preview |
| **Sandbox Execution** | `sidecar/skills-sandbox.ts` & `vak-sandbox` | Disposable Seatbelt sandbox rehearsal with SHA-256 verification |
| **Selection Gate Verifier** | `sidecar/skills-eval.ts` | Prompt matching test harness for `use_skill` gate |

---

> [!TIP]
> The Creator Studio unifies Agent Skills and Sandboxed Dynamic Applications under a single, minimalist desktop experience with visual pipeline inspection, live canvas staging, continuous auto-saves, and governed sandbox verification.

---

## 7. Model Evaluation Harness & Regression Runner

- **Local Ollama `qwen3.5:4b-mlx` Execution**:
  - Runs 100% locally and offline (zero cost, zero token leakage).
  - **Selection Gate Test**: Runs positive prompts (expected to load this skill) and distractor prompts (expected to load other skills or none). Asserts that `use_skill` returns `{"names": ["my-skill"]}`.
  - **Instruction Adherence Gate**: Verifies output data structures, canonical path bindings, and absence of hallucinated tool parameters.
  - **Telemetry**: Measures prompt latency, generation speed (tokens/sec), and token consumption.

---

## 8. Implementation Architecture & Code Locations

The Skill Studio leverages Vakyartha's existing, modular architecture without introducing new backend runtimes:

| Capability | App / Sidecar Location | Role in Skill Studio |
| :--- | :--- | :--- |
| **Studio UI Shell** | `src/skills-studio.ts` (new) / `src/skills-page.ts` | 3-pane layout, Monaco editor, breakpoint switcher, test deck |
| **Skill Storage & Manifest** | `sidecar/skills.ts` | Frontmatter parser, package fingerprinting, file storage |
| **Discovery & Catalogs** | `shared/skills.ts` & `sidecar/skills-builtin.ts` | Catalog scrapers, 14-day commit checker, local package indexer |
| **Canvas & Surface Staging** | `src/canvas.ts` & `@vak/web` | Container query renderer, canonical data hot-reloading |
| **Dual Spoken Projection** | `src/voice/speech-text.ts` & `lowerSurface` | Spoken gist simulation, TTS playback preview |
| **MCP Tools & Schema Inspector**| `sidecar/integrations.ts` & `@vak/mcp/client` | Tool schema reader, virtual mock MCP server, approval simulator |
| **Research & Web MCP Grounding**| `sidecar/integrations.ts` (`brave`, `tavily`, `context7`) | Live documentation retrieval, formula verification |
| **Test Evaluation Runner** | `sidecar/skills-eval.ts` (new) | Local Ollama 4B test harness, selection gate runner |
| **Sandbox Execution** | `sidecar/sandbox.ts` & `vak-sandbox` | Disposable realm simulator, command preview |
| **YOLO & Assist Co-Pilot** | `sidecar/skills-copilot.ts` (new) | Full package generator, trigger optimizer, chart recommender |

---

> [!TIP]
> The Skill Studio elevates skills from passive prompt templates into robust, verified software capabilities with full authoring, visual surface staging, dual-projection voice simulation, and deterministic testing.
