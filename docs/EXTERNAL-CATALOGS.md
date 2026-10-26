# External catalog integration

Implementation and verification guide, 2026-10-26. Product ownership and acceptance rules: [SPECS.md](SPECS.md), [ADR.md](ADR.md), [SECURITY.md](../SECURITY.md). External sources supplement the app's curated catalog; adding a listing never activates it.

## User flow

Settings → Integrations keeps **Our catalog**, **External catalogs**, and **In use** together. External discovery has a source picker, submitted search, pagination, loading/empty/error states and a connection review. Review shows publisher identity as reported by the source, listing/version, exact endpoint or package, credential requirements, service costs as unknown, source links and compatibility limits. Catalog membership does not mean the app reviewed the server.

For compatible entries, acknowledge access and costs and choose **Add and configure**. A local package additionally requires explicit source/dependency review acknowledgement. Existing matching catalog packages/endpoints open their existing setup instead of importing another copy. Local packages must be installed separately on that setup page; hosted entries install no package. Save required credentials and turn the integration on to negotiate a connection and list tools. Failed credentials/network/protocol errors appear on the integration page; refresh or corrected setup reconnects. Every imported tool defaults to Ask, including read-only tools. Existing per-tool policy controls, user-requested test runs, recent calls, disable and removal apply.

Imported local entries can be removed even before installation. Removal stops the integration, removes its local runtime data and saved credentials through Projection, then removes the app's imported catalog definition. It does not undo remote effects, cancel third-party subscriptions or delete shared audit logs.

## Discovery sources

| Source | Metadata endpoint | Behavior |
|---|---|---|
| Official MCP Registry | `https://registry.modelcontextprotocol.io/v0.1/servers` | Standard server metadata, latest-version query, substring name search and opaque cursors. |
| GitHub MCP Registry | `https://api.mcp.github.com/v0.1/servers` | Standard metadata envelope; source-owned search and cursor semantics. |
| Docker MCP Catalog | `https://desktop.docker.com/mcp/catalog/v2/catalog.json` | Full catalog normalized to the same listings; local search/pagination over cached metadata. Hosted entries and container-only requirements are distinguished. |

The source picker contacts only these fixed origins. No model, integration credential, provider credential or arbitrary catalog-supplied URL is used for discovery. Metadata requests reject redirects, time out after 15 seconds and cap decoded bodies at 8 MB. Package review additionally reads the public npm registry's exact package metadata. Server descriptions are plain text and README HTML is not loaded or executed. Supplied publisher icons use the authenticated image path described below.

Source documentation: [official API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md), [aggregation guidance](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/registry-aggregators.mdx), [GitHub registry](https://github.com/mcp), [Docker catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/). These are external services with independent availability and terms. Registry availability does not guarantee a listed server works.

## Identity assets and layout

The Integrations page uses one containing block for its heading, tabs, toolbar and grid. Cards reserve a bottom action row so short and long descriptions share a common action baseline. External cards expose a real **Review connection** or **View requirements** button; status badges remain informational. Wide and narrow layouts retain the same axes and keyboard-accessible actions.

Catalog source marks and curated publisher avatars are bundled locally from their original publishers; URLs, retrieval dates, hashes and usage notes are in [asset provenance](../public/brand/integrations/README.md). Listing icons come from `icons[].src`, the source's publisher-avatar metadata, or the container catalog's icon field. Missing/unsupported images fall back to publisher initials. Identity artwork never grants trust or installs/enables a server.

`GET /api/marketplaces/<source>/icon?q=…&cursor=…&key=…` resolves a listing key to source-provided icon metadata; it accepts no caller-provided fetch URL. The sidecar uses the framework's connection-pinned public HTTPS fetch, checks every redirect (at most two), sends no credentials/cookies, times out each request after eight seconds and caps each response at 256 KiB. Accepted formats are PNG/JPEG/WebP by signature and SVG by declared MIME/root. Responses require window authentication, disable sniffing and carry a restrictive sandbox CSP. At most 128 icon responses are kept in memory; concurrent requests for the same image coalesce.

The window fetches icons with bounded concurrency, creates a blob URL and revokes it after decode. Publisher SVG XML never enters the page DOM: it is rebuilt from an allowlist of passive geometry/gradient attributes, with external references, scripts/foreign elements/entities rejected, event/style attributes omitted and intrinsic viewport bounded. Only the rebuilt image enters an `img` element. Failed icons do not prevent browsing or change lifecycle state. Imported setup/cards keep the saved publisher identity through `/api/integrations/<id>/icon`, including after restart, without changing installed state.

## Compatibility

- **Hosted:** fixed public HTTPS Streamable HTTP URLs without embedded credentials, query, fragment, custom port, literal IP or unresolved template. Supported declared credential headers become secret-store fields. One raw token or one Bearer-token substitution per supported header is accepted. Routing/framing/cookie headers, compound/fixed credentials and unsupported transports stay browse-only. URL validation is lexical; importing a hostname is not proof of DNS ownership or a network sandbox.
- **Local:** public npm packages, exact supported versions, stdio transport, no extra launch arguments, a source repository, a single JavaScript bin, and supported declared environment fields. Package review checks the package identity/version and npm publication timestamp against the 14-day minimum, and shows direct dependencies and declared script names. The app does not audit transitive code automatically. Installation uses only Projection's existing pinned, script-free, age-filtered installer. No new runtime dependency is added to the app.
- **Other runtimes:** container execution, Python/other package formats, bundles and custom launch arguments remain browse-only. For an externally managed container service, configure its runtime separately and use **Add your own server** for its HTTP gateway. The app does not install or manage the container runtime or enforce its lifecycle; it owns the gateway connection only.
- **Authentication:** browser OAuth, account linking and automatic token refresh remain unsupported. Missing auth metadata is not evidence a server is unauthenticated. A server requiring browser sign-in may import successfully and then report an authentication error; use a supported token route if the publisher offers one.
- **Costs:** an entry is not assumed free. No paid service or model run is performed by discovery; remote calls can incur independent service charges. Imports do not enter the app's curated free-capability set.
- **Updates:** import is a snapshot. No automatic package/version/endpoint replacement, auto-install or auto-enable. A remote listing version cannot pin a hosted implementation. Proxy endpoints known to be retiring are refused with a direct-endpoint explanation.

## Ownership and persistence

`sidecar/marketplaces.ts` owns external discovery and catalog definition snapshots. `shared/marketplaces.ts` is the bounded UI/API contract; `src/marketplaces-page.ts` supplies the browser/review UI. `sidecar/integrations.ts` passes one app-owned catalog array through public `IntegrationsOptions.catalog`; definitions can be appended/removed without reaching into framework internals.

- `<data>/external-catalog.json`: imported definitions/provenance only, mode 0600 with atomic replacement. No credentials or installed state. Damaged definitions disable new imports without overwriting the file or preventing normal app startup.
- `<data>/catalog-cache/`: disposable metadata pages, mode 0600, one-hour freshness, at most 64 pages on disk and in memory. Concurrent matching fetches coalesce. On outage, expired cached pages remain visible but cannot authorize a new import. Search terms are represented by hashed filenames; cached content remains local metadata.
- Framework-owned `integrations.json`, runtime folders, secret store and call logs remain canonical for configuration, installation and execution. No second runtime/process manager or native IPC is introduced.
- Reviews are held in memory for ten minutes and bound to a fingerprint of the reviewed connection. Add accepts that fingerprint plus acknowledgement; it does not accept client-authored launch definitions. Duplicate endpoint/package imports reuse the existing catalog entry. Listing identity and version remain inspectable after restart.

Projection `328d820` makes custom/unreviewed tool policies default to Ask regardless of server annotations. `801e227` uses the negotiated MCP protocol on later HTTP requests, clears session/version on reconnect and refuses redirects that could forward custom credentials. These are general framework fixes made upstream, not edits under the app's submodule.

## Verification

`node --test test/marketplaces.test.ts` covers all metadata formats, incompatible transports, endpoint/header/loader-environment rejection, fixed discovery origins, no secret headers, cursor encoding, cache/coalescing, offline stale behavior, damaged definitions, exact-version/age/bin review, explicit consent and HTTP route authentication. Local installation uses an in-repo fake npm fixture, not a downloaded server. It verifies install flags, declared-only environment, tool approval denial, explicit test calls, disable, restart and removal/credential cleanup. Hosted lifecycle checks cover wrong credentials, correction, negotiation/listing, denied-call isolation, testing, disable/reconnect and restart.

`npm run build && node scripts/marketplaces-check.ts` checks app-native WebKit at 1440px/light, 1100px/light and 620px/dark: exact header/tab/toolbar/grid alignment, bottom-aligned card actions with unequal description lengths, decoded source logos and publisher thumbnails, inactive SVG event attributes, source picker, pagination, review focus and acknowledgement, import to normal setup while off, provenance, source outage/retry, unsupported containers, empty results and horizontal fit. Verification output and screenshots are retained in the temporary directory printed by the command. Set `WK_WIDTH=620` to run a single width.

Live discovery returned results from all three sources on 2026-10-26. An isolated Docker-catalog Astro Docs import exposed a real protocol-negotiation failure (HTTP 400 after initialization); the upstream fix was then checked against the same endpoint. The connection listed `search_astro_docs` with Ask, completed one public documentation search, reconnected after disable and removed cleanly. Evidence directory: `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-marketplaces-live-42lEOl`. No account credential, paid call, model generation, external npm installation, installed-app replacement or channel restart was used. This proves that connection path, not all servers, authentication styles or service reliability.


Initial discovery source validation: 143 app tests and 326 tests/replay against the pinned framework pass, plus typecheck, UI build, sidecar bundling and the existing wide/narrow canvas WebKit suite. Catalog WebKit passed at both widths in `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-marketplaces-check-3h0glT`; each width uses a fresh server origin/data folder after repeated shared-origin off-screen invocations timed out before navigation. The harness reports failures with a nonzero exit status; this was a harness isolation change, not a retry-based product success claim. This task did not rebuild or replace the installed desktop application.


UI correction validation (2026-10-26): 144 app tests and typecheck pass. Icon tests verify source-owned URLs, credential-free bounded fetching, coalescing and rejection of caller-supplied/missing/private icon URLs. The extended three-width WebKit suite checks the screenshot-reported alignment and card-button faults, alongside existing lifecycle navigation. A clean local rebuild/installation supersedes the initial source-only checkpoint; exact compiled commits and artifact provenance are recorded in RELEASING.md.


Live identity fetches use Projection `da49065`, which fixes the public-fetch resolver's single-address versus dual-stack callback shape on the current runtime. The first real checks failed with an invalid-address error; fixture success was insufficient evidence. The upstream fix preserves one checked DNS result and private-address refusal; both callback forms are tested offline. The pinned framework now passes 327 tests. This is a general networking correction in Projection, not an app-specific fetch workaround.
