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


## Rejected tool-generation recovery — 2026-10-26

Projection `399a3a9` adds a public `ToolGenerationError` and bounded tool-loop recovery for provider-rejected syntax before any text/call. The exact HTTP 500 XML parser response from `2026-10-26T01-59-23.232Z-02ecb182` is reproduced by a local canned server. Framework tests verify classification, a fresh invocation for each retry, prior tool receipts without runner replay, step exhaustion, ordinary-error refusal, partial-output refusal and cancellation. An app regression verifies durable request exhaustion and refusal after restart (ADR-016). Unknown failed-generation tokens remain unknown; retries are counted requests, not free work.

Affected-case rerun: `.vak/evaluations/agent-mvp/results/2026-10-26T02-20-35.683Z-7a130c5f`, app base `1577426` with the modified framework pin and budget test, primary local model and existing authorized evaluation runtime. **Failed:** 103.9s, 12 generation requests, zero external tool calls, step limit. Seven surfaces survived with separate form/table identities, but supplied 12/18 costs became 1200/1800, cost-per-seat values became 300/225, bound form defaults were empty, and the fictional label was absent. Later comparison rows were empty. `review.json` records these findings. There were **zero XML rejections** in this rerun; do not claim it demonstrates live recovery or a causal authoring improvement. The exact-error deterministic test is the recovery evidence. No task was accepted.

Retained-output WebKit checks at 1100px/light and 620px/dark each edited five controls and filtered two tables with unchanged model-request/run/input counts; screenshots were inspected. Extra inferred inputs remain visible. These checks establish local controls on retained failed outputs, not output correctness, comprehensive accessibility or installed-window acceptance. Task and canvas smoke checks pass in both layouts. Overall validation: 58 app tests, 248 pinned framework tests/replay gate, typecheck, UI build, sidecar bundle and one native test. No dependency/lockfile changes, paid requests, MCP installs or installed-app/channel restart.

**Next concrete checkpoint:** replay this report's transcript (`transcripts/44866792-1040-40c7-bfbd-a0dcf60bb31e.jsonl`) in Projection. Investigate malformed node/prop boundaries creating extra inferred inputs, table rows written as `[{"data":"options"}]` instead of a usable binding, and repeated replacements/new IDs that lose initialized data. Use general catalog/parser/authoring rules with real-output regressions; never rewrite supplied numeric facts or split/synthesize surfaces in the app. Rerun comparison and affected research cases after those changes. Keep numeric associations, defaults, source interpretation, output receipts and recovery/retention gates open.


## Authoring, independent layouts and review feedback — 2026-10-26

Current Projection pin: `9d44982` (authoring repairs `5ea729a` plus strict test fix `ff9bfaa`; trusted completion acknowledgement `0b8bee3`). App base `3d64d24` with the working changes described here; every report records the modified-working-tree flag. The original framework checkout had concurrent unrelated component edits, so tests/typecheck also ran in isolated committed checkouts and those edits were neither staged nor adopted. No packages/dependencies were added to either project; lockfiles remain unchanged.

Replay first reproduced the extra inputs and blank rows through `SurfaceStore.apply`/`projectText`. Verbatim fictional calls are now framework fixtures. A keyless property group with an extra closer stays on its node rather than creating another input; explicit `"[{/data/options}]"` bindings survive coercion and follow data changes. Missing/scalar bound containers are diagnosed without rejecting numeric list items. Patch corrections preserve omitted data; full render replacement and explicit empty arrays retain their meaning. Wrong supplied values are never rewritten by a repair.

The live comparison then exposed wording-only retries: valid layout output was rejected just for not ending with an exact sentence, followed by column loss during more generation. The additive completion decision now permits a trusted neutral acknowledgement after substantive checks, withholding raw provider prose without another generation (ADR-018). Layout checks accept independent form/table surfaces with title/layout wrappers, reject combined/ambiguous outputs, identify surplus IDs and diagnose blank displayed cells/key mismatches (ADR-019). Optional user-provided visible notices are bounded, persisted and checked in resolved output (ADR-020); final comparison trial explicitly includes notice `Fictional` alongside its option labels. None of these mechanisms establishes semantic verification or user acceptance.

Persistent diagnostic reports (UTC filenames; all use the primary free local model and existing authorized runtime):

| Report | Case and measurements | Observed outcome |
| --- | --- | --- |
| `2026-10-26T02-42-27.393Z-d6251ce0` | Comparison, 113.5s/12 requests, pin `ff9bfaa` | Failed: two identities and fictional labels; defaults empty, cost-per-seat column lost. Two intermediate rejections were solely final wording. |
| `2026-10-26T02-44-22.452Z-b7378396` | Research, 56.1s/6 requests/two approved reads, pin `ff9bfaa` | Narrow source-excerpt candidate: two independent surfaces, matching cited quotes, documentation/production assessment populated. Full changed-criterion, source-date and reliability gates remain open. |
| `2026-10-26T02-48-49.910Z-417f9bf0` | Comparison, 114.7s/12 requests, pin `9d44982` | Failed: defaults/labels retained, but obsolete combined output remained and requested per-seat values were not visible. No wording-only rejection. |
| `2026-10-26T02-51-54.884Z-1c3d9159` | Comparison, 79.9s/12 requests | Failed: independent outputs and defaults/labels, but root-only policy rejected a wrapper and displayed cost keys/recommendations were missing. |
| `2026-10-26T02-53-16.524Z-bfb7bc7d` | Research, 78.5s/7 requests/two approved reads | Source-excerpt candidate only: quotes match reads, but decisions are uninitialized and production-service limitation is omitted from displayed excerpts. Full research explanation remains unverified. |
| `2026-10-26T02-56-09.615Z-cc8bb137` | Comparison, 35.1s/two requests | Failed: correct associated numeric values/defaults and a usable independent comparison, but no fictional-data label. |
| `2026-10-26T03-00-13.121Z-3fecc6de` | Comparison with explicit notice, 114.7s/12 requests | Machine candidate **overturned to failed**: numbers/defaults/identities/notice all pass, but Atlas says “Exceeds seats; better value,” contradicting 4 available vs 6 required seats and cost-per-seat 3 vs Birch's 2.25. See `review.json`. |

These are diagnostic examples across changing policies, not a controlled causal comparison or reliability rate. **A candidate is not a full outcome pass.** No task was automatically accepted. A successful last response was replaced with the app's neutral acknowledgement, never a certification of the model's reasoning. Raw records/screenshots and `review.json` corrections stay in the gitignored evaluation workspace.

Validation: 64 app tests, 257 pinned framework tests/replay gate, typecheck, UI build, sidecar bundle and native test. Wide/light and narrow/dark task/canvas WebKit checks pass; the setup check covers visible-notice entry/hiding, scheduled persistence and detail display. Retained comparison/research outputs were exercised in both widths with unchanged model-request/run/input counters. Screenshots show actual labels/rows; the final comparison's contradictory recommendation was also visually confirmed. This does not close comprehensive accessibility, installed-window or changed-criterion gates. No paid run, MCP installation, installed-app replacement or channel restart.

**Next:** tighten the outcome evaluation around row-local recommendation/constraint contradictions before making another candidate-pass claim. Preserve the final transcript `07965ef6-3ec8-43bc-ad41-5cb0ed058de5.jsonl` and source-research reports. Define any automatic comparison checks against explicit typed user facts/constraints and canonical displayed fields; do not infer arbitrary semantic truth from nonempty cells, notices or keyword presence. General engine changes still require a concrete public-API gap and belong in Projection. Keep P1.9/P2.7/P4.1/P4.9 open, followed by saved-output receipts and operation recovery/retention. Do not undo the proven parser/binding repairs or synthesize correct facts in app surfaces.


## Current-baseline review and conservative verdicts — 2026-10-26

Reconciled source changes through app `8f2d6dd` and Projection `a1537c3`: expanded components/actions, background chat work, separate gathering/answer budgets, inline placement, plain replies/title handling and voice/dictation. These are retained. No framework change or live model/voice request was needed for this checkpoint.

`scripts/evaluation-reference.ts` now derives cost-per-seat, budget/capacity satisfaction and combined eligibility from the single typed comparison fixture. Reports place those independent reference facts beside actual displayed rows for review. Goal, criteria and numeric expectations use that fixture. Evaluation extraction uses public canonical resolution, visibility and finalized table columns; hidden/orphan nodes, unused data and combined-role surfaces cannot masquerade as independent visible evidence.

Automated success is now **`needs-semantic-review`**, not `candidate-pass`, for every case. Any failed check remains `failed`. This is a conservative gate, not a natural-language contradiction detector. Offline replay of `2026-10-26T03-00-13.121Z-3fecc6de` pairs Atlas's `enoughSeats: false`/`meetsBoth: false` with its displayed “Exceeds seats; better value”; the previous machine candidate becomes review-required, while the existing manual `review.json` failure remains authoritative. Historical reports were not rewritten. No new reliability or completion claim follows.

Validation: 86 app tests, 277 unchanged pinned-framework tests, typecheck, UI build and current wide/narrow task/canvas WebKit checks pass. Existing build advisory: voice is imported both statically and dynamically, so the dynamic import creates no separate chunk. No dependency/lockfile changes, paid requests, speech requests, integration install or runtime restart. Next: explicit typed claim/constraint validation or recorded semantic review, then real-case reruns; P1.9/P4.9 stay open.


## Explicit typed comparison claims — 2026-10-26

App base `1867a55` with this checkpoint's working changes; unchanged Projection `a1537c3`. Optional `resultPolicy.table` supplies bounded expected visible rows. The general app checker enforces exact columns/identities/scalar values and types through the existing same-run completion callback. The evaluation derives `within_budget`, `enough_seats` and `meets_both` independently from its typed numeric fixture, explicitly requests those columns, supplies their expectations, and independently rechecks canonical displayed claims. This verifies agreement with declared assertions, not arbitrary prose, input provenance or independent model reasoning. Assertions remain fixed; form edits do not recompute them (ADR-022).

New local diagnostic: `.vak/evaluations/agent-mvp/results/2026-10-26T06-27-59.817Z-e242767d`, task/transcript `87cbf088-2298-4c93-b43b-954961ec226d`. **Failed:** 140.2s/12 requests/no external calls, step limit. Atlas is missing from visible rows; Birch's cost-per-seat is 3 rather than 2.25 and its declared budget/capacity booleans mismatch. Both completion enforcement and independent `formalClaimsMatch` reject it. The run never reaches valid review/acceptance. `review.json` records the failure. This is a changed-contract diagnostic, not a controlled improvement comparison or an overall reliability claim.

Validation: 89 app tests, 277 pinned framework tests, typecheck, UI build, sidecar bundle, native test and wide/narrow task/canvas WebKit checks. Tests cover strict scalar types, reordered columns/rows, zero/false, duplicate/missing identities, bounds/policy mismatch, unused data and same-run repair. Setup JSON is optional; scheduled-task checks verify assertion persistence/detail display without new model work. Retained-output UI inspection is recorded beside the report. No paid/voice calls, integration installation, dependency change, framework update or installed-app/channel restart.

Next: replay this trial's malformed table authoring/correction transcript in Projection to find a general rule, while preserving the app's truthful failure. Do not fill/rename/recompute generated cells in the app. Arbitrary prose, research explanation/dates/changed-criterion behavior, output receipts and recovery/retention remain open gates. Evaluation success still means `needs-semantic-review`, never automatic acceptance.


## Token-based parser repair with concurrent styling — 2026-10-26

Replayed failing transcript `87cbf088-2298-4c93-b43b-954961ec226d` in Projection's own isolated worktree. A missing closing key quote (`"within_budget:false}`) swallowed the next row; `SurfaceStore.apply` returned no error but only Birch survived with mixed values. The repair scans identifier/colon/token/delimiter boundaries and uses standard `JSON.parse` to validate primitive tokens. Proper quoted keys win. Final-input guards defer damaged-key recovery during streaming; incomplete, ambiguous, nonfinite and non-JSON literal spellings are not guessed. No new compound regex patch, compatibility adapter, schema version shim, dependency or fact rewriting. Captured Atlas's false budget claim remains false for the app to reject.

Framework draft review: [Projection PR #1](https://github.com/nranjan2code/Projection/pull/1), branch `codex/quoted-member-recovery`, final pushed pin `05c9d59`. Rebased onto committed styling `0b59e6f`, retaining both changelog entries; theme/card code was untouched by the parser change. Existing app integration checkpoint `3011b04` had already adopted combined commit `4156e8f`; this checkpoint advances only to its final-input guard follow-up. Public schemas and post-parse validation remain authoritative. No framework checkout edits in Vakyartha.

One primary-local-model trial on `4156e8f`: report `2026-10-26T06-52-18.822Z-72d38ec0`, task/transcript `35a40e9e-1d4d-4687-9fc1-89fbb6c40a71`. **Needs semantic review:** 38.1s/two generation requests/no external calls, every recorded numeric/default/layout/notice/formal-claim check passes. Both rows contain correct supplied values and booleans. `review.json` retains that narrow assessment; no task accepted. This single run does not establish a causal reliability improvement or full changed-criterion/prose/provenance correctness. The deterministic raw render/update replay is the specific repair evidence. `05c9d59` adds conservative final/prefix guards after this trial; no extra live run was used to claim improvement.

Validation of the final combined pin: 89 app tests, 281 framework tests/replay gate, typecheck, UI/sidecar builds and current wide/narrow task/canvas checks. Retained-output WebKit inspection exercises local controls without dispatching work. No new packages, paid or voice calls, integration install, installed-app or channel restart. Next: review changed-criterion/static-assertion behavior and full research evidence, then continue scoped output destinations/receipts. Arbitrary prose and release-readiness gates remain open.
