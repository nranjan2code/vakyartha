import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEgressUrl, createGuardedFetch } from "../sidecar/egress.ts";

test("evaluateEgressUrl admits approved provider endpoints over HTTPS", () => {
  assert.equal(evaluateEgressUrl("https://api.openai.com/v1/chat/completions", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://api.anthropic.com/v1/messages", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://generativelanguage.googleapis.com/v1beta/models", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://api.telegram.org/bot123/getUpdates", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://mcp.kite.trade/mcp", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://mcp.nseindia.in/cmmkt/mcp", false).allowed, true);
  assert.equal(evaluateEgressUrl("https://my-company.cloud.databricks.com/ai-gateway/mcp-services/demo", false).allowed, true);
});

test("evaluateEgressUrl rejects unapproved public destinations and HTTP", () => {
  const evil = evaluateEgressUrl("https://evil-attacker.com/exfiltrate", false);
  assert.equal(evil.allowed, false);
  assert.match(evil.reason ?? "", /not in the authorized provider catalog/);

  const insecure = evaluateEgressUrl("http://api.openai.com/v1/chat/completions", false);
  assert.equal(insecure.allowed, false);
  assert.match(insecure.reason ?? "", /must use HTTPS/);
});

test("evaluateEgressUrl handles loopback ports strictly in non-test mode", () => {
  assert.equal(evaluateEgressUrl("http://127.0.0.1:11434/api/tags", false).allowed, true);
  assert.equal(evaluateEgressUrl("http://localhost:1234/v1/models", false).allowed, true);

  const blockedPort = evaluateEgressUrl("http://127.0.0.1:8080/admin", false);
  assert.equal(blockedPort.allowed, false);
  assert.match(blockedPort.reason ?? "", /not in the allowed local model list/);
});

test("createGuardedFetch throws when outbound request is denied by policy", async () => {
  let called = false;
  const mockFetch = async () => {
    called = true;
    return new Response("ok");
  };

  const guarded = createGuardedFetch(mockFetch as unknown as typeof fetch, false);

  await assert.rejects(
    () => guarded("https://unapproved-site.org/leak"),
    /\[egress policy\] Outbound call denied/
  );
  assert.equal(called, false);

  const res = await guarded("https://api.openai.com/v1/models");
  assert.equal(called, true);
  assert.equal(await res.text(), "ok");
});

test("evaluateEgressUrl admits custom hosts and normalizes schemes and paths", () => {
  const custom = [
    "https://mcp.alphavantage.co",
    "http://192.168.1.50:8000/v1/models",
    ".azure.com",
    "custom-ai.internal",
  ];
  assert.equal(evaluateEgressUrl("https://mcp.alphavantage.co/query", false, custom).allowed, true);
  assert.equal(evaluateEgressUrl("http://192.168.1.50:8000/v1/chat", false, custom).allowed, true);
  assert.equal(evaluateEgressUrl("https://my-resource.openai.azure.com/openai/deployments", false, custom).allowed, true);
  assert.equal(evaluateEgressUrl("https://custom-ai.internal/api", false, custom).allowed, true);
  assert.equal(evaluateEgressUrl("https://unauthorized-domain.com", false, custom).allowed, false);
});

