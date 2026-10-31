import type { ModelFacts } from "@vak/providers";

/**
 * A turn's thinking and effort, kept only where the model can use them. The
 * decision step picks both without knowing the model; a model known not to
 * reason rejects or wastes them, while an unknown capability keeps the choice.
 */
export function fitTurnControls(body: { think?: unknown; effort?: unknown }, facts?: Pick<ModelFacts, "thinking">): { think: boolean; effort?: "low" | "medium" | "high" } {
  const reasons = facts?.thinking !== false;
  const effort = reasons && (body.effort === "low" || body.effort === "medium" || body.effort === "high") ? body.effort : undefined;
  return { think: reasons && body.think === true, ...(effort ? { effort } : {}) };
}
