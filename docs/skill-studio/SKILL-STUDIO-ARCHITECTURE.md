# Creator Studio: current architecture and limits

Source review: 2026-10-29. Studio (`src/skills-studio.ts`) edits reusable instruction packages and executable app packages. These have different activation, persistence and execution contracts. [SKILLS.md](../SKILLS.md) owns the skill lifecycle; [the app runtime contract](../sandboxed-apps/RUNTIME-CONTRACT.md) owns executable apps; [SKILL-AUTHORING.md](../SKILL-AUTHORING.md) owns composition guidance.

The [prompt audit](../PROMPT-AUDIT.md) records the earlier defects, source repairs and remaining outcome gates. This document describes current source and intended ownership; it does not certify model compliance or an installed build. Older mockups in `assets/` are design references, not implementation evidence.

## Workbench and package owners

Studio opens from the sidebar or Settings → Skills. Its hub searches/pages skills, apps and drafts. A package explorer and central workbench offer Spec & Code, Flow DAG, Live Preview, and Sandbox & Tests. Editors use the existing text-area implementation. Switching to conversation hides Studio and preserves its in-memory working selection; persisted drafts support later reopening.

| Package | Draft owner | Activation and execution |
| --- | --- | --- |
| Skill | `<data>/skills/.drafts/<name>/`, with debounced saves | Explicit Publish Skill updates the published package; on/off state and required surface-design rules remain enforced. Discovery excludes draft directories. Loading a skill never runs its script files. |
| Executable app | `<data>/app-drafts/<id>.json`, with draft/base fingerprints | Explicit Studio publication changes the app version and pauses schedules. Published actions/refreshes execute code through the supervised sandbox. Canonical state, projections and optional bounded database snapshots persist in the host-owned app record. |

Chat can inspect app packages through `read_app_package` and request approval to stage inert source through `save_app_draft`. It does not gain publication or scheduling authority from a skill. Build with chat prepares an editable request in the source conversation. App construction/maintenance uses the enabled app procedures and four package documents; domain skills can guide the content.

## Selection and execution

Production chat/tasks use a counted selection request, then selected instruction bodies and available tools. The required surface-design policy is separate from optional selection and applies once across native and schema-wrapped authoring. Selected procedures are admitted whole into current-run system context; references remain data. Channels currently lack the optional loader/index wiring. See the audit for the exact paths and context measurements.

A published app action or refresh does not repeat this selection process. It invokes the named backend handler, uses declared and currently permitted integration tools, validates returned state/projection updates and commits through the app owner. Scheduled calls require explicit opt-in and an awake/running app; Ask/off tools cannot run unattended. Skills never grant execution authority.

## Flow DAG

The graph is an illustrative interpretation of package text and declarations. It is not a runtime trace, hard-coded domain router, automatic dependency resolver or permission checker. `allowed-tools` is descriptive. Procedure links guide model decisions; the graph does not execute those links or establish cosine-similarity routing.

The conceptual skill path is request → selection → selected procedures and governed tools → canonical data → content-driven surfaces → spoken projection. `/records` is an example path, not a universal domain schema. Independent outputs can use separate surfaces; related views map shared records. The graph describes possible procedure relationships and is not proof those procedures executed.

The app path is explicit action/opted-in trigger → supervised backend invocation → host-owned canonical state/database/projections → selected surface. No warm worker, implicit model refresh, direct-network grant or arbitrary persistent filesystem database is implied.

## Preview, layout and speech

The stage uses `<vak-surface>` with viewport choices 320px, 720px, 960px and available width. A width simulation does not prove a channel's native projection or its form behavior. Skill previews synthesize domain/sample surfaces; they do not show a real provider's authored result. App surface previews and rehearsal results also require independent checks against actual backend behavior and source values.

Choose layout from content and container width. A short reading column or form may be appropriate; no metric/chart/table tier count is mandatory. Use offered semantic layout props and canonical schema values: split ratio `"2:1"`, widths `sm|md|lg`, tones `neutral|info|success|warning|danger`. Full-width data panels and explicitly requested wide charts remain valid choices. Consult the [nine-kind chart matrix](../SKILL-AUTHORING.md#chart-choice-and-actual-support), including candlestick and specialist limits.

The current linter checks instruction text with simple patterns: full-width/chart co-occurrence, hex colors, and selected unsupported-chart words. It is not schema decoding, geometry measurement, source/calculation validation or an outcome gate. It recommends canonical tones and treats full-width choices as contextual review rather than a universal prohibition. A clean hint list is labelled no text-pattern warnings, not layout compliance. Existing preview fixtures and DAG badges are not evidence that a skill ran successfully.

The voice preview lowers the same surface content and uses browser speech synthesis. Visible findings, units and caveats should carry the same meaning in speech. This preview does not prove live microphone, provider speech or conversation-loop outcomes.

## Package generation and suggestions

`sidecar/skills-copilot.ts` uses deterministic starters and editable suggestions. It preserves the requested procedure instead of assigning every task an analytics workflow. It does not invoke a model, perform research, invent domain schemas/calculations/thresholds, or add an unrelated helper script. Trigger suggestions retain the user's scope. Chart choices come from the current public catalog, including candlestick. Shared design and interaction guidance own layout and bindings.

Generated packages are drafts requiring review. Suggested tool names do not grant access. Keep narrow domain descriptions; supporting references and explicit positive/negative scenarios can be tailored before publication.

## Rehearsal and evaluation

Skill script rehearsal verifies saved source hashes and uses bounded disposable sandbox execution. App rehearsal uses the exact saved draft fingerprint, awaits the handler, and returns results without committing live app state or granting external-tool authority. Neither proves general model instruction adherence or live data correctness.

The `/api/skills/eval` endpoint evaluates selection only. Studio sends the chosen chat provider/model and explicit expected selection for each positive or distractor prompt. The endpoint requires an enabled published optional skill and uses a fresh instance of the same selection interceptor for each case. No model alias, first-registry fallback or word-overlap substitute is used. Missing setup fails explicitly; unpublished drafts are not tested by this endpoint.

Results include expected selection, actual names, target pass/error and elapsed time. Selecting the target for a distractor fails; rejecting it passes. These results do not verify other selected names, instruction adherence, source/calculation truth, interactions, receipts or throughput. Deterministic request tests and the narrowly frozen local selector evidence are in [EVALUATION.md](../EVALUATION.md); broader primary-provider outcome gates remain independent.

## Source map

| Capability | Owner |
| --- | --- |
| Workbench, fixture previews, illustrative DAG, lint copy, browser speech | `src/skills-studio.ts` |
| Skill parser, published/draft storage, reviewed updates, loader and provider wrapper | `sidecar/skills.ts` |
| Bundled package discovery | `sidecar/skills-builtin.ts`, `sidecar/builtin-skills/` |
| Deterministic generation and suggestions | `sidecar/skills-copilot.ts` |
| Selection-only evaluator | `sidecar/skills-eval.ts`, `/api/skills/eval` in `sidecar/server.ts` |
| Skill script rehearsal | `sidecar/skills-sandbox.ts`, separate sandbox helper |
| App drafts/publication/state/action/trigger ownership | `sidecar/sandbox-pool/app-registry.ts` |
| Supervised app invocation and database support | `sidecar/sandbox-pool/`, separate sandbox helper |
| General schema, projection, bindings and provider protocol | Projection public packages; changes belong in its owning repository |

Documentation and offline assembly checks do not close live selection, source/value, interaction, receipt, system-isolation or installed-delivery gates.
