import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message, Provider, ProviderEntry } from "@vak/providers";
import type { TaskRunIdentity } from "../shared/task-contract.ts";
import { emptyShape, type FinopsView, type Rate, type Shape, type Step, type Turn } from "../shared/finops.ts";

type Context = { task?: TaskRunIdentity; turn?: Turn; session?: string; at: string; started: number };
export function messageShape(messages: Message[]): Shape {
  const s = emptyShape();
  for (const m of messages) {
    if (m.role === "user") s.user += m.content.length;
    else if (m.role === "tool") s[m.toolName?.startsWith("vak_") ? "feedback" : "results"] += m.content.length;
    else {
      s.text += m.content.length;
      for (const c of m.toolCalls ?? []) s[c.name.startsWith("vak_") ? "projection" : "tools"] += c.arguments.length;
    }
  }
  return s;
}
function addShape(to: Shape, from: Shape): void {
  for (const k of Object.keys(to) as (keyof Shape)[]) to[k] += from[k];
}

/** Observes the app's provider boundary; never stores prompts, arguments, results, or native reasoning. */
export class Finops {
  readonly scope = new AsyncLocalStorage<Context>();
  readonly dir: string;
  readonly file: string;
  readonly warn: (s: string) => void;
  constructor(dataDir: string, warn: (s: string) => void = () => {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "logs", "finops.jsonl");
    this.warn = warn;
  }

  session(id: string): void {
    const c = this.scope.getStore();
    if (c) c.session = id;
  }

  async chat(work: () => Promise<void>, task?: TaskRunIdentity): Promise<void> {
    const c: Context = { ...(task ? { task: { ...task } } : {}), at: new Date().toISOString(), started: performance.now() };
    await this.scope.run(c, async () => {
      try { await work(); }
      finally {
        if (c.turn) {
          c.turn.ms = performance.now() - c.started;
          try {
            const filename = c.turn.session.replace(/[^\w-]/g, "_").slice(0, 120) || "default";
            const saved = JSON.parse(readFileSync(path.join(this.dir, "sessions", `${filename}.json`), "utf8")) as { timeline: { kind: string; at: string }[]; messages: Message[] };
            const reply = saved.timeline.filter((t) => t.kind === "assistant" && Date.parse(t.at) >= Date.parse(c.at) - 50).sort((a, b) => Math.abs(Date.parse(a.at) - Date.parse(c.at)) - Math.abs(Date.parse(b.at) - Date.parse(c.at)))[0];
            if (reply) {
              c.turn.at = reply.at;
              const ordinal = saved.timeline.filter((t) => t.kind === "assistant").indexOf(reply);
              const starts = saved.messages.flatMap((m, i) => m.role === "user" && !m.content.startsWith("[engine]") ? [i] : []);
              c.turn.errors = saved.messages.slice(starts[ordinal], starts[ordinal + 1]).filter((m) => m.role === "tool" && m.isError).length;
            }
          } catch { /* A failed request may have no saved session. Telemetry still survives. */ }
          try {
            mkdirSync(path.dirname(this.file), { recursive: true });
            if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > 10_000_000) renameSync(this.file, `${this.file}.1`);
            appendFileSync(this.file, `${JSON.stringify(c.turn)}\n`, { mode: 0o600 });
          } catch { this.warn("FinOps: turn telemetry could not be saved"); }
        }
      }
    });
  }

  providers(entries: ProviderEntry[]): ProviderEntry[] {
    return entries.map((e) => ({ ...e, make: (opts) => this.observe(e.make(opts), Boolean(e.local)) }));
  }

  observe(provider: Provider, local: boolean): Provider {
    const owner = this;
    return {
      ...provider,
      async *stream(req) {
        const c = owner.scope.getStore();
        if (!c) { yield* provider.stream(req); return; }
        const turn = c.turn ??= {
          ...(c.task ? { task: c.task } : {}), id: randomUUID(), session: c.session ?? "default", at: c.at, provider: provider.id, model: req.model, local,
          ms: 0, source: "recorded", context: messageShape(req.messages), output: emptyShape(), steps: [],
          projectionCalls: 0, externalCalls: 0, errors: 0, complete: true,
        };
        const step: Step = {
          ms: 0, context: messageShape(req.messages), systemChars: req.system?.length ?? 0,
          schemaChars: JSON.stringify(req.responseSchema ?? req.tools ?? []).length,
          nativeChars: req.messages.reduce((n, m) => n + (m.native ? JSON.stringify(m.native).length : 0), 0),
          output: emptyShape(), projectionCalls: 0, externalCalls: 0, complete: false,
        };
        turn.steps.push(step);
        const started = performance.now();
        const calls = new Map<string, string>();
        try {
          for await (const ev of provider.stream(req)) {
            if (ev.type === "text") step.output[req.responseSchema ? "projection" : "text"] += ev.delta.length;
            else if (ev.type === "tool_start") {
              calls.set(ev.id, ev.name);
              if (ev.name.startsWith("vak_")) step.projectionCalls++;
              else step.externalCalls++;
            } else if (ev.type === "tool_args") step.output[calls.get(ev.id)?.startsWith("vak_") ? "projection" : "tools"] += ev.delta.length;
            else if (ev.type === "done") {
              step.complete = true;
              for (const [dest, key] of [["input", "input"], ["outputTokens", "output"], ["cachedInput", "cachedInput"]] as const) {
                const v = ev.usage?.[key];
                if (typeof v === "number" && Number.isFinite(v) && v >= 0) step[dest] = v;
              }
            }
            yield ev;
          }
        } finally {
          step.ms = performance.now() - started;
          turn.complete &&= step.complete;
          addShape(turn.output, step.output);
          turn.projectionCalls += step.projectionCalls;
          turn.externalCalls += step.externalCalls;
        }
      },
    };
  }

  rates(): Rate[] {
    try { return JSON.parse(readFileSync(path.join(this.dir, "finops-rates.json"), "utf8")) as Rate[]; }
    catch { return []; }
  }

  setRate(body: Record<string, unknown>): Rate[] {
    if (typeof body.provider !== "string" || !body.provider.trim() || typeof body.model !== "string" || !body.model.trim() || body.provider.length > 150 || body.model.length > 200) throw new Error("Provider and model are required");
    for (const k of ["input", "cached", "output"]) if (typeof body[k] !== "number" || !Number.isFinite(body[k]) || (body[k] as number) < 0) throw new Error("Rates must be finite, non-negative USD per million tokens");
    const rate: Rate = { provider: body.provider.trim(), model: body.model.trim(), input: body.input as number, cached: body.cached as number, output: body.output as number, updated: new Date().toISOString() };
    const rates = this.rates().filter((r) => r.provider !== rate.provider || r.model !== rate.model);
    rates.push(rate);
    const file = path.join(this.dir, "finops-rates.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(rates), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return rates;
  }

  view(): FinopsView {
    const turns: Turn[] = [];
    // Ignore only a truncated final record; one corrupt line must not hide other turns.
    for (const f of [`${this.file}.1`, this.file]) if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
      try { const t = JSON.parse(line) as Turn; if (t.id && t.session && Array.isArray(t.steps)) turns.push(t); } catch { /* interrupted append */ }
    }
    const sessionsDir = path.join(this.dir, "sessions");
    if (existsSync(sessionsDir)) for (const f of readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(readFileSync(path.join(sessionsDir, f), "utf8")) as { id: string; messages: Message[]; timeline: { kind: string; at: string; status?: string }[] };
        const starts = s.messages.flatMap((m, i) => m.role === "user" && !m.content.startsWith("[engine]") ? [i] : []);
        const replies = s.timeline.filter((t) => t.kind === "assistant");
        for (let n = 0; n < replies.length; n++) {
          const reply = replies[n]!, start = starts[n];
          if (start === undefined || !reply.status) continue;
          const [provider, model, duration] = reply.status.split(" · ");
          if (!provider || !model || !duration || !/^\d+(\.\d+)?s$/.test(duration)) continue;
          // The host timestamps its reply at request admission. Match it to the app's
          // admission timestamp, allowing scheduling skew but never matching two replies.
          const recorded = turns.find((t) => t.source === "recorded" && t.session === s.id && t.provider === provider && Math.abs(Date.parse(t.at) - Date.parse(reply.at)) < 1000);
          if (recorded) continue;
          const end = starts[n + 1] ?? s.messages.length, chunk = s.messages.slice(start, end), output = messageShape(chunk.filter((m) => m.role === "assistant"));
          const calls = chunk.flatMap((m) => m.toolCalls ?? []);
          const steps: Step[] = [];
          const lo = starts[Math.max(0, n - 9)] ?? 0;
          for (let i = start; i < end; i++) if (s.messages[i]!.role === "assistant") steps.push({
            ms: 0, context: messageShape(s.messages.slice(lo, i)), systemChars: 0, schemaChars: 0, nativeChars: 0,
            output: messageShape([s.messages[i]!]), projectionCalls: 0, externalCalls: 0, complete: false,
          });
          turns.push({ id: `legacy:${s.id}:${n}`, session: s.id, at: reply.at, provider, model, local: ["ollama", "lmstudio"].includes(provider),
            ms: parseFloat(duration) * 1000, source: "reconstructed", context: messageShape(s.messages.slice(lo, start + 1)), output, steps,
            projectionCalls: calls.filter((c) => c.name.startsWith("vak_")).length, externalCalls: calls.filter((c) => !c.name.startsWith("vak_")).length,
            errors: chunk.filter((m) => m.role === "tool" && m.isError).length, complete: false });
        }
      } catch { /* sessions can be replaced while this page is loading */ }
    }
    return { turns: turns.sort((a, b) => a.at.localeCompare(b.at)), rates: this.rates() };
  }
}
