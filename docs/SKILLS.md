# Skills

Skills are reusable instructions the assistant follows when a request matches. Settings → Skills has two views: **Installed** (search, filters All/On/Built in/From catalogs/Yours, a page per skill with its on/off switch, instructions, edit and remove) and **Explore catalogs**.

For new or revised workflows, start with [the authoring guide](SKILL-AUTHORING.md). It covers canonical data, layout, chart selection, both projections and the source map.

## Built in

Twenty-seven skills ship on: assistant, interactive-ui, plan-my-day, write-email, summarize, explain-simply, compare-options, trip-planner, meal-plan, budget-helper, debug-error, shell-command, code-review, commit-message, surface-design, dashboard, data-review, task-tracker, meeting-actions, research-brief, create-skill, operations-dashboard, sales-dashboard, finance-dashboard, periodic-report, daily-news and market-dashboard (`sidecar/skills-builtin.ts`). Each is planted once (`seeded.json`); removals stay removed. Changed built-ins show Update available in the Updates filter, with current/proposed instructions and an explicit Update skill action. Matching content fingerprints reject stale previews; on/off choices stay unchanged. The assistant skill holds general response/presentation guidance formerly embedded in the app server. The interactive-ui skill covers forms, data, bindings, tables, charts and submitted actions without domain-specific execution handlers. The shared surface-design skill covers composition and styling across those components; domain procedures chain to these enabled skills. See the [capability audit and daily workflows](SKILL-AUDIT.md).

## Format

A skill is a `SKILL.md` file: a `---` block with `name` (lowercase letters, digits, hyphens; up to 64) and `description` (when to use it; up to 1024 characters), then the instructions (up to 32 KB). Other frontmatter keys are ignored.

## How skills chain

- The system instructions carry only the name and description of each **enabled** skill.
- In app chat and tasks, the first counted model generation offers only skill selection. `use_skill` accepts `{names: [...]}` to select/load relevant enabled skills or `{names: []}` for no match. Answer and external tools are withheld during selection. Further calls can load additional skills. This uses the existing tool loop, not an extra hidden provider call.
- Changing enabled skills after a run is prepared fails explicitly if its selection context is stale, instead of bypassing selection.
- Schema-capable providers constrain the selection; other providers get one native selection tool with validation before dispatch. Invalid, interrupted or cancelled selection does not unlock answer tools. Task budgets, provider usage and conversation records include selection. This guarantees a selection step, not that the selected skills or resulting answer are semantically correct.
- Trusted local context loading uses answer-step limits and stays available when external-operation allowance is zero. It records no external operation; the selection generation is still metered. Further skill loads use the same bounded loop, without a fixed extra stage per skill.
- Skills never grant access: integration tools keep their policies and approvals. Scheduled tasks get `use_skill` alongside their selected capabilities.
- Channel-specific execution is unchanged by this checkpoint; the skill-first path is verified for app chat/tasks, not claimed for every channel or voice resolver.

## Data and execution

The interactive-ui skill teaches related views mapped from one collection of records, with separate datasets for unrelated views, with form controls bound to canonical input pointers. It describes requested operations and submission behavior. The runtime uses typed component descriptors and resolves maps and supported aggregates; it never executes expression strings. Per-row calculations need an available tool or independently checked model-authored results.

The source-specific CSV bridge, derive/prepare tools, parameter options and automatic form/report compiler are removed. There is one general authoring path; ordinary task input snapshots and governed external tool results remain available as untrusted data. Validation, permissions, canonical persistence, revision checks and output receipts remain execution code.

Skill selection is verified separately from answer correctness. Historical local trials and the current authorized provider comparison are in [EVALUATION.md](EVALUATION.md). No provider result implies a platform reliability threshold. The installed app now uses the verified cleanup build; source edits alone still require a rebuild/restart before becoming installed behavior. Built-ins are seeded once; existing files are never silently replaced. Updates are reviewed explicitly, and edited/removed skills stay preserved until the user chooses a replacement. Catalog skills remain pinned to their reviewed version; built-in update availability does not claim an upstream catalog check.

## Catalog and review

- Six publisher repositories are listed (`shared/skills.ts`, checked October 2026); any public `owner/repository` can be opened.
- Listings are read at the repository's newest commit at least 14 days old, the same age rule integrations follow. The commit is recorded with the skill.
- Review shows the exact instructions and any bundled files, including files beside a root-level SKILL.md. Bundled files (scripts, resources) are never imported or run.
- Adding requires an acknowledgement and stores exactly the reviewed text (bound by fingerprint). Added skills start off.

Data: `<data>/skills/<name>/SKILL.md` and `<data>/skills/skills.json` (on/off state and source).

## Verification (2026-10-26)

- `test/skills.test.ts`: parsing, enabled-only prompt/tool, pinned review-bound add.
- Live catalog read of all six repositories (9–210 skills each); a reviewed skill added, enabled and indexed.
- Local `qwen3.5:4b-mlx` in the app: with a test skill enabled, the model called `use_skill` and answered from its instructions. With 18 skills on, it chose a catalog skill (brand guidelines) and answered with its exact colour values.
- Through the app: one skill fetched, reviewed, installed and switched on from each of the six catalogs; in the UI, a catalog opened, searched ("pdf"), reviewed and installed.

## Skill and prompt audit (2026-10-27)

The interactive-ui skill is 222 words (1,753 characters), reduced from355 (2,822). It retains the non-obvious mapping/binding contract and action handling; it does not prescribe a domain or require unrelated views to share data. Discovery offers names/descriptions, then selected bodies load on demand. No reference router or forced extra authoring stage was added for this short skill.

The larger context cost was a duplicated root/descendant catalog schema, reduced from about66k to34k characters. Runtime compact/strict controls were removed: transactional and progressive execution each receive their active typed protocol, with no contradictory helper variant. Caller dataSchema is optional and describes only known canonical data; it is not inferred from each user request. Native tool schemas remain guidance unless actual decoding is supported, followed by runtime validation. Existing catalog ingestion handles declared aliases and supported scalar conversions; it does not justify guessing facts, treating missing values as zero or executing formula text.

Fixed assembly conflicts: related views may share a surface; follow-ups can use prior context; research evidence can use the same record mappings/positional cells the authoring contract supports. The fresh trial's first field-loss failure was in submission, not skill discovery. The later malformed native tree remains a retained failure. The final shortened-skill/general-runtime trial and actual WebKit replay pass; EVALUATION.md records the exact scope.

## Updates

New bundled skills seed once. Existing built-ins whose instructions differ from the current bundle appear under **Updates**, with an **Update available** badge. Their detail page shows both versions; **Update skill** replaces instructions only after that explicit choice and preserves on/off state. A changed file or offered version invalidates the old preview. Removed skills are not restored. Catalog skills remain on their reviewed commit; automatic upstream checks/replacements are not implemented.


## Capability-grounded daily workflows (2026-10-27)

Thirteen focused built-ins add surface design, operational dashboards, data review, work tracking, meeting actions, research briefs Vakyartha skill creation, specialized operations/sales/finance dashboards, periodic reports, daily news and market reviews. Existing assistant, interactive-ui, day-planning, comparison and budget instructions now distinguish visual layout, data contracts and domain work. Chaining is model-selected through `use_skill`, not an automatic forced pipeline or new execution handler. Disabled skills cannot be loaded; skill instructions refer to enabled collaborators.

`surface-design` applies to forms, tables, cards, metrics, charts and mixed canvases. Projection's common `maxWidth: sm|md|lg|full` constrains any component independently of grid span. Explicit numeric grids preserve unused tracks; automatic grids remain fluid. Skill text cannot inject arbitrary styling. App theme tokens supply heading/value weight, spacing and corners.

`create-skill` produces a self-contained instruction draft in the supported flat-frontmatter format. No model-facing skill-install tool is currently offered: adding/enabling/updating remains a reviewed Settings action, or a separately authorized file operation through an offered tool. It does not assume scripts or supporting assets will be imported.

New entries seed once; changed defaults use the existing reviewed update flow. Source changes do not update the installed application or replace its local skill files. The fresh primary-local mapped-table gate passed one of three cases; two stopped at the fixed 60-second deadline with no canonical output. Retained evidence and verification scope: [audit](SKILL-AUDIT.md). No end-to-end daily-workflow reliability gate is closed by these instruction changes.

Both projections use canonical surface content. The shared design skill now covers spoken gist, readable units/periods and caveats; domain reports must update narrative alongside tables/charts. `daily-news` requires accessible current sources; `market-dashboard` requires actual session/history/freshness evidence. Reporting cadence is distinct from recurrence. The [chart support matrix](SKILL-AUTHORING.md#chart-choice-and-actual-support) defines eight supported kinds and explicit specialist gaps.
