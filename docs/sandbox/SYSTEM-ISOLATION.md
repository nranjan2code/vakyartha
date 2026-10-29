# Required system isolation

Requested 2026-10-29. The user selected a minimal trusted broker for credentials, approvals, persistence and authorized network operations, with isolated execution workers. This is required implementation work. It is not a statement of current protection or an accepted runtime outcome.

## Target boundary

The broker holds only the authority required to admit operations, obtain credentials, perform authorized outbound requests and commit canonical state. Ordinary engine computation, provider response processing, generated code and external tool execution must not acquire that ambient authority merely because they serve a chat or app.

The current engine combines those responsibilities. Renaming that process a broker does not meet this requirement. Each operation needs an explicit owner and grant; isolate execution from credential, network and persistence authority. Reuse the existing desktop UI/engine connection. Any necessary worker connection must be private, narrow, versioned and bounded; it must not add a shell relay or network listener. Keep each durable entity's existing single writer.

| Boundary | Required behavior | Owner |
| --- | --- | --- |
| Host execution | Execution workers receive explicit inputs and confined working data; no ambient Keychain, app-state, original-project or network access | App composition, sandbox enforcement |
| Provider requests | Broker resolves the selected configured provider and authorized endpoint; credentials remain broker-owned; bounded response processing has no independent network or persistence authority | App authorization, general provider transport in Projection |
| Local integration execution | Required containment is checked before launch and retained through descendant cleanup; missing/incompatible enforcement refuses startup | Projection MCP lifecycle, sandbox enforcement |
| Remote and built-in integration calls | Existing tool identity, schema, approval and current policy checks precede broker dispatch; tools receive only declared capability scope | Existing integrations, app broker composition |
| Resource enforcement | Explicit CPU and memory limits have platform-specific enforced semantics and receipts | Sandbox backend, app configuration |
| Linux execution | Real filesystem, network, environment, descendant and resource isolation; unavailable kernel support refuses execution | Sandbox backend, client platform admission |

Authorized network access remains possible. The broker is necessarily trusted for the operations it admits; this design does not claim that authorization eliminates all privileged code.

## Broker contract

1. Worker operations identify a live task/session/app, invocation, operation ID and requested capability. The broker derives authority from its own current records; worker-supplied identifiers, labels, endpoint names or receipts are not grants.
2. Use the existing integration catalog, schemas, policies, approvals, cancellation and logs. No parallel connector path, credential store, plugin lifecycle or task authority.
3. Provider access names a configured provider/model and admitted request operation. Workers cannot supply arbitrary destination URLs, credential names, headers, local file paths or general fetch/command instructions. Custom endpoints retain explicit user configuration and endpoint-specific authorization.
4. Validate requests at the receiver, bound frames and queues before parsing, reject unknown versions/operations and oversized or malformed values, and bind replies to the admitted invocation. A stale, cancelled or unrelated invocation cannot commit state or consume another invocation's permission.
5. Check destination policy on redirects and resolved addresses, including loopback/private endpoints. A configured local provider receives only its explicit local grant. Do not treat an initial approved URL as authorization for a different destination.
6. Credentials are inserted only for the selected authorized destination and are absent from worker environments, arguments, files, logs, surfaced errors and returned receipts. External tool credentials retain the existing declared-variable rule; moving away from tool-owned credentials requires an explicit compatible broker protocol.
7. Streamed provider responses and tool output are bounded untrusted data. Parsing/rendering cannot request extra host authority. Preserve current output wrapping, source receipts and multiple interactive surfaces.
8. Revoke pending work when access is disabled. Propagate cancellation/deadlines and drain bounded queues. An interrupted request with uncertain external effects is recorded and never automatically replayed.
9. A durable commit remains with its canonical writer after existing validation and revision checks. Workers return candidates; they cannot directly change chats, settings, approvals, app records or original project files.
10. Required isolation never silently falls back to ordinary execution. Explicitly disabling isolation must be visibly distinct from a protected execution and cannot produce a successful isolation receipt.

## CPU and memory contract

Expose requested limits and effective enforcement separately. Invalid, unsupported or unenforceable required limits fail before target effects. Defaults must be explicit for commands, retained workspaces, app actions, engine workers and integration workers; persistent transports must not accidentally inherit a one-shot command lifetime.

CPU elapsed time, CPU execution time and CPU bandwidth are different measures. Define which is enforced, its unit, whether accounting covers descendants, and whether a worker may fork to escape its budget. A wall-clock timeout alone is insufficient evidence of a CPU quota.

Memory limits must name the accounted resource and include descendants according to the declared scope. A language heap option, database setting, manifest number, virtual-address limit or sampled RSS value cannot be presented as a hard aggregate physical-memory quota. If a platform offers only sampled termination, report its interval, overshoot and limitations separately; it does not close the hard-quota requirement. An enforceable platform boundary or a separately approved stronger execution environment is needed where native facilities are insufficient.

Limit events must terminate the contained process tree, retain verified cleanup and distinguish CPU exhaustion, memory exhaustion, wall timeout, cancellation, output exhaustion and containment failure. Record effective limits, backend and enforcement mode without turning absent measurements into zeroes. Resource accounting must not weaken the existing owner-death, execution-gate or quarantine rules.

## Linux contract

Use first-party backend code and existing dependencies/system APIs where practical. Any additional runtime, package or service still needs approval. Do not require a privileged host daemon by default. Probe the actual required kernel facilities and permissions, not just the executable version or operating-system name.

Filesystem grants, overriding denies, minimal environment and denied network must be enforced before target code starts. Namespace, filesystem and syscall restrictions must compose with descendant accounting, owner-death cleanup and private control storage. Prevent target access to host credentials, other processes, control descriptors, mount administration and containment/resource controls. Avoid a best-effort backend that reports availability without enforcement.

The same durable Realm implementation must retain review, promotion, recovery and rollback ownership. Linux support cannot introduce a second promoter or persistence writer. Cross-platform clients must consume the backend's actual capabilities and refuse unsupported execution rather than bypass platform checks.

## Implementation order and ownership

1. Freeze the intended grants, forbidden effects, CPU/memory semantics and receipt requirements. Inventory every existing host provider/tool/command path; establish deterministic latency, frame size and queue baselines before adding worker transport.
2. In the sandbox repository, implement/test truthful capability negotiation, resource enforcement and Linux containment. Preserve native supervised cleanup, leased execution and durable recovery contracts. Keep unsupported modes explicitly unavailable.
3. In Projection, add only general missing provider/MCP transport mechanisms: fail-closed admission, compatible confined transport, bounded/cancellable protocol and destination enforcement. Make changes in its owning checkout, test and push them before moving the app pin. Existing stdio supervision closes target stdin, so the present command wrapper is not assumed to be a usable persistent MCP transport.
4. In Vakyartha, compose the chosen broker and isolated workers, using existing settings, approvals, integration dispatch and persistence owners. Measure the private worker contract against the baseline. Preserve desktop private transport, channels and all interactive surfaces.
5. Run independent boundary/resource tests and full ordinary workflows. Package compatible helpers and effective-limit diagnostics. Verify the exact installed build separately; source changes do not upgrade it.

## Frozen acceptance scenarios

Use synthetic secrets, temporary projects and local test endpoints. No paid inference or real credential exposure is needed for containment checks. Keep failed receipts and expected effects unchanged while repairing a boundary.

| Gate | Required independent observation |
| --- | --- |
| Host worker isolation | Reads/writes of an outside canary, app-private records and original project fail; admitted workspace work succeeds; credential retrieval and direct network attempts fail |
| Provider mediation | An admitted configured endpoint succeeds through the broker; arbitrary endpoint/header/credential requests, redirect escapes, private-address rebinding and stale invocation IDs are refused before forbidden effects |
| Integration authority | Denial/off/revocation prevents dispatch; approved exact tool/schema reaches the existing adapter; output cannot authorize another operation; local tool containment cannot silently disappear |
| CPU enforcement | Bounded native CPU loop and descendant workload exhaust the declared scope; sleeping work does not falsely prove CPU enforcement; host remains responsive; cleanup is verified |
| Memory enforcement | Actual touched native allocations and descendant allocations trigger the declared memory boundary; peak/overshoot is measured independently; a heap-only or sampled limit does not pass as a hard quota |
| Linux containment | Real Linux execution proves permitted workspace IO, denied outside IO/network/environment leakage, descendant cleanup, owner death, quotas and unsupported-kernel refusal |
| Recovery | Worker/broker death and malformed/oversized messages preserve canonical state or explicit uncertain effects; no automatic replay or permission transfer; Realm recovery gates still hold |
| Compatibility | Private desktop IPC, provider streaming/cancellation, chat/task/app tool calls, source receipts, settings and channels work through the new boundary; multiple Canvas surfaces and local interaction retain their owners |
| Delivery | App/framework/helper revisions and capabilities match the packaged and installed runtime; installed canaries reproduce the containment/resource results |

The implementation checklist is in [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md#required-system-isolation--indestructible-engine--2026-10-29). Current bounded command/app behavior remains documented in [OVERVIEW.md](OVERVIEW.md) and the [app runtime contract](../sandboxed-apps/RUNTIME-CONTRACT.md). These gates remain open until implementation and evidence satisfy them.
