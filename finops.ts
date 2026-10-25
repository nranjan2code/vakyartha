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
