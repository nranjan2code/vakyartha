# Working on News Desk

Read [Building a Vakyartha app](../../../docs/BUILDING-APPS.md) first; this app follows its method. Then README.md, SKILLS.md and ARCHITECTURE.md here.

## Invariants

1. `context.state` is the only owner: `feeds[]`, `newFeed` draft, `category`, `articles[]`, `saved[]` (canonical URLs), `receipts[]`, `problem`, `checkedAt`. Every run starts with `normalize()`, which accepts untrusted or version-1 state and drops malformed records.
2. `view(state)` is pure and derives all three surfaces (`headlines`, `saved`, `sources`), including the coverage chart records, from the same articles. Articles and feeds render through repeaters; regions are emitted only when they apply; empty and failed states say what to do.
3. `feed.ts` is a bounded syndication parser: no DTD or entity declarations, balanced tags, HTTPS article URLs, canonical URLs without `utm_` parameters. Source markup never becomes executable UI; excerpts are escaped Markdown text.
4. Only `web__fetch_page` is called. A failed feed records a receipt and keeps earlier articles with their original times.
5. Fields save as they change (`/category`, `/newFeed/*`); **Add feed** validates the draft.

## Change method

Change `server.ts` or `feed.ts`; run `node scripts/app-surfaces.ts`; bump `version`; update these four documents; run `node --test test/reference-apps.test.ts test/app-registry.test.ts`. With network and the sandbox helper, `node scripts/reference-apps-check.ts --live` checks live feeds independently and the views in WebKit.
