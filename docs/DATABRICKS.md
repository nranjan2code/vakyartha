# Databricks MCP setup

Verified against the vendor documentation on 2026-10-26:

- [Provided MCPs, endpoint formats and legacy endpoints](https://docs.databricks.com/aws/en/agents/mcp-tools/built-in-mcp-services)
- [Authentication and networking](https://docs.databricks.com/aws/en/agents/mcp-tools/authentication-networking)

In Settings → Integrations → Databricks:

1. Copy the full MCP server URL from your workspace. For a provided or registered service, use `https://<workspace-hostname>/ai-gateway/mcp-services/<catalog>.<schema>.<service>`. The service determines which tools are exposed; `system.ai.dbsql` runs SQL, while `system.ai.genie_one_mcp` supports natural-language analytics. Availability, feature enablement and grants depend on your workspace.
2. Save the URL. Documented legacy `/api/2.0/mcp/...` workspace endpoints are also accepted. Workspace hosts on AWS, Azure and Google Cloud are supported; HTTPS is required. Embedded credentials, query strings, fragments, nonstandard ports and other destinations are refused.
3. Save a short-lived personal access token from that workspace with only the required permissions. It uses the existing app secret store (Keychain on macOS) and travels in the Authorization bearer header, never the URL. Replace it when it expires.
4. Enable the integration. Its discovered tools appear with the existing policies, test controls and call log. Review tool permissions before use: tools may query private data, execute code or change resources. Calls may incur workspace compute/service charges. Workspace inbound network controls must allow this computer's network.

This integration uses the vendor-hosted Streamable HTTP server; no local package, SDK, proxy or CLI is installed. It is off by default and is not classified as a free task capability. One catalog configuration selects one endpoint; use the existing custom-server flow for additional independent endpoints, which remain marked unverified.

PAT authentication is intended for local testing. The vendor recommends OAuth for production/team use. Browser OAuth sign-in and token refresh are not implemented here. Databricks Apps servers require OAuth and are excluded from this entry.

The framework URL resolver is general: Projection `c147332` adds configuration-based HTTP endpoints, validates complete text configuration before saving, and resolves again when connecting. The app owns the allowed workspace destinations and setup guidance.

Verification: endpoint acceptance/rejection across three clouds, saved setup/restart, secret redaction, and framework HTTP reconnection/header tests. Wide (1100px) and narrow (620px) WebKit checks verify catalog discovery, setup fields, masked token input, endpoint saving, disabled default and page width. No live workspace authentication or query has been run; those require a user-provided endpoint/token and may incur charges.

If setup fails:

- **Needs setup:** save both the server URL and token. Saving a URL alone does not enable access.
- **Rejected URL:** check the full workspace hostname and MCP path. Rejected complete endpoint edits preserve the previous configuration. Additional custom servers do not inherit this catalog entry's workspace-host restrictions.
- **Authentication or permission error:** replace an expired/revoked token, check the selected MCP's grants and underlying resource permissions, and verify any required workspace preview is enabled. A valid token does not grant access to every service.
- **Connection error:** check workspace ingress/IP controls and this computer's network. Browser access alone does not verify MCP connectivity.

After correcting setup, enable the entry (or switch it off and on) to reconnect and refresh its tool list. Use the existing per-tool test controls only when you are ready to approve the operation and any service charges. A successful connection or tool listing alone does not verify query results or external changes.

Implementation checkpoint: application `b33c594`, framework `c147332`. These source changes were committed and pushed; the previously installed application was not rebuilt for this connector. The verification used 134 app tests passing serially, 324 framework tests, typecheck/build and wide/narrow WebKit setup checks. Parallel app runs encountered unrelated timing-sensitive task tests; no live workspace call or paid operation was performed.
