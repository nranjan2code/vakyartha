# Desktop FinOps

FinOps is a product feature of Vakyartha (desktop app and its browser version). The framework remains responsible for projection and provider execution; no pricing, accounting, retention, or FinOps UI belongs in the [Projection](https://github.com/nranjan2code/Projection) packages (`framework/packages/*`).

Open **Settings → FinOps** for the same turn-by-turn views used to inspect the installed app's logs:

- Whole-turn duration, including tool and approval waits.
- Context composition at the first model request: user/actions, assistant text, projection arguments, other tool arguments, engine feedback, and external results.
- Conversation characters repeated across every model step in a turn.
- Generated UI arguments, other tool arguments, and assistant text.
- Provider-reported input, output, and cached input tokens. An input total without cache detail is shown separately, along with prompt cache hit rate percentage (`cachedInput / input * 100%`).
- Estimated API cost, with missing usage or rates explicitly unknown.

The open page refreshes every five seconds while visible and not editing a rate, and manual Refresh updates it in place. Filters, selected turn and unsaved rates survive refresh. The freshness line distinguishes measured/reconstructed counts and configured model rates. Charts draw the latest 200 filtered turns; details and CSV retain all filtered history. Telemetry appears after a turn completes, rather than as live token-by-token billing.

Filter by work type (task runs or ordinary chats) and conversation, select a turn or click a chart bar for details, and export the current selection as CSV. Details include system instructions, tool schemas, and native replay sizes for new turns. Native replay overlaps visible content; encrypted reasoning length is not a token count.

## Accounting boundary

The optional media plugins retain numeric provider usage where returned, but currently display their monetary charge as unknown. Their hosted generation/editing costs are excluded from the chat-token estimate. Approval to upload or generate is not a monetary ceiling; no estimated or actual media charge is fabricated. See [MEDIA-TOOLS.md](MEDIA-TOOLS.md).

`sidecar/finops.ts` decorates the app's provider instances and observes their requests and streamed usage. `AsyncLocalStorage` isolates concurrent chat requests over private desktop IPC or development HTTP. Provider events pass through unchanged; tool policies, approvals, generation and projection stay in the existing engine. The host's existing admission checks also protect `/api/finops`.

The app saves numeric telemetry in `<dataDir>/logs/finops.jsonl`, with owner-only creation permissions. The file rotates at 10 MB and retains one previous file. It records session/model identifiers, timings, character counts, token usage and call counts, never prompt text, tool arguments/results, credentials or native reasoning content. An interrupted or missing usage report stays unknown. Ledger errors are logged and do not prevent a reply.

Current scope is desktop private-IPC and playground HTTP chat turns and in-process task runs. Task usage is attributed to its canonical session, so existing session filters can inspect it. This is observation, not a cumulative task spending ceiling. Calibration, channel runs, integration setup tests and external agents are excluded. Local endpoints have a zero API rate; their compute, electricity and hosting costs are excluded.

## Historical sessions

For older sessions, the app reconstructs the visible conversation and model steps from saved messages and timeline durations. It assumes the default last 10 turns because the original per-turn history preference was not saved. It labels these turns reconstructed, omits unrecorded prompt/schema/native sizes and does not invent token usage or paid spend. New telemetry replaces the corresponding reconstructed turn.

Character counts measure the provider-neutral request content, using JavaScript string lengths. They exclude transport envelopes and are not estimates of token counts or billed input. Requests with structured output count that response as projection output.

## Prices

Enter exact provider/model rates under **Model rates**, in USD per million input, cached input, and output tokens. Standard preset rates for major providers (OpenAI `gpt-4o`/`o1`/`o3-mini`, Anthropic `claude-3-5-sonnet`/`haiku`, Google Gemini `gemini-2.5-pro`/`flash`) can be applied with one click. They are saved in `<dataDir>/finops-rates.json` with an update timestamp. They are manually configured, not fetched or assumed from a model name.

Costs use the **current** configured rates, including when viewing previous turns. They are estimates, not historical invoices, and exclude cache-write premiums, provider extras and tool fees. Unknown cached input prevents a discounted estimate unless cached and uncached rates are equal. A partially observed paid run stays unknown even if another step reported usage. Totals show the known subtotal and the number of turns with unknown cost.

## Validation

`node scripts/finops-check.ts` verifies automatic/manual refresh, selection and draft preservation, exact configured estimates and responsive layout in WebKit at 1100/620 pixels. `test/finops.test.ts` covers stream transparency, persistence without prompt content, per-step usage/cost, concurrent chats, incomplete streams, historical reconstruction, deduplication and rate validation. Run `npm test`, `npm run typecheck`, and the desktop UI build. Check charts and turn selection in `scripts/webkit-check.swift`, since the installed window uses WebKit.


## Task and run attribution

The task dispatcher supplies its task/run IDs directly to the accounting scope; model output and HTTP chat payloads cannot assign them. Each observed turn retains these IDs without goal text or result content. Concurrent and approval-suspended runs keep independent scopes. FinOps details and CSV include both IDs. Schedule → Run history → Show usage requests only that run's numeric summary; viewing usage never calls a model or integration. Usage for a running task may not be saved until its observation scope exits.

Counts and estimates cover measured model requests only. Missing/incomplete token reports, absent ledger records and unpriced models stay unknown. Model API estimates exclude tool/server charges, compute and hosting; local model API cost is zero, not a claim of zero total operating cost. Estimates use the currently configured rates and are not a spending ceiling. Ledger rotation can remove earlier measurements; task records and evidence are retained separately. Cumulative execution reservations now live in the task journal (ADR-013), separately from these measured usage records. Refused generation requests never reach the observer. A reservation may remain charged when actual dispatch is uncertain; it is not proof of billing. Monetary ceilings remain unsupported.
