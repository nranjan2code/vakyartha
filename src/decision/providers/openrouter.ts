// Real OpenRouter / OpenAI-compatible decision provider adapter.
// Calls the OpenAI-compatible chat completions endpoint (e.g. OpenRouter for `microsoft/decision-1`,
// Groq for `llama-3.2-1b`, Cerebras, etc.) with structured JSON schema format.
// Strictly validated with timeout and automatic fallback to heuristics on error.

import { HeuristicDecisionProvider } from "../heuristic.ts";
import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "../types.ts";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "microsoft/decision-1";
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 2000;

const fallback = new HeuristicDecisionProvider();

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

export class OpenRouterDecisionProvider implements DecisionProvider {
  readonly id = "openrouter" as const;
  readonly label = "OpenRouter: Microsoft-Decision-1";
  readonly baseUrl: string;
  readonly apiKey?: string;
  model: string;

  constructor(
    apiKey?: string,
    model: string = DEFAULT_OPENROUTER_MODEL,
    baseUrl: string = DEFAULT_OPENROUTER_BASE_URL,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async classifyTurn(state: DecisionState, timeoutMs = DEFAULT_OPENROUTER_TIMEOUT_MS): Promise<TurnShape> {
    const start = performance.now();

    // If no key is provided, gracefully drop back to heuristics immediately
    if (!this.apiKey) {
      const res = await fallback.classifyTurn(state);
      return {
        ...res,
        reason: `${res.reason} (OpenRouter API key not configured; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const systemPrompt = `You are a high-speed AI decision model and turn classifier.
Analyze the user message and classify the turn into exactly one intent:
- "salutation": simple casual greeting, gratitude, or conversational banter ("Hi", "Thanks", "Ok", "Bye")
- "canvas_refinement": visual styling, changing chart kind, sorting table, or UI layout tweak
- "scoped_tool_task": concrete, bounded request requiring external tool execution, API action, or data retrieval
- "complex_reasoning": open-ended analysis, synthesis, deep planning, drafting, multi-step problem solving, or creative reasoning

Respond ONLY with a valid JSON object matching this exact schema:
{
  "intent": "salutation" | "canvas_refinement" | "scoped_tool_task" | "complex_reasoning",
  "confidence": <number between 0.0 and 1.0>,
  "historyPolicy": "strip_all" | "last_turn_only" | "recent_window" | "full",
  "allowedTools": [<string tool names needed, or [] for none>],
  "includeSurfaceGrammar": <boolean>,
  "stepLimit": <number 1 to 16>,
  "toolBudget": <number 0 to 12>,
  "suggestedTier": "local_fast" | "primary" | "frontier_cloud",
  "reason": "<one sentence rationale>"
}`;

    const userPayload = JSON.stringify({
      message: state.message,
      activeSurfaceKind: state.activeSurfaceKind ?? null,
      availableTools: state.availableTools,
    });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPayload },
          ],
          response_format: { type: "json_object" },
          temperature: 0.0,
          max_tokens: 180,
        }),
      });

      if (!res.ok) {
        throw new Error(`OpenRouter responded with HTTP ${res.status}`);
      }

      const data = (await res.json()) as OpenAiChatCompletionResponse;
      if (data.error?.message) throw new Error(data.error.message);

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty response content from OpenRouter");

      const parsed = JSON.parse(content) as {
        intent?: TurnIntent;
        confidence?: number;
        historyPolicy?: TurnShape["historyPolicy"];
        allowedTools?: string[];
        includeSurfaceGrammar?: boolean;
        stepLimit?: number;
        toolBudget?: number;
        suggestedTier?: TurnShape["suggestedTier"];
        reason?: string;
      };

      if (!parsed.intent || typeof parsed.confidence !== "number") {
        throw new Error("Invalid schema from OpenRouter");
      }

      const elapsed = Math.round((performance.now() - start) * 100) / 100;

      return {
        intent: parsed.intent,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        historyPolicy: parsed.historyPolicy ?? (parsed.intent === "salutation" ? "strip_all" : "full"),
        allowedToolNamespaces: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
        includeSurfaceGrammar: Boolean(parsed.includeSurfaceGrammar),
        stepLimit: typeof parsed.stepLimit === "number" ? Math.max(1, parsed.stepLimit) : 8,
        toolBudget: typeof parsed.toolBudget === "number" ? Math.max(0, parsed.toolBudget) : 4,
        suggestedTier: parsed.suggestedTier ?? "primary",
        reason: parsed.reason ?? `Evaluated by OpenRouter model (${this.model}).`,
        latencyMs: elapsed,
      };
    } catch {
      const fallbackRes = await fallback.classifyTurn(state);
      return {
        ...fallbackRes,
        reason: `${fallbackRes.reason} (OpenRouter model ${this.model} unavailable or timed out; fell back to heuristics).`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
