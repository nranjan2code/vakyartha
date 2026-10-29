# News Desk

Categorized publisher feeds and a persistent local reading list.

## Setup and data sources
The exact tool is web__fetch_page through the Web pages integration. Configure 1–6 credential-free public HTTPS RSS, Atom or JSON Feed URLs with name and category. Default sources cover World, Business, Technology and Science. Enable Web pages and set fetch_page to Allow before refreshing; declarations never grant permission.

## Views and actions
Headlines: filter by category/text, refresh publisher feeds and save/remove articles. Reading list: inspect saved excerpts and remove bookmarks. Sources & refresh: edit feed JSON and inspect the latest 24 source attempts. Source links open the original publisher page. Publication time is distinct from retrieval time; missing publication time stays unknown.

## Data contract, retention and calculations
RSS/Atom support is a bounded syndication subset with balanced tags and no DTD/entity declarations. JSON Feed versions 1 and 1.1 are accepted. Article URLs are HTTPS and deduplicated by canonical URL with utm parameters/fragment removed. Different URLs about the same event are not semantically merged. Headline ≤240 characters and excerpt ≤200 characters. Up to 60 items/feed, 180 recent articles plus saved records within a 240-record bound and up to 60 bookmarks. Full articles and remote images are not copied. Configured category/source names are editorial labels, not model classification or a verified trust rating.

## Scheduling and persistence
Optional 15-minute source polling, disabled after publication. It runs only while the app and computer are running/awake. Missed intervals are skipped. A source error records a failure and retains older articles with their original timestamps; partial success is reported. This is polling, not a streaming feed.

## Failure and recovery
Inspect the current message and source/import/run receipts. Failed source reads never become fresh data; failed computation or invalid projection does not publish candidate state. Missing/disabled sandbox helpers fail closed. Inspect uncertain effects before any exact-run acknowledgement; never automatically replay them. Preserve original failures during diagnosis.

## Maintenance and verification
Read AGENTS.md, SKILLS.md and ARCHITECTURE.md. Inspect actual package/review fingerprints, create an inert draft, update code and affected docs together, rehearse, independently verify and publish explicitly. Check schema compatibility; publication is not a migration service. Independently compare publisher headline, canonical URL, publication/retrieval time and category with source data. Verify sorting, duplicate retention, category/text filtering, bookmarks across refresh/reload, source failure and no claimed fresh data after failure. Test malformed/oversized XML, CDATA/entities, DTD rejection and unsafe URLs.

From repository root, run `node --test test/reference-apps.test.ts`, `npm run typecheck`, `npm run build` and `node scripts/reference-apps-check.ts --live`. The live checker uses isolated settings and real sandbox execution. Its finance data is explicitly synthetic. Current verification scope/results belong in docs/EVALUATION.md and HANDOVER.md; do not infer a pass from this procedure text.

## Limits
No semantic event clustering, generated summaries, article-body scraping, image proxy, publisher trust ranking, streaming subscription or notifications. Source availability/terms remain publisher-owned. Initial views are empty until successful retrieval.

Native projections use the ordinary Projection catalog and wide/narrow layouts. Source/record values and visible explanations also feed spoken projection; there is no separate narration store. No additional SDK, package or raw network path is introduced.

## App settings and action status
Open Settings in the app header for connection readiness, integration setup links, schedules, last-run status and package/data details. Integration policy changes apply globally; this page grants no access. Source/criteria preferences stay in the app’s own views. Ordinary actions execute through this app’s sandbox owner and report in its top status area; local table search/sorting stays local and does not invoke a model.
