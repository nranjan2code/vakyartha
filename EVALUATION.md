# Agent outcome evaluation

This complements deterministic tests with opt-in runs on the primary installed local model. A finished run is not a passing outcome. No release thresholds or broad reliability claims are established yet.

## Development setup

The user explicitly authorized reusing and altering this development machine's installed settings/integrations for evaluation. Reuse that authorization in future sessions. Paid model runs still require separate approval.

`node scripts/task-evaluate.ts --run-local` uses the installed local provider settings, installed model profile and already installed pinned Memory MCP runtime. It starts the current source app against the persistent `.vak/evaluations/agent-mvp` workspace. No package is installed, paid model selected or channel restarted. It uses the enabled built-in Web pages and Time integrations, plus Memory when installed. Other enabled services are not called merely because they exist: the evaluation selects concrete free capabilities and exact operation scopes.

The evaluation runtime is shared from the existing installation; task/session records, transcripts, numeric usage and named evaluation memory entities persist in the evaluation directory. Credentials and personal memory are not copied. This is a repeatable development workspace, not a disposable directory. Raw evidence stays gitignored; never commit `.vak`.

## Commands

```bash
npm run build
node scripts/task-evaluate.ts --run-local
node scripts/task-evaluate.ts --run-local --case=interactive-comparison
node scripts/task-evaluate.ts --run-local --case=public-source-research
node scripts/task-evaluate.ts --run-local --case=memory-operation
node scripts/task-evaluate.ts --inspect
node scripts/evaluation-ui-check.ts .vak/evaluations/agent-mvp/results/<report-directory>
```

`--inspect` serves saved tasks without starting a new model run. Optional `--settings=<installed-data-directory>` and `--data=<evaluation-directory>` select explicit locations. The primary model is `qwen3.5:4b-mlx`; a missing model fails rather than silently falling back. The UI check opens retained results in WebKit at 1100px/light and 620px/dark, edits fields and filters tables without submitting new model work, and saves screenshots beside the report. Animation classes are removed for stable snapshots as in the existing canvas smoke; this does not establish animation correctness.

Review each report's `summary.json`, per-case task/session snapshot, transcripts and screenshots. Captured commit IDs plus a modified-working-tree flag distinguish uncommitted trials. Machine checks exclude user instructions from evidence. Independent surfaces must have separate identities, and table row names must appear in visible cells rather than unused data or prose. Candidate checks remain weaker than semantic correctness and actual interaction review. The harness never automatically accepts a task.

## Baseline and response-completion trials — 2026-10-26

The baseline used app `72de108` with the evaluation harness under development and Projection `c8e7245`. The second used the same app base plus opt-in response completion on Projection `dbae5c2`. One trial of each case was run per mode; these are diagnostic examples, not a statistically meaningful reliability rate.

| Case | Baseline | Response completion | Outstanding finding |
| --- | --- | --- | --- |
| Fictional comparison | 32.5s, 2 generation requests; combined form/table; missing fictional label | 39.1s, 4 requests; distinct form/table and fictional label | Table omitted option names; form did not initialize supplied criteria. Initial machine candidate status was overturned by review and a tighter visible-row check. |
| Public-source research | 36.7s, 2 requests; both pages fetched/cited; missing requested form/table | 94.6s, 5 requests; both fetched/cited; one surface with a table, no form | Literal path in table rows, invented counts and inaccurate testing suitability. Failed outcome despite successful retrieval. |
| Approved Memory operation | 25.9s, 2 tool calls; write/read-back with independently persisted marker | 49.1s, 6 generation requests, 2 tool calls; write/read-back with independently persisted marker | Machine candidate only. One bounded operation is insufficient to close the full connected-work scenario or establish general correctness. |

Evidence folders (UTC timestamps are used in filenames):

- `.vak/evaluations/agent-mvp/results/2026-10-25T21-21-43.949Z-a4fe6c63`
- `.vak/evaluations/agent-mvp/results/2026-10-25T21-32-47.634Z-cc8a4012`, including `review.json` correcting the initial comparison candidate status.

## Ownership and next work

Projection's default stops on a clean projection. The new opt-in `completion: "response"` allows publication as progress in the same bounded host run and ends on a response without tool calls. Ordinary chat is unchanged. Vakyartha enables it for tasks and still requires separate user evidence review before acceptance. No repeated chat requests, generated surface splitting or parallel canonical stores are used.

Next, replay the recorded research binding and missing-identity output in Projection's own repository to identify general catalog/normalizer/authoring improvements. Add regressions from the real output before rerunning affected local cases. Do not solve these failures with app-side surface rewriting. Keep source correctness, independent controls, output receipts, recovery and full installed-window checks open until their acceptance evidence exists.
