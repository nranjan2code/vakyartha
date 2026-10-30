// Strongly typed contracts for the Pluggable Decision Engine & Turn Shaper.
// Designed for zero-compromise runtime flexibility, strict validation, and
// seamless coexistence with Vakyartha's Rust Root of Trust.

export type TurnIntent =
  | "salutation"          // Greetings, gratitude, short acknowledgments ("Hi", "Thanks", "Ok")
  | "canvas_refinement"   // Visual updates, styling, sorting, chart tweaks
  | "scoped_tool_task"    // Clear tool execution (filesystem, search, database, etc.)
  | "complex_reasoning";  // Deep open-ended reasoning, architecture, coding, multi-step tasks

export type HistoryPolicy =
  | "strip_all"        // Omit prior history (0 turns)
  | "last_turn_only"   // Only retain immediate prior turn
  | "recent_window"    // Retain 2-3 recent turns
  | "full";            // Retain normal full history

export interface TurnShape {
  /** The classified intent of the user prompt */
  readonly intent: TurnIntent;

  /** Calibrated confidence score (0.0 to 1.0) */
  readonly confidence: number;

  /** Dynamic context retention policy */
  readonly historyPolicy: HistoryPolicy;

  /**
   * Allowed MCP tool namespaces or prefixes (e.g. ["filesystem", "duckdb"]).
   * An empty array explicitly prunes ALL tool schemas from the turn payload.
   */
  readonly allowedToolNamespaces: readonly string[];

  /** Whether the generation prompt should include Projection surface authoring rules */
  readonly includeSurfaceGrammar: boolean;

  /** Recommended per-turn execution step limit */
  readonly stepLimit: number;

  /** Recommended per-turn MCP tool call budget */
  readonly toolBudget: number;

  /** Recommended model tier */
  readonly suggestedTier: "local_fast" | "primary" | "frontier_cloud";

  /** Optional descriptive rationale from the decision engine */
  readonly reason?: string;

  /** Execution latency of the decision step in milliseconds */
  readonly latencyMs?: number;
}

export interface DecisionState {
  /** The current user message */
  readonly message: string;

  /** Summary or content of the previous turn, if any */
  readonly lastTurnSummary?: string;

  /** Active surface kind on canvas (e.g. "table", "chart", "form"), if any */
  readonly activeSurfaceKind?: string;

  /** List of currently enabled tool names / identifiers in the workspace */
  readonly availableTools: readonly string[];

  /** Currently selected primary model provider */
  readonly currentProvider?: string;

  /** Currently selected primary model name */
  readonly currentModel?: string;
}

/** All providers supported by Vakyartha */
export type SupportedProviderId =
  | "heuristic"
  | "ollama"
  | "openrouter"
  | "groq"
  | "cerebras"
  | "openai"
  | "anthropic"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "xai"
  | "together"
  | "fireworks"
  | "moonshot"
  | "qwen"
  | "lmstudio"
  | "compatible";

export type DecisionProviderId = SupportedProviderId;

export interface DecisionConfig {
  /** Master switch for turn shaping */
  enabled: boolean;

  /** Active decision provider */
  providerId: DecisionProviderId;

  /** Specific decision model id */
  modelId: string;

  /** Hard timeout ceiling in milliseconds before falling back to heuristics */
  timeoutMs: number;

  /** Whether to aggressively prune MCP tools on non-tool turns */
  pruneTools: boolean;

  /** Whether to strip conversational history and surface grammar on greetings */
  stripSalutations: boolean;

  /** Whether to dynamically optimize multi-turn context assembly instead of fixed sliding windows */
  optimizeContext: boolean;
}

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  readonly label: string;

  /**
   * Classifies the turn state into a concrete TurnShape.
   * Guaranteed never to throw; always returns a safe fallback on timeout or error.
   */
  classifyTurn(state: DecisionState, timeoutMs?: number): Promise<TurnShape>;
}
