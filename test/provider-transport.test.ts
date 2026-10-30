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
