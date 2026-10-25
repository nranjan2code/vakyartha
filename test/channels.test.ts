import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProfileCache, providersFromEnv } from "@vak/providers";
import { Channels } from "../sidecar/channels.ts";
import { SETTINGS } from "../sidecar/settings.ts";

function manager(env: Record<string, string | undefined>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "vak-ch-"));
  return { dataDir, channels: new Channels({ env, providers: () => providersFromEnv(env), profiles: new ProfileCache(path.join(dataDir, "m.json")), dataDir, log: () => {} }) };
}

test("a channel is off until enabled, and an enabled one without its token waits for it", async () => {
  const { channels, dataDir } = manager({});
  const tg = channels.view().find((c) => c.id === "telegram")!;
  assert.deepEqual([tg.enabled, tg.state, tg.ready, tg.needs], [false, "off", false, ["TELEGRAM_BOT_TOKEN"]]);
  await channels.configure("telegram", { enabled: true, provider: "ollama", model: "qwen3.5:4b-mlx" });
  const after = channels.view().find((c) => c.id === "telegram")!;
  assert.equal(after.state, "off");
  assert.match(after.detail, /token/);
  // The choice is saved for the next launch.
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "channels.json"), "utf8")).telegram, { enabled: true, provider: "ollama", model: "qwen3.5:4b-mlx" });
  await assert.rejects(channels.configure("nope", { enabled: true }));
});

test("channel tokens are settings like API keys: secret, never shown back", () => {
  const token = SETTINGS.find((s) => s.name === "TELEGRAM_BOT_TOKEN")!;
  assert.equal(token.secret, true);
  assert.equal(token.group, "channel");
});
