// Real local Ollama decision provider adapter.
// Calls Ollama native `/v1/systemone` logit-scoring endpoint on local models with `decision` capability
// (e.g. `d1-omni:latest` 380M, `laya:latest` 421M) in ~15-30ms with 0 output tokens.
// Completely domain-agnostic: dynamically adapts to registered runtime tools without domain hardcoding.
// Strictly validated with timeout and automatic fallback to heuristics on error.

import { HeuristicDecisionProvider, matchDynamicTools } from "../heuristic.ts";
import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "../types.ts";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_DECISION_MODEL = "d1-omni:latest";
export const DEFAULT_DECISION_TIMEOUT_MS = 1500;

const fallback = new HeuristicDecisionProvider();

interface SystemOneQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<
    string,
    {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  >;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: string;
}

export class OllamaDecisionProvider implements DecisionProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama SystemOne: d1-omni / laya";
  readonly host: string;
  model: string;
  /** Replaces the direct HTTP call where the caller cannot reach Ollama itself. */
  post?: (body: { model: string; state: string; questions: Record<string, SystemOneQuestion>; session?: string }, signal: AbortSignal) => Promise<SystemOneResponse>;

  constructor(host: string = DEFAULT_OLLAMA_HOST, model: string = DEFAULT_OLLAMA_DECISION_MODEL) {
    this.host = host;
    this.model = model;
  }

  async classifyTurn(state: DecisionState, timeoutMs = DEFAULT_DECISION_TIMEOUT_MS): Promise<TurnShape> {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const hasActiveSurface = Boolean(state.activeSurfaceKind || (state.activeSurfaces && state.activeSurfaces.length > 0));
    // 1. General-purpose, domain-agnostic intent question. Canvas refinement is
    // offered only with a surface on screen: otherwise the small model files
    // unfamiliar scripts under it (a Devanagari greeting was "canvas").
    const questions: Record<string, SystemOneQuestion> = {
      intent: {
        type: "choice",
        instructions: "Classify the primary intent of the user message",
        criteria: {
          salutation: "Only a greeting, thanks, farewell, acknowledgement or small talk, in any language or script, with no request",
          ...(hasActiveSurface ? { canvas_refinement: "Visual styling, changing chart kind, sorting table, or UI layout tweak on an existing active canvas surface" } : {}),
          scoped_tool_task: "A concrete, bounded request requiring external tool execution, reading files, data retrieval, or API action",
          complex_reasoning: "Open-ended analysis, synthesis, deep planning, drafting, multi-step problem solving, or creative reasoning",
        },
      },
      // Independent of intent: a greeting that also asks something ("hi, what's
      // the weather?") must keep its tools, whatever language it is in.
      asks: {
        type: "choice",
        instructions: "Does the message ask for information, an action, or content, beyond social pleasantries? Judge meaning in any language.",
        criteria: {
          yes: "It asks a question or requests information, an action, or content",
          no: "It is only a greeting, thanks, farewell or pleasantry",
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

      const request = { model: this.model, state: contextText, questions };
      let data: SystemOneResponse;
      if (this.post) {
        data = await this.post({ ...request, ...(state.sessionId ? { session: state.sessionId } : {}) }, controller.signal);
      } else {
        const response = await fetch(`${this.host}/v1/systemone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          throw new Error(`Ollama /v1/systemone responded with HTTP ${response.status}`);
        }
        data = (await response.json()) as SystemOneResponse;
      }
      if (data.error) throw new Error(data.error);

      const intentAnswer = data.answers?.intent;
      if (!intentAnswer?.choice) throw new Error("No intent answer from Ollama");

      let intent = intentAnswer.choice as TurnIntent;
      const confidence = typeof intentAnswer.confidence === "number" ? intentAnswer.confidence : 0.85;

      // Guard against Ghost Canvas Refinement: UI refinement requires an active surface snapshot on screen
      if (intent === "canvas_refinement" && !hasActiveSurface) {
        intent = state.availableTools.length > 0 ? "scoped_tool_task" : "complex_reasoning";
      }

      // Guard against Disguised Salutations & Compound Intents:
      // A pure salutation cannot contain matched tool stems or substantive instructions
      if (intent === "salutation") {
        const matched = matchDynamicTools(state.message, state.availableTools);
        if (matched.length > 0 || state.message.trim().length > 60 || data.answers?.asks?.choice !== "no") {
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
        reasoningEffort: intent === "salutation" || intent === "canvas_refinement" ? "low" : intent === "scoped_tool_task" ? "medium" : "high",
        think: intent === "complex_reasoning",
        reason: `Evaluated by local decision model ${data.model ?? this.model} (Single-pass probability: ${Math.round(confidence * 100)}%).`,
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
        reason: `${res.reason} (Ollama model ${this.model} unavailable; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
