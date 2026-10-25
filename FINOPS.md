# Desktop FinOps

FinOps is a product feature in `apps/desktop`, shared with the playground. The framework remains responsible for projection and provider execution; no pricing, accounting, retention, or FinOps UI belongs in `packages/*`.

Open **Settings → FinOps** for the same turn-by-turn views used to inspect the installed app's logs:

- Whole-turn duration, including tool and approval waits.
- Context composition at the first model request: user/actions, assistant text, projection arguments, other tool arguments, engine feedback, and external results.
- Conversation characters repeated across every model step in a turn.
- Generated UI arguments, other tool arguments, and assistant text.
- Provider-reported input, output, and cached input tokens. An input total without cache detail is shown separately.
- Estimated API cost, with missing usage or rates explicitly unknown.

Filter by chat, select a turn or click a chart bar for details, and export the current selection as CSV. Details include system instructions, tool schemas, and native replay sizes for new turns. Native replay overlaps visible content; encrypted reasoning length is not a token count.

## Accounting boundary

`sidecar/finops.ts` decorates the app's provider instances and observes their requests and streamed usage. `AsyncLocalStorage` isolates concurrent HTTP chat requests. Provider events pass through unchanged; tool policies, approvals, generation and projection stay in the existing engine. The host's existing admission checks also protect `/api/finops`.

The app saves numeric telemetry in `<dataDir>/logs/finops.jsonl`, with owner-only creation permissions. The file rotates at 10 MB and retains one previous file. It records session/model identifiers, timings, character counts, token usage and call counts, never prompt text, tool arguments/results, credentials or native reasoning content. An interrupted or missing usage report stays unknown. Ledger errors are logged and do not prevent a reply.

Current scope is desktop/playground HTTP chat turns. Calibration, Telegram/channel runs, integration setup tests and external agents are excluded. Local endpoints have a zero API rate; their compute, electricity and hosting costs are excluded.

## Historical sessions

For older sessions, the app reconstructs the visible conversation and model steps from saved messages and timeline durations. It assumes the default last 10 turns because the original per-turn history preference was not saved. It labels these turns reconstructed, omits unrecorded prompt/schema/native sizes and does not invent token usage or paid spend. New telemetry replaces the corresponding reconstructed turn.

Character counts measure the provider-neutral request content, using JavaScript string lengths. They exclude transport envelopes and are not estimates of token counts or billed input. Requests with structured output count that response as projection output.

## Prices

Enter exact provider/model rates under **Model rates**, in USD per million input, cached input, and output tokens. They are saved in `<dataDir>/finops-rates.json` with an update timestamp. They are manually configured, not fetched or assumed from a model name.

Costs use the **current** configured rates, including when viewing previous turns. They are estimates, not historical invoices, and exclude cache-write premiums, provider extras and tool fees. Unknown cached input prevents a discounted estimate unless cached and uncached rates are equal. A partially observed paid run stays unknown even if another step reported usage. Totals show the known subtotal and the number of turns with unknown cost.

## Validation

`apps/desktop/test/finops.test.ts` covers stream transparency, persistence without prompt content, per-step usage/cost, concurrent chats, incomplete streams, historical reconstruction, deduplication and rate validation. Run `npm test`, `npm run typecheck`, and the desktop UI build. Check charts and turn selection in `scripts/webkit-check.swift`, since the installed window uses WebKit.
