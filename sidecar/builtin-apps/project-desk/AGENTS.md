# Working on Project Activity Desk

Read the repository AGENTS.md and docs/SKILL-AUTHORING.md, then this package's README.md, SKILLS.md and ARCHITECTURE.md before changes.

## Invariants and owner
context.state.issues, pulls and commits own their respective source samples. context.state.triage is the independent local lane mapping keyed by validated issue URL. Controls and receipts share app state.

The source queries retrieve at most 20 recently updated issue endpoint records, 10 open pull requests and 10 commits. Pull-request records are excluded from the issue sample. Counts describe retrieved samples, not full backlog or throughput. IDs/URLs/state/timestamps are validated against the configured repository. Commit identity is the full SHA. Labels and authors remain source values. The latest 24 attempts are retained.

## Change method
- Keep ordinary code inside the supervised app runtime; no host fallback, credential copying, new dependency or direct HTTP/DNS path.
- Preserve exact source/input identities, types, units, timestamps, missingness and all independent surfaces. Do not use visible labels as source values or introduce another persistent writer.
- Read complete actual source and published/draft fingerprints first. Make an inert draft, review schema/data compatibility, rehearse and verify before publication.
- Update README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md together whenever affected behavior/contracts change. Document migration/reset decisions explicitly.
- Freeze original values/actions/source/receipt expectations before evaluation; retain failure evidence. A unit test, safe rejection or committed change never substitutes for the original user outcome.
- Rendering/catalog/binding fixes belong in Projection's owning repository; containment belongs in the sandbox owner. Keep product/domain choices in this package.

## Verification
Independently check issue/PR distinction, configured repository identity, SHA, counts and timestamps against public source JSON. Verify local lane changes survive source refresh/reopen without any remote write call. Check repository changes clear old records, malformed/unsafe source identities fail, and empty arrays are valid zero-record samples.

Run the reference-app tests/typecheck/build and authorized live/native-WebKit checker described in README.md. Never silently reset user data, run a paid model, install a new dependency or publish a release. Record verification/current state in the host project's HANDOVER.md/EVALUATION.md.
