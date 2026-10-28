# News Desk: architecture

## File map
feed.ts parses and validates syndication records without external libraries. server.ts owns controls, governed reads, retention, bookmarks and canonical projections. surface.json defines Headlines, Reading list and Sources views. app.json declares one governed read tool and one opt-in refresh trigger. README.md owns setup/use/data limits; AGENTS.md owns maintenance invariants; SKILLS.md maps relevant procedures. Those documents travel with source and reviewed publication.

## Canonical data and projections
context.state.articles owns validated article records; context.state.saved owns bookmarked canonical URLs; source configuration, filters and bounded receipts are app state.

## Runtime flow
Visible control → current-revision serialized app dispatch → disposable supervised sandbox → validated domain inputs and permitted integration/SQL → independent canonical Projection updates → atomic app record commit → visible/spoken projections. This uses the existing app host and integration lifecycle; there is no domain renderer, native relay or separate connector.

## Data/network boundaries
The exact tool is web__fetch_page through the Web pages integration. Configure 1–6 credential-free public HTTPS RSS, Atom or JSON Feed URLs with name and category. Default sources cover World, Business, Technology and Science. Enable Web pages and set fetch_page to Allow before refreshing; declarations never grant permission.

Optional 15-minute source polling, disabled after publication. It runs only while the app and computer are running/awake. Missed intervals are skipped. A source error records a failure and retains older articles with their original timestamps; partial success is reported. This is polling, not a streaming feed.

## Failure, persistence and evolution
The app host is the only persistent writer. Failed invocation or invalid projection retains committed state; external uncertainty is never automatically replayed. Domain schema changes require an explicit compatibility/migration design, not a user-data reset. Runtime bounds remain 30-second invocations, bounded tool/response sizes and the opted-in database snapshot bound where relevant. General CPU/RSS/disk quotas and permanent app daemons are not promised.

## Extension decisions and verification
Keep source parsing/calculation/product behavior in this package. Reuse the existing integrations and standard Projection components. A missing general visual/binding capability belongs in Projection's own repository, not a package-specific surface patch. Independently compare publisher headline, canonical URL, publication/retrieval time and category with source data. Verify sorting, duplicate retention, category/text filtering, bookmarks across refresh/reload, source failure and no claimed fresh data after failure. Test malformed/oversized XML, CDATA/entities, DTD rejection and unsafe URLs.

No semantic event clustering, generated summaries, article-body scraping, image proxy, publisher trust ranking, streaming subscription or notifications. Source availability/terms remain publisher-owned. Initial views are empty until successful retrieval.
