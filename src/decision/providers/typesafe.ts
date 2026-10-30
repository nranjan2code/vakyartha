// Real TypeSafe AI decision provider adapter.
// Calls TypeSafe AI's native `/v1/systemone` logit/decision endpoint with its flagship
// non-autoregressive decision model Jev (`jev-latest`, `jev-1.14`, `jev-router`).
// Completely domain-agnostic: dynamically adapts to registered runtime tools without domain hardcoding.
// Strictly validated with timeout and automatic fallback to heuristics on error.

import { HeuristicDecisionProvider, matchDynamicTools } from "../heuristic.ts";
import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "../types.ts";

export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 2500;

const fallback = new HeuristicDecisionProvider();

interface TypeSafeQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

interface TypeSafeSystemOneResponse {
  model?: string;
  answers?: Record<
    string,
    {
      type?: string;
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
      score?: number;
      value?: boolean;
    }
  >;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: string | { message?: string };
}

export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly id = "typesafe" as const;
  readonly label = "TypeSafe AI: Jev SystemOne";
  readonly baseUrl: string;
  private readonly keyResolver?: string | (() => string | undefined);
  model: string;

  constructor(
    apiKey?: string | (() => string | undefined),
    model: string = DEFAULT_TYPESAFE_MODEL,
    baseUrl: string = DEFAULT_TYPESAFE_BASE_URL,
  ) {
    this.keyResolver = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get apiKey(): string | undefined {
    if (typeof this.keyResolver === "function") return this.keyResolver();
    if (typeof this.keyResolver === "string") return this.keyResolver;
    if (typeof process !== "undefined" && process.env?.TYPESAFE_API_KEY) {
      return process.env.TYPESAFE_API_KEY;
    }
    return undefined;
  }

  /**
   * Queries TypeSafe AI's endpoint dynamically to detect all available models for this API key.
   * Never relies on hardcoded model lists.
   */
  async listModels(timeoutMs = DEFAULT_TYPESAFE_TIMEOUT_MS): Promise<string[]> {
    const resolvedKey = this.apiKey;
    if (!resolvedKey) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${resolvedKey}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id: string } | string> } | Array<{ id: string } | string>;
      const raw = Array.isArray(body) ? body : (body.data ?? []);
      return raw.map((item) => (typeof item === "string" ? item : item.id)).filter(Boolean).sort();
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async classifyTurn(state: DecisionState, timeoutMs = DEFAULT_TYPESAFE_TIMEOUT_MS): Promise<TurnShape> {
    const start = performance.now();
    const resolvedKey = this.apiKey;

    // Infallible fallback: If no API key is configured, immediately fall back to heuristics
    if (!resolvedKey) {
      const res = await fallback.classifyTurn(state);
      return {
        ...res,
        reason: `${res.reason} (TypeSafe AI API key not configured; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // 1. General-purpose, domain-agnostic intent question
    const questions: Record<string, TypeSafeQuestion> = {
      intent: {
        type: "choice",
        instructions: "Classify the primary intent of the user message",
        criteria: {
          salutation: "Simple casual greeting, gratitude, or chit-chat (e.g. hi, thanks, ok, bye)",
          canvas_refinement: "Visual styling, changing chart kind, sorting table, or UI layout tweak on an existing active canvas surface",
          scoped_tool_task: "A concrete, bounded request requiring external tool execution, reading files, data retrieval, or API action",
          complex_reasoning: "Open-ended analysis, synthesis, deep planning, drafting, multi-step problem solving, or creative reasoning",
        },
      },
    };

    // 2. Derive unique namespaces dynamically from available runtime tools
    const uniqueNamespaces = Array.from(
      new Set(
        state.availableTools.map((t) => (t.includes("_") ? t.split("_")[0]! : t.split("-")[0]!)),
      ),
    ).filter(Boolean);

    if (uniqueNamespaces.length > 1 && uniqueNamespaces.length <= 6) {
      const criteria: Record<string, string> = {};
      for (const ns of uniqueNamespaces) {
        criteria[ns] = `Tasks relating to ${ns} actions, data, or resources`;
      }
      questions.tool_namespace = {
        type: "choice",
        instructions: "Which tool capability is primarily required to fulfill the user request?",
        criteria,
      };
    }

    try {
      const contextText = state.activeSurfaceKind
        ? `Active surface on canvas: ${state.activeSurfaceKind}.\nUser request: ${state.message}`
        : state.message;

      const endpoint = `${this.baseUrl}/systemone`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolvedKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          state: contextText,
          questions,
        }),
      });

      if (!response.ok) {
        throw new Error(`TypeSafe AI /v1/systemone responded with HTTP ${response.status}`);
      }

      const data = (await response.json()) as TypeSafeSystemOneResponse;
      if (data.error) {
        const errMsg = typeof data.error === "string" ? data.error : data.error.message ?? "Unknown error";
        throw new Error(errMsg);
      }

      const intentAnswer = data.answers?.intent;
      if (!intentAnswer?.choice) throw new Error("No intent answer from TypeSafe AI");

      let intent = intentAnswer.choice as TurnIntent;
      const confidence = typeof intentAnswer.confidence === "number" ? intentAnswer.confidence : 0.90;

      // Guard against Ghost Canvas Refinement: UI refinement requires an active surface snapshot on screen
      const hasActiveSurface = Boolean(
        state.activeSurfaceKind || (state.activeSurfaces && state.activeSurfaces.length > 0),
      );
      if (intent === "canvas_refinement" && !hasActiveSurface) {
        intent = state.availableTools.length > 0 ? "scoped_tool_task" : "complex_reasoning";
      }

      // Guard against Disguised Salutations & Compound Intents:
      // A pure salutation cannot contain matched tool stems or substantive instructions
      if (intent === "salutation") {
        const matched = matchDynamicTools(state.message, state.availableTools);
        if (matched.length > 0 || state.message.trim().length > 60) {
          intent = matched.length > 0 ? "scoped_tool_task" : "complex_reasoning";
        }
      }

      const chosenNamespace = data.answers?.tool_namespace?.choice;
      const namespaceConfidence = data.answers?.tool_namespace?.confidence ?? 0;
      let allowedToolNamespaces: string[] = [];

      if (intent === "salutation" || intent === "canvas_refinement") {
        allowedToolNamespaces = [];
      } else if (intent === "scoped_tool_task") {
        if (chosenNamespace && uniqueNamespaces.includes(chosenNamespace) && namespaceConfidence >= 0.70) {
          allowedToolNamespaces = state.availableTools.filter((t) =>
            t.toLowerCase().startsWith(chosenNamespace.toLowerCase()),
          );
        } else {
          // If namespace confidence is ambiguous (< 0.70), match dynamically against runtime tools
          const fallbackShape = await fallback.classifyTurn(state);
          allowedToolNamespaces = fallbackShape.allowedToolNamespaces.length > 0
            ? [...fallbackShape.allowedToolNamespaces]
            : [...state.availableTools];
        }
      } else {
        allowedToolNamespaces = [...state.availableTools];
      }

      const elapsed = Math.round((performance.now() - start) * 100) / 100;

      return {
        intent,
        confidence: Math.round(confidence * 100) / 100,
        historyPolicy:
          intent === "salutation"
            ? "strip_all"
            : intent === "canvas_refinement"
              ? "last_turn_only"
              : intent === "scoped_tool_task"
                ? "recent_window"
                : "full",
        allowedToolNamespaces,
        includeSurfaceGrammar: intent === "canvas_refinement" || intent === "complex_reasoning",
        stepLimit: intent === "salutation" ? 4 : intent === "canvas_refinement" ? 8 : intent === "scoped_tool_task" ? 12 : 24,
        toolBudget: intent === "salutation" || intent === "canvas_refinement" ? 0 : intent === "scoped_tool_task" ? 4 : 8,
        suggestedTier: intent === "salutation" || intent === "canvas_refinement" ? "local_fast" : "primary",
        reason: `Evaluated by TypeSafe AI ${data.model ?? this.model} (Single-pass calibrated probability: ${Math.round(confidence * 100)}%).`,
        latencyMs: elapsed,
        decisionUsage: data.usage
          ? {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
            }
          : undefined,
      };
    } catch {
      // Infallible fallback: timeout or error instantly falls back to heuristics
      const res = await fallback.classifyTurn(state);
      return {
        ...res,
        reason: `${res.reason} (TypeSafe AI model ${this.model} unavailable; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
