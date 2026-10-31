# Executable reference applications

To build your own, follow [Building a Vakyartha app](BUILDING-APPS.md); these packages are its worked examples.

Current update contract (2026-10-30): existing app packages are never silently replaced at startup. Update controls show an inspectable manifest/source preview and require current package/revision plus the exact candidate fingerprint. Saved drafts take precedence over bundled replacements; stale or incomplete drafts require Studio review. Running/uncertain work blocks publication; pending UI edits must be saved/discarded first. Accepted updates retain saved app data, rebuild views and pause scheduling. No installed-app update or live voice outcome is implied by these source checks.


Five independent source packages exercise Vakyartha's supported app runtime and ordinary Projection surfaces. They are examples of actual executable behavior with explicit bounds. They do not certify arbitrary model-generated apps or capabilities the runtime does not expose.

| Package | Purpose and views | Canonical owner and source | Native projections |
| --- | --- | --- | --- |
| [Market Terminal](../sidecar/builtin-apps/market-terminal/README.md) | Market, Instrument, Analytics | Validated delayed NSE snapshots and dated history; bounded DuckDB observations | OHLC candlesticks, line, horizontal signed bars, heatmap, tables and SQL controls |
| [News Desk](../sidecar/builtin-apps/news-desk/README.md) | Headlines, Reading list, Sources & refresh | Bounded publisher feed records and local bookmarks in app state | Responsive article cards, category/text controls, original links and source receipts |
| [Project Activity Desk](../sidecar/builtin-apps/project-desk/README.md) | Triage, Activity, Source ledger | Bounded public repository issue/PR/commit samples; local lanes in app state | Keyboard/pointer board, timeline, exact tables and retrieval receipts |
| [Personal Finance Workbench](../sidecar/builtin-apps/finance-workbench/README.md) | Overview, Ledger, Import & methods | User-imported INR records in bounded DuckDB; integer-paise arithmetic | Category expense bars, daily signed net-flow bars, budget progress, exact ledger and import form |
| [Voice Desk](../sidecar/builtin-apps/voice-desk/README.md) | Notes (capture, list, editor), Action items | Notes and their action items in app state; dictation and read-aloud through host voice actions | Capture box, searchable note cards, autosaving editor, checklists, two-step delete |

## Install and operate

New source data directories seed the shipped packages once. Apps → Add Reference App and the administration console discover available packages from their actual manifests and let the user choose a missing reference. Installation leaves schedules off and grants no integration permissions. Existing published packages and edited skills are not silently overwritten. Source builds and installed desktop builds are separate; installation of a reference in an old executable does not upgrade its runtime.

News Desk and Project Activity Desk use the existing Web pages integration and exact web__fetch_page tool. Enable the integration and deliberately choose its fetch_page policy; Ask/off cannot be bypassed. The default four news feeds are categories from one publisher, not evidence of publisher diversity. Feeds are configurable. Market Terminal uses its documented NSE integration. Finance needs no remote service, credential or real personal data for its synthetic verification.

News/project optional 15-minute refresh and market optional 5-minute refresh run only while the host and computer are awake/running. Surface polling displays committed updates. This is not continuous source streaming, a daemon or proof of sustained unattended operation. Missed intervals are skipped; failures retain their receipts and source timestamps.

## Documentation and extension method

Every package contains README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md. The [authoring template](../sidecar/builtin-skills/app-authoring/references/package-template.md) specifies each document and its completion checks. The maintenance checklist and app-debugger require source, state, authority, schema and documentation to agree. Studio's shared scaffold generates the four docs with a real local counter; a domain workflow still needs its own implemented behavior and verification.

These documents travel with app source and drafts. They are not skill-loader manifests, execution grants or a publication validator. Ordinary actions execute code without a model request. Use the existing governed integration path; credentials stay with the host. One canonical owner feeds independent visual and spoken projections. Do not add a parallel renderer, connector, database writer or narration store. General missing visual capabilities belong in Projection's owning repository; app-specific source/units/calculations belong in the app.

## Verification

Run npm test, npm run typecheck and npm run build. On macOS with the existing sandbox helper, run:

```sh
node scripts/market-terminal-check.ts --live
node scripts/reference-apps-check.ts --live
node scripts/app-authoring-check.ts
```

The live scripts read public or configured sources into isolated app data. Finance inputs are explicitly synthetic. The authoring script exercises the native reference chooser, scheduling opt-in and actual Studio source/draft preservation at wide/narrow widths. Source/value checks, actual interactions, persisted results, screenshots and run receipts are evaluated separately. See [Evaluation](EVALUATION.md) and [Handover](HANDOVER.md) for the current evidence, retained failures and unresolved gates.

Remaining boundaries: News Desk has exact URL deduplication, not semantic event clustering or generated summaries. Project counts describe retrieved samples, not exhaustive backlog or remote writes. Finance is imported cash flow, not bank synchronization or an account balance. DuckDB uses bounded atomic snapshots rather than an unbounded persistent volume. Specialist chart gaps and model authoring gates remain open in the market audit and evaluation; adding references does not close them.

## Practical setup and ownership acceptance

Each app exposes host-owned Settings: required connection readiness and global permission scope, direct integration setup, schedules, last-run status, package/data details and links to domain views/source documentation. Missing data access opens setup before a manual refresh executes. No policy is silently promoted; interactive app Ask approvals and per-app tool-policy overrides remain unsupported. App actions/edits are consumed by the app runtime, and chat/task continuations require their own actual mounted surface instance. Local table controls do not dispatch a model request. Canvas action progress/errors use its existing top status region. Verify these boundaries using scripts/apps-check.ts and scripts/app-authoring-check.ts, plus scripts/control-layout-check.ts for generic action measure, compact density, wrapping and explicit layout overrides.
