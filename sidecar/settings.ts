// Desktop settings: API keys and endpoints the Settings screen edits.
// Plain values live in settings.env in the data folder. Secrets live in the
// macOS Keychain (through /usr/bin/security, so no SDK), and elsewhere in the
// same file written 0600. Secrets are never sent back to the UI, only whether
// they are set.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { PROVIDER_SETTINGS, type ProviderSetting } from "@vak/providers";
import { CHANNELS } from "./channels.ts";
import { VOICE_KEYS } from "./voice/index.ts";
import { MEDIA_KEYS } from "./media/catalog.ts";
import { validateSandboxWorkspace } from "./sandbox-status.ts";

export interface Setting extends Omit<ProviderSetting, "group" | "provider"> {
  group: ProviderSetting["group"] | "channel" | "voice" | "media" | "app";
  /** The provider or channel it configures. */
  owner: string;
}

/** The registry declares every provider variable, each channel and voice provider its secrets; the screen lists exactly those. */
export const SETTINGS: Setting[] = [
  { name: "VAK_SANDBOX_ENABLED", label: "OS-level process isolation", secret: false, group: "app", owner: "sandbox", placeholder: "true or false" },
  { name: "VAK_SANDBOX_WORKSPACE", label: "Sandbox execution project folder", secret: false, group: "app", owner: "sandbox", placeholder: "/Users/you/Projects/example" },
  { name: "VAK_EXTRA_EGRESS_HOSTS", label: "Custom allowed network egress hosts", secret: false, group: "app", owner: "sandbox", placeholder: "my-azure.openai.azure.com, 192.168.1.50:8000" },
  { name: "TYPESAFE_API_KEY", label: "TypeSafe AI API key", secret: true, group: "main", owner: "typesafe" },
  { name: "TYPESAFE_BASE_URL", label: "TypeSafe AI endpoint", secret: false, group: "more", owner: "typesafe", placeholder: "https://api.typesafe.ai/v1" },
  ...PROVIDER_SETTINGS.map(({ provider, ...s }) => ({ ...s, owner: provider })),
  ...CHANNELS.flatMap((c) => c.secrets.map((s) => ({ ...s, secret: true, group: "channel" as const, owner: c.id }))),
  ...VOICE_KEYS.map((k) => ({ ...k, secret: true, group: "voice" as const })),
  ...MEDIA_KEYS.map((k) => ({ ...k, secret: true, group: "media" as const })),
];

export interface SettingView {
  name: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  group: Setting["group"];
  owner: string;
  set: boolean;
  value?: string;
}

export interface SecretStore {
  readonly kind: "keychain" | "file" | "native";
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
}

export function nativeSecrets(): SecretStore {
  return {
    kind: "native", get: () => undefined,
    set() { throw new SettingsError("Save credentials through the native vault"); },
    delete() { throw new SettingsError("Remove credentials through the native vault"); },
  };
}

const SECURITY = "/usr/bin/security";

/**
 * The login Keychain. Writes go through `security -i` on stdin so a key never
 * appears in a process listing; items `security` creates trust `security`, so
 * reading them back raises no prompt.
 */
export function keychainStore(service: string): SecretStore {
  const quiet = { stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"], encoding: "utf8" as const };
  return {
    kind: "keychain",
    get(name) {
      try {
        return execFileSync(SECURITY, ["find-generic-password", "-s", service, "-a", name, "-w"], quiet).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    set(name, value) {
      execFileSync(SECURITY, ["-i"], { ...quiet, input: `add-generic-password -U -s "${service}" -a "${name}" -w "${value}"\n` });
      if (this.get(name) !== value) throw new Error(`the Keychain did not store ${name}`);
    },
    delete(name) {
      try {
        execFileSync(SECURITY, ["delete-generic-password", "-s", service, "-a", name], quiet);
      } catch {
        /* not there */
      }
    },
  };
}

function readEnvFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    try {
      v = v.startsWith('"') ? (JSON.parse(v) as string) : v.replace(/^'(.*)'$/, "$1");
    } catch {
      /* keep it as written */
    }
    out.set(m[1]!, v);
  }
  return out;
}

function writeEnvFile(file: string, values: Map<string, string>): void {
  writeFileSync(file, [...values].map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(""), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Secrets kept in the settings file itself (platforms without a Keychain here). */
export function fileSecrets(file: string): SecretStore {
  return {
    kind: "file",
    get: (name) => readEnvFile(file).get(name),
    set(name, value) {
      const all = readEnvFile(file);
      all.set(name, value);
      writeEnvFile(file, all);
    },
    delete(name) {
      const all = readEnvFile(file);
      if (all.delete(name)) writeEnvFile(file, all);
    },
  };
}

export class SettingsError extends Error {}

export class Settings {
  readonly file: string;
  readonly secrets: SecretStore;
  readonly env: Record<string, string | undefined>;

  constructor(opts: { file: string; secrets: SecretStore; env?: Record<string, string | undefined> }) {
    this.file = opts.file;
    this.secrets = opts.secrets;
    this.env = opts.env ?? process.env;
  }

  /**
   * Put saved values into the environment; values saved in the app win over a
   * developer's .env. Secrets left in the file by an older version move to the
   * Keychain first.
   */
  load(): void {
    const file = readEnvFile(this.file);
    if (this.secrets.kind === "keychain") {
      let moved = false;
      for (const s of SETTINGS) {
        const v = file.get(s.name);
        if (!s.secret || v === undefined) continue;
        if (v) this.secrets.set(s.name, v);
        file.delete(s.name);
        moved = true;
      }
      if (moved) writeEnvFile(this.file, file);
    }
    for (const s of SETTINGS) {
      const v = s.secret ? this.secrets.get(s.name) : file.get(s.name);
      if (v) this.env[s.name] = v;
    }
    if (process.env.VAK_VAULT_ACCOUNTS) {
      for (const account of process.env.VAK_VAULT_ACCOUNTS.split(",")) {
        const trimmed = account.trim();
        if (trimmed) this.env[trimmed] = "native-vault";
      }
    }
  }

  updatePresence(presence: Record<string, boolean>): void {
    for (const [name, isPresent] of Object.entries(presence)) {
      if (isPresent) {
        this.env[name] = "native-vault";
      } else {
        delete this.env[name];
      }
    }
  }

  view(): SettingView[] {
    return SETTINGS.map((s) => ({
      name: s.name,
      label: s.label,
      secret: s.secret,
      placeholder: s.placeholder,
      group: s.group,
      owner: s.owner,
      set: Boolean(this.env[s.name]),
      value: s.secret ? undefined : (this.env[s.name] ?? ""),
    }));
  }

  /** Apply changes: a string sets, null or "" clears. Unknown names are ignored. Returns the names changed. */
  save(values: Record<string, unknown>): string[] {
    const changes: [Setting, string][] = [];
    for (const [name, value] of Object.entries(values)) {
      const s = SETTINGS.find((x) => x.name === name);
      if (!s) continue;
      if (s.secret && this.secrets.kind === "native") throw new SettingsError("Credentials are managed by the native vault");
      const v = typeof value === "string" ? value.trim() : "";
      // A newline would start another variable in the file; quotes and spaces
      // never occur in API keys and would break the Keychain command line.
      if (/[\r\n]/.test(v) || (s.secret && /[\s"\\]/.test(v))) throw new SettingsError(`${s.label} contains characters a key never has`);
      if (name === "VAK_SANDBOX_ENABLED" && v !== "true" && v !== "false") throw new SettingsError("Process isolation must be true or false.");
      if (name === "VAK_EXTRA_EGRESS_HOSTS" && v) {
        if (/[\r\n"'\\]/.test(v)) throw new SettingsError("Custom egress hosts cannot contain quotes, backslashes, or newlines.");
      }
      if (name === "VAK_SANDBOX_WORKSPACE" && v) {
        try { validateSandboxWorkspace(v); } catch (error) { throw new SettingsError((error as Error).message); }
      }
      changes.push([s, v]);
    }
    const file = readEnvFile(this.file);
    for (const [s, v] of changes) {
      // Without a Keychain the secret lives in this same 0600 file.
      if (s.secret && this.secrets.kind === "keychain") {
        if (v) this.secrets.set(s.name, v);
        else this.secrets.delete(s.name);
      } else if (v) file.set(s.name, v);
      else file.delete(s.name);
      if (v) this.env[s.name] = v;
      else delete this.env[s.name];
    }
    writeEnvFile(this.file, file);
    return changes.map(([s]) => s.name);
  }
}
