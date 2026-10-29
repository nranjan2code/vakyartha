# Research basis and limits

Reviewed for this design on 2026-10-29. This is a research bibliography, not an integration recommendation or dependency approval. Product contracts use capability language; external sources inform tradeoffs rather than define Vakyartha's authority model.

## Primary sources

| Reference | Observation used | Boundary on the conclusion |
| --- | --- | --- |
| [Controlled study of agent-system scaling](https://arxiv.org/abs/2512.08296), revised 2026-04-08 | Across 260 configurations, architecture/task alignment matters; tool-heavy and sequential work can incur coordination penalties | Benchmark/model-specific findings; predictive fit is imperfect and does not select Vakyartha's policy automatically |
| [Engineering report on parallel research](https://www.anthropic.com/research/multi-agent-research-system), 2025-06-13 | Broad independent investigations benefit from separate contexts; duplicated work, coordination and token overhead are material | Internal evaluation and a research workload; no universal speedup or required agent count |
| [Failure taxonomy for agent collaboration](https://arxiv.org/abs/2503.13657), revised 2025-10-26 | Analysed traces identify system design, inter-agent alignment and verification failures | Descriptive taxonomy; many failures also occur with one agent, and categories are not a complete causal detector |
| [Review of authorization architectures](https://arxiv.org/abs/2609.15906), submitted 2026-09-14 | Traceable human authority, runtime authorization and bounded delegation need end-to-end treatment | Research review/proposal, not proof that a particular implementation is secure |
| [Bounded delegation security study](https://arxiv.org/abs/2608.15888), submitted 2026-08-16 | Scope/budget propagation and action-composition restrictions must be enforced outside model text | Preprint; formal properties have stated assumptions and experiments retain utility/security tradeoffs |
| [Agent evaluation methods](https://www.anthropic.com/research/demystifying-evals-for-ai-agents), 2026-01-09 | Combine deterministic, calibrated semantic and human checks; inspect actual outcomes and permit valid alternative approaches | Checker quality and task definitions need independent review; a model score is not automatic truth |
| [Long-running execution harness lessons](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents), 2025-11-26 | Explicit progress artifacts and end-to-end checking address continuity and premature completion | Engineering experience; its implementation pattern is not adopted as a new runtime dependency |
| [Interrupted execution and replay semantics](https://docs.langchain.com/oss/python/langgraph/interrupts), living documentation accessed 2026-10-29 | Resuming around an interruption may rerun code; side effects need explicit isolation/idempotency treatment | Source-specific replay semantics; Vakyartha must specify its own behavior rather than assume identical execution |
| [External agent lifecycle and authorization specification](https://a2a-protocol.org/latest/specification/), living specification accessed 2026-10-29 | Task/message interoperability does not supply application-specific authorization scope or revocation semantics | External agent interoperability is deferred; no protocol/version or SDK is adopted by this proposal |

Living references can change after this review. Before relying on an external protocol or implementation detail, freeze its exact revision and compatibility expectations. Research publication dates and access dates are distinct; do not present a living page as an immutable October snapshot.

## Design synthesis

These sources support testing delegation against a single-agent baseline, separating authorization from instructions, protecting original acceptance checks, accounting for all descendants and preserving uncertainty after interruption. They do not establish that every complex task needs children, that several agreeing agents are independent evidence, that native code alone supplies isolation, or that local deduplication creates exactly-once external effects.

The proposed depth/count limits, latency targets, watchdog window, native control aggregate and rollout order are local design judgments. They need the decisions and evidence in [validation and rollout](VALIDATION-AND-ROLLOUT.md). They are not benchmark guarantees or accepted implementation defaults.
