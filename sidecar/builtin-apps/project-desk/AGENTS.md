# Working on Project Activity Desk

Read [Building a Vakyartha app](../../../docs/BUILDING-APPS.md) first; this app follows its method. Then README.md, SKILLS.md and ARCHITECTURE.md here.

## Invariants

1. `context.state` is the only owner: `repository`, `repoDraft`, `issues[]`, `pulls[]`, `commits[]`, `triage{issue URL → lane}`, `receipts[]`, `problem`, `checkedAt`. Every run starts with `normalize()`, which drops malformed records and lanes for issues no longer open.
2. `view(state)` is pure and derives all three surfaces (`triage`, `activity`, `sources`), including chart tallies, from the same records. Regions are emitted only when they have data; empty and failed states say what to do.
3. Source records are validated against the configured repository: positive issue numbers, open/closed state, `https://github.com/<repo>/issues|pull|commit/` URLs, full 40-character SHAs, real timestamps, bounded text.
4. Only `web__fetch_page` is called, for the three public API URLs. Triage is local; nothing writes to the repository.
5. `/repoDraft` saves as typed and is validated by Refresh; `/cards` (the board) accepts only known open issues and the three lanes.

## Change method

Change `server.ts`; run `node scripts/app-surfaces.ts`; bump `version`; update these four documents; run `node --test test/reference-apps.test.ts test/app-registry.test.ts`. With network and the sandbox helper, `node scripts/reference-apps-check.ts --live` checks live commits independently and keyboard triage in WebKit.
