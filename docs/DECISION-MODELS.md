# Decision Models, Dynamic Turn Shaping & Decision Chaining

This document describes the architecture, runtime placement, and usage of **Decision Models**, the **Turn Shaper**, and **Decision Chaining** in Vakyartha.

---

## 1. Overview & Problem Statement

### The "Monolithic Turn" Penalty
In standard agent architectures, every user interaction—even casual greetings like `"Hi"`, acknowledgments like `"Thanks"`, or simple visual adjustments like `"Make the chart blue"`—prepares and sends an unpruned payload to the primary model:
- Comprehensive system instructions (3,000–5,000 tokens)
- Full conversation history (2,000–10,000 tokens)
- Schemas for all enabled MCP tools (5,000–15,000 tokens)
- Default execution limits (`maxSteps=12`, `toolRounds=10`)

### Impact on the Primary Local 4B Target
For Vakyartha's primary target—a local 4B model running on Apple Silicon / CPU via Ollama (`qwen3.5:4b-mlx`):
1. **Prefill Latency:** Prompt ingestion of 15,000 tokens takes 3–6 seconds before the first token is generated.
2. **Memory Pressure:** Attention caches across 15k tokens consume high unified RAM.
3. **Tool Hallucination:** Flooding a compact model with 30 irrelevant tool schemas on a simple greeting increases the risk of hallucinated tool calls.
4. **FinOps Waste:** On hosted frontier providers, casual banter unnecessarily consumes paid input tokens.

---

## 2. The Solution: System 1 Decision Models

Vakyartha separates **System 1 (Decision Models)** from **System 2 (Generative Models)**:

| Dimension | Generative Models (System 2) | Decision Models (System 1) |
| :--- | :--- | :--- |
| **Primary Target** | `qwen3.5:4b-mlx`, Claude, OpenAI, Gemini | `d1-omni:latest` (380M), `laya:latest` (421M), Heuristics |
| **Output Type** | Autoregressive streamed text / tokens | Single-pass discrete choice + calibrated probabilities |
| **Output Tokens** | Variable (tens to thousands) | **`0 output tokens`** (Logit / score evaluation) |
| **Typical Latency** | 1.5s – 10.0s | **15ms – 50ms** |
| **Core Role** | Deep reasoning, prose, code synthesis | Intent classification, MCP tool pruning, criteria scoring |

---

## 3. End-to-End System Architecture

```mermaid
flowchart TD
    subgraph UI ["User & Settings Layer (src/settings.ts)"]
        UserMsg["User Input (e.g. 'Hi' or 'Read package.json')"]
        SettingsUI["Settings > Models > Turn Optimization"] -.-> Prefs["Prefs Store (decision:enabled, decision:model)"]
    end

    subgraph TurnLifecycle ["Turn Start & Turn Shaper (src/main.ts & src/decision/shaper.ts)"]
        UserMsg --> ShaperHook{"Is Decision Engine Enabled?"}
        Prefs -.-> ShaperHook
        
        ShaperHook -- "No (Disabled)" --> UnshapedPayload["Unshaped Default Payload<br>(Full history, all tools)"]
        ShaperHook -- "Yes (Enabled)" --> DecisionCall["Decision Classification (<50ms)"]
        
        DecisionCall --> OllamaSystemOne["Ollama /v1/systemone<br>(d1-omni / laya)"]
        DecisionCall -. "Timeout / Error" .-> HeuristicFallback["In-Memory Heuristics (<1ms)"]
        
        OllamaSystemOne & HeuristicFallback --> TurnShape["Typed TurnShape Contract"]
        
        TurnShape --> Assembler["Dynamic Turn Assembler"]
        
        Assembler --> HPolicy["History Policy:<br>strip_all (0 turns) | last_turn (1 turn) | full"]
        Assembler --> TPolicy["Tool Pruning:<br>[] for banter/canvas | scoped namespaces"]
        Assembler --> BPolicy["Budgets:<br>stepLimit: 1-12 | toolBudget: 0-8"]
    end

    subgraph Dispatch ["Engine & Broker (src-tauri & sidecar)"]
        HPolicy & TPolicy & BPolicy --> ClientTurn["VakClient.turn(shapedPayload)"]
        UnshapedPayload --> ClientTurn
        ClientTurn --> PrimaryModel["Primary Model Execution (qwen3.5:4b-mlx)"]
    end
```

---

## 4. Turn Profiles & Shaping Matrix

When enabled, the Decision Engine classifies incoming user turns into one of four deterministic profiles:

| Intent | Criteria / Detection | History Policy | Tool Policy | Max Steps | Tool Budget | Surface Grammar |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`salutation`** | Greetings, gratitude, casual banter (`"Hi"`, `"Thanks"`, `"Ok"`) | `strip_all` (0 prior turns) | `[]` (Prunes all MCP schemas) | `1` | `0` | Excluded |
| **`canvas_refinement`** | Visual styling, chart kind, table sorting with active canvas | `last_turn_only` (1 prior turn) | `[]` (No external tools) | `3` | `0` | Included |
| **`scoped_tool_task`** | Tasks needing specific tools (file inspection, web search, SQL) | `recent_window` (3 prior turns) | Pruned to matching namespace only | `6` | `4` | Included |
| **`complex_reasoning`** | Architecture, coding, multi-step problem solving | `full` (Normal history) | All enabled tools preserved | `12` | `8` | Included |

---

## 5. Multi-Turn Context Assembly Optimization vs Static Sliding Windows

### The Problem with Static Sliding Windows
Traditional agent apps use naive sliding windows (e.g. sending the last 10 turns indiscriminately):
1. **Attention Distraction & Degradation:** Small local models (such as `qwen3.5:4b-mlx`) degrade significantly when bombarded with irrelevant historical conversation, old file dumps, or prior debugging chatter.
2. **Loss of Critical Anchors:** If a user establishes foundational constraints in Turn 1, but proceeds through 11 conversational clarification turns, a fixed 10-turn window silently purges the root constraints.
3. **Severe Token Bloat on Trivial Interactions:** Saying `"Hi"`, `"Thanks"`, or changing a button color sends thousands of prior tokens unnecessarily.

### Semantic Context Shaping
With **Context Assembly Optimization** enabled (`vak:decision:optimizeContext: true`), the Decision Engine dynamically adapts history assembly per turn:

```mermaid
flowchart TD
    UserTurn["Incoming User Turn"] --> DecisionEval["Decision Engine Evaluation (<40ms)"]
    DecisionEval --> Classify{"Intent & Dependencies"}
    
    Classify -- "Salutation / Banter" --> CleanSlate["Clean Slate (strip_all)<br>history = 1 (current turn only)<br>Drop 100% of historical tokens"]
    Classify -- "Canvas / Surface Edit" --> SurfaceAnchor["Surface Anchor (last_turn_only)<br>history = 2 (prior reply + current turn)<br>Preserves canonical surface note, omits chatter"]
    Classify -- "Scoped Tool Task" --> FocusedWindow["Working Window (recent_window)<br>history = 4 (recent 3 turns + current)<br>Keeps active task state, drops ancient tangents"]
    Classify -- "Complex Reasoning" --> FullContext["Full Context (full)<br>history = configured limit (e.g. 10)<br>Preserves wide architectural context"]
```

- **`salutation` (`strip_all`)**: `history: 1` in host engine ensures only the current user message is sent. Previous messages are completely excluded.
- **`canvas_refinement` (`last_turn_only`)**: `history: 2` delivers the immediate prior reply plus the current user action. Combined with `@vak/providers`'s `shownSurfacesNote`, the model sees the exact canonical node IDs and structured data schema needed for `vak_update` without conversational noise.
- **`scoped_tool_task` (`recent_window`)**: `history: 4` keeps recent working context (e.g. a file read or query result from the prior turn) without dragging along unrelated past topics.
- **`complex_reasoning` (`full`)**: Retains the user's configured history window (default 10 turns).

---

## 6. Decision Chaining for Multi-Stage Decisions

For complex tasks where a single decision is insufficient, `DecisionChainRunner` ([`src/decision/chain.ts`](file:///Users/nisheethranjan/Projects/vakyartha/src/decision/chain.ts)) enables sequential, branching pipelines:

```mermaid
flowchart LR
    A["Step 1: Domain Triage<br>(Code vs Data vs Chit-Chat)"] --> B{"Chit-Chat?"}
    B -- "Yes" --> C["Short-circuit Greeting"]
    B -- "No" --> D["Step 2: Operation<br>(Read-only vs Mutation)"]
    D --> E{"Mutation?"}
    E -- "No" --> F["Proceed with Read-Only Tools"]
    E -- "Yes" --> G["Step 3: Risk Gate<br>(Low Risk vs High Risk Approval)"]
```

Because each step in `d1-omni` takes only ~15ms, a 3-step decision chain finishes in **under 50ms total**, returning a composite confidence score without token generation.

---

## 7. Built-in Agent Skill: `decision-eval`

Located at [`sidecar/builtin-skills/decision-eval/SKILL.md`](file:///Users/nisheethranjan/Projects/vakyartha/sidecar/builtin-skills/decision-eval/SKILL.md), this skill allows running LLMs to delegate discrete classification to the local decision model during their workflow.

### Use Cases:
- Security audit of code snippets (`vulnerable` vs `sanitized` vs `unreviewed`)
- Acceptance criteria verification before marking an autonomous task step complete
- Optimal surface kind selection (`table` vs `bar_chart` vs `metric_card`) based on dataset cardinality

---

## 8. Configuration & User Preferences

All settings live in Vakyartha's reactive preferences store:

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `vak:decision:enabled` | `boolean` | `"true"` | Master switch for dynamic turn shaping |
| `vak:decision:provider` | `string` | `"ollama"` | Active decision provider (`ollama`, `openai`, `openrouter`, or `heuristic`) |
| `vak:decision:model` | `string` | `"d1-omni:latest"` | Local decision model name |
| `vak:decision:timeout` | `number` | `1500` | Hard timeout ceiling (ms) before heuristic fallback |
| `vak:decision:pruneTools` | `boolean` | `"true"` | Prunes irrelevant MCP tools on non-tool turns |
| `vak:decision:stripSalutations`| `boolean` | `"true"` | Strips past history and surface grammar on greetings |
| `vak:decision:optimizeContext` | `boolean` | `"true"` | Shapes multi-turn context dynamically based on turn intent |

Controls are exposed under **Settings > Models > Decision & Turn Optimization** in the desktop app.

---

## 10. Dynamic Runtime Discovery & Domain Agnosticism

Vakyartha is an open, general-purpose agentic system. The Decision Engine is strictly **domain-agnostic** and operates with **zero hardcoded tool lists, file patterns, or domain routes**.

### 1. Dynamic Discovery at Turn Initialization
Before every turn in `src/main.ts#runTurn`, the system captures the live state of the workspace:
1. **Active MCP Integrations & Tools (`/api/integrations`):** Discovers all servers where `i.enabled && i.status === "ready"`. Collects active tools whose policy is not `"off"`, noting their namespace (`<server>__<tool>`), human title, and schema summary.
2. **Active Skills (`/api/skills`):** Discovers all enabled built-in or user-authored procedural skills (`s.enabled === true`), including their procedure instructions.
3. **Active Canvas Projections (`client.store.list()`):** Snapshots all active `<vak-surface>` elements on screen, their titles, and their active component types (`table`, `chart`, `form`, `stat`, `section`).

### 2. Universal Domain Adaptability
Because decisions are evaluated against runtime-discovered capabilities rather than hardcoded domain lists, the system seamlessly routes and prunes across any domain:
- **Financial Dashboards:** Recognizes stock tickers, price quotes, analytical DuckDB queries, and financial chart components.
- **Healthcare & Clinical Operations:** Evaluates EHR queries, patient vital lookups, drug interaction checks, and medical record tables.
- **CRM & Sales Operations:** Routes pipeline opportunities, contact updates, deal values, and Slack/email team notifications.
- **Customer Support & Triage:** Chains multi-step escalation, priority scoring, refund thresholds, and human-handoff gates.
- **Software Engineering & Data Analysis:** Operates across Git, local file systems, unit tests, and analytical SQL.

### 3. Dynamic Tool Stemming & Semantic Intersection
On scoped tool tasks, the engine intersects the user prompt against the names, namespaces, and descriptions of currently enabled tools. Unrelated tools are pruned from the primary model's context window, minimizing prompt bloat, eliminating tool hallucinations, and accelerating response generation.

---

## 11. Real Multi-Turn Benchmark & Empirical Evaluation

For empirical multi-turn benchmarks, token savings measurements, and latency profiles across local Ollama (`laya:latest`, `d1-omni:latest`) and cloud OpenAI decision models, see the complete report in [`docs/decision/BENCHMARK-STOCK-DASHBOARD.md`](decision/BENCHMARK-STOCK-DASHBOARD.md).

