# Working on News Desk

Read the repository AGENTS.md and docs/SKILL-AUTHORING.md, then this package's README.md, SKILLS.md and ARCHITECTURE.md before changes.

## Invariants and owner
context.state.articles owns validated article records; context.state.saved owns bookmarked canonical URLs; source configuration, filters and bounded receipts are app state.

RSS/Atom support is a bounded syndication subset with balanced tags and no DTD/entity declarations. JSON Feed versions 1 and 1.1 are accepted. Article URLs are HTTPS and deduplicated by canonical URL with utm parameters/fragment removed. Different URLs about the same event are not semantically merged. Headline ≤240 characters and excerpt ≤200 characters. Up to 60 items/feed, 180 recent articles plus saved records within a 240-record bound and up to 60 bookmarks. Full articles and remote images are not copied. Configured category/source names are editorial labels, not model classification or a verified trust rating.

## Change method
- Keep ordinary code inside the supervised app runtime; no host fallback, credential copying, new dependency or direct HTTP/DNS path.
- Preserve exact source/input identities, types, units, timestamps, missingness and all independent surfaces. Do not use visible labels as source values or introduce another persistent writer.
- Read complete actual source and published/draft fingerprints first. Make an inert draft, review schema/data compatibility, rehearse and verify before publication.
- Update README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md together whenever affected behavior/contracts change. Document migration/reset decisions explicitly.
- Freeze original values/actions/source/receipt expectations before evaluation; retain failure evidence. A unit test, safe rejection or committed change never substitutes for the original user outcome.
- Rendering/catalog/binding fixes belong in Projection's owning repository; containment belongs in the sandbox owner. Keep product/domain choices in this package.

## Verification
Independently compare publisher headline, canonical URL, publication/retrieval time and category with source data. Verify sorting, duplicate retention, category/text filtering, bookmarks across refresh/reload, source failure and no claimed fresh data after failure. Test malformed/oversized XML, CDATA/entities, DTD rejection and unsafe URLs.

Run the reference-app tests/typecheck/build and authorized live/native-WebKit checker described in README.md. Never silently reset user data, run a paid model, install a new dependency or publish a release. Record verification/current state in the host project's HANDOVER.md/EVALUATION.md.
