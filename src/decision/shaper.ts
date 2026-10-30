// Turn Shaper orchestration module.
// Applies decision-scoring outcomes to dynamically optimize chat payloads:
// eliminates context bloating, prunes unused tool schemas, and bounds step limits.

import { prefs } from "../core.ts";
import { HeuristicDecisionProvider } from "./heuristic.ts";
import { DEFAULT_DECISION_TIMEOUT_MS, DEFAULT_OLLAMA_DECISION_MODEL, OllamaDecisionProvider } from "./providers/ollama.ts";
import { DEFAULT_OPENROUTER_MODEL, OpenRouterDecisionProvider } from "./providers/openrouter.ts";
import { DEFAULT_OPENAI_MODEL, OpenAIDecisionProvider } from "./providers/openai.ts";
import type { DecisionConfig, DecisionProvider, DecisionState, TurnShape } from "./types.ts";

export interface ChatTurnPayload {
  message: string;
  history?: unknown[];
  tools?: Array<{ name: string; namespace?: string; description?: string; parameters?: unknown }>;
  skills?: Array<{ name: string; description?: string }>;
  surfaces?: Array<{ id: string; title?: string; componentTypes: string[] }>;
  systemPrompt?: string;
  maxSteps?: number;
  toolRounds?: number;
  surfaceKind?: string;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ShapedTurnResult {
  readonly payload: ChatTurnPayload;
  readonly shape: TurnShape;
  readonly originalToolCount: number;
  readonly prunedToolCount: number;
  readonly originalHistoryLength: number;
  readonly prunedHistoryLength: number;
}

const heuristicProvider = new HeuristicDecisionProvider();
const ollamaProvider = new OllamaDecisionProvider();
const openrouterProvider = new OpenRouterDecisionProvider();
const openaiProvider = new OpenAIDecisionProvider();

export function getDecisionConfig(): DecisionConfig {
  const enabled = prefs.get("decision:enabled") !== "false";
  const providerId = (prefs.get("decision:provider") as DecisionConfig["providerId"]) ?? "ollama";
  const modelId = prefs.get("decision:model") ?? DEFAULT_OLLAMA_DECISION_MODEL;
  const timeoutMs = Number(prefs.get("decision:timeout") ?? DEFAULT_DECISION_TIMEOUT_MS);
  const pruneTools = prefs.get("decision:pruneTools") !== "false";
  const stripSalutations = prefs.get("decision:stripSalutations") !== "false";
  const optimizeContext = prefs.get("decision:optimizeContext") !== "false";

  return {
    enabled,
    providerId,
    modelId,
    timeoutMs: Number.isNaN(timeoutMs) ? DEFAULT_DECISION_TIMEOUT_MS : timeoutMs,
    pruneTools,
    stripSalutations,
    optimizeContext,
  };
}

export function saveDecisionConfig(cfg: Partial<DecisionConfig>): void {
  if (cfg.enabled !== undefined) prefs.set("decision:enabled", String(cfg.enabled));
  if (cfg.providerId !== undefined) prefs.set("decision:provider", cfg.providerId);
  if (cfg.modelId !== undefined) prefs.set("decision:model", cfg.modelId);
  if (cfg.timeoutMs !== undefined) prefs.set("decision:timeout", String(cfg.timeoutMs));
  if (cfg.pruneTools !== undefined) prefs.set("decision:pruneTools", String(cfg.pruneTools));
  if (cfg.stripSalutations !== undefined) prefs.set("decision:stripSalutations", String(cfg.stripSalutations));
  if (cfg.optimizeContext !== undefined) prefs.set("decision:optimizeContext", String(cfg.optimizeContext));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("vak:decision-config-changed"));
}

export function getActiveDecisionProvider(config: DecisionConfig = getDecisionConfig()): DecisionProvider {
  if (config.providerId === "ollama") {
    ollamaProvider.model = config.modelId || DEFAULT_OLLAMA_DECISION_MODEL;
    return ollamaProvider;
  }
  if (config.providerId === "openai") {
    openaiProvider.model = config.modelId || DEFAULT_OPENAI_MODEL;
    return openaiProvider;
  }
  if (config.providerId === "openrouter") {
    openrouterProvider.model = config.modelId || DEFAULT_OPENROUTER_MODEL;
    return openrouterProvider;
  }
  return heuristicProvider;
}

/**
 * Intercepts a chat turn payload and shapes it dynamically based on the decision model.
 */
export async function shapeTurn(
  payload: ChatTurnPayload,
  config: DecisionConfig = getDecisionConfig(),
): Promise<ShapedTurnResult> {
  const originalTools = payload.tools ?? [];
  const originalHistory = payload.history ?? [];
  const originalToolCount = originalTools.length;
  const originalHistoryLength = originalHistory.length;

  if (!config.enabled) {
    const unshaped: TurnShape = {
      intent: "complex_reasoning",
      confidence: 1.0,
      historyPolicy: "full",
      allowedToolNamespaces: originalTools.map((t) => t.name),
      includeSurfaceGrammar: true,
      stepLimit: payload.maxSteps ?? 12,
      toolBudget: payload.toolRounds ?? 8,
      suggestedTier: "primary",
      reason: "Decision engine disabled; turn payload preserved unshaped.",
      latencyMs: 0,
    };
    return {
      payload,
      shape: unshaped,
      originalToolCount,
      prunedToolCount: 0,
      originalHistoryLength,
      prunedHistoryLength: 0,
    };
  }

  const provider = getActiveDecisionProvider(config);
  const state: DecisionState = {
    message: payload.message,
    activeSurfaceKind: payload.surfaceKind ?? payload.surfaces?.[0]?.componentTypes?.[0],
    activeSurfaces: payload.surfaces,
    activeSkills: payload.skills,
    availableTools: originalTools.map((t) => t.name),
    runtimeTools: originalTools.map((t) => ({
      name: t.name,
      namespace: t.namespace ?? (t.name.includes("_") ? t.name.split("_")[0]! : t.name.split("-")[0]!),
      description: t.description,
    })),
    currentProvider: payload.provider,
    currentModel: payload.model,
  };

  let shape = await provider.classifyTurn(state, config.timeoutMs);

  // Defense-in-depth: Guard against Ghost Canvas Refinement if no surface is active
  const hasActiveSurface = Boolean(state.activeSurfaceKind || (state.activeSurfaces && state.activeSurfaces.length > 0));
  if (shape.intent === "canvas_refinement" && !hasActiveSurface) {
    shape = {
      ...shape,
      intent: originalTools.length > 0 ? "scoped_tool_task" : "complex_reasoning",
      historyPolicy: "recent_window",
      allowedToolNamespaces: originalTools.map((t) => t.name),
      stepLimit: Math.max(shape.stepLimit, 6),
      toolBudget: Math.max(shape.toolBudget, 4),
      reason: `${shape.reason} (Guarded against ghost canvas refinement: no surface active on screen).`,
    };
  }

  const shapedPayload = { ...payload };

  // 1. History Pruning & Context Optimization
  if (shape.historyPolicy === "strip_all" && config.stripSalutations) {
    shapedPayload.history = [];
  } else if (config.optimizeContext) {
    if (shape.historyPolicy === "last_turn_only") {
      shapedPayload.history = originalHistory.slice(-1);
    } else if (shape.historyPolicy === "recent_window") {
      shapedPayload.history = originalHistory.slice(-4);
    }
  }

  // 2. Tool Pruning
  if (shape.allowedToolNamespaces.length === 0 && (shape.intent === "salutation" || shape.intent === "canvas_refinement")) {
    if (config.pruneTools) {
      shapedPayload.tools = [];
    }
  } else if (config.pruneTools && shape.allowedToolNamespaces.length > 0) {
    shapedPayload.tools = originalTools.filter((tool) =>
      shape.allowedToolNamespaces.some((ns) =>
        tool.name.toLowerCase().includes(ns.toLowerCase()),
      ),
    );
  }

  // 3. Execution Budgets
  shapedPayload.maxSteps = Math.min(payload.maxSteps ?? 16, shape.stepLimit);
  shapedPayload.toolRounds = Math.min(payload.toolRounds ?? 12, shape.toolBudget);

  const prunedToolCount = originalToolCount - (shapedPayload.tools?.length ?? 0);
  const prunedHistoryLength = originalHistoryLength - (shapedPayload.history?.length ?? 0);

  return {
    payload: shapedPayload,
    shape,
    originalToolCount,
    prunedToolCount,
    originalHistoryLength,
    prunedHistoryLength,
  };
}
