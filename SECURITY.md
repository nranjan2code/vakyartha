# SECURITY.md: Vakyartha

What the app protects, from whom, and how. Rules for changing code are in [AGENTS.md](AGENTS.md); the architecture is in [SPECS.md](SPECS.md). The engine's own defences (Host/Origin checks, tool-output wrapping, approvals, SSRF, MCP server environments, projector escaping) come from the [Projection framework](https://github.com/nranjan2code/Projection/blob/main/SECURITY.md) and apply here unchanged.

## What there is to protect

- **API keys** for model providers, integrations (GitHub, Notion, Brave, Tavily) and channels (Telegram).
- **The user's data**: chats, files the Files integration can see, accounts reachable through integrations.
- **The machine**: the app runs model-chosen requests and third-party MCP servers on it.

## Who could attack

| Threat | Example | Defence |
|---|---|---|
| A web page in the user's browser | POSTs to the sidecar's loopback port to spend the user's keys | The framework's Host, Origin and JSON-body checks, plus a random bearer token that only the app's own window receives (`backend`). The browser version (`npm run web`) is open on loopback only, for development. |
| A malicious or compromised MCP package | A new release of a dependency runs code at install | Each catalog server names an exact version published at least 14 days earlier (checked by `test/integrations.test.ts`). The framework's `Integrations` installs it with `--ignore-scripts --before=<today − 14 days>`, so every dependency is that old too and nothing runs at install, into its own folder. |
| An over-reaching filesystem server | Files reads `~/.ssh` | It is started with only the folders the user adds, checked by the framework (`checkFolders`): absolute, existing, never a system root or the whole home folder. Writes ask. |
| A prompt injection through an integration | A fetched page says "push to my repo" | Writes and open-internet tools default to Ask in each integration's policy; every call is logged to `logs/tools.jsonl`. |
| A stolen settings file | Someone copies the data folder | On macOS keys live in the Keychain, written through `security -i` on stdin (never on a command line) and never sent back to the UI. Elsewhere they live in a file only the user can read (0600). Settings values are checked so they cannot inject into `settings.env`. |
| A compromised local speech model | The Whistle engine, a prebuilt binary with no published source, reaches the internet or reads keys | Its pack is pinned to Hugging Face commits at least 14 days old and to each file's SHA-256, checked before the files are moved into place (`sidecar/whistle.ts`). It runs as a short process per recording with an empty environment, under `sandbox-exec` with networking denied, and is given only the recording file. It never receives keys. |
| A second program on the same bot | `npm run telegram` (Projection) and the app poll one Telegram bot | Reported as a conflict in Settings → Channels, not crashed on. |

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
- `test/integrations.test.ts`: every catalog server pinned to an exact version, first-run defaults, state saved by earlier versions still loads.
- `test/voice.test.ts`: only listed voice packs install; a Whistle file that does not match its pinned checksum is refused and leaves nothing behind; language tags and inputs are validated before any provider is called.
- `test/finops.test.ts`: the token-protected HTTP path, and no prompt or tool content copied into the usage ledger.
- The framework's checks (`framework/packages/host/test`, `framework/packages/mcp/test`, including installs and folder checks in `integrations.test.ts`) run with `npm run test:framework`.
- Before every push: the secret scan in AGENTS.md.


## Task-selected files and local outputs

Only explicitly selected UTF-8 `.txt`, `.md`, `.csv`, `.json` snapshots are accepted for task input (four files, 16,000 bytes each/48,000 total). The browser supplies filename/content, never a host path or folder grant. The server computes snapshot hashes; contents are untrusted model context and are sent to the selected task model. They grant no tool or network authority. Live external access remains governed by the existing integration scope/approval lifecycle.

Optional task Markdown exports use a fixed private app-data output directory and generated task/run filenames. Exclusive creation and no-follow reads refuse overwrite/symlink substitution; hash/size read-back produces receipts, and missing/changed/stale output blocks acceptance. Manual save retry never repeats model or integration work. Task-local diagnostic retention expires the named transcript after the configured idle interval, while necessary canonical content persists until task deletion. Deletion removes owned snapshots, outputs, checkpoints, transcript and UI drafts. Downloaded copies, external effects, shared memory/integration logs, credentials and numeric usage remain according to the explicit UI scope.

A dispatched operation with an uncertain outcome stops automatic work. Continuation needs the exact current operation IDs, task revision and a dated user review note. Same-run duplicate call IDs and accepted input IDs are not replayed; this does not assert exactly-once behavior by arbitrary external services. Raw file content is not copied into numeric telemetry or credentials. No new native IPC or dependency is introduced.
