# Desktop runtime audit — 2026-10-27

Vakyartha keeps one Node engine child owned by the Tauri shell. Desktop opens no HTTP listener. The main window uses native IPC channels; the shell relays versioned messages over anonymous stdin/stdout pipes. The `vak://localhost` value is an internal routing identifier, not a network endpoint. Closing the parent pipe shuts down the engine; the shell retains its four-second quit deadline. A ten-second handshake deadline prevents a stuck child from hanging startup.

This is the user's selected process boundary. Node is not embedded into the native process, and execution/data ownership remains in the engine. General request/response streaming lives in Projection's public `createFetchHandler` and injectable `VakClient` transport, pinned to pushed `479323e`. Browser mode remains an explicit loopback development adapter. Provider calls and user-selected integrations still need their existing outgoing network/process capabilities.

## Boundary and security

Only the main local app window may invoke the engine commands. The bridge accepts known methods, `/api/` routes and content-type/range headers; callers cannot supply an admission token, origin or host. The engine injects its own admission metadata and retains the same host checks, permissions, task ownership and canonical persistence. There is no second task/session store.

The protocol has a version handshake, bounded identities, 32 concurrent requests, a 32 MiB request-body limit, a 48 MiB aggregate input queue and 64 KiB acknowledged response chunks. A stopped consumer expires after 30 seconds. Cancellation releases response readers and existing close handlers. The general host adapter applies producer backpressure, splits large writes and caps queued writes at 8 MiB. Chat disconnection retains the existing detached-execution behavior; Stop still uses the canonical cancellation path.

Release startup removes inherited Node preload/loader options, module paths, TLS-verification disablement, diagnostic cache/coverage destinations and development overrides. Native addons are disabled in the engine, which imports only built-ins. Explicit integration processes keep their existing isolation and environment rules. The desktop/browser entry points use umask 077 for newly created files; existing files are not retroactively migrated.

## Dependencies and packaging

There are two direct frontend packages, both established native-shell bindings. The framework has no third-party runtime SDKs. Build-only dependencies stay outside the shipped engine. All 77 registry entries in the lockfile have integrity hashes; this includes platform alternatives, not 77 packages shipped in the sidecar. Fresh npm ci installs 35 packages, audits 47 including workspaces and reports zero known vulnerabilities. Registry verification covered 24 installed packages: all 24 have verified signatures and 14 have verified attestations. These checks do not establish that dependency code is harmless.

Repository npm installs disable dependency lifecycle scripts and save exact versions. The two development ranges are replaced with their already-locked exact versions, and native direct dependency constraints now match the existing Cargo lock exactly. No dependency or dependency version was added. The only locked install hook is optional development file watching; clean installation and builds succeed without running it.

Packaging rejects unexpected external imports and requires a single engine module. It omits the frontend public directory from engine resources, since the UI already ships separately. npm loses only its top-level docs/man pages; its implementation, dependency files and licenses remain intact. Integration installation still uses the existing pinned, script-free framework lifecycle. Replacing npm with a custom installer would expand the maintenance/security surface rather than merely remove unused documentation.

The sandbox helper is rebuilt with --locked and an explicit host target; any failed build stops packaging instead of silently copying an old binary. A runtime manifest records versions, source commits/dirty flags and SHA-256 receipts. File hashes cover file content; directory hashes cover a sorted index of relative names, sizes and per-file hashes. The manifest is diagnostic provenance, not a signature or runtime tamper protection. Sandbox remains an adjacent repository rather than a new app-owned implementation.

Measured release resources: Node 122,545,856 bytes, npm 9,541,859 bytes and engine approximately 730 kB. Removing duplicate assets and npm documentation saves about 3.49 MB of resource content even after adding the private transport. Node still dominates package size; these savings are not a claim that the whole app shrank by 25 percent. Keep the signed official runtime rather than introducing a custom stripped runtime/build chain without measured benefit.

## Speed and FinOps

Five isolated baseline starts had median readiness 473 ms and approximately 74 MiB resident memory. This does not explain the earlier minute-long model authoring duration. No provider-latency improvement is claimed. The native IPC smoke measured a 2 ms median for 20 local info requests and 64 ms to upload a valid 1,048,620-byte WAV attachment; these are measurements on this Mac, not a cross-platform performance budget.

The historical FinOps view repeatedly scanned the full ledger for every saved reply. A temporary, per-view sorted lookup now preserves the same session/provider and strict timestamp-skew matching without a persistent cache or new writer. For 200 synthetic sessions / 10,000 measured turns, the five-run median fell from 420 ms to 36 ms. Session/ledger reads and parsing remain synchronous; very large history still warrants profiling before an asynchronous storage redesign.

FinOps had real telemetry but snapshot-like presentation: opening Settings fetched once, and Refresh rebuilt the page. It now refreshes in place every five seconds while visible, preserves filters/selected turns/price drafts, and shows freshness, measured/reconstructed counts and configured-rate coverage. Charts show the latest 200 filtered turns; details and CSV retain the full filtered history. Data appears after a turn finishes, not as live billing during generation.

A read-only numeric inspection of the installed ledger found 162 measured turns and no model price entries. Hosted costs therefore correctly remained unknown. Prices remain explicit user configuration, local API rates remain zero, and missing token/cache data is never invented.

## Verification and limits

The isolated source snapshot passes 181 app tests, 398 Projection tests/replay, three Rust tests, typecheck, UI/engine builds and runtime signature/latest-LTS checks. Fresh installs run without dependency scripts. FinOps WebKit at 1100/620 verifies automatic/manual refresh, preserved filters/turn/draft, missing-rate disclosure and the exact $0.000328 configured estimate. Existing canvas, skills and standard surface/chart WebKit checks pass.

Run `node scripts/desktop-check.ts` for the native private-IPC smoke. It builds a separate test identity with isolated data/Keychain state, publishes and renders a canonical surface, opens FinOps, uploads a valid WAV, checks the Node child for zero listening TCP ports, then verifies parent exit leaves no orphan. No paid or live model call is needed. This is a transport/rendering test, not a new model-authoring outcome pass.

Evidence for this review is retained under ignored `.vak/evaluations/node-runtime/`; the isolated snapshot is `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-private-snapshot-2119spgm/`. The native receipt is under `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-desktop-private-BA7afS/`. Early offscreen polling checks correctly stayed idle while hidden; the WebKit test now explicitly simulates visibility. Native test identities are unique per run to avoid concurrent single-instance collisions. The shared workspace's in-progress sandbox compile failure was retained; packaging passes against committed sandbox source in the isolated snapshot.

These are source changes. The installed application has not been replaced, and no public release, channel restart, paid call or model acceptance-gate closure is implied. Existing provider/source/value/interpretation/interaction/receipt failures remain open.

References: [Tauri IPC](https://v2.tauri.app/concept/inter-process-communication/), [Tauri process model](https://v2.tauri.app/concept/process-model/), [Node embedding API](https://nodejs.org/api/embedding.html), [npm installation configuration](https://docs.npmjs.com/cli/v11/using-npm/config/), [Vite build options](https://vite.dev/config/build-options.html).
