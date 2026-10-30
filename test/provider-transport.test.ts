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
