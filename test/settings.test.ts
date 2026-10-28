import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileSecrets, type SecretStore, Settings, SettingsError } from "../sidecar/settings.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "vak-settings-"));

/** Stands in for the Keychain. */
function memoryKeychain(): SecretStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { kind: "keychain", items, get: (n) => items.get(n), set: (n, v) => void items.set(n, v), delete: (n) => void items.delete(n) };
}

test("secrets go to the Keychain, plain values to the file, and the screen never gets a secret back", () => {
  const file = path.join(dir(), "settings.env");
  const keychain = memoryKeychain();
  const env: Record<string, string | undefined> = {};
  const s = new Settings({ file, secrets: keychain, env });
  s.save({ OPENAI_API_KEY: "sk-test", OLLAMA_HOST: "http://box:11434", NOT_A_SETTING: "x" });
  assert.equal(keychain.items.get("OPENAI_API_KEY"), "sk-test");
  const text = readFileSync(file, "utf8");
  assert.match(text, /OLLAMA_HOST/);
  assert.doesNotMatch(text, /sk-test|NOT_A_SETTING/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const view = s.view();
  const key = view.find((v) => v.name === "OPENAI_API_KEY")!;
  assert.equal(key.set, true);
  assert.equal(key.value, undefined);
  assert.equal(view.find((v) => v.name === "OLLAMA_HOST")!.value, "http://box:11434");
  s.save({ OPENAI_API_KEY: null });
  assert.equal(keychain.items.has("OPENAI_API_KEY"), false);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("keys an older version left in the file move to the Keychain on load", () => {
  const file = path.join(dir(), "settings.env");
  writeFileSync(file, 'ANTHROPIC_API_KEY="ant-test-old"\nOLLAMA_MODEL="qwen3.5:4b-mlx"\n');
  const keychain = memoryKeychain();
  const env: Record<string, string | undefined> = {};
  new Settings({ file, secrets: keychain, env }).load();
  assert.equal(keychain.items.get("ANTHROPIC_API_KEY"), "ant-test-old");
  assert.equal(env.ANTHROPIC_API_KEY, "ant-test-old");
  assert.equal(env.OLLAMA_MODEL, "qwen3.5:4b-mlx");
  assert.doesNotMatch(readFileSync(file, "utf8"), /ant-test-old/);
});

test("without a Keychain, secrets stay in the 0600 file and survive other edits", () => {
  const file = path.join(dir(), "settings.env");
  const env: Record<string, string | undefined> = {};
  const s = new Settings({ file, secrets: fileSecrets(file), env });
  s.save({ GROQ_API_KEY: "gsk-1" });
  s.save({ OLLAMA_HOST: "http://h" });
  const again: Record<string, string | undefined> = {};
  new Settings({ file, secrets: fileSecrets(file), env: again }).load();
  assert.equal(again.GROQ_API_KEY, "gsk-1");
  assert.equal(again.OLLAMA_HOST, "http://h");
});

// A newline would start a new variable in the file; a quote or space would
// break out of the Keychain command line.
test("values that could inject another variable or command are refused", () => {
  const file = path.join(dir(), "settings.env");
  const s = new Settings({ file, secrets: memoryKeychain(), env: {} });
  assert.throws(() => s.save({ OLLAMA_HOST: "http://h\nOPENAI_API_KEY=x" }), SettingsError);
  assert.throws(() => s.save({ OPENAI_API_KEY: 'a" -w "b' }), SettingsError);
});

test("sandbox settings validate the whole change before persisting or changing runtime values", () => {
  const folder = dir(), file = path.join(folder, "settings.env"), env: Record<string, string | undefined> = {};
  const settings = new Settings({ file, secrets: memoryKeychain(), env });
  settings.save({ VAK_SANDBOX_ENABLED: "true", VAK_SANDBOX_WORKSPACE: folder });
  assert.throws(() => settings.save({ VAK_SANDBOX_ENABLED: "false", VAK_SANDBOX_WORKSPACE: "/" }), SettingsError);
  assert.equal(env.VAK_SANDBOX_ENABLED, "true");
  assert.equal(env.VAK_SANDBOX_WORKSPACE, folder);
  assert.throws(() => settings.save({ VAK_SANDBOX_ENABLED: "yes" }), SettingsError);
  assert.throws(() => settings.save({ VAK_SANDBOX_WORKSPACE: "relative/project" }), SettingsError);
  assert.throws(() => settings.save({ VAK_SANDBOX_WORKSPACE: path.join(folder, "absent") }), SettingsError);
  settings.save({ VAK_SANDBOX_WORKSPACE: "" });
  assert.equal(env.VAK_SANDBOX_WORKSPACE, undefined);
});
