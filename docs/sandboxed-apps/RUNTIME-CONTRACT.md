# Executable apps: current runtime contract

This contract supersedes implementation claims in the earlier architecture and operations proposals. The mini-cloud hosts persistent local applications: chat/Studio builds executable packages; ordinary code handles actions and refreshes without a model request.

## Lifecycle and ownership

1. `read_app_package` / `save_app_draft` in chat, Canvas → Create app draft, or Studio saves inert source into private `app-drafts/<id>.json`. Canvas promotion preserves presentation; executable behavior must be authored explicitly. Chat can supply the complete manifest and source through the generic draft tool. Canvas retains its source chat; Build with chat returns there and prepares an editable ordinary composer request to author missing executable behavior; it does not send a hidden model request. No domain compiler or generated fake refresh handler is added.
2. Studio retains incomplete source, loads actual package files, previews valid surfaces, rehearses a fingerprint-bound draft through the sandbox without external tool access, and publishes explicitly. Draft saves reject stale fingerprints. Publication also checks the original package fingerprint and disables scheduling.
3. Published package, domain state, opted-in DuckDB snapshot, canonical surface snapshots, revision, schedule markers and current/prior run receipts live in one private `app-state/<id>.json` record. One serialized app owner writes it through file sync, rename and directory sync. This improves crash ordering; it is not physical power-loss certification. The last 50 prior run receipts are retained.
4. Each action or named trigger acquires bounded execution capacity (three by default), stages a disposable package/input copy and runs the existing `vaksb run` contract. There are no ordinary Node fallback or warm uncontained workers. The helper owns process-tree containment and verified cleanup. Scratch files and module memory disappear after each invocation.
5. Successful work returns domain state, an opted-in closed database snapshot and validated Projection updates; the host commits them together and advances the revision. Failed computation does not publish its state. Existing independent surfaces remain available through a selector. Reopening/restarting reads committed current snapshots. Visible app views poll for newer revisions while retaining local edits.
6. Scheduling is opt-in. Runs happen while the app/computer are running and awake. Due-minute claims persist before execution; overlapping schedule scans serialize. Missed minutes are skipped, failed runs are not replayed. Integration effects that become uncertain block further execution and pause schedules. Explicit run-ID acknowledgement follows inspection and never replays work. Abrupt host restart marks an in-flight run uncertain.
7. Update/delete serialize behind app work. Registered identifiers and every package path are checked at the persistence boundary. Original legacy app directories/data are preserved; compatible source packages import once as inert drafts. Unsupported legacy packages remain untouched for manual review, not silently executed.

## Backend interface

Only Node 24 `.ts`, `.mjs` and `.js` entrypoints are supported. All relative source files must be included. Each execution loads the declared entrypoint once.

```ts
export async function handleAction(controlId, value, context, action) {
  context.state.count = Number(value) * 2;
  return { data: { count: context.state.count } };
}
export async function refreshData(context) {
  const source = await context.callTool("server__tool", { /* declared tool arguments */ });
  // Validate/parse the actual tool-output text, compute domain values, then return
  // canonical projection data. Never infer source values from visual labels.
  return { data: { source } };
}
```

For interactions, `context.surface` identifies the source surface when supplied; submissions require the current app revision. A cron declaration's `action` names the exported function actually invoked. Missing functions, rejected promises and invalid output fail. `context.state` is persistent JSON domain state; `context.surfaces` holds current snapshots. Return `{data}`, `{patches:[{id,props}]}`, or `{updates:[{surface,data,nodes}]}` for multiple surfaces. Node patches follow Projection's public update API, not JSON Patch. Return optional `focusSurface` naming an existing surface for explicit post-commit view navigation. Related visual and spoken content must derive from the same canonical data. App code is responsible for domain validation and calculations.

## Bounded DuckDB analytics (ADR-049)

Opt into `entitlements.storage.duckdb: true`. The runtime stages the reviewed native `@duckdb/node-api@2.0.0-r.1` package and matching platform binding in the disposable workspace. `context.database.run(sql, parameters?)` executes parameterized statements; `query(sql, parameters?)` returns JSON-compatible row objects. Queries are limited to 10,000 returned rows / 256 KiB JSON. The instance uses one thread and a 128 MiB DuckDB memory setting (not a whole-process quota), with external access and automatic extension install/load disabled. Raw network remains denied by the helper.

Only the worker opens the live file. On success it closes DuckDB and reads a bounded regular snapshot without following links. The 2 MiB binary snapshot is base64-encoded in the existing app record, atomically committed with state, validated surfaces and revision. Failure never replaces the prior snapshot. Host JSON record ownership stays unchanged; no additional persistence writer, private IPC or native relay is introduced. Rehearsal gets a fresh isolated database and no external tool access. App code owns schemas and deliberate migrations; arbitrary persistent filesystem databases and SQLite file entitlements remain unsupported. This bounded capability supersedes earlier blanket database exclusions.

## Real-data access and boundaries

`manifest.entitlements.mcpTools` lists exact existing integration tool names. `context.callTool` uses a bounded, sequential file mailbox because the existing sandbox intentionally closes target stdin. Fixed files are opened without following links; untrusted file reads are bounded even if a target grows them concurrently. This adds no native relay, listener, credential store or connector implementation.

The host resolves the declared tool through the existing integration lifecycle, schema validation, policy rechecks and call log. Only enabled tools currently set to Allow may run unattended. Ask/off are not bypassed, and app declarations grant no permission. Requests are capped at 16 calls/invocation, 16 KiB arguments and 256 KiB reply. Attempted/completed tool names and argument hashes are recorded before/after dispatch. No automatic replay follows an uncertain effect. Executable apps receive bounded original source text captured after the existing integration schema/policy/log checks, rather than the model-facing clipped wrapper. Request-scoped receipts isolate concurrent reads; missing/error/oversized receipts fail. Tool output remains untrusted text; code must parse the source's actual documented format. Keys never enter app packages or child environments.

No direct HTTP/DNS/domain grant is supported. Raw network is denied by the existing helper. Its documented system runtime read grants still apply. Native execution is macOS-only and requires the compatible supervised helper; disablement/missing helper fails closed. Runs are bounded to 30 seconds and 32 KiB stdout/stderr. Packages have 100 files, 1 MiB/file and 4 MiB total UTF-8 text; results are at most 4 MiB and persisted records 8 MiB. Concurrency is 1–8 configured slots and at most 32 pool waiters.

CPU/RSS/process-count/disk-growth quotas, arbitrary persistent filesystem database volumes, file watchers, permanently running daemons, raw network/model brokers and hard spend ceilings are not implemented. Legacy manifest resource numbers do not enforce these quotas. The console reports RSS as unmeasured and does not claim static protection or spending measurements. Arbitrary self-modification is not allowed: code updates go through reviewed package publication; ordinary self-refresh updates data.

## Evidence

The source checkpoint has 217 passing app tests, typecheck/build and real-helper/WebKit checks. The required primary-provider graph gate remains 2/3; no broader model app-authoring trial followed it. The installed app has not been replaced by this checkpoint.

See the newest HANDOVER/EVALUATION checkpoint. A source build is not an installed-app update. Tool, renderer and calculation tests are separate from primary-provider app authoring outcomes. Preserve failed receipts; no passing mechanism test closes an earlier model/source/value/interpretation/interaction failure.
