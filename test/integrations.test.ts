import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pinnedInstallArgs } from "@vak/mcp/client";
import { CATALOG, createIntegrations, databricksEndpoint } from "../sidecar/integrations.ts";
import { fileSecrets } from "../sidecar/settings.ts";

const deps = (dataDir: string) => ({ dataDir, secrets: fileSecrets(path.join(dataDir, "settings.env")), approve: async () => "deny" as const });

test("every npm server in the catalog is pinned to an exact version the framework will install", () => {
  for (const e of CATALOG) {
    const s = e.source;
    if (s.kind === "npm") assert.doesNotThrow(() => pinnedInstallArgs(s.package, s.version, "/tmp/x"), e.id);
  }
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
});

test("first run: only Time is on", () => {
  const list = createIntegrations(deps(mkdtempSync(path.join(tmpdir(), "vakyartha-int-"))));
  assert.deepEqual(list.view().filter((v) => v.enabled).map((v) => v.entry.id), ["time"]);
});

test("state saved before integrations moved into the framework still loads", () => {
  // The layout the app wrote itself up to 0.1.0: integrations.json at the data folder root.
  const dataDir = mkdtempSync(path.join(tmpdir(), "vakyartha-int-"));
  const saved = {
    integrations: { time: { installed: "built-in", enabled: true, config: {}, policies: { now: "off" } }, memory: { installed: "2026.8.31", enabled: false, config: {}, policies: {} } },
    custom: [{ id: "custom-mine", name: "Mine", publisher: "Added by you", trust: "custom", summary: "https://example.com/mcp", description: "", homepage: "https://example.com/mcp", icon: "plug", access: [], source: { kind: "http", url: "https://example.com/mcp" }, config: [] }],
  };
  writeFileSync(path.join(dataDir, "integrations.json"), JSON.stringify(saved));
  const list = createIntegrations(deps(dataDir));
  const view = new Map(list.view().map((v) => [v.entry.id, v]));
  assert.equal(view.get("time")?.enabled, true);
  assert.equal(list.policyOf("time", { name: "now", inputSchema: {} }), "off");
  assert.equal(view.get("memory")?.version, "2026.8.31");
  assert.equal(view.get("custom-mine")?.entry.trust, "custom");
});

test("Databricks accepts workspace MCP URLs across clouds and refuses token destinations outside them", async () => {
  for (const endpoint of [
    "https://dbc-example.cloud.databricks.com/ai-gateway/mcp-services/system.ai.dbsql",
    "https://adb-123.4.azuredatabricks.net/api/2.0/mcp/sql",
    "https://123.4.gcp.databricks.com/api/2.0/mcp/functions/main/tools/lookup",
  ]) assert.equal(databricksEndpoint({ endpoint: ` ${endpoint} ` }), endpoint);
  for (const endpoint of [
    "", "http://dbc-example.cloud.databricks.com/api/2.0/mcp/sql", "https://example.com/api/2.0/mcp/sql",
    "https://dbc-example.cloud.databricks.com.evil.example/api/2.0/mcp/sql",
    "https://cloud.databricks.com/api/2.0/mcp/sql", "https://example.databricksapps.com/mcp",
    "https://user:password@dbc-example.cloud.databricks.com/api/2.0/mcp/sql",
    "https://dbc-example.cloud.databricks.com:8443/api/2.0/mcp/sql",
    "https://dbc-example.cloud.databricks.com/api/2.0/mcp/sql?token=value",
    "https://dbc-example.cloud.databricks.com/api/2.0/mcp/sql#fragment",
    "https://dbc-example.cloud.databricks.com/api/2.0/sql/statements",
  ]) assert.throws(() => databricksEndpoint({ endpoint }), /MCP/);
  const dataDir = mkdtempSync(path.join(tmpdir(), "vakyartha-db-"));
  const list = createIntegrations(deps(dataDir));
  const view = () => list.view().find((v) => v.entry.id === "databricks")!;
  assert.equal(view().entry.trust, "vendor");
  assert.equal(view().enabled, false);
  assert.equal(view().entry.sourceKind, "http");
  assert.deepEqual(view().missing, ["Databricks MCP server URL", "Databricks personal access token"]);
  const endpoint = "https://dbc-example.cloud.databricks.com/ai-gateway/mcp-services/system.ai.dbsql";
  await list.configure("databricks", { config: { endpoint }, secrets: { token: "test-token" } });
  assert.equal(view().status, "off");
  assert.equal(view().secretsSet.token, true);
  assert.doesNotMatch(JSON.stringify(view()), /test-token/);
  await assert.rejects(list.configure("databricks", { config: { endpoint: "https://evil.example/mcp" } }), /MCP/);
  assert.equal(view().config.endpoint, endpoint);
  const again = createIntegrations(deps(dataDir));
  assert.equal(again.view().find((v) => v.entry.id === "databricks")!.config.endpoint, endpoint);
});
