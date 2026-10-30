import { test } from "node:test";
import assert from "node:assert/strict";
import { HeuristicDecisionProvider } from "../src/decision/heuristic.ts";
import { OllamaDecisionProvider, DEFAULT_OLLAMA_HOST } from "../src/decision/providers/ollama.ts";
import { OpenRouterDecisionProvider } from "../src/decision/providers/openrouter.ts";
import { OpenAIDecisionProvider } from "../src/decision/providers/openai.ts";
import { DecisionChainRunner, type DecisionChainDefinition } from "../src/decision/chain.ts";
import { getDecisionConfig, saveDecisionConfig, shapeTurn, type ChatTurnPayload } from "../src/decision/shaper.ts";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    length: 0,
  } as Storage;
}

test("HeuristicDecisionProvider: classifies salutations and casual banter", async () => {
  const provider = new HeuristicDecisionProvider();

  for (const msg of ["Hi", "Hello!", "hey there", "good morning", "thanks a lot", "ok", "sure", "bye"]) {
    const shape = await provider.classifyTurn({
      message: msg,
      availableTools: ["filesystem_read", "web_search", "duckdb_query"],
    });

    assert.equal(shape.intent, "salutation", `Failed for message: ${msg}`);
    assert.equal(shape.historyPolicy, "strip_all");
    assert.deepEqual(shape.allowedToolNamespaces, []);
    assert.equal(shape.includeSurfaceGrammar, false);
    assert.equal(shape.stepLimit, 1);
    assert.equal(shape.toolBudget, 0);
    assert.ok(shape.confidence >= 0.9);
  }
});

test("HeuristicDecisionProvider: classifies canvas refinements when surface is active", async () => {
  const provider = new HeuristicDecisionProvider();

  const shape = await provider.classifyTurn({
    message: "change to bar chart and sort by total",
    activeSurfaceKind: "chart",
    availableTools: ["filesystem_read", "web_search"],
  });

  assert.equal(shape.intent, "canvas_refinement");
  assert.equal(shape.historyPolicy, "last_turn_only");
  assert.deepEqual(shape.allowedToolNamespaces, []);
  assert.equal(shape.includeSurfaceGrammar, true);
  assert.ok(shape.stepLimit <= 3);
  assert.equal(shape.toolBudget, 0);
});

test("HeuristicDecisionProvider: classifies and prunes scoped tool tasks", async () => {
  const provider = new HeuristicDecisionProvider();

  const fileShape = await provider.classifyTurn({
    message: "inspect file package.json and read dependencies",
    availableTools: ["filesystem_read", "web_search", "duckdb_query"],
  });

  assert.equal(fileShape.intent, "scoped_tool_task");
  assert.equal(fileShape.historyPolicy, "recent_window");
  assert.ok(fileShape.allowedToolNamespaces.includes("filesystem_read"));
  assert.ok(!fileShape.allowedToolNamespaces.includes("web_search"));
  assert.ok(fileShape.stepLimit <= 6);

  const searchShape = await provider.classifyTurn({
    message: "search the web for latest TypeScript 5.8 release notes",
    availableTools: ["filesystem_read", "web_search", "duckdb_query"],
  });

  assert.equal(searchShape.intent, "scoped_tool_task");
  assert.ok(searchShape.allowedToolNamespaces.includes("web_search"));
  assert.ok(!searchShape.allowedToolNamespaces.includes("duckdb_query"));

  // Domain-agnostic tests: Healthcare, CRM/Sales, and Travel/Weather
  const healthcareShape = await provider.classifyTurn({
    message: "fetch patient vitals and check drug interactions",
    availableTools: ["patient_records_fetch", "drug_interaction_check", "accounting_ledger_query"],
  });
  assert.equal(healthcareShape.intent, "scoped_tool_task");
  assert.ok(healthcareShape.allowedToolNamespaces.includes("patient_records_fetch"));
  assert.ok(!healthcareShape.allowedToolNamespaces.includes("accounting_ledger_query"));

  const crmShape = await provider.classifyTurn({
    message: "send a notification on slack about customer renewal",
    availableTools: ["slack_post_message", "salesforce_query", "github_create_pr"],
  });
  assert.equal(crmShape.intent, "scoped_tool_task");
  assert.ok(crmShape.allowedToolNamespaces.includes("slack_post_message"));
  assert.ok(!crmShape.allowedToolNamespaces.includes("github_create_pr"));
});

test("HeuristicDecisionProvider: preserves full context on complex reasoning tasks", async () => {
  const provider = new HeuristicDecisionProvider();

  const shape = await provider.classifyTurn({
    message: "Architect a resilient multi-tenant microservices deployment strategy",
    availableTools: ["filesystem_read", "web_search", "duckdb_query"],
  });

  assert.equal(shape.intent, "complex_reasoning");
  assert.equal(shape.historyPolicy, "full");
  assert.equal(shape.includeSurfaceGrammar, true);
  assert.deepEqual(shape.allowedToolNamespaces, ["filesystem_read", "web_search", "duckdb_query"]);
  assert.equal(shape.stepLimit, 12);
  assert.equal(shape.toolBudget, 8);
});

test("OllamaDecisionProvider: live systemone classification with d1-omni", async () => {
  const provider = new OllamaDecisionProvider(DEFAULT_OLLAMA_HOST, "d1-omni:latest");

  const greetingShape = await provider.classifyTurn({
    message: "Hi there! How are you?",
    availableTools: ["filesystem", "web_search"],
  });

  assert.equal(greetingShape.intent, "salutation");
  assert.equal(greetingShape.historyPolicy, "strip_all");
  assert.deepEqual(greetingShape.allowedToolNamespaces, []);
  assert.ok(greetingShape.confidence > 0.85);

  const toolShape = await provider.classifyTurn({
    message: "Can you read package.json and find the dependency version?",
    availableTools: ["filesystem", "web_search", "duckdb"],
  });

  assert.equal(toolShape.intent, "scoped_tool_task");
  assert.equal(toolShape.historyPolicy, "recent_window");
  assert.ok(toolShape.allowedToolNamespaces.includes("filesystem"));
  assert.ok(!toolShape.allowedToolNamespaces.includes("web_search"));

  const canvasShape = await provider.classifyTurn({
    message: "update the chart layout and change colors",
    activeSurfaceKind: "chart",
    availableTools: ["filesystem", "web_search"],
  });

  assert.equal(canvasShape.intent, "canvas_refinement");
  assert.equal(canvasShape.historyPolicy, "last_turn_only");
  assert.equal(canvasShape.includeSurfaceGrammar, true);
  assert.deepEqual(canvasShape.allowedToolNamespaces, []);
});

test("OllamaDecisionProvider: gracefully falls back to heuristics on unreachable host", async () => {
  // Use non-existent port to simulate network failure / offline daemon
  const provider = new OllamaDecisionProvider("http://127.0.0.1:59999", "d1-omni:latest");

  const shape = await provider.classifyTurn(
    {
      message: "Hello world!",
      availableTools: ["filesystem"],
    },
    50, // Short 50ms timeout
  );

  assert.equal(shape.intent, "salutation");
  assert.equal(shape.historyPolicy, "strip_all");
  assert.ok(shape.reason?.includes("unavailable"));
});

test("shapeTurn: trims context, tools, and execution budgets on greetings", async () => {
  const payload: ChatTurnPayload = {
    message: "Good morning!",
    history: [
      { role: "user", content: "older turn 1" },
      { role: "assistant", content: "older turn 2" },
      { role: "user", content: "older turn 3" },
    ],
    tools: [
      { name: "filesystem_read", description: "read file" },
      { name: "web_search", description: "search web" },
    ],
    maxSteps: 16,
    toolRounds: 12,
  };

  const config = getDecisionConfig();
  config.enabled = true;
  config.stripSalutations = true;
  config.pruneTools = true;

  const result = await shapeTurn(payload, config);

  assert.equal(result.shape.intent, "salutation");
  assert.deepEqual(result.payload.history, []);
  assert.deepEqual(result.payload.tools, []);
  assert.equal(result.payload.maxSteps, 1);
  assert.equal(result.payload.toolRounds, 0);
  assert.equal(result.originalToolCount, 2);
  assert.equal(result.prunedToolCount, 2);
  assert.equal(result.originalHistoryLength, 3);
  assert.equal(result.prunedHistoryLength, 3);
});

test("shapeTurn: preserves payload unshaped when decision engine is disabled", async () => {
  const payload: ChatTurnPayload = {
    message: "Hi",
    history: [{ role: "user", content: "turn 1" }],
    tools: [{ name: "filesystem_read" }],
    maxSteps: 12,
    toolRounds: 8,
  };

  const config = getDecisionConfig();
  config.enabled = false;

  const result = await shapeTurn(payload, config);

  assert.equal(result.payload.history?.length, 1);
  assert.equal(result.payload.tools?.length, 1);
  assert.equal(result.payload.maxSteps, 12);
  assert.equal(result.payload.toolRounds, 8);
  assert.equal(result.prunedToolCount, 0);
  assert.equal(result.prunedHistoryLength, 0);
});

test("Decision config persistence", () => {
  saveDecisionConfig({
    enabled: true,
    providerId: "ollama",
    modelId: "laya:latest",
    pruneTools: true,
    stripSalutations: true,
  });

  const cfg = getDecisionConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.providerId, "ollama");
  assert.equal(cfg.modelId, "laya:latest");
  assert.equal(cfg.pruneTools, true);
  assert.equal(cfg.stripSalutations, true);
  assert.equal(cfg.optimizeContext, true);

  saveDecisionConfig({ optimizeContext: false });
  assert.equal(getDecisionConfig().optimizeContext, false);
  saveDecisionConfig({ optimizeContext: true });
});

test("shapeTurn: optimizes multi-turn context assembly when optimizeContext is enabled", async () => {
  const dummyHistory = [
    { role: "user", content: "Turn 1" },
    { role: "assistant", content: "Reply 1" },
    { role: "user", content: "Turn 2" },
    { role: "assistant", content: "Reply 2" },
    { role: "user", content: "Turn 3" },
    { role: "assistant", content: "Reply 3" },
    { role: "user", content: "Turn 4" },
    { role: "assistant", content: "Reply 4" },
    { role: "user", content: "Turn 5" },
    { role: "assistant", content: "Reply 5" },
  ];

  // 1. With optimizeContext: true, canvas_refinement preserves only last turn
  saveDecisionConfig({ enabled: true, providerId: "heuristic", optimizeContext: true });
  const shapedCanvas = await shapeTurn({
    message: "change to bar chart",
    surfaceKind: "chart",
    history: dummyHistory,
    tools: [{ name: "search" }],
  });
  assert.equal(shapedCanvas.shape.intent, "canvas_refinement");
  assert.equal(shapedCanvas.shape.historyPolicy, "last_turn_only");
  assert.equal(shapedCanvas.payload.history?.length, 1);
  assert.equal((shapedCanvas.payload.history?.[0] as { content: string }).content, "Reply 5");

  // 2. With optimizeContext: false, canvas_refinement retains all 10 turns
  saveDecisionConfig({ enabled: true, providerId: "heuristic", optimizeContext: false });
  const unshapedCanvas = await shapeTurn({
    message: "change to bar chart",
    surfaceKind: "chart",
    history: dummyHistory,
    tools: [{ name: "search" }],
  });
  assert.equal(unshapedCanvas.payload.history?.length, 10);

  // Restore default
  saveDecisionConfig({ optimizeContext: true });
});

test("DecisionChainRunner: executes multi-stage decision pipeline with conditional branching", async () => {
  const runner = new DecisionChainRunner(DEFAULT_OLLAMA_HOST, "d1-omni:latest");

  const triageChain: DecisionChainDefinition = {
    name: "task_triage_and_risk",
    steps: [
      {
        name: "domain",
        instructions: "Classify the technical domain of the task",
        criteria: {
          code_engineering: "Software development, editing files, or refactoring code",
          data_analysis: "SQL queries, metrics, reports, or charts",
          chit_chat: "Casual conversation or greeting",
        },
      },
      {
        name: "operation",
        instructions: "Determine the operation type",
        condition: (answers) => answers.domain?.choice !== "chit_chat",
        criteria: {
          read_only: "Inspecting, reading, or analyzing without changing files",
          mutation: "Modifying, deleting, or creating files and databases",
        },
      },
      {
        name: "risk_gate",
        instructions: "Assess security risk level",
        condition: (answers) => answers.operation?.choice === "mutation",
        criteria: {
          low_risk: "Minor edits, documentation, comments, or formatting",
          high_risk: "System file changes, deletions, or structural modifications",
        },
      },
    ],
  };

  // Test 1: Read-only inspection task
  const result1 = await runner.run(triageChain, "Can you read package.json and show me dependencies?");
  assert.equal(result1.answers.domain?.choice, "code_engineering");
  assert.equal(result1.answers.operation?.choice, "read_only");
  assert.equal(result1.answers.risk_gate, undefined, "risk_gate should be skipped for read_only operation");
  assert.ok(result1.totalLatencyMs < 1500);

  // Test 2: Mutation task (triggers risk_gate)
  const result2 = await runner.run(triageChain, "Delete all temporary cache files in the directory");
  assert.equal(result2.answers.domain?.choice, "code_engineering");
  assert.equal(result2.answers.operation?.choice, "mutation");
  assert.ok(result2.answers.risk_gate !== undefined, "risk_gate should run for mutation operation");
  assert.equal(result2.answers.risk_gate.choice, "high_risk");
});

test("OpenRouterDecisionProvider: falls back to heuristics gracefully when API key is missing", async () => {
  const provider = new OpenRouterDecisionProvider(undefined);

  const shape = await provider.classifyTurn({
    message: "Hi there!",
    availableTools: ["filesystem", "web_search"],
  });

  assert.equal(shape.intent, "salutation");
  assert.equal(shape.historyPolicy, "strip_all");
  assert.ok(shape.reason?.includes("API key not configured"));
});

test("OpenRouterDecisionProvider: falls back to heuristics on network error or invalid endpoint", async () => {
  const provider = new OpenRouterDecisionProvider("sk-dummy-test-key", "microsoft/decision-1", "http://127.0.0.1:59999/v1");

  const shape = await provider.classifyTurn(
    {
      message: "Please read package.json",
      availableTools: ["filesystem"],
    },
    50, // 50ms timeout
  );

  assert.equal(shape.intent, "scoped_tool_task");
  assert.ok(shape.reason?.includes("unavailable or timed out"));
});

test("OpenAIDecisionProvider: falls back to heuristics gracefully when API key is missing", async () => {
  const provider = new OpenAIDecisionProvider(undefined);

  const shape = await provider.classifyTurn({
    message: "Good afternoon!",
    availableTools: ["filesystem", "web_search"],
  });

  assert.equal(shape.intent, "salutation");
  assert.equal(shape.historyPolicy, "strip_all");
  assert.ok(shape.reason?.includes("API key not configured"));
});

test("OpenAIDecisionProvider: live classification with OpenAI gpt-4o-mini structured outputs if Keychain key available", async () => {
  let key: string | undefined;
  try {
    const { execSync } = await import("node:child_process");
    key = execSync("security find-generic-password -s com.nranjan2code.vakyartha -a OPENAI_API_KEY -w", { encoding: "utf8" }).trim();
  } catch {
    key = process.env.OPENAI_API_KEY;
  }

  if (!key) return; // Skip live network call if no local key present

  const provider = new OpenAIDecisionProvider(key, "gpt-4o-mini");

  const shape = await provider.classifyTurn({
    message: "Hi there!",
    availableTools: ["filesystem_read", "web_search"],
  });

  assert.equal(shape.intent, "salutation");
  assert.equal(shape.historyPolicy, "strip_all");
  assert.deepEqual(shape.allowedToolNamespaces, []);
  assert.ok(shape.confidence >= 0.85);
});

test("shapeTurn: dynamically consumes runtime surfaces, skills, and tools without domain hardcoding", async () => {
  const dynamicTools = [
    { name: "crm_salesforce__get_deal", namespace: "crm_salesforce", description: "Get CRM opportunity" },
    { name: "slack__post_message", namespace: "slack", description: "Post to a channel" },
    { name: "weather__forecast", namespace: "weather", description: "Check local weather forecast" },
    { name: "duckdb__execute", namespace: "duckdb", description: "Run local analytical SQL" },
  ];

  const dynamicSkills = [
    { name: "sales-triage", description: "Triage inbound customer deals" },
    { name: "data-analytics", description: "Analyze tabular records" },
  ];

  const dynamicSurfaces = [
    { id: "sales_dashboard", title: "Quarterly Deals", componentTypes: ["chart", "table"] },
  ];

  const config = {
    ...getDecisionConfig(),
    enabled: true,
    providerId: "heuristic" as const,
    stripSalutations: true,
    optimizeContext: true,
    pruneTools: true,
  };

  // 1. Dynamic canvas refinement detection from live surface snapshots
  const canvasTurn = await shapeTurn(
    {
      message: "switch the chart to a donut and sort table by deal value",
      surfaces: dynamicSurfaces,
      skills: dynamicSkills,
      tools: dynamicTools,
    },
    config,
  );

  assert.equal(canvasTurn.shape.intent, "canvas_refinement");
  assert.equal(canvasTurn.shape.historyPolicy, "last_turn_only");
  assert.equal(canvasTurn.payload.tools?.length, 0); // No external tools needed for canvas tweaks

  // 2. Dynamic tool pruning for runtime-scoped task
  const toolTurn = await shapeTurn(
    {
      message: "post a message on slack to announce the deal closed",
      surfaces: dynamicSurfaces,
      skills: dynamicSkills,
      tools: dynamicTools,
    },
    config,
  );

  assert.equal(toolTurn.shape.intent, "scoped_tool_task");
  assert.ok(toolTurn.payload.tools?.some((t) => t.name === "slack__post_message"));
  assert.ok(!toolTurn.payload.tools?.some((t) => t.name === "weather__forecast"));
  assert.ok(toolTurn.prunedToolCount > 0);
});




