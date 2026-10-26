# Skills

Skills are reusable instructions the assistant follows when a request matches. Settings → Integrations → Skills (beside MCP) has two views: **Installed** (search, filters All/On/Built in/From catalogs/Yours, a page per skill with its on/off switch, instructions, edit and remove) and **Explore catalogs**.

## Built in

Twelve everyday skills ship on: plan-my-day, write-email, summarize, explain-simply, compare-options, trip-planner, meal-plan, budget-helper, debug-error, shell-command, code-review, commit-message (`sidecar/skills-builtin.ts`). Each is planted once (`seeded.json`); one the user removes or edits is never put back.

## Format

A skill is a `SKILL.md` file: a `---` block with `name` (lowercase letters, digits, hyphens; up to 64) and `description` (when to use it; up to 1024 characters), then the instructions (up to 32 KB). Other frontmatter keys are ignored.

## How skills chain

- The system instructions carry only the name and description of each **enabled** skill.
- When a request matches, the model calls `use_skill` with the name and receives the instructions as the tool result. A skill can name another skill to load next, and can direct the model to integration tools.
- Skills never grant access: integration tools keep their policies and approvals. Scheduled tasks get `use_skill` alongside their selected capabilities.

## Catalog and review

- Six publisher repositories are listed (`shared/skills.ts`, checked October 2026); any public `owner/repository` can be opened.
- Listings are read at the repository's newest commit at least 14 days old, the same age rule integrations follow. The commit is recorded with the skill.
- Review shows the exact instructions and any bundled files. Bundled files (scripts, resources) are never imported or run.
- Adding requires an acknowledgement and stores exactly the reviewed text (bound by fingerprint). Added skills start off.

Data: `<data>/skills/<name>/SKILL.md` and `<data>/skills/skills.json` (on/off state and source).

## Verification (2026-10-26)

- `test/skills.test.ts`: parsing, enabled-only prompt/tool, pinned review-bound add.
- Live catalog read of all six repositories (9–210 skills each); a reviewed skill added, enabled and indexed.
- Local `qwen3.5:4b-mlx` in the app: with a test skill enabled, the model called `use_skill` and answered from its instructions. With 18 skills on, it chose a catalog skill (brand guidelines) and answered with its exact colour values.
- Through the app: one skill fetched, reviewed, installed and switched on from each of the six catalogs; in the UI, a catalog opened, searched ("pdf"), reviewed and installed.
