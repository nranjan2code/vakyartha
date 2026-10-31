# Containment gap audit (2026-10-31)

The desktop worker now runs under `vaksb worker` with only its own data directory writable, the bundled resources readable, no network and no secret values. Model chat was moved behind Rust (native provider transport). Every other capability that touches the outside world still runs inside the worker and fails. This audit lists each gap, the evidence and the Rust-owned boundary that should replace it.

## How it was checked

- A probe under the same `vaksb worker` grants as [worker.rs](../../src-tauri/src/worker.rs) (`--read resources --write worker`, `--no-addons`):
  - child process spawn: works
  - HTTPS fetch, loopback fetch to Ollama `:11434`, DNS lookup: all fail (`fetch failed`, `ENOTFOUND`)
  - reading `~/Vakyartha-Home`, `~/Downloads`: `EPERM`
  - `vaksb run --workspace … -- /bin/cat` from inside the worker: `Failed to create sandbox: Operation not permitted at /private/tmp/vaksb-supervisor-*` (ignores `TMPDIR`; nested containment refused)
- `curl` to `https://mcp.nseindia.in/bhavcopy/cm/mcp` `initialize` from the host shell: HTTP 200 (the server is fine).
- Installed app data (`~/Library/Application Support/com.nranjan2code.vakyartha/worker/`): no `settings.env`, empty `integrations/`, empty `catalog-cache/`, tool log only shows `list_realms`, engine log shows `ollama/lfm3` errors.
- Window CSP in `tauri.conf.json`: `connect-src 'self' ipc: http://ipc.localhost`.

## Gaps

| # | Capability | Fails because | Seen as | Owning boundary |
|---|---|---|---|---|
| 1 | Sandbox project folder | `validateSandboxWorkspace` ([sandbox-status.ts](../../sidecar/sandbox-status.ts)) stats the path inside the worker, which has no read grant | "This folder does not exist or cannot be read" | Rust already has `control_validate_workspace_folder` / `control_register_workspace` / `control_bind_workspace`; Sandbox page still writes `VAK_SANDBOX_WORKSPACE` through worker settings. Second, worker-side `WorkspaceRegistry` duplicates the Rust registry (two writers). |
| 2 | Sandboxed execution (`run_command`), realms | Worker spawns `vaksb run`; nested containment cannot be created | Fails even once #1 is fixed | Rust supervises `vaksb run` / realms (process supervision is Rust's per rule 8); worker sends a validated request over the private pipe |
| 3 | Local stdio MCP servers with OS isolation on | `@vak/mcp/client` spawns `sandboxBin run -- …` from the worker (same as #2) | Server never starts | Same Rust-supervised launch as #2 |
| 4 | Local stdio MCP servers, isolation off | Child inherits worker containment: no network, no reads outside worker dir (e.g. filesystem server folders) | Server starts, its tools fail | Same Rust launch, with per-server grants (declared folders, declared hosts) |
| 5 | Remote HTTP MCP servers (NSE, Kite, Notion hosted, …) | `@vak/mcp/client` calls global `fetch`; worker has no network | "NSE: fetch failed", no tools listed | Native integration transport in Rust: host from the pinned catalog entry, egress check, approval, streaming |
| 6 | Integration install (npm source) | npm needs `registry.npmjs.org`; no network | Install fails; `integrations/` stays empty | Rust runs the pinned install (`--ignore-scripts --before=…`) or a Rust-mediated registry fetch into the worker grant |
| 7 | Integration/marketplace catalog and images | `marketplaces.ts` uses `fetch` / `pinnedFetch` | `catalog-cache/` empty | Native fetch for catalog hosts |
| 8 | Telegram channel | `@vak/telegram` uses `fetch`; and token never reaches the worker (see #11) | Channel cannot start | Native channel transport for `api.telegram.org` with the token held by Rust |
| 9 | Hosted voice (OpenAI/ElevenLabs/Gemini STT and TTS), Whistle install, Ollama voice packs | `sidecar/voice/*` uses `fetch`; keys missing (#11) | Dictation / speech fail on desktop | Native transport operations for voice endpoints (as done for chat) |
| 10 | Media generation (OpenAI/Gemini image, fal, Luma), URL attachments, OCR | `media/*` uses `pinnedFetch`; OCR calls Ollama `/api/generate`, which the native Ollama route doesn't allow (only `tags`/`show`/`chat`) | Generation and OCR fail | Extend native operations: media providers, Ollama `generate`/`embed`, public URL fetch with Rust address pinning |
| 11 | Every non-chat credential | `nativeSecrets().get` always returns `undefined`; `sidecar_command` only reports presence for a hard-coded list of model keys (no `TELEGRAM_BOT_TOKEN`, `ELEVENLABS_API_KEY`, fal/Luma, MCP server keys) | Settings show "add its token" after saving it in the vault | Credentials stay in Rust; each native operation attaches its own key. Presence list must come from the settings catalog, not a fixed array |
| 12 | System 1 decision engine and webview decision providers | `src/decision/*` calls `fetch` to `127.0.0.1:11434/v1/systemone`, TypeSafe, OpenAI, OpenRouter from the webview; CSP blocks all of them; also puts provider keys in the webview | Turn shaping silently falls back to heuristics | Decision calls go through the native provider transport (add `systemone` operation); no keys in the webview |
| 13 | Custom egress hosts | `VAK_EXTRA_EGRESS_HOSTS` is a worker setting; `check_egress_endpoint` takes the custom list from its caller | A compromised worker/webview can widen egress | Rust stores the user-approved list and reads it itself |
| 14 | Egress allowlist maintenance | `ALLOWED_EGRESS_HOSTS` in `policy.rs` is hard-coded and mirrored in `sidecar/egress.ts` | Every new catalog server needs a Rust edit and a TS edit | Rust derives integration hosts from the pinned catalog plus user approval; delete the TS mirror |
| 15 | Error wording | Worker `catch` blocks collapse `EPERM` into "does not exist" / "fetch failed" | Users can't tell containment from real failure | Native operations return typed refusals ("not permitted by containment", "needs approval") |

Not confirmed: `ollama/lfm3` errors (two in the log). Could be the model, or a request the native Ollama route rejects; needs the error text.

## Done

- 2026-10-31, step 1 (native egress), first consumer remote MCP: worker sends `egress_request` frames; Rust ([egress.rs](../../src-tauri/src/egress.rs)) admits plain HTTPS to `INTEGRATION_HOSTS` only after the user allows that host on the integration page (`egress_set_approval`, stored in the native root), strips all but MCP protocol headers, refuses redirects, and relays the response on the provider frame family. On desktop `globalThis.fetch` is this channel, so Telegram, catalog and voice calls now fail with a clear approval or HTTPS message instead of `fetch failed`. Removed: `sidecar/egress.ts`, `check_egress_endpoint`, `VAK_EXTRA_EGRESS_HOSTS` and the Sandbox page allowlist/tester. Closes #13, #14 for hosts; #5 for credential-free servers.
- 2026-10-31, step 1 credentials: `shared/integration-egress.json` (compiled into Rust) binds each approvable host to at most one vault key and header. Integration keys are saved with `vault_set` from the integration page; the worker's `nativeSecrets` knows presence only and reads a present key as a marker; Rust attaches the real key for that host. Covers Tavily, GitHub MCP and ElevenLabs. `policy.rs` keeps only `MODEL_API_HOSTS`. Closes #11 for header keys.
- Still open from step 1: Telegram (token in the URL path), Databricks (per-workspace hosts), `pinnedFetch` callers (#10), loopback Ollama operations. Local servers with env keys (Brave, Notion, Context7) receive the marker until step 2 launches them from Rust.
- 2026-10-31, steps 2 and 3, piece A: Rust ([sandbox.rs](../../src-tauri/src/sandbox.rs)) runs every vak-sandbox helper call. The worker sends `sandbox_request` frames naming a chat session (or none) and helper arguments; Rust resolves the folder from its registry binding or the Sandbox page folder (`sandbox_set_folder`, admitted by `WorkspaceAdmissionPolicy`, stored natively), owns the Realm store in the native root, assigns a chat's Realm, checks a Realm's base path against the resolved folder, and refuses paths, stores and `create` in worker-built Realm arguments. Runs without a chat folder use create → exec → destroy on a temporary Realm. App runs and skill rehearsals use `run_scratch`, confined to the worker's data folder. Decided with the user: the OS-isolation switch is removed (always contained) and command execution, Realms and folder binding are desktop-only. Removed: `sandbox-realms.ts`, `workspace-registry.ts`, the worker workspace/project routes, export/import routes, `VAK_SANDBOX_WORKSPACE`, `VAK_SANDBOX_ENABLED`, `validateSandboxWorkspace`, `scripts/sandbox-check.ts`, `scripts/folder-workspace-outcome.ts` and their tests. Closes #1, #2.
- Reopened by piece A: the FOLDER6 primary-local folder outcome gate ran through the deleted worker path; it must be re-run through the desktop app before it counts as passing. Realms created before this change live in the old worker store and are not migrated.
- Still open (piece B): stdio MCP servers and npm installs launched by Rust (#3, #4, #6); tool approval enforcement still runs in the worker.

## Suggested order

1. **Native egress operation (generic, Rust)**: one `egress_request` frame, host checked against catalog-derived plus user-approved hosts, Ask by default, credentials attached by Rust, streaming. Fixes #5, #7, #8, #9, #10, #12 and removes the TS mirror (#13, #14).
2. **Rust-supervised command and server launch**: `vaksb run` / realms / stdio MCP started by Rust with per-request grants. Fixes #2, #3, #4, #6.
3. **Workspace folder through the existing Rust registry**: Sandbox page uses `control_*` workspace commands; delete worker `WorkspaceRegistry` and `validateSandboxWorkspace` (#1).
4. **Credential presence from the settings catalog** (#11) and typed refusal messages (#15).

## Framework touchpoints (rule 1)

- `@vak/mcp/client` uses global `fetch` and spawns processes itself. Replacing `globalThis.fetch` app-side can carry #5, but stdio launch (#3, #4) needs an injectable launcher in Projection.
- `pinnedFetch` (`@vak/providers`) does its own DNS and sockets, so it bypasses a replaced global `fetch`; Telegram media and app media use it. Projection needs an injectable transport there too.
- `@vak/telegram` `api.ts` uses global `fetch` (app-side replacement works).
