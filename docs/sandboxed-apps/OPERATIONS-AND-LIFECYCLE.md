# App operations and lifecycle

Use this runbook with the [runtime contract](RUNTIME-CONTRACT.md). It replaces the earlier warm-worker/daemon operations proposal. These are source capabilities; consult [Handover](../HANDOVER.md) and [Releasing](../RELEASING.md) for installed-build status.

## Build and publish

1. Create an app in Studio, ask chat to build an executable package, or choose Create app draft from Canvas. Canvas retains the source conversation and presentation; missing backend behavior must still be authored.
2. Edit the actual package files. Save Draft/autosave remains inert. Incomplete source is retained for further editing, but publication and rehearsal require a valid package. Build with chat prepares an editable request in the source chat; sending it is a normal chat operation.
3. Define the actual `handleAction` and named refresh functions. Declare only needed existing integration tools. Resolve inputs, sources and domain validation before claiming the app can refresh real data.
4. Rehearse the saved, fingerprint-bound draft in Studio. Rehearsal has no external-tool access and does not commit live app state. Do not interpret a rehearsal as verification of live data access or rollback of external effects.
5. Review the manifest, code, data permissions and independently checked outputs, then Publish App. Stale draft/base fingerprints require reloading and reviewing current source. Publication retains domain state, initializes the new package's surfaces and leaves scheduling off.

`read_app_package` lists source names and review fingerprints; `path`/`offset` pages actual source. `save_app_draft` requests approval through the existing chat approval path. First drafts of an existing app supply its published `base` fingerprint; later saves supply the draft's `previous` fingerprint. These writes do not publish code or grant external access.

## Run and refresh

Open a published app in Apps. Opening mounts its current surface; an action or trigger starts bounded execution. The selected surface identity and current app revision accompany UI actions. A stale revision fails instead of applying against newer state.

Handlers run ordinary async code in a fresh supervised sandbox. They update JSON domain state and return validated surface updates. Inputs, calculations and all dependent views should derive from the same canonical values. Use the surface selector for independent views. Local scratch files and module variables do not persist between invocations.

Run Poll executes the first declared trigger in the current UI. The API can select a specific declared trigger. A trigger calls its named exported function directly; it does not ask a model to refresh. Current state and all returned projections commit together only after success. Views poll for new revisions and retain local edits on conflicts; reopen to load the saved version after inspecting a conflict.

Real-data calls use exact declared integration tool names, current enabled status and Allow policy. Configure the integration through its existing Settings flow. Ask/off calls do not run unattended. A successful transport receipt does not establish source truth, freshness or numerical correctness.

## Scheduling, interruption and recovery

Enable schedule explicitly in Apps after reviewing the declared triggers and permissions. Pause it before maintenance. Cron matching uses the desktop process's local timezone; there is no manifest timezone selector. The scan runs every 30 seconds, records the due minute before execution and avoids overlapping scans. Missed minutes are skipped; execution needs the app running and the computer awake. Repeating agent tasks remain a separate capability.

Inspect failed or uncertain run receipts and integration logs. An uncertain external effect blocks further app execution and pauses scheduling. After independently checking the external target, acknowledge the exact run ID using Review uncertain run. Acknowledgement leaves schedules paused and never replays the operation. Interrupted runs become uncertain on host restart.

Runtime suspend cancels current invocations and waits for their cleanup. Wake permits later invocations. Restart cancels/drains invocations and clears logical leases; there are no warm workers to recycle. Host quit uses the existing desktop shutdown path; helper owner-death cleanup remains a separate protection. Do not infer a new wall-clock shutdown guarantee from it.

## Update and remove

Load the current package before editing, save a separate draft, rehearse and publish with current fingerprints. Review data/schema changes explicitly. Updates serialize behind app work; domain state persists, while projections initialize from the new package and scheduling is disabled. There is no automatic package rollback or database migration facility.

Delete in Apps removes the registered app record and its draft after serialized app work. It does not undo external tool effects, remove shared integration logs or delete preserved legacy directories/databases. Legacy source is imported inertly only when compatible; unsupported packages/data remain untouched for manual review.

## API map

The existing host authentication and UI transport apply to all routes. Model app code cannot use these routes as an authority bypass.

| Route | Method | Contract |
| --- | --- | --- |
| `/api/apps` | GET / POST | List published apps / explicitly install a complete package; existing IDs are refused |
| `/api/apps/drafts` | GET | List inert drafts |
| `/api/apps/:id` | GET / PUT / DELETE | Inspect / fingerprint-checked update / remove registered app |
| `/api/apps/:id/draft` | GET / PUT / DELETE | Read source / save with current base or previous fingerprint / discard |
| `/api/apps/:id/publish` | POST | Publish exact draft fingerprint |
| `/api/apps/:id/rehearse` | POST | Rehearse exact draft fingerprint with controlId/value; no external-tool authority |
| `/api/apps/:id/action` | POST | Dispatch controlId/value/action/surface with required current revision |
| `/api/apps/:id/triggers/:triggerId/run` | POST | Execute the named declared trigger |
| `/api/apps/:id/state` | GET | Read committed domain state |
| `/api/apps/:id/schedule` | POST | Set enabled explicitly |
| `/api/apps/:id/recover` | POST | Acknowledge exact uncertain runId; no replay |
| `/api/apps/builtin/:id` | POST | Install a known bundled source package |
| `/api/admin/fleet` | GET | Invocation capacity and logical lease status; null metrics are unmeasured |
| `/api/admin/fleet/restart` | POST | Cancel/drain current invocations and clear logical leases |
| `/api/admin/lifecycle/suspend` / `wake` | POST | Suspend/cancel / permit future invocations |
| `/api/admin/telemetry/stream` / `logs/stream` | GET | Existing authenticated status/log streams |

## Verification and limits

Run `npm test`, `npm run typecheck`, `npm run build`, then `node scripts/apps-check.ts` for the app journey. Native acceptance needs macOS and the existing compatible helper; `VAK_TEST_SANDBOX_BIN` selects a built helper for checks. These checks use isolated test data, not the installed user's apps. Existing canvas regressions use `node scripts/canvas-check.ts`.

The current source has 217 passing app tests and responsive WebKit evidence. Primary-provider graph authoring remains 2/3; no broader model app-authoring trial followed that failed gate. No installed-app replacement, physical power-loss certification, permanent daemon, unbounded filesystem database persistence, watcher, raw network/model broker, strict resource quota or latency guarantee follows from these results. See [Evaluation](../EVALUATION.md#executable-local-app-runtime--2026-10-28) for retained failures and receipts.

2026-10-28 capability update: opted-in bounded DuckDB snapshots now persist atomically with each app record, with sandbox-owned SQL and no new writer/IPC. General persistent filesystem volumes remain unsupported. See [current runtime contract](RUNTIME-CONTRACT.md) and ADR-049 for the superseding interface and limits.
