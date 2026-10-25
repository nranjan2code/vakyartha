// Channels: chat platforms the engine answers on while the app runs in the
// background. Each channel declares the secrets it needs and how to run until
// aborted; this manager starts, stops and reports them. Telegram is the first;
// Slack (Socket Mode) and Discord (Gateway) plug in here as more entries once
// their listeners exist (their projectors are in @vak/slack and @vak/discord).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { choosePlan, type ProfileCache, type ProviderEntry, resolveProfile } from "@vak/providers";
import { type ChannelState, runTelegram } from "@vak/telegram";

export interface ChannelContext {
  env: Record<string, string | undefined>;
  provider: ProviderEntry;
  model: string;
  profiles: ProfileCache;
  dataDir: string;
  /** None: the channel's own (Telegram's bot instructions know its limits). */
  instructions?: string;
  signal: AbortSignal;
  log: (line: string) => void;
  onState: (state: ChannelState, detail: string) => void;
}

export interface ChannelDef {
  id: string;
  label: string;
  /** Secret settings it needs (shown in Settings, stored like API keys). */
  secrets: { name: string; label: string }[];
  /** Runs until ctx.signal aborts. */
  run(ctx: ChannelContext): Promise<void>;
}

export const CHANNELS: ChannelDef[] = [
  {
    id: "telegram",
    label: "Telegram",
    secrets: [{ name: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token (from @BotFather)" }],
    async run(ctx) {
      const provider = ctx.provider.make();
      const profile = await resolveProfile(ctx.provider.id, provider, ctx.model, ctx.profiles, AbortSignal.timeout(8000));
      await runTelegram({
        token: ctx.env.TELEGRAM_BOT_TOKEN!,
        provider,
        model: ctx.model,
        plan: choosePlan(profile),
        instructions: ctx.instructions,
        dataDir: path.join(ctx.dataDir, "channels", "telegram"),
        signal: ctx.signal,
        log: ctx.log,
        onState: ctx.onState,
      });
    },
  },
];

interface ChannelConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
}

export interface ChannelView {
  id: string;
  label: string;
  enabled: boolean;
  provider?: string;
  model?: string;
  /** Every secret it needs is set. */
  ready: boolean;
  /** Secret settings it uses, and those still unset. */
  secrets: string[];
  needs: string[];
  state: ChannelState | "off";
  detail: string;
}

export class Channels {
  private configs: Record<string, ChannelConfig> = {};
  private running = new Map<string, { ctrl: AbortController; state: ChannelState | "off"; detail: string; done: Promise<void> }>();
  private readonly file: string;
  private readonly deps: Omit<ChannelContext, "provider" | "model" | "signal" | "onState"> & { providers: () => ProviderEntry[] };

  constructor(deps: Channels["deps"]) {
    this.deps = deps;
    this.file = path.join(deps.dataDir, "channels.json");
    try {
      this.configs = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.configs = {};
    }
  }

  view(): ChannelView[] {
    return CHANNELS.map((c) => {
      const cfg = this.configs[c.id] ?? { enabled: false };
      const run = this.running.get(c.id);
      const needs = c.secrets.filter((s) => !this.deps.env[s.name]).map((s) => s.name);
      return { id: c.id, label: c.label, enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, ready: !needs.length, secrets: c.secrets.map((s) => s.name), needs, state: run?.state ?? "off", detail: run?.detail ?? (cfg.enabled && needs.length ? "add its token in Settings" : "") };
    });
  }

  /** Save a channel's choices and restart it to match. */
  async configure(id: string, change: Partial<ChannelConfig>): Promise<void> {
    if (!CHANNELS.some((c) => c.id === id)) throw new Error(`unknown channel ${id}`);
    this.configs[id] = { ...(this.configs[id] ?? { enabled: false }), ...change };
    writeFileSync(this.file, JSON.stringify(this.configs, null, 2));
    await this.restart(id);
  }

  /** Start every enabled channel (at launch, and after keys change). */
  async startAll(): Promise<void> {
    await Promise.all(CHANNELS.map((c) => this.restart(c.id)));
  }

  async stopAll(): Promise<void> {
    await Promise.all(CHANNELS.map((c) => this.stop(c.id)));
  }

  private async stop(id: string): Promise<void> {
    const run = this.running.get(id);
    if (!run) return;
    run.ctrl.abort();
    await run.done;
    this.running.delete(id);
  }

  private async restart(id: string): Promise<void> {
    await this.stop(id);
    const def = CHANNELS.find((c) => c.id === id)!;
    const cfg = this.configs[id];
    if (!cfg?.enabled || def.secrets.some((s) => !this.deps.env[s.name])) return;
    const ctrl = new AbortController();
    const entry: { ctrl: AbortController; state: ChannelState | "off"; detail: string; done: Promise<void> } = { ctrl, state: "starting", detail: "", done: Promise.resolve() };
    this.running.set(id, entry);
    const providers = this.deps.providers();
    // A channel runs unattended, so its model is its own choice; it defaults to the local one.
    const provider = providers.find((p) => p.id === cfg.provider && p.available) ?? providers.find((p) => p.local && p.available);
    const model = cfg.model || provider?.defaultModel;
    if (!provider || !model) {
      Object.assign(entry, { state: "error", detail: "choose a model for this channel" });
      return;
    }
    const onState = (state: ChannelState, detail: string) => {
      if (entry.state !== state || entry.detail !== detail) this.deps.log(`${id}: ${state} ${detail}`);
      Object.assign(entry, { state, detail });
    };
    entry.done = def
      .run({ ...this.deps, provider, model, signal: ctrl.signal, onState })
      .catch((err) => onState("error", (err as Error).message));
  }
}
