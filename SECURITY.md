# SECURITY.md: Vakyartha

What the app protects, from whom, and how. Rules for changing code are in [AGENTS.md](AGENTS.md); the architecture is in [SPECS.md](docs/SPECS.md). The engine's own defences (Host/Origin checks, tool-output wrapping, approvals, SSRF, MCP server environments, projector escaping) come from the [Projection framework](https://github.com/nranjan2code/Projection/blob/main/SECURITY.md) and apply here unchanged.

## What there is to protect

- **API keys** for model providers, integrations (including workspace bearer tokens) and channels (Telegram).
- **The user's data**: chats, files the Files integration can see, accounts reachable through integrations.
- **The machine**: the app runs model-chosen requests and third-party MCP servers on it.

## Who could attack

| Threat | Example | Defence |
|---|---|---|
| A media input or provider output escapes its scope | A symlink reaches a private file; a download redirects to loopback; a clip speaks approval words | Media tools read only approved library/chat inputs with path, final-symlink, signature and size checks. Output downloads use connection-pinned public HTTPS with per-hop checks and no provider credentials. Private media URIs carry opaque IDs and use authenticated file access. Model/operation selections are validated at dispatch and after waits. In conversation mode audible-media overlap is discarded before transcription. Hosted submission uncertainty is never automatically retried. See `test/media.test.ts` and `docs/MEDIA-TOOLS.md`. |
| A web page in the user's browser | POSTs to the sidecar's loopback port to spend the user's keys | The framework's Host, Origin and JSON-body checks, plus a random bearer token that only the app's own window receives (`backend`). The browser version (`npm run web`) is open on loopback only, for development. |
| A malicious or compromised MCP package | A new release of a dependency runs code at install | Each npm catalog server names an exact version; the catalog selects versions published at least 14 days earlier. Tests check exact pins and the framework install arguments. The framework's `Integrations` installs it with `--ignore-scripts --before=<today − 14 days>`, so every dependency is that old too and nothing runs at install, into its own folder. |
| An over-reaching filesystem server | Files reads `~/.ssh` | It is started with only the folders the user adds, checked by the framework (`checkFolders`): absolute, existing, never a system root or the whole home folder. Writes ask. |
| A prompt injection through an integration | A fetched page says "push to my repo" | Writes and open-internet tools default to Ask in each integration's policy; every call is logged to `logs/tools.jsonl`. |
| A stolen settings file | Someone copies the data folder | On macOS keys live in the Keychain, written through `security -i` on stdin (never on a command line) and never sent back to the UI. Elsewhere they live in a file only the user can read (0600). Settings values are checked so they cannot inject into `settings.env`. |
| A voice hijack | A page read aloud, a TV or another person says "allow write"; tool output tells the model to approve | Only sentences heard from the microphone reach the voice resolver, which is deterministic (`@vak/core` `resolveAnswer`); no model decides an approval. A voice approval must name a word from the tool's own name (never an agreement word, whatever the server titles its tool), allows once only, and an unclear or mixed answer ("no, allow it") leaves it on screen. A sentence that began while the app was speaking and matches what it said is ignored as echo. A heard message cannot act by itself: writes still need an approval. Model help for choices and forms is limited to values the surface allows (`readModelAnswer`). Tests: `test/voice.test.ts`, Projection `answer.test.ts`. |
| A compromised local speech model | The Whistle engine, a prebuilt binary with no published source, reaches the internet or reads keys | Its pack is pinned to Hugging Face commits at least 14 days old and to each file's SHA-256, checked before the files are moved into place (`sidecar/voice/whistle.ts`). It runs as a short process per recording with an empty environment, under `sandbox-exec` with networking denied, and is given only the recording file. It never receives keys. |
| A second program on the same bot | `npm run telegram` (Projection) and the app poll one Telegram bot | Reported as a conflict in Settings → Channels, not crashed on. |

## Remote workspace integrations

Hosted MCP entries install no local server package, so the npm version-age rule does not pin the hosted service's implementation. The user configures the endpoint and grants account access explicitly. The workspace catalog entry accepts documented HTTPS cloud host suffixes and MCP paths, refusing embedded credentials, nonstandard ports, queries and fragments. Its token uses the app secret store and an Authorization header; it never belongs in the endpoint or task journal. Host validation identifies an allowed service destination, not the account or resources the user intended: users must check their workspace URL and token permissions.

Configuration-based endpoint resolution is supplied by the framework over detached non-secret settings; the app owns destination restrictions. Rejected complete endpoint edits leave the prior configuration intact. Required setup fields must be present before normal activation. Discovered tools retain the framework's annotation-based policies: changes and open-internet access default to Ask. Remote calls can incur service/compute charges and the workspace entry is excluded from free task capabilities. Token expiry/revocation, workspace grants and network controls still govern access. No browser OAuth or automatic credential refresh is provided. [Setup and verification limits](docs/DATABRICKS.md).

## Task records and drafts

Task journals are local user content, created with owner-only file permissions in a private task directory. Bound-field drafts are also user content, persisted in the app window's local storage; they are separate from the canonical saved surfaces and numeric usage ledger. Neither store is a place for provider or integration credentials.

Task permissions allow one concrete operation. Pending requests expire and lose authority on restart; changed integration configuration or blocked tools prevent an old request being approved. Task sessions reject ordinary HTTP mutation paths, including while idle, so a chat request cannot bypass task access policy.

Task deletion requires stopped execution, a current revision and explicit acknowledgement of uncertain effects. It removes only the selected journal, conversation, raw transcript and local drafts. External changes, shared memory, integrations, credentials, shared integration logs and numeric usage records remain. Cancellation and deletion cannot undo an operation already sent to an external service. Shared-log retention and sustained long-term history are tracked separately in the MVP checklist.

## What the app does not defend against

- **Code the user chooses to run.** A custom MCP server added by command runs with the user's permissions. The app marks it unverified and makes every tool ask, but cannot sandbox it (macOS sandbox profiles are a planned step).
- **A provider seeing prompts.** Whatever the user sends to a hosted model goes to that provider. Local models (Ollama, LM Studio) keep everything on the machine.
- **An attacker with the user's account on the machine.** They can read the Keychain items the app can read.
- **Unsigned builds.** The app is not code-signed or notarized yet. Install it only from your own build.

## Reporting

The repository is public: <https://github.com/nranjan2code/vakyartha>. Report a vulnerability privately to the maintainer (Nisheeth Ranjan) rather than in a public issue. If it is in the engine itself, it belongs to [Projection](https://github.com/nranjan2code/Projection); report it the same way.

## Checks that guard this

- `test/settings.test.ts`: Keychain/file storage, secrets never returned, injection through settings values refused.
- `test/integrations.test.ts`: exact npm catalog pins, first-run defaults, earlier saved state, workspace endpoint validation, setup persistence and secret redaction.
- `test/voice.test.ts`: only listed voice packs install; a Whistle file that does not match its pinned checksum is refused and leaves nothing behind; language tags and inputs are validated before any provider is called.
- `test/finops.test.ts`: the token-protected HTTP path, and no prompt or tool content copied into the usage ledger.
- The framework's checks (`framework/packages/host/test`, `framework/packages/mcp/test`, including installs and folder checks in `integrations.test.ts`) run with `npm run test:framework`.
- Before every push: the secret scan in AGENTS.md.


## Chat attachments

Images attached in the chat are copied to `<data>/attachments/<chat id>/` (folder 0700, files 0600), accepted only as known image types up to 20 MB, behind the sidecar token and the host's JSON-only POST rule. Chat ids are checked against `[A-Za-z0-9_-]` so a path cannot escape the folder. Deleting the chat deletes the folder. The OCR tools read only image files and send them to the local Ollama only; their Markdown export is a write and defaults to Ask. Guarded by `test/attachments.test.ts`.

## Task-selected files and local outputs

Only explicitly selected UTF-8 `.txt`, `.md`, `.csv`, `.json` snapshots are accepted for task input (four files, 16,000 bytes each/48,000 total). The browser supplies filename/content, never a host path or folder grant. The server computes snapshot hashes; contents are untrusted model context and are sent to the selected task model. They grant no tool or network authority. Live external access remains governed by the existing integration scope/approval lifecycle.

Optional task Markdown exports use a fixed private app-data output directory and generated task/run filenames. Exclusive creation and no-follow reads refuse overwrite/symlink substitution; hash/size read-back produces receipts, and missing/changed/stale output blocks acceptance. Manual save retry never repeats model or integration work. Task-local diagnostic retention expires the named transcript after the configured idle interval, while necessary canonical content persists until task deletion. Deletion removes owned snapshots, outputs, checkpoints, transcript and UI drafts. Downloaded copies, external effects, shared memory/integration logs, credentials and numeric usage remain according to the explicit UI scope.

A dispatched operation with an uncertain outcome stops automatic work. Continuation needs the exact current operation IDs, task revision and a dated user review note. Same-run duplicate call IDs and accepted input IDs are not replayed; this does not assert exactly-once behavior by arbitrary external services. Raw file content is not copied into numeric telemetry or credentials. No new native IPC or dependency is introduced.


## External catalog discovery and imports

External directories are untrusted metadata sources. Discovery contacts fixed HTTPS origins only, with no app/integration credentials, redirect refusal, a 15-second timeout and an 8 MB response cap. Text renders as text and README HTML is not fetched. Publisher icons use a separate authenticated, connection-pinned public HTTPS fetch with per-hop checks, an eight-second timeout and a 256 KiB cap. Source metadata selects the URL; callers cannot provide one. Accepted raster formats are signature-checked; SVGs are rebuilt in the window from passive shapes/attributes with no scripts, event/style attributes, entities or external references. Responses carry sandbox CSP/nosniff headers; blob URLs are revoked after decode. Locally bundled source/publisher marks have recorded provenance. Missing/unsupported icons fall back to initials. Catalog membership and publisher ownership are not a code audit or a grant of trust. Imported credentials stay in the canonical app secret store; definition snapshots and caches contain no credentials.

Review precedes adoption and exposes endpoint/package, source, required credentials and service costs as unknown. An in-memory ten-minute review fingerprint binds the import; clients cannot supply arbitrary executable catalog definitions. Imports stay off and unverified. Every unreviewed tool defaults to Ask regardless of server annotations; explicit user policies remain effective. Supported npm imports require a checked exact version at least 14 days old, a source repository, a supported JavaScript bin and declared environment only. Package scripts are disabled by the existing installer; this does not audit or sandbox runtime/transitive code. Unsupported arguments, loader environment, arbitrary headers and other runtimes are refused.

External endpoint validation excludes embedded credentials, query/fragment, literal IP/local suffixes and unresolved templates, but does not establish DNS ownership or provide a network sandbox. The MCP client refuses redirects so configured secret headers cannot be forwarded. Hosted implementations remain mutable and may require unsupported browser authentication or charge independently. Stale offline listings cannot authorize imports. Imported-definition corruption does not overwrite saved content or prevent other integrations from running. Removal uses canonical stop/uninstall/credential deletion before deleting the imported definition; remote data, subscriptions, prior effects and shared audit logs remain. See [implementation/verification limits](docs/EXTERNAL-CATALOGS.md) and `test/marketplaces.test.ts`.


## Capability dispatch revalidation

Integration changes invalidate tools captured by an existing run and its chat-wide grants. Approval waits recheck authority/cancellation before dispatch. Supported native tool arguments are validated before effects; incomplete native generations and ambiguous tool names dispatch nothing. MCP errors/denials remain explicit failures through task receipts and agent events. HTTP cancellation/timeout/close abort pending work and MCP parsing is bounded at 8 MiB. This cannot undo an operation already received by a service. Skills remain instructions only; stale prepared selection context fails explicitly. Verification and remaining transport/schema/skill/channel limits are in [the pipeline review](docs/PIPELINE-REVIEW.md).


Reusable skill/report authoring follows [the maintained method](docs/SKILL-AUTHORING.md). Skills remain instruction-only: common layout measures are validated semantic props, not arbitrary executable styling, and spoken content comes from canonical surfaces rather than a separate model-authorized payload. Domain names, report cadence and visible buttons do not grant integration access or create recurrence.
