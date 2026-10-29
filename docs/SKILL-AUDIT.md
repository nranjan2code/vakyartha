# Skill and dynamic-surface audit — 2026-10-27

This file retains the dated audit and its original outcome evidence. For the current 35-package source, request assembly, newer app/workspace paths and unresolved instruction conflicts, use [PROMPT-AUDIT.md](PROMPT-AUDIT.md) (2026-10-29). Historical sizes, counts and eight-kind chart coverage below are not current-state claims.

## Current package and runtime review — 2026-10-27

The [current external package specification](https://agentskills.io/specification) retains a folder with `SKILL.md`, required `name`/`description`, optional `scripts/`, `references/` and `assets/`, and staged loading of metadata, instructions and resources. Vakyartha has this folder and staged-loading shape for supported UTF-8 references and inert script source. Its parser accepts a documented YAML subset with optional `license`, `compatibility`, string `metadata` and `allowed-tools`; it does not claim full YAML syntax, executable scripts or binary assets. The root-level import is a stated extension. The experimental `allowed-tools` field never grants authority. Unsupported resources remain visible as omitted, because their absence can make a third-party skill incomplete.

Actual execution evidence matters more than folder shape. The installed one-card smoke selected only `surface-design`, then rendered the requested card; it did not load `market-dashboard`. Recorded usage was 899 input tokens for selection (3.7s) and 15,732 for the authoring step (63.9s). The second request carried 37,190 characters of authoring schema, 17,518 characters of system instructions and 3,556 characters of returned skill context. These are character counts, not a token attribution. The frozen fictional market request selected its domain skill, read both references and produced one canonical five-row history with mapped chart/table and checked 5% price return after a general complete-data instruction correction. Its first run's empty-data failure remains retained. See [evaluation](EVALUATION.md#bundled-packages-and-market-dashboard--2026-10-27). One supplied-data success does not establish real-source freshness, calendar/adjustment handling, continuation or output receipts.

Current work, in order:

1. Reduce the measured authoring request cost while retaining available tool access and all surface types. Projection now removes 4,392 repeated characters from the core strict tool schema. The local record-view gate still failed at initial values; this is a measured mechanism reduction, not a latency or outcome pass. A local attempt to select integration-tool groups alongside skills was unreliable and was discarded. Further tool discovery needs a separately proved design.
2. Expand package compatibility with standard frontmatter and reference forms. The importer now preserves optional fields through Settings editing and stores reviewed script source as inert UTF-8 text; binary assets remain explicit omissions. A script never gains authority from the package; execution requires a governed runtime boundary.
3. Add reusable examples only where a measured task benefits. Keep source facts and derived results checked at runtime.

The earlier market-source gap remains in retained evaluation evidence and is deferred at the user's request. Pinned external smoke: `openai/skills` `skills/.curated/pdf` reviewed with two accepted text files and one omitted asset; `anthropics/skills` `skills/pdf` reviewed with 11 accepted text files, eight of them inert script sources. Neither package was installed into user data.

## Scope and evidence

Reviewed the app specs, current handover, MVP spec/checklist, skill seed/import/selection/update code, task inputs/output receipts, integration catalog, pipeline audit and recent interactive-skill evaluation procedure. Read the pinned public component catalog, record mappings, web layout/chart code and local interaction behavior. Runtime repairs belong in Projection; no framework dependency files are edited in place.

This is an audit and implementation of instruction coverage and layout mechanisms. Existing failed primary-provider, source fidelity, continuation and installed-app outcomes remain open. Historical hosted success does not establish primary-provider reliability.

## What can actually support a daily skill

| Capability | Current boundary | Skill consequence |
| --- | --- | --- |
| Canonical record data and bindings | Related views can map the same collection within a surface; independent surfaces remain supported | Preserve source identities and values; never imply automatic synchronization across separate data objects |
| Forms and controls | Existing pointers, local validation, governed submitted actions; draft preservation | Capture supplied defaults, use current submitted paths and acknowledge actual changes |
| Tables | Local search, sort and paging; requested numeric totals | A table filter does not cross-filter charts or change aggregate scope |
| Charts and metrics | Shared record mappings; sum/mean/min/max/count | Per-row arithmetic and formulas are not a local computation engine |
| Layout and theme | Semantic components, responsive grids/splits/stacks, common measures and theme tokens | Compose readable views using supported props; no arbitrary CSS/HTML execution |
| Task input and export | Selected bounded UTF-8 text/Markdown/CSV/JSON snapshots; verified Markdown receipts | Do not promise arbitrary document parsing, spreadsheet creation or a saved file without its receipt |
| External reads/writes | Configured integrations, selected task capabilities, per-tool policy and approvals | Skills never install, activate or authorize a capability |
| Context and memory | Selected user-configured external tools; local canonical chat/task state | No parallel retrieval store or implicit cross-chat memory |
| Background work | Bounded app-owned tasks and one-time schedules while running/awake | A displayed agenda or tracker is not recurrence, notifications or continuous monitoring |
| Skill loading | Enabled names/descriptions, counted selection, then selected bodies | Keep descriptions distinct and collaborators conditional; no hard-coded keyword router |
| Skill imports | Reviewed SKILL.md, supported text references and inert script source; binary assets are disclosed but omitted | The creator should make references self-contained and avoid required binary assets or executable behavior |
| Other channels | Separate execution wiring | Do not claim chat/task skill or interaction parity everywhere |

## Existing fourteen skills

- `assistant`: retain general guidance; route structured work to enabled data and design guidance.
- `interactive-ui`: retain canonical mapping/binding/submission guidance; add the design collaborator and table-filter scope limitation.
- `plan-my-day`: retain time planning; distinguish a displayed plan from a scheduled operation.
- `compare-options`: retain decision support; keep facts separate from criteria and revise recommendations after submitted changes.
- `budget-helper`: retain scope-specific budgeting; distinguish currencies/periods, aggregate scope and recalculation.
- `write-email`, `summarize`, `explain-simply`, `trip-planner`, `meal-plan`: retain their bounded procedures; do not inflate them into mandatory forms or dashboards.
- `debug-error`, `shell-command`, `code-review`, `commit-message`: retain their distinct technical purposes and execution boundaries.

## New targeted coverage

| Skill | Daily request it serves | Collaborators when enabled |
| --- | --- | --- |
| `surface-design` | “Make this form/table/canvas readable and well laid out” | interactive-ui for bindings/actions |
| `dashboard` | “Build an operations dashboard from these records” | interactive-ui + surface-design |
| `data-review` | “Inspect this CSV for missing data and summarize the supplied figures” | interactive-ui + surface-design for interactive output |
| `task-tracker` | “Track these deliverables, owners and blockers” | interactive-ui + surface-design |
| `meeting-actions` | “Extract decisions and an action register from these notes” | interactive-ui + surface-design for a register |
| `research-brief` | “Answer this question with sources and limitations” | interactive-ui + surface-design for evidence views |
| `create-skill` | “Create a reusable Vakyartha workflow for my weekly review” | Existing relevant workflows; data/design guidance for surface work |
| `operations-dashboard` | “Review this week's throughput, backlog and blockers” | dashboard + data/design guidance |
| `sales-dashboard` | “Show booked results and open pipeline separately” | dashboard + data/design guidance |
| `finance-dashboard` | “Review cash flow and budget versus actual for this month” | dashboard + data/design guidance |
| `periodic-report` | “Make a daily/weekly/monthly performance report” | dashboard when requested; data/design guidance |
| `daily-news` | “Give me a sourced digest for my region and topics today” | research-brief; data/design for an interactive digest |
| `market-dashboard` | “Review the last completed market week for my watchlist” | dashboard, research when needed, data/design guidance |

These are instruction procedures, not additional engines. The enabled discovery list grows from fourteen to twenty-seven names; bodies still load only on selection. Selection quality and actual chained behavior require independent real-provider evidence. No enterprise account, automatic refresh, shared workspace or deployment is implied by the dashboard name.

## Layout findings and ownership

1. Explicit grids used `auto-fit`, collapsing empty tracks and expanding sparse panels. Projection now preserves tracks for numeric column requests, while automatic grids remain fluid.
2. Horizontal rows centered panels by default. More-specific row CSS also overrode explicit alignment classes. Projection now defaults to top alignment and honors the requested alignment.
3. Components had grid spans but lacked a common content-width constraint. Projection adds semantic `maxWidth: sm|md|lg|full` on every component, distinct from span and capped to its container. Web measures are 320/720/1040 pixels or available width. Forms, summaries and controls can be compact while a dense table uses the available space.
4. Charts expanded to all available width. The projector now supplies a readable default cap, with explicit full-width support, and disconnects resize observers on replacement.
5. Visual hierarchy is partly app-owned: existing theme tokens now give headings and metric values stronger weight, with consistent card spacing and corners. The shared design skill teaches meaningful grouping, units, restrained status tones, appropriate chart choice, narrow-layout order and preservation of drafts.

No arbitrary model CSS, new dependency, domain handler, data writer or native IPC is added. Improving visual defaults does not verify business facts or calculations.

## Verification and unresolved gates

Before broadening any model workflow, ran the required primary-provider mapping gate in Projection: `node scripts/record-view-check.ts --run-local --table-only`. One of three cases passed, including original numeric types/values and a local mapped edit. Two aborted at the unchanged 60-second limit before canonical publication, with no dispatch diagnostic or assistant message. The earliest observed boundary is provider generation, before accepted authoring; the receipt does not establish the underlying reason for the timeouts. No prompt/parser variants or repeat attempts were made.

Raw evidence: `~/Projects/vakProjection/.vak/contracts/record-view-2026-10-27T09-27-46.683Z.json`. No full daily-workflow model trial is claimed after this failed gate, and no paid provider run was made. Free-form, original source/value/interpretation/submission/receipt outcomes stay open.

The deterministic `scripts/surface-design-check.ts` exercises mixed cards, metrics, sections, forms, tables and charts through public host APIs in real WebKit. Geometry checks cover sparse explicit grids, bounded measures, explicit full-width charts, top/explicit alignment and narrow overflow. Interaction checks cover local editing/filtering without action dispatch, preserved drafts/filter state and unrelated result updates. These prove renderer behavior for scripted inputs, not live skill selection or authored answer quality. Existing skills-update and canvas checks remain separate.

Activation follows the existing lifecycle: new bundled skills seed once; changed defaults require their reviewed update action. Custom instructions, removals and on/off choices remain protected. The installed application is unchanged until a separate rebuild/install; source validation is not installation evidence.


Final source verification: 164 app tests and 393 framework tests/replay pass, with both typechecks, framework package generation and UI build. Reviewed built-in update checks pass at 1100/620 pixels; mixed-layout checks pass at 1440/1100/620 pixels in light/dark, and existing canvas checks pass at 1100/620. Screenshots: `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-surface-design-XR25K6/`. Projection is pinned to pushed `c045a3c` on `origin/codex/surface-design`. App source changes remain reviewable in the working tree; no installed build was replaced.


Follow-up scope: [SKILL-AUTHORING.md](SKILL-AUTHORING.md) is now the canonical guide, with README/AGENTS/spec/canvas/lifecycle/release links and ADR-038 preserving the method. Specialized reporting skills distinguish data windows from recurring delivery and current retrieval from supplied snapshots. The chart selection/support matrix covers eight kinds plus separate event/work components and explicitly unsupported specialist/statistical features. WebKit gallery checks exercise all eight render paths and dated heatmap; these are render/geometry checks, not data-source, statistical or live-authoring certification.

Both projections use canonical surface data. Source inspection found that short spoken text truncated at a decimal point; the retained failing regression is `/tmp/vakyartha-report-projections.log`, with passing evidence in `/tmp/vakyartha-report-projections-after.log`. `test/voice.test.ts` now verifies the full decimal finding, reporting period and caveat in visual text and gist/screen/details, before and after a bound value edit. No paid speech call or live microphone test was run. This fixes a deterministic speech projection defect, not the separate unresolved primary-model outcome.
