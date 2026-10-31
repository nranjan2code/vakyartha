import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEntry, ProviderTransport } from "@vak/providers";
import { withProviderTransport } from "../sidecar/provider-transport.ts";

test("app provider factories receive the host transport with per-turn options intact", () => {
  const captured: { options?: Parameters<ProviderEntry["make"]>[0] } = {};
  const entry: ProviderEntry = {
    id: "fixture",
    label: "Fixture",
    available: true,
    make(options) {
      captured.options = options;
      return { id: "fixture", async *stream() {} };
    },
  };
  const transport: ProviderTransport = async () => new Response("ok");
  const [wrapped] = withProviderTransport([entry], transport);

  wrapped!.make({ think: true });

  assert.equal(captured.options?.think, true);
  assert.equal(captured.options?.transport, transport);
});

test("without an injected host transport, providers retain their normal factory", () => {
  const entry: ProviderEntry = {
    id: "fixture",
    label: "Fixture",
    available: true,
    make: () => ({ id: "fixture", async *stream() {} }),
  };

  assert.strictEqual(withProviderTransport([entry])[0], entry);
});

test("new app provider routes both metadata and generation through native transport", async t => {
  const { typesafeProviderEntry } = await import("../sidecar/server.ts");
  t.mock.method(globalThis, "fetch", () => { throw new Error("Ambient network is forbidden"); });
  const requests: { provider: string; url: string; method: string }[] = [];
  const transport: ProviderTransport = async (provider, input, init = {}) => {
    requests.push({ provider, url: String(input), method: String(init.method ?? "GET") });
    if ((init.method ?? "GET") === "GET") return Response.json({ data: [{ id: "fixture-model" }] });
    return new Response('data: {"choices":[{"delta":{"content":"Fixture result"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  const [entry] = withProviderTransport([typesafeProviderEntry({})], transport);
  const provider = entry!.make();
  assert.deepEqual(await provider.listModels?.(), ["fixture-model"]);
  const events = [];
  for await (const event of provider.stream({ model: "fixture-model", messages: [{ role: "user", content: "Bound request" }] })) events.push(event);
  assert.ok(events.some(event => event.type === "text" && event.delta === "Fixture result"));
  assert.deepEqual(requests, [
    { provider: "typesafe", url: "https://api.typesafe.ai/v1/models", method: "GET" },
    { provider: "typesafe", url: "https://api.typesafe.ai/v1/chat/completions", method: "POST" },
  ]);
});

test("native provider responses deliver data frames that arrive after the reader is waiting", async () => {
  const { providerChannel } = await import("../sidecar/provider-channel.ts");
  const parts = ['{"data":[{"id":"b"},', '{"id":"a"}]}'];
  const channel = providerChannel(async (message) => {
    if (message.type !== "provider_request") return;
    const id = message.id as string;
    const frames: Record<string, unknown>[] = [
      { v: 2, id, type: "provider_headers", status: 200, headers: { "content-type": "application/json" } },
      ...parts.map((part, seq) => ({ v: 2, id, type: "provider_data", seq, data: Buffer.from(part).toString("base64") })),
      { v: 2, id, type: "provider_end" },
    ];
    // Each frame is its own macrotask, as frames read from the parent pipe are.
    frames.forEach((frame, index) => setTimeout(() => channel.receive(frame), index * 5));
  });
  const res = await channel.fetch("openai", "https://api.openai.com/v1/models", { signal: AbortSignal.timeout(2000) }, { operationId: "op-1", attempt: 0 });
  assert.deepEqual(await res.json(), { data: [{ id: "b" }, { id: "a" }] });
});

test("native egress forwards only protocol headers and returns the MCP session header", async () => {
  const { providerChannel } = await import("../sidecar/provider-channel.ts");
  const sent: Record<string, unknown>[] = [];
  const channel = providerChannel(async (message) => {
    if (message.type !== "egress_request") return;
    sent.push(message);
    const id = message.id as string;
    const status = message.method === "DELETE" ? 204 : 200;
    setTimeout(() => {
      channel.receive({ v: 2, id, type: "provider_headers", status, headers: { "content-type": "application/json", "mcp-session-id": "s-1" } });
      if (status === 200) channel.receive({ v: 2, id, type: "provider_data", seq: 0, data: Buffer.from('{"ok":true}').toString("base64") });
      channel.receive({ v: 2, id, type: "provider_end" });
    }, 1);
  });
  const res = await channel.egressFetch("https://mcp.nseindia.in/bhavcopy/cm/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", cookie: "a=b", authorization: "Bearer x" }, body: "{}" });
  assert.equal(res.headers.get("mcp-session-id"), "s-1");
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(sent[0]!.headers, { "content-type": "application/json", accept: "application/json" });
  assert.match(String(sent[0]!.id), /^egr-/);
  assert.equal((await channel.egressFetch("https://mcp.nseindia.in/x", { method: "DELETE" })).status, 204);
  await assert.rejects(channel.egressFetch("http://127.0.0.1:11434/api/tags"), /HTTPS/);
});

test("native egress refuses redirects instead of following them", async () => {
  const { providerChannel } = await import("../sidecar/provider-channel.ts");
  const channel = providerChannel(async (message) => {
    const id = message.id as string;
    if (message.type !== "egress_request") return;
    setTimeout(() => { channel.receive({ v: 2, id, type: "provider_headers", status: 302, headers: {} }); channel.receive({ v: 2, id, type: "provider_end" }); }, 1);
  });
  await assert.rejects(channel.egressFetch("https://mcp.nseindia.in/mcp", { method: "POST", body: "{}" }), /redirect/);
});
