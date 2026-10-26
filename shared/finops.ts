import type { TaskRunIdentity } from "./task-contract.ts";
// App-owned accounting. Projection packages know nothing about prices or this ledger.
export interface Shape {
  user: number;
  text: number;
  projection: number;
  tools: number;
  feedback: number;
  results: number;
}
export const emptyShape = (): Shape => ({ user: 0, text: 0, projection: 0, tools: 0, feedback: 0, results: 0 });
export const shapeTotal = (s: Shape): number => Object.values(s).reduce((a, b) => a + b, 0);
export interface Step {
  ms: number;
  context: Shape;
  systemChars: number;
  schemaChars: number;
  // Serialized native replay is separate: encrypted reasoning bytes are not tokens.
  nativeChars: number;
  output: Shape;
  projectionCalls: number;
  externalCalls: number;
  input?: number;
  outputTokens?: number;
  cachedInput?: number;
  complete: boolean;
}
export interface Turn {
  task?: TaskRunIdentity;
  id: string;
  session: string;
  at: string;
  provider: string;
  model: string;
  local: boolean;
  ms: number;
  source: "recorded" | "reconstructed";
  context: Shape;
  output: Shape;
  steps: Step[];
  projectionCalls: number;
  externalCalls: number;
  errors: number;
  complete: boolean;
}
export interface Rate {
  provider: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  updated: string;
}
export interface FinopsView { turns: Turn[]; rates: Rate[] }

/** Missing reports stay unknown: a failed paid request may still have been billed. */
export function estimateCost(turn: Turn, rates: Rate[]): number | undefined {
  if (turn.local) return 0;
  const rate = rates.find((r) => r.provider === turn.provider && r.model === turn.model);
  if (!rate || turn.source !== "recorded" || !turn.complete || !turn.steps.length) return undefined;
  let usd = 0;
  for (const s of turn.steps) {
    if (!s.complete || s.input === undefined || s.outputTokens === undefined) return undefined;
    if (rate.input !== rate.cached && s.cachedInput === undefined) return undefined;
    const cached = s.cachedInput ?? 0;
    if (cached > s.input) return undefined;
    usd += ((s.input - cached) * rate.input + cached * rate.cached + s.outputTokens * rate.output) / 1_000_000;
  }
  return usd;
}


export interface RunUsage {
  requests: number;
  input?: number;
  output?: number;
  estimatedModelUsd?: number;
}
/** Missing or incomplete reports are unknown, including a run that never reached a provider. */
export function runUsage(view: FinopsView, taskId: string, runId: string): RunUsage {
  const turns = view.turns.filter((turn) => turn.task?.taskId === taskId && turn.task.runId === runId);
  const tokens = (key: "input" | "outputTokens"): number | undefined => {
    if (!turns.length || turns.some((t) => !t.complete || t.source !== "recorded" || !t.steps.length || t.steps.some((s) => !s.complete || s[key] === undefined))) return undefined;
    return turns.reduce((sum, t) => sum + t.steps.reduce((n, step) => n + step[key]!, 0), 0);
  };
  const costs = turns.map((t) => estimateCost(t, view.rates));
  return { requests: turns.reduce((sum, t) => sum + t.steps.length, 0), input: tokens("input"), output: tokens("outputTokens"), estimatedModelUsd: costs.length && costs.every((cost) => cost !== undefined) ? costs.reduce((sum, cost) => sum + cost!, 0) : undefined };
}


export function parseRunUsage(value: unknown): RunUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run usage");
  const raw = value as Record<string, unknown>;
  const count = (key: string, optional = true): number | undefined => {
    const n = raw[key];
    if (n === undefined && optional) return undefined;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key !== "estimatedModelUsd" && !Number.isSafeInteger(n))) throw new Error("Invalid usage count or estimate");
    return n;
  };
  return { requests: count("requests", false)!, input: count("input"), output: count("output"), estimatedModelUsd: count("estimatedModelUsd") };
}
