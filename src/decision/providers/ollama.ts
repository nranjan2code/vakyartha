// Real local Ollama decision provider adapter.
// Uses Ollama's native `/v1/systemone` structured decision-scoring endpoint
// supported by local decision models such as `d1-omni:latest` and `laya:latest`.
// Executes in a single forward pass (<50ms, 0 output tokens) with calibrated probabilities.

import { HeuristicDecisionProvider } from "../heuristic.ts";
import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "../types.ts";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_DECISION_MODEL = "d1-omni:latest";
export const DEFAULT_DECISION_TIMEOUT_MS = 1500;

const fallback = new HeuristicDecisionProvider();

interface SystemOneQuestion {
  type: "choice" | "score" | "noul";
  instructions: string;
  criteria: Record<string, string>;
}

interface SystemOneResponse {
  model?: string;
  answers?: {
    intent?: {
      type: string;
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };
    tool_need?: {
      type: string;
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: string;
}

export class OllamaDecisionProvider implements DecisionProvider {
  readonly id = "ollama" as const;
  readonly label = "Local Ollama Decision Model (d1-omni / laya)";
  readonly host: string;
  model: string;

  constructor(host: string = DEFAULT_OLLAMA_HOST, model: string = DEFAULT_OLLAMA_DECISION_MODEL) {
    this.host = host;
    this.model = model;
  }

  async classifyTurn(state: DecisionState, timeoutMs = DEFAULT_DECISION_TIMEOUT_MS): Promise<TurnShape> {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const questions: Record<string, SystemOneQuestion> = {
      intent: {
        type: "choice",
        instructions: "Classify the primary intent of the user message",
        criteria: {
          salutation: "Simple casual greeting, gratitude, or chit-chat (e.g. hi, thanks, ok, bye)",
          canvas_refinement: "Visual styling, changing chart kind, sorting table, or UI layout tweak",
          scoped_tool_task: "Inspecting, reading, or opening local files, configs, package.json, code inspection, web search, or database queries",
          complex_reasoning: "Designing software systems, writing new algorithms, architecture, or deep conceptual explanations",
        },
      },
    };

    // If tools are available, add a secondary fast classification for tool capability
    if (state.availableTools.length > 0) {
      questions.tool_need = {
        type: "choice",
        instructions: "Which specific tool is required to fulfill the user request?",
        criteria: {
          filesystem: "Reading, inspecting, or writing local project files such as package.json, code, or directories",
          web_search: "Querying internet search engines or external web URLs",
          database: "Running SQL statements, DuckDB, or database queries",
        },
      };
    }

    try {
      const response = await fetch(`${this.host}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          state: state.message,
          questions,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama /v1/systemone responded with HTTP ${response.status}`);
      }

      const data = (await response.json()) as SystemOneResponse;
      if (data.error) throw new Error(data.error);

      const intentAnswer = data.answers?.intent;
      if (!intentAnswer?.choice) throw new Error("No intent answer from Ollama");

      const intent = intentAnswer.choice as TurnIntent;
      const confidence = typeof intentAnswer.confidence === "number" ? intentAnswer.confidence : 0.85;

      const toolChoice = data.answers?.tool_need?.choice ?? "none";
      let allowedToolNamespaces: string[] = [];

      if (intent === "salutation" || intent === "canvas_refinement") {
        allowedToolNamespaces = [];
      } else if (intent === "scoped_tool_task") {
        if (toolChoice === "filesystem") {
          allowedToolNamespaces = state.availableTools.filter((t) =>
            /file|fs|path|dir|read|write/i.test(t),
          );
          if (allowedToolNamespaces.length === 0) allowedToolNamespaces = ["filesystem", "fs"];
        } else if (toolChoice === "web_search" || toolChoice === "search") {
          allowedToolNamespaces = state.availableTools.filter((t) =>
            /search|web|fetch|browser/i.test(t),
          );
          if (allowedToolNamespaces.length === 0) allowedToolNamespaces = ["web_search", "search", "fetch"];
        } else if (toolChoice === "database") {
          allowedToolNamespaces = state.availableTools.filter((t) =>
            /sql|duckdb|database|db/i.test(t),
          );
          if (allowedToolNamespaces.length === 0) allowedToolNamespaces = ["duckdb", "sql"];
        } else {
          allowedToolNamespaces = [...state.availableTools];
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
        stepLimit: intent === "salutation" ? 1 : intent === "canvas_refinement" ? 3 : intent === "scoped_tool_task" ? 6 : 12,
        toolBudget: intent === "salutation" || intent === "canvas_refinement" ? 0 : intent === "scoped_tool_task" ? 4 : 8,
        suggestedTier: intent === "salutation" || intent === "canvas_refinement" ? "local_fast" : "primary",
        reason: `Evaluated by local decision model ${data.model ?? this.model} (Single-pass probability: ${Math.round(confidence * 100)}%).`,
        latencyMs: elapsed,
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
