// Full Decision Engine Benchmark Runner
// Runs the Stock Dashboard scenario across 4 comparative modes:
// Mode A: Baseline (Unshaped Monolithic - No Decision)
// Mode B: Local System 1 (Ollama laya:latest)
// Mode C: Local System 1 (Ollama d1-omni:latest)
// Mode D: Cloud System 1 (OpenAI gpt-4o-mini Strict JSON Schema)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  try {
    OPENAI_KEY = execSync("security find-generic-password -s com.nranjan2code.vakyartha -a OPENAI_API_KEY -w", { encoding: "utf8" }).trim();
  } catch {
    console.error("Missing OPENAI_API_KEY in Keychain or environment");
    process.exit(1);
  }
}

const MCP_TOOLS = [
  { type: "function", function: { name: "filesystem_read", description: "Read files from local filesystem", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "filesystem_write", description: "Write files to disk", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "duckdb_query", description: "Execute SQL query on analytical database", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_search", description: "Search the web for real-time information", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "nse_quote", description: "Get real-time market quote data for equity symbols", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } } },
  { type: "function", function: { name: "run_command", description: "Run sandboxed shell commands", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_skill_file", description: "Read skill package markdown documentation", parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] } } },
  { type: "function", function: { name: "browser_fetch", description: "Fetch web pages and extract article text", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

const SYSTEM_PROMPT = `You are Vakyartha, an agent with interactive canvas projection.
Surface Grammar:
- Render interactive surfaces using JSON cards, tables, charts and stats.
- Supported chart kinds: bar, line, area, donut, candlestick.
- For stock dashboards: render a summary stat card, a table with ticker/price/change, and a bar chart comparing daily change.`;

const TURNS = [
  { turnNumber: 1, label: "Salutation (Greeting)", userPrompt: "Hi there, good morning!" },
  { turnNumber: 2, label: "Substantive Task (Create Stock Dashboard)", userPrompt: "Create a stock dashboard for AAPL, MSFT, and GOOGL with their current prices, daily change, market cap, and a comparison bar chart." },
  { turnNumber: 3, label: "Salutation (Gratitude)", userPrompt: "Thanks, that looks fantastic! Appreciate it." },
  { turnNumber: 4, label: "Canvas Refinement (Edit Dashboard)", userPrompt: "Can you add NVDA to the dashboard, sort the table by daily change descending, and change the chart color theme to emerald?" },
];

async function callOpenAiChat(payload: { messages: Array<{ role: string; content: string }>; tools?: typeof MCP_TOOLS }) {
  const start = performance.now();
  const body: Record<string, unknown> = {
    model: "gpt-4o-mini",
    messages: payload.messages,
    temperature: 0.2,
  };
  if (payload.tools && payload.tools.length > 0) body.tools = payload.tools;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
  });

  const latencyMs = Math.round(performance.now() - start);
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    latencyMs,
  };
}

async function callOllamaSystemOne(model: string, message: string) {
  const start = performance.now();
  const res = await fetch("http://127.0.0.1:11434/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      state: message,
      questions: {
        intent: {
          type: "choice",
          instructions: "Classify intent",
          criteria: {
            salutation: "Casual greeting, pleasantry, or gratitude",
            canvas_refinement: "Modifying, restyling, sorting, or adding items to an active dashboard or surface",
            task: "Substantive task, analysis, or query",
          },
        },
      },
    }),
  });

  const latencyMs = Math.round(performance.now() - start);
  const data = await res.json();
  const choice = data.answers?.intent?.choice ?? "task";
  const confidence = data.answers?.intent?.confidence ?? 0.85;

  return {
    intent: choice === "salutation" ? "salutation" : choice === "canvas_refinement" ? "canvas_refinement" : "task",
    confidence,
    latencyMs,
  };
}

async function callOpenAiDecision(message: string) {
  const start = performance.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a fast System 1 classifier. Classify user message into exact JSON: { intent: 'salutation' | 'canvas_refinement' | 'task', confidence: number }" },
        { role: "user", content: message },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "quick_intent",
          strict: true,
          schema: {
            type: "object",
            properties: {
              intent: { type: "string", enum: ["salutation", "canvas_refinement", "task"] },
              confidence: { type: "number" },
            },
            required: ["intent", "confidence"],
            additionalProperties: false,
          },
        },
      },
      temperature: 0.1,
      max_tokens: 50,
    }),
  });

  const latencyMs = Math.round(performance.now() - start);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  return {
    intent: parsed.intent ?? "task",
    confidence: parsed.confidence ?? 0.9,
    latencyMs,
  };
}

async function main() {
  console.log("Starting comparative matrix benchmark across 4 turns...\n");

  // Mode A: Baseline (Unshaped)
  console.log("Running Mode A (Unshaped Monolithic)...");
  const resultsA = [];
  const histA: Array<{ role: string; content: string }> = [];
  for (const t of TURNS) {
    histA.push({ role: "user", content: t.userPrompt });
    const out = await callOpenAiChat({ messages: [{ role: "system", content: SYSTEM_PROMPT }, ...histA], tools: MCP_TOOLS });
    histA.push({ role: "assistant", content: out.content });
    resultsA.push({ turn: t.turnNumber, label: t.label, promptTokens: out.usage.prompt_tokens, completionTokens: out.usage.completion_tokens, totalTokens: out.usage.total_tokens, latencyMs: out.latencyMs });
  }

  // Mode B: Ollama laya:latest
  console.log("Running Mode B (Ollama laya:latest)...");
  const resultsB = [];
  const histB: Array<{ role: string; content: string }> = [];
  for (const t of TURNS) {
    const dec = await callOllamaSystemOne("laya:latest", t.userPrompt);
    histB.push({ role: "user", content: t.userPrompt });
    let shapedHistory: Array<{ role: string; content: string }> = [];
    let shapedTools: typeof MCP_TOOLS | undefined = undefined;
    let shapedSystem = SYSTEM_PROMPT;

    if (dec.intent === "salutation") {
      shapedHistory = [{ role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = "You are Vakyartha assistant. Respond politely and concisely in one sentence.";
    } else if (dec.intent === "canvas_refinement") {
      shapedHistory = [histB[histB.length - 2] ?? { role: "assistant", content: "Stock dashboard rendered." }, { role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = `${SYSTEM_PROMPT}\n[Active Surface: stock_dash showing AAPL, MSFT, GOOGL table and bar chart]`;
    } else {
      shapedHistory = [...histB];
      shapedTools = MCP_TOOLS;
    }

    const out = await callOpenAiChat({ messages: [{ role: "system", content: shapedSystem }, ...shapedHistory], tools: shapedTools });
    histB.push({ role: "assistant", content: out.content });
    resultsB.push({ turn: t.turnNumber, label: t.label, intent: dec.intent, decLatencyMs: dec.latencyMs, promptTokens: out.usage.prompt_tokens, completionTokens: out.usage.completion_tokens, totalTokens: out.usage.total_tokens, latencyMs: dec.latencyMs + out.latencyMs });
  }

  // Mode C: Ollama d1-omni:latest
  console.log("Running Mode C (Ollama d1-omni:latest)...");
  const resultsC = [];
  const histC: Array<{ role: string; content: string }> = [];
  for (const t of TURNS) {
    const dec = await callOllamaSystemOne("d1-omni:latest", t.userPrompt);
    histC.push({ role: "user", content: t.userPrompt });
    let shapedHistory: Array<{ role: string; content: string }> = [];
    let shapedTools: typeof MCP_TOOLS | undefined = undefined;
    let shapedSystem = SYSTEM_PROMPT;

    if (dec.intent === "salutation") {
      shapedHistory = [{ role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = "You are Vakyartha assistant. Respond politely and concisely in one sentence.";
    } else if (dec.intent === "canvas_refinement") {
      shapedHistory = [histC[histC.length - 2] ?? { role: "assistant", content: "Stock dashboard rendered." }, { role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = `${SYSTEM_PROMPT}\n[Active Surface: stock_dash showing AAPL, MSFT, GOOGL table and bar chart]`;
    } else {
      shapedHistory = [...histC];
      shapedTools = MCP_TOOLS;
    }

    const out = await callOpenAiChat({ messages: [{ role: "system", content: shapedSystem }, ...shapedHistory], tools: shapedTools });
    histC.push({ role: "assistant", content: out.content });
    resultsC.push({ turn: t.turnNumber, label: t.label, intent: dec.intent, decLatencyMs: dec.latencyMs, promptTokens: out.usage.prompt_tokens, completionTokens: out.usage.completion_tokens, totalTokens: out.usage.total_tokens, latencyMs: dec.latencyMs + out.latencyMs });
  }

  // Mode D: OpenAI gpt-4o-mini Strict Structured Outputs
  console.log("Running Mode D (OpenAI gpt-4o-mini Strict JSON)...");
  const resultsD = [];
  const histD: Array<{ role: string; content: string }> = [];
  for (const t of TURNS) {
    const dec = await callOpenAiDecision(t.userPrompt);
    histD.push({ role: "user", content: t.userPrompt });
    let shapedHistory: Array<{ role: string; content: string }> = [];
    let shapedTools: typeof MCP_TOOLS | undefined = undefined;
    let shapedSystem = SYSTEM_PROMPT;

    if (dec.intent === "salutation") {
      shapedHistory = [{ role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = "You are Vakyartha assistant. Respond politely and concisely in one sentence.";
    } else if (dec.intent === "canvas_refinement") {
      shapedHistory = [histD[histD.length - 2] ?? { role: "assistant", content: "Stock dashboard rendered." }, { role: "user", content: t.userPrompt }];
      shapedTools = undefined;
      shapedSystem = `${SYSTEM_PROMPT}\n[Active Surface: stock_dash showing AAPL, MSFT, GOOGL table and bar chart]`;
    } else {
      shapedHistory = [...histD];
      shapedTools = MCP_TOOLS;
    }

    const out = await callOpenAiChat({ messages: [{ role: "system", content: shapedSystem }, ...shapedHistory], tools: shapedTools });
    histD.push({ role: "assistant", content: out.content });
    resultsD.push({ turn: t.turnNumber, label: t.label, intent: dec.intent, decLatencyMs: dec.latencyMs, promptTokens: out.usage.prompt_tokens, completionTokens: out.usage.completion_tokens, totalTokens: out.usage.total_tokens, latencyMs: dec.latencyMs + out.latencyMs });
  }

  const finalReport = { resultsA, resultsB, resultsC, resultsD };
  fs.writeFileSync("/tmp/vak-matrix-benchmark.json", JSON.stringify(finalReport, null, 2));
  console.log("\nBenchmark complete. Results saved to /tmp/vak-matrix-benchmark.json");
}

main().catch(err => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
