# Project Activity Desk

Public repository activity and local issue triage with auditable source receipts.

## Setup and data sources
The exact tool is web__fetch_page through Web pages. Only credential-free public repository HTTPS API reads are made. Configure owner/repository; the default is nranjan2code/vakyartha. Enable Web pages and allow fetch_page. Private repositories/authentication are outside this reference; use an appropriate existing integration for a separately designed private workflow.

## Views and actions
Triage: refresh repository activity, inspect exact source rows and drag open-issue cards between Review, Next and Watch. These moves are local organization only. Activity: read recent commits and open pull requests. Source ledger: inspect retrieval attempts. Changing repositories clears the current sample and local lanes before fetching the new repository.

## Data contract, retention and calculations
The source queries retrieve at most 20 recently updated issue endpoint records, 10 open pull requests and 10 commits. Pull-request records are excluded from the issue sample. Counts describe retrieved samples, not full backlog or throughput. IDs/URLs/state/timestamps are validated against the configured repository. Commit identity is the full SHA. Labels and authors remain source values. The latest 24 attempts are retained.

## Scheduling and persistence
Optional 15-minute polling while the host/computer are running and awake; publication disables it. Missed minutes are skipped. Partial failures retain prior datasets for the same repository and report their failed receipts. No background mutation or notification is performed.

## Failure and recovery
Inspect the current message and source/import/run receipts. Failed source reads never become fresh data; failed computation or invalid projection does not publish candidate state. Missing/disabled sandbox helpers fail closed. Inspect uncertain effects before any exact-run acknowledgement; never automatically replay them. Preserve original failures during diagnosis.

## Maintenance and verification
Read AGENTS.md, SKILLS.md and ARCHITECTURE.md. Inspect actual package/review fingerprints, create an inert draft, update code and affected docs together, rehearse, independently verify and publish explicitly. Check schema compatibility; publication is not a migration service. Independently check issue/PR distinction, configured repository identity, SHA, counts and timestamps against public source JSON. Verify local lane changes survive source refresh/reopen without any remote write call. Check repository changes clear old records, malformed/unsafe source identities fail, and empty arrays are valid zero-record samples.

From repository root, run `node --test test/reference-apps.test.ts`, `npm run typecheck`, `npm run build` and `node scripts/reference-apps-check.ts --live`. The live checker uses isolated settings and real sandbox execution. Its finance data is explicitly synthetic. Current verification scope/results belong in docs/EVALUATION.md and HANDOVER.md; do not infer a pass from this procedure text.

## Limits
No remote issue edits, assignment, delivery prediction, exhaustive pagination, CI-health claim, private token forwarding or full backlog/throughput analytics. Native board moves are local app state.

Native projections use the ordinary Projection catalog and wide/narrow layouts. Source/record values and visible explanations also feed spoken projection; there is no separate narration store. No additional SDK, package or raw network path is introduced.
