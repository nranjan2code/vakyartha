import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Integrations } from "@vak/mcp/client";
import { CATALOG } from "../sidecar/integrations.ts";
import { nativeSecrets } from "../sidecar/settings.ts";
import { EGRESS_HOSTS, integrationSecretName } from "../shared/integration-egress.ts";

test("every fixed remote catalog host is approvable and its header key is bound to that host only", () => {
  for (const entry of CATALOG) {
    const source = entry.source;
    if (source.kind !== "http" || typeof source.url !== "string") continue;
    const host = EGRESS_HOSTS.find((h) => h.host === new URL(source.url as string).hostname);
    assert.ok(host, `${entry.id} host is missing from shared/integration-egress.json`);
    const keyed = entry.config.filter((f) => f.kind === "secret" && f.header);
    assert.ok(keyed.length <= 1, entry.id);
    for (const f of keyed) assert.deepEqual(host.credential, { account: integrationSecretName(entry.id, f.key), header: f.header!.name, format: f.header!.format }, entry.id);
  }
});

test("integration secrets use the vault account name the page saves to", () => {
  const names: string[] = [];
  const list = new Integrations({ dataDir: mkdtempSync(path.join(tmpdir(), "vak-int-")), catalog: CATALOG, secrets: { kind: "file", get: () => undefined, set: (n: string) => void names.push(n), delete() {} } } as never);
  void list.configure("tavily", { secrets: { apiKey: "k" } }).catch(() => {});
  assert.deepEqual(names, [integrationSecretName("tavily", "apiKey")]);
});

test("native secrets expose presence as a marker and refuse values", () => {
  const store = nativeSecrets("OPENAI_API_KEY");
  assert.equal(store.get("OPENAI_API_KEY"), "native-vault");
  assert.equal(store.get("INTEGRATION_TAVILY_APIKEY"), undefined);
  store.present!("INTEGRATION_TAVILY_APIKEY", true);
  assert.equal(store.get("INTEGRATION_TAVILY_APIKEY"), "native-vault");
  assert.throws(() => store.set("X", "secret"));
});
