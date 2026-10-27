# Capability pipeline review — 2026-10-27

Scope: app chat/tasks, skill import/selection/loading, integration discovery/install/configuration, MCP transport, agent dispatch, approvals, result propagation and channel wiring. This is a source/contract review with offline and loopback regressions. No paid model call, external integration installation, installed-app replacement or live-channel restart was performed.

## How execution works

1. The app owns the curated/imported integration definitions and skill files. Projection owns integration installation, connections, tool adaptation and default policies. Credentials remain in the app's secret store.
2. Enabled skills contribute names/descriptions to system context. A counted model generation selects skills through `use_skill`, including an explicit empty selection. Their bodies load as local context, without external-operation authority. Further loads use the same loop.
3. Chat obtains tools from enabled, configured integrations. Tasks additionally restrict this set to selected integration IDs, check readiness/spending and journal operations. Skill selection withholds answer/external tools for its generation; it does not select an integration subset for later requests.
4. Native calls are parsed and checked against the supported argument-schema contract before execution. MCP adaptation enforces policy and waits for approval when needed. Integration revisions and cancellation are rechecked before dispatch.
5. MCP output is bounded and labelled as untrusted data. Error status travels separately from its text into agent history/events. Tasks retain operation identities, uncertainty and local output receipts; external outcomes still require independent verification.
6. Generated surfaces use the canonical store/projectors. Skill instructions do not execute scripts, expressions or local files. Multiple surfaces and interactive field edits retain their existing runtime.

## Defects addressed

- Captured tools could outlive disable/reconfiguration/removal. Integration revisions now invalidate old handles and chat grants, including refresh/install. A fresh run obtains current handles.
- A policy revoked while approval waited could still dispatch. Authorization and cancellation are checked again after approval.
- Native external arguments could bypass their declared types. Supported runtime validation now precedes approval and execution, including object-shape checks. The adapter also validates direct callers.
- MCP `isError` and user denial became successful tool events. Explicit result status now reaches the agent and UI; exact failed calls are suppressed within the run. Task receipt wrapping preserves structured results.
- Already cancelled MCP calls could be sent; timeout only abandoned the promise. Cancellation/timeout/close now terminate HTTP work and clean up pending timers/listeners. Cancellation cannot undo effects already received by a server.
- Unbounded JSON/SSE bodies and stdio frames were parsed before model-facing clipping. Transport parsing now has an 8 MiB limit.
- Positive Retry-After headers did not consume retry allowance. Every retry now consumes the finite allowance; an aborted wait cannot initiate another attempt.
- Incomplete native generations could dispatch external calls. Non-successful generation completion now prevents that dispatch. Ambiguous/reserved tool names are rejected before effects instead of silently overwriting a handler.
- An enabled-skill change could bypass selection for an already prepared system context. Stale selection context now fails explicitly. Root-level skill review also correctly lists supporting files that will not be imported.

## Boundaries and remaining work

- **Instruction-only skill compatibility:** imports retain SKILL.md, not referenced guides/scripts/assets. Review discloses this; installation is not proof that a complete upstream procedure is executable. No general dependency resolver or script runner is introduced.
- **Selection quality and context:** first selection sees recent user messages, not the full assistant/tool/workspace context. Follow-up intent and skill relevance still require live outcome evidence. All enabled integration schemas are offered after selection, so a large catalog can still inflate context. No tool-discovery router is added without measured need.
- **MCP subset:** the client supports tool listing/calling over stdio and HTTP, not a complete resources/prompts/subscriptions/authentication implementation. Tool results are reduced to text; accompanying structured or multimodal content is not preserved as a general typed artifact. These are capability gaps, not guarantees implied by an MCP connection.
- **Schema coverage:** native input validation uses the existing framework schema subset. It is not a complete external JSON Schema implementation or a substitute for server-side validation. Unsupported schema references fail rather than authorizing an unchecked call.
- **Trust and freshness:** curated default policies still depend on server annotations; publisher identity is not an audit. Cached metadata is not continuously refreshed, and hosted implementations can change. Local process HOME/environment isolation is not an OS sandbox.
- **Channel parity:** channel execution has its own provider path; app skill selection, MCP access and FinOps wiring are not automatically shared. Preserve that explicit capability difference until a channel approval/access design is implemented.
- **Accounting and outcomes:** model-request budgets count logical generations; bounded HTTP retries can produce additional transport attempts. Receipts and transport success do not prove interpretation, arithmetic or an external service's exactly-once behavior. Existing local primary-provider/source/continuation/interaction outcome failures remain open.

## Verification

Before changes:161 app tests,383 framework tests/replay and app typecheck passed despite the reproduced gaps. New regressions cover dispatch revocation, invalid arguments, explicit failure status, incomplete generations, duplicate names, HTTP cancellation/timeouts/close, oversized replies, finite retries and stale skill selection. After adoption of pushed Projection `adf0604`,163 app tests,393 framework tests/replay, both typechecks, framework package generation, UI build and wide/narrow canvas WebKit pass. These checks establish execution mechanisms, not a new model-reliability claim.
