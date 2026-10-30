// Deterministic, zero-latency heuristic decision provider.
// Executes in <1ms without network calls or token expenditure.
// Serves as an ultra-fast path for obvious intents and an infallible fallback.

import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "./types.ts";

const SALUTATION_PATTERNS = [
  /^(?:hi|hello|hey|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening|day))(?:\s+(?:there|all|everyone|world|folks))?[\s!.,?:;]*(?:how\s+are\s+you[\s?.]*)?$/i,
  /^(?:thanks|thank\s+you|thx|cheers|much\s+appreciated)(?:\s+(?:so\s+much|a\s+lot|very\s+much))?[\s!.,?:;]*$/i,
  /^(?:ok|okay|got\s+it|understood|cool|sure|great|sounds\s+good|perfect)[\s!.,?:;]*$/i,
  /^(?:bye|goodbye|see\s+ya|farewell|cya)[\s!.,?:;]*$/i,
  /^(?:who\s+are\s+you|what\s+is\s+your\s+name|what\s+can\s+you\s+do)[\s!.,?:;]*$/i,
];

const CANVAS_REFINEMENT_PATTERNS = [
  /\b(?:make|change|turn|switch|set)\s+(?:the\s+|it\s+)?(?:color|theme|view|chart|graph|table|background|font)\b/i,
  /\b(?:sort\s+by|filter\s+by|group\s+by|show\s+(?:more|fewer|less)\s+rows)\b/i,
  /\b(?:chart\s+to|change\s+to\s+(?:bar|pie|line|scatter|table|donut))\b/i,
  /\b(?:refresh\s+data|clear\s+canvas|reset\s+view|highlight\s+row)\b/i,
];

const FILE_TOOL_PATTERNS = [
  /\b(?:read|open|show|inspect|cat|tail|view|find)\s+(?:file|directory|folder|path|code|logs?|readme|package\.json)\b/i,
  /\b\w+\.(?:ts|js|json|md|rs|toml|yaml|yml|css|html|csv|sql|py)\b/i,
];

const SEARCH_TOOL_PATTERNS = [
  /\b(?:search\s+for|search\s+the\s+web|google|lookup|look\s+up|find\s+online|browse)\b/i,
  /\b(?:latest\s+news|stock\s+price|documentation\s+for|weather\s+in)\b/i,
];

const DB_TOOL_PATTERNS = [
  /\b(?:query|sql|select\s+.*from|duckdb|database|tables?|schema)\b/i,
];

export class HeuristicDecisionProvider implements DecisionProvider {
  readonly id = "heuristic" as const;
  readonly label = "Built-in Fast Heuristics (0ms)";

  async classifyTurn(state: DecisionState): Promise<TurnShape> {
    const start = performance.now();
    const text = state.message.trim();

    // 1. Check for salutations and casual banter
    if (SALUTATION_PATTERNS.some((pat) => pat.test(text))) {
      return {
        intent: "salutation",
        confidence: 0.98,
        historyPolicy: "strip_all",
        allowedToolNamespaces: [],
        includeSurfaceGrammar: false,
        stepLimit: 1,
        toolBudget: 0,
        suggestedTier: "local_fast",
        reason: "Detected pure salutation/banter; pruned all tool schemas and surface grammar.",
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // 2. Check for canvas / surface visual refinement
    if (state.activeSurfaceKind && CANVAS_REFINEMENT_PATTERNS.some((pat) => pat.test(text))) {
      return {
        intent: "canvas_refinement",
        confidence: 0.92,
        historyPolicy: "last_turn_only",
        allowedToolNamespaces: [],
        includeSurfaceGrammar: true,
        stepLimit: 3,
        toolBudget: 0,
        suggestedTier: "local_fast",
        reason: "Detected canvas/surface adjustment with active visual surface; omitted external tools.",
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // 3. Check for specific tool task categories
    const matchingToolNamespaces: string[] = [];

    if (FILE_TOOL_PATTERNS.some((pat) => pat.test(text))) {
      matchingToolNamespaces.push("filesystem", "files", "fs");
    }
    if (SEARCH_TOOL_PATTERNS.some((pat) => pat.test(text))) {
      matchingToolNamespaces.push("search", "fetch", "web", "browser");
    }
    if (DB_TOOL_PATTERNS.some((pat) => pat.test(text))) {
      matchingToolNamespaces.push("duckdb", "db", "sql", "database");
    }

    if (matchingToolNamespaces.length > 0) {
      // Intersect with available tools
      const filtered = state.availableTools.filter((t) =>
        matchingToolNamespaces.some((ns) => t.toLowerCase().includes(ns)),
      );

      return {
        intent: "scoped_tool_task",
        confidence: 0.88,
        historyPolicy: "recent_window",
        allowedToolNamespaces: filtered.length > 0 ? filtered : matchingToolNamespaces,
        includeSurfaceGrammar: true,
        stepLimit: 6,
        toolBudget: 4,
        suggestedTier: "primary",
        reason: `Matched specialized tool keywords (${matchingToolNamespaces.join(", ")}); pruned unrelated tools.`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // 4. Default: complex reasoning or general task
    return {
      intent: "complex_reasoning",
      confidence: 0.75,
      historyPolicy: "full",
      allowedToolNamespaces: state.availableTools,
      includeSurfaceGrammar: true,
      stepLimit: 12,
      toolBudget: 8,
      suggestedTier: "primary",
      reason: "General or multi-step reasoning task; preserved standard context and tool catalog.",
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }
}
