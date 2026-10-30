// Deterministic, zero-latency heuristic decision provider.
// Executes in <1ms without network calls or token expenditure.
// Completely domain-agnostic: matches intents linguistically and dynamically derives
// tool requirements from whatever tools are active in the runtime.

import type { DecisionProvider, DecisionState, TurnIntent, TurnShape } from "./types.ts";

const SALUTATION_PATTERNS = [
  /^(?:hi|hello|hey|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening|day))(?:\s+(?:there|all|everyone|world|folks))?[\s!.,?:;]*(?:how\s+are\s+you[\s?.]*)?$/i,
  /^(?:thanks|thank\s+you|thx|cheers|much\s+appreciated)(?:\s+(?:so\s+much|a\s+lot|very\s+much))?[\s!.,?:;]*$/i,
  /^(?:ok|okay|got\s+it|understood|cool|sure|great|sounds\s+good|perfect)[\s!.,?:;]*$/i,
  /^(?:bye|goodbye|see\s+ya|farewell|cya)[\s!.,?:;]*$/i,
  /^(?:who\s+are\s+you|what\s+is\s+your\s+name|what\s+can\s+you\s+do)[\s!.,?:;]*$/i,
];

const CANVAS_REFINEMENT_PATTERNS = [
  /\b(?:make|change|turn|switch|set)\s+(?:the\s+|it\s+)?(?:color|theme|view|chart|graph|table|background|font|layout)\b/i,
  /\b(?:sort\s+by|filter\s+by|group\s+by|show\s+(?:more|fewer|less)\s+rows)\b/i,
  /\b(?:chart\s+to|change\s+to\s+(?:bar|pie|line|scatter|table|donut|area|candlestick))\b/i,
  /\b(?:refresh\s+data|clear\s+canvas|reset\s+view|highlight\s+row|update\s+surface)\b/i,
];

const COMMON_TOOL_STEMS: Record<string, string[]> = {
  filesystem: ["file", "files", "dir", "folder", "path", "read", "write", "open", "json", "ts", "js", "code", "inspect"],
  fs: ["file", "files", "dir", "folder", "path", "read", "write", "open"],
  search: ["web", "google", "online", "browse", "lookup", "url", "fetch", "internet"],
  web: ["search", "google", "online", "browse", "fetch", "url", "http", "internet"],
  db: ["sql", "query", "database", "table", "duckdb", "select"],
  duckdb: ["sql", "query", "database", "table", "select"],
  sql: ["query", "database", "table", "db", "select"],
  mail: ["email", "send", "message", "inbox"],
  email: ["mail", "send", "message", "inbox"],
  slack: ["channel", "message", "chat", "post"],
  jira: ["issue", "ticket", "task", "bug"],
  linear: ["issue", "ticket", "task", "bug"],
  gcal: ["calendar", "event", "meeting", "schedule"],
  calendar: ["event", "meeting", "schedule", "gcal"],
  weather: ["forecast", "temperature", "rain", "sunny", "climate"],
  patient: ["vitals", "health", "ehr", "medical", "doctor", "drug"],
  drug: ["interaction", "medicine", "pharmacy", "prescription"],
};

const GENERIC_CRUD_TOKENS = new Set([
  "get", "set", "list", "read", "write", "check", "find", "status", "fetch",
  "create", "update", "delete", "run", "query", "post", "send", "inspect", "call", "trigger",
]);

/**
 * Dynamically matches tools from availableTools against user prompt tokens.
 * Completely domain-agnostic: derives semantic tokens from tool names, namespaces,
 * and standard semantic stems without hardcoding rigid domain routing.
 */
export function matchDynamicTools(prompt: string, availableTools: readonly string[]): string[] {
  if (availableTools.length === 0) return [];

  const lowerPrompt = prompt.toLowerCase();
  const promptWords = new Set(
    lowerPrompt
      .replace(/[^a-z0-9_\-\s.]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );

  const matched = new Set<string>();

  for (const tool of availableTools) {
    const lowerTool = tool.toLowerCase();
    const toolTokens = lowerTool
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    // 1. Direct tool name substring match in prompt
    if (lowerPrompt.includes(lowerTool)) {
      matched.add(tool);
      continue;
    }

    // Require matching non-generic substantive tokens to avoid false positives on common verbs (e.g. "status", "check")
    const substantiveTokens = toolTokens.filter((t) => !GENERIC_CRUD_TOKENS.has(t));
    const tokensToMatch = substantiveTokens.length > 0 ? substantiveTokens : toolTokens;

    // 2. Token overlap with prompt words (including singular/plural and morphological variations: -s, -ed, -ing, -ment, -tion)
    let hasOverlap = tokensToMatch.some((tok) => {
      if (promptWords.has(tok)) return true;
      if (tok.endsWith("s") && promptWords.has(tok.slice(0, -1))) return true;
      if (!tok.endsWith("s") && promptWords.has(`${tok}s`)) return true;
      // Morphological stem prefix matching for tokens with length >= 4 (e.g. deploy / deployment, search / searching)
      if (tok.length >= 4) {
        for (const word of promptWords) {
          if (word.length >= 4 && (word.startsWith(tok) || tok.startsWith(word))) return true;
        }
      }
      return false;
    });

    // 3. Match via standard semantic stems
    if (!hasOverlap) {
      for (const tok of tokensToMatch) {
        const stems = COMMON_TOOL_STEMS[tok];
        if (stems && stems.some((stem) => promptWords.has(stem) || lowerPrompt.includes(stem))) {
          hasOverlap = true;
          break;
        }
      }
    }

    if (hasOverlap) {
      matched.add(tool);
    }
  }

  return Array.from(matched);
}

export class HeuristicDecisionProvider implements DecisionProvider {
  readonly id = "heuristic" as const;
  readonly label = "Built-in Fast Heuristics (0ms)";

  async classifyTurn(state: DecisionState): Promise<TurnShape> {
    const start = performance.now();
    const text = state.message.trim();

    // 1. Salutations and casual conversational banter (domain-agnostic)
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

    // 2. Active canvas visual refinement (domain-agnostic UI adjustment)
    if (state.activeSurfaceKind && CANVAS_REFINEMENT_PATTERNS.some((pat) => pat.test(text))) {
      // Check for Hybrid Turn: Canvas UI tweak + External Tool Data Fetch / Action
      const hasFetchIntent = /\b(?:fetch|pull|query|search|load|sync|download|api|refresh\s+from|get\s+from|check\s+with)\b/i.test(text);
      const matchedTools = matchDynamicTools(text, state.availableTools);
      if (hasFetchIntent && matchedTools.length > 0) {
        return {
          intent: "scoped_tool_task",
          confidence: 0.90,
          historyPolicy: "recent_window",
          allowedToolNamespaces: matchedTools,
          includeSurfaceGrammar: true,
          stepLimit: 6,
          toolBudget: Math.min(4, matchedTools.length + 1),
          suggestedTier: "primary",
          reason: `Detected hybrid turn: canvas visual refinement combined with external tool data fetch (${matchedTools.join(", ")}).`,
          latencyMs: Math.round((performance.now() - start) * 100) / 100,
        };
      }

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

    // 3. Dynamic tool task matching against registered tools
    const matchedTools = matchDynamicTools(text, state.availableTools);

    if (matchedTools.length > 0) {
      return {
        intent: "scoped_tool_task",
        confidence: 0.88,
        historyPolicy: "recent_window",
        allowedToolNamespaces: matchedTools,
        includeSurfaceGrammar: true,
        stepLimit: 6,
        toolBudget: Math.min(4, matchedTools.length + 1),
        suggestedTier: "primary",
        reason: `Dynamically matched ${matchedTools.length} relevant tool(s) from user prompt.`,
        latencyMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // 4. Default: Complex reasoning, open-ended generative task, or full capability
    return {
      intent: "complex_reasoning",
      confidence: 0.8,
      historyPolicy: "full",
      allowedToolNamespaces: [...state.availableTools],
      includeSurfaceGrammar: true,
      stepLimit: 12,
      toolBudget: 8,
      suggestedTier: "primary",
      reason: "General or complex task; preserved full context and registered tools.",
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }
}
