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


## Wrapped-list replay and targeted rerun — 2026-10-26

Projection `9c6a0ae` repairs a schema-declared singleton list reference only when its absolute target is an existing array. Replaying the recorded `rows: ["data/evidence"]` now stores a canonical binding, displays actual evidence rows, and follows later data updates. Missing/scalar targets, relative references, ordinary paths and nested row cells remain unchanged. The framework passes 240 tests including its replay gate.

A targeted research rerun on that pin took 60.4s, four generation requests and two approved page reads. Evidence rows were populated, but the requested form/table were still combined into one surface and source interpretation remained unreliable. That run used a direct row array rather than the repaired spelling; it is not evidence of a causal end-to-end improvement from this specific repair. Keep the outcome failed. Retained evidence: `.vak/evaluations/agent-mvp/results/2026-10-25T21-50-54.221Z-aa0e1edb`. The inspector supports single-case report directories and now exercises native and segmented select controls plus checkboxes as well as field edits/filtering, checking that no run/input/model request is dispatched.

## Checked result layouts — 2026-10-26

Projection `b519afc` adds same-run completion validation and a permitted transport-result observer. Vakyartha offers opt-in comparison/source-excerpt layouts (ADR-015), while flexible tasks remain available. Deterministic tests prove rejected prose stays out of the public response, repairs stay in one execution, arbitrary surface IDs work, source excerpts require actual successful reads, and unsupported columns/quotes fail. The evaluation now checks cost/seat numbers on the associated visible row and supplied defaults at actual control bindings, rather than merely finding numbers anywhere in the result.

Persistent local-model diagnostics, all on the authorized installed local setup with no paid requests or MCP installs:

- `2026-10-26T01-46-35.981Z-0a9c2f11`: initial checked comparison exhausted 12 requests after 109.2s; failed. This experimental contract used unnecessarily fixed surface IDs.
- `2026-10-26T01-52-55.671Z-d0b308b8`: checked comparison exhausted 12 requests after 132.7s. Two separate surfaces and correct associated option rows survived, but form defaults were empty and the fictional-data label was missing. Failed. Removed fixed surface-ID/column-name requirements from the final comparison check; visible declared identities and independent root outputs are what matter.
- `2026-10-26T01-55-15.382Z-11001582`: checked research took 235.4s, 12 generation requests and two approved page reads. Both sources were read/cited, but one combined surface survived, the form root was absent and the table's referenced rows did not resolve. Failed. This trial still used the initial fixed-ID contract; it does not establish final-policy reliability.
- `2026-10-26T01-59-23.232Z-02ecb182`: final comparison policy, 49.6s/three requests. Associated option values and supplied form defaults were present, but output remained combined and unlabeled. Ollama returned HTTP 500 with malformed generated tool XML before repair could finish. Failed; no task automatically accepted. Do not classify it as a successful comparison or evidence that the ID relaxation solved authoring.

Validation at this checkpoint: 57 app tests, 243 pinned framework tests, typecheck, UI/sidecar builds, and wide/light plus narrow/dark WebKit setup/lifecycle/interactivity checks. Setup now exposes bounded manifests with contextual labels; native select controls use the app's styling and retain keyboard/focus behavior. Existing multi-surface editing/filtering/navigation checks remain green. Offscreen screenshots disable the app grid transition to inspect settled responsive geometry, including the collapsed-sidebar gutter; they do not certify animation behavior. Raw evidence is retained under the gitignored evaluation workspace.

Next: reproduce the combined-output/missing-data authoring and malformed-tool failures in Projection from the retained transcripts, using general authoring prevention/repair rules. Do not split model surfaces or invent missing values in the app. Check supplied defaults, fictional labels, numerical associations and interpretations independently. Outcome gates remain open; no release-readiness claim follows from completion enforcement alone.
