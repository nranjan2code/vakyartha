// Real OpenAI decision provider adapter.
// Uses OpenAI's official 2026 Strict Structured Outputs (`response_format: { type: "json_schema", json_schema: { strict: true } }`)
// with fast-tier models (`gpt-4o-mini`).
// Strictly validated with timeout and automatic fallback to heuristics on error.

import { HeuristicDecisionProvider, matchDynamicTools } from "../heuristic.ts";
import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "../types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_OPENAI_TIMEOUT_MS = 3500;

const fallback = new HeuristicDecisionProvider();

const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["salutation", "canvas_refinement", "scoped_tool_task", "complex_reasoning"],
    },
    confidence: { type: "number" },
    historyPolicy: {
      type: "string",
      enum: ["strip_all", "last_turn_only", "recent_window", "full"],
    },
    allowedTools: {
      type: "array",
      items: { type: "string" },
    },
    includeSurfaceGrammar: { type: "boolean" },
    stepLimit: { type: "integer" },
    toolBudget: { type: "integer" },
    suggestedTier: {
      type: "string",
      enum: ["local_fast", "primary", "frontier_cloud"],
    },
    reason: { type: "string" },
  },
  required: [
    "intent",
    "confidence",
    "historyPolicy",
    "allowedTools",
    "includeSurfaceGrammar",
    "stepLimit",
    "toolBudget",
    "suggestedTier",
    "reason",
  ],
  additionalProperties: false,
};

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class OpenAIDecisionProvider implements DecisionProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI: GPT-4o-mini";
  readonly baseUrl: string;
  private readonly keyResolver?: string | (() => string | undefined);
  model: string;

  constructor(
    apiKey?: string | (() => string | undefined),
    model: string = DEFAULT_OPENAI_MODEL,
    baseUrl: string = DEFAULT_OPENAI_BASE_URL,
  ) {
    this.keyResolver = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get apiKey(): string | undefined {
    if (typeof this.keyResolver === "function") return this.keyResolver();
    if (typeof this.keyResolver === "string") return this.keyResolver;
    if (typeof process !== "undefined" && process.env?.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }
    return undefined;
  }

  async classifyTurn(state: DecisionState, timeoutMs = DEFAULT_OPENAI_TIMEOUT_MS): Promise<TurnShape> {
    const start = performance.now();
    const resolvedKey = this.apiKey;

    // If no key is provided, gracefully drop back to heuristics immediately
    if (!resolvedKey) {
      const res = await fallback.classifyTurn(state);
      return {
        ...res,
        reason: `${res.reason} (OpenAI API key not configured; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const userContent = JSON.stringify({
      message: state.message,
      activeSurfaceKind: state.activeSurfaceKind ?? null,
      availableTools: state.availableTools,
      currentProvider: state.currentProvider,
      currentModel: state.currentModel,
    });

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolvedKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "You are an ultra-fast System 1 decision engine for an AI assistant. Classify the user turn state strictly into the provided JSON schema.",
            },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "decision_turn_shape",
              strict: true,
              schema: DECISION_JSON_SCHEMA,
            },
          },
          temperature: 0.1,
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI responded with HTTP ${response.status}`);
      }

      const data = (await response.json()) as OpenAiChatCompletionResponse;
      if (data.error?.message) throw new Error(data.error.message);

      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) throw new Error("Empty response content from OpenAI");

      const parsed = JSON.parse(rawContent) as {
        intent: TurnIntent;
        confidence: number;
        historyPolicy?: TurnShape["historyPolicy"];
        allowedTools?: string[];
        includeSurfaceGrammar?: boolean;
        stepLimit?: number;
        toolBudget?: number;
        suggestedTier?: TurnShape["suggestedTier"];
        reason?: string;
      };

      const elapsed = Math.round((performance.now() - start) * 100) / 100;

      let intent = parsed.intent;
      // Guard against Ghost Canvas Refinement: UI refinement requires an active surface snapshot on screen
      const hasActiveSurface = Boolean(state.activeSurfaceKind || (state.activeSurfaces && state.activeSurfaces.length > 0));
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

      return {
        intent,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        historyPolicy: intent === "salutation"
          ? "strip_all"
          : intent === "canvas_refinement"
            ? "last_turn_only"
            : (parsed.historyPolicy ?? "full"),
        allowedToolNamespaces: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
        includeSurfaceGrammar: Boolean(parsed.includeSurfaceGrammar),
        stepLimit: typeof parsed.stepLimit === "number" ? Math.max(1, parsed.stepLimit) : 8,
        toolBudget: typeof parsed.toolBudget === "number" ? Math.max(0, parsed.toolBudget) : 4,
        suggestedTier: parsed.suggestedTier ?? "primary",
        reason: parsed.reason ?? `Evaluated by OpenAI model (${this.model}).`,
        latencyMs: elapsed,
        decisionUsage: data.usage
          ? {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
            }
          : undefined,
      };
    } catch {
      const fallbackRes = await fallback.classifyTurn(state);
      return {
        ...fallbackRes,
        reason: `${fallbackRes.reason} (OpenAI model ${this.model} unavailable or timed out; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
