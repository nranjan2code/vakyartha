// Skill Studio Co-Pilot: natural language package synthesis and element-by-element suggestions.
// Compliant with Agent Skills specification and Vakyartha's single canonical projection architecture.

import type { SkillGenerateRequest, SkillGenerateResponse, SkillSuggestRequest, SkillSuggestResponse, SkillView } from "../shared/skills.ts";

/** Converts human prompt into a clean lowercase hyphenated skill name. */
export function sanitizeSkillName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
  return slug || "custom-analysis";
}

/** Synthesize a complete Agent Skills directory package from a natural language prompt. */
export async function generateSkillPackage(req: SkillGenerateRequest, activeTools: string[] = []): Promise<SkillGenerateResponse> {
  const prompt = req.prompt.trim();
  const name = sanitizeSkillName(prompt.split(/\s+/).slice(0, 4).join(" "));
  
  // Identify domain context
  const isFinance = /finance|revenue|budget|spend|cost|churn|pipeline|sales|accounting|profit/i.test(prompt);
  const isDevOps = /kubernetes|docker|cloud|aws|azure|gcp|container|pod|cluster|infra|server/i.test(prompt);
  const isDataReview = /data|quality|clean|missing|anomaly|audit|records|csv|database/i.test(prompt);
  const isReporting = /daily|weekly|monthly|periodic|summary|digest|status|update/i.test(prompt);

  const domainWord = isFinance ? "financial and revenue performance" : isDevOps ? "cloud infrastructure and cluster operations" : isDataReview ? "data records, validation, and anomalies" : isReporting ? "cadence metrics and status tracking" : "domain workflows and decision records";

  const description = `Analyze ${domainWord} from supplied records, evaluate anomalies, and project structured findings across interactive canvas and spoken summaries.`;

  // Determine allowed tools based on active tools
  const tools: string[] = ["read_skill_file"];
  if (activeTools.some(t => t.includes("sandbox") || t.includes("command") || t.includes("shell"))) {
    tools.push("sandbox_exec");
  }
  if (activeTools.some(t => t.includes("brave") || t.includes("tavily") || t.includes("search"))) {
    tools.push("search_web");
  }
  const allowedTools = tools.join(" ");

  // Instructions adhering to Vakyartha's liquid layout & multi-surface rules
  const body = `# ${name}

## Objective
${description}

## Procedure
1. Resolve the active analysis window, source records, and currency/units. Keep unverified figures explicit.
2. Load \`interactive-ui\` when binding canonical data collections or receiving form criteria.
3. The shared, required \`surface-design\` guidance applies automatically:
   - Structure the canvas using the 3-Tier liquid layout architecture.
   - Tier 1: Executive summary headline and 3 to 4 metric aggregate cards (\`maxWidth: "full"\`, \`columns: 4\`).
   - Tier 2: Analytical core using a 2-column grid or 2:1 split pairing a trend chart with distribution (\`maxWidth: "lg"\`).
   - Tier 3: Dense detail inspection table (\`maxWidth: "full"\`) with sortable columns and search.
4. Keep one canonical collection under \`/records\` rather than duplicating numbers across separate surfaces.
5. Formulate the visible narrative so the first sentence carries the primary finding, timeframe, and major caveat, remaining meaningful when spoken via voice TTS.
6. When isolated command execution or parsing is needed, guide execution through the app-owned Sandbox integration (\`sandbox\` and \`shell-command\`). Supporting scripts are inert references and never execute automatically.
`;

  // Generate domain supporting files
  const files: { path: string; text: string }[] = [];

  // Reference formulas/glossary
  files.push({
    path: "references/calculation_rules.md",
    text: `# Calculation Guidelines & Rules

## Metric Definitions
- **Baseline Population**: Measured across verified periods without imputing missing values as zero.
- **Delta Percentage**: \\((V_\\text{current} - V_\\text{prior}) / V_\\text{prior} \\times 100\\).
- **Caveat Disclosure**: Missing records or stale readings must be explicitly noted in visible prose.

## Visual Tone Conventions
- \`"positive"\`: Favorable performance (e.g. revenue surplus, latency reduction).
- \`"caution"\`: Moderate warning or threshold variance requiring inspection.
- \`"critical"\`: Severe breach, downtime, or negative variance.
- \`"neutral"\`: Contextual information or baseline measures.
`,
  });

  // Mock Canonical Data Schema & Records
  files.push({
    path: "schemas/canonical_records.json",
    text: JSON.stringify({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": `${name} Canonical Records`,
      "type": "object",
      "required": ["records"],
      "properties": {
        "records": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "label", "value", "status"],
            "properties": {
              "id": { "type": "string" },
              "label": { "type": "string" },
              "value": { "type": "number" },
              "status": { "type": "string", "enum": ["normal", "caution", "critical"] }
            }
          }
        }
      },
      "records": [
        { "id": "rec-01", "label": "Segment Alpha", "value": 42000, "status": "normal" },
        { "id": "rec-02", "label": "Segment Beta", "value": 68500, "status": "normal" },
        { "id": "rec-03", "label": "Segment Gamma", "value": 31200, "status": "caution" },
        { "id": "rec-04", "label": "Segment Delta", "value": 14900, "status": "critical" }
      ]
    }, null, 2),
  });

  // Inert Helper Script
  files.push({
    path: "scripts/parse_records.py",
    text: `#!/usr/bin/env python3
"""
Inert reference script for ${name}.
Read on demand via read_skill_file; execute only in authorized vak-sandbox realms.
"""
import json
import sys

def summarize_data(records):
    total = sum(r.get("value", 0) for r in records)
    count = len(records)
    avg = total / count if count else 0
    return {
        "count": count,
        "total": total,
        "average": round(avg, 2),
        "anomalies": [r["id"] for r in records if r.get("status") == "critical"]
    }

if __name__ == "__main__":
    sample = [
        {"id": "rec-01", "value": 42000, "status": "normal"},
        {"id": "rec-02", "value": 68500, "status": "normal"},
        {"id": "rec-03", "value": 31200, "status": "caution"},
        {"id": "rec-04", "value": 14900, "status": "critical"}
    ]
    summary = summarize_data(sample)
    print(json.dumps(summary, indent=2))
`,
  });

  // Test Prompts
  files.push({
    path: "tests/test_scenarios.json",
    text: JSON.stringify({
      "positive_prompts": [
        `Review the latest ${name.replace(/-/g, " ")} metrics and show the dashboard`,
        `Inspect segment anomalies and show the breakdown table`,
        `What is the total value and status distribution for this period?`
      ],
      "distractor_prompts": [
        "What is the weather forecast for tomorrow morning?",
        "Help me draft a polite follow-up email to a colleague"
      ]
    }, null, 2),
  });

  return {
    name,
    description,
    body,
    allowedTools,
    compatibility: "Compliant with Agent Skills specification and Vakyartha Projection canvas.",
    license: "MIT",
    metadata: {
      author: "Skill Studio Co-Pilot",
      version: "1.0.0",
      generatedAt: new Date().toISOString()
    },
    files,
    rationale: `Synthesized package with 3-Tier liquid canvas instructions, canonical schema, inert sandbox script, and evaluation test suite.`
  };
}

/** Provide element-by-element suggestions for trigger optimization, chart kinds, data bindings, tools, and voice gist. */
export function suggestSkillElement(req: SkillSuggestRequest, activeSkills: SkillView[] = [], catalogTools: string[] = []): SkillSuggestResponse {
  const { type, name = "my-skill", description = "", body = "" } = req;

  if (type === "trigger") {
    // Check if description overlaps with existing skills
    const collisions = activeSkills.filter(s => s.name !== name && s.enabled && (
      s.description.toLowerCase().includes(name.toLowerCase()) ||
      description.toLowerCase().split(/\s+/).filter(w => w.length > 5).some(w => s.description.toLowerCase().includes(w))
    ));

    const optimized = `Execute ${name.replace(/-/g, " ")} procedures for domain records, evaluate criteria, and present 3-tier canvas projections and spoken findings.`;
    return {
      suggestion: optimized,
      rationale: collisions.length > 0
        ? `Found potential overlap with ${collisions.map(c => c.name).join(", ")}. Tuned description with specific action verbs to ensure discriminating use_skill selection on local 4B models.`
        : `Description optimized to third-person operational scope, staying within the 1024-character discovery limit.`,
      options: [
        optimized,
        `Review and summarize ${name.replace(/-/g, " ")} records, calculate aggregates, and render interactive tables and charts.`,
        `Inspect ${name.replace(/-/g, " ")} performance, identify anomalies, and guide sandbox execution when data transformation is requested.`
      ]
    };
  }

  if (type === "chart") {
    const text = (body + " " + (req.field ?? "")).toLowerCase();
    let bestKind = "bar";
    let rationale = "Bar chart is optimal for comparing discrete categories.";

    if (/time|date|trend|daily|monthly|quarter|timeline|history/i.test(text)) {
      bestKind = "line";
      rationale = "Line chart is recommended for ordered time observations. Area chart may also be used for magnitude over time.";
    } else if (/proportion|percentage|share|ratio|distribution|breakdown/i.test(text)) {
      bestKind = "pie";
      rationale = "Pie (donut) chart is recommended for positive additive parts of one whole.";
    } else if (/matrix|density|intensity|calendar/i.test(text)) {
      bestKind = "heatmap";
      rationale = "Heatmap is recommended for nonnegative 2D matrix or dated calendar intensity.";
    } else if (/correlation|scatter|pair|x and y/i.test(text)) {
      bestKind = "scatter";
      rationale = "Scatter chart is recommended for paired numeric observations.";
    }

    return {
      suggestion: bestKind,
      rationale: `${rationale} Adheres to Vakyartha's 8 standard chart kinds (bar, stacked, line, area, pie, scatter, heatmap, radar). Never use unsupported candlestick or waterfall.`,
      options: ["bar", "line", "area", "pie", "scatter", "stacked", "heatmap", "radar"]
    };
  }

  if (type === "binding") {
    const field = req.field || "value";
    const fragment = `{"rows": {"records": "{/records}", "fields": ["label", "${field}"]}}`;
    return {
      suggestion: fragment,
      rationale: `Binds mapped columns to the single canonical record collection under /records. Table edits and sorting remain local without mutating unrelated views.`,
      options: [
        fragment,
        `{"series": {"records": "{/records}", "label": "label", "fields": ["${field}"]}}`,
        `{"value": {"records": "{/records}", "field": "${field}", "aggregate": "sum"}}`
      ]
    };
  }

  if (type === "tools") {
    const detected: string[] = ["read_skill_file"];
    if (/sandbox|python|script|bash|terminal|command|run/i.test(body)) detected.push("sandbox_exec");
    if (/web|search|internet|browse|news|latest/i.test(body)) detected.push("search_web");
    if (/file|folder|directory|disk|read|write/i.test(body)) detected.push("filesystem");
    if (/github|repo|issue|pr|commit/i.test(body)) detected.push("github");

    const matched = detected.filter(t => catalogTools.length === 0 || catalogTools.some(c => c.includes(t) || t.includes(c)));

    return {
      suggestion: matched.join(" "),
      rationale: `Detected ${matched.length} tools based on action verbs in the skill body. Declaring them under allowed-tools guides assistant selection without granting ambient authority.`,
      options: matched
    };
  }

  if (type === "gist") {
    const summary = `The ${name.replace(/-/g, " ")} review shows 4 active segments with a combined volume of 156,600, with 1 segment flagged for critical variance.`;
    return {
      suggestion: summary,
      rationale: `Formulated with primary finding, total volume, and critical caveat in the first sentence so that Voice TTS captures full meaning before lowerSurface gist truncation.`,
      options: [
        summary,
        `Summary of ${name.replace(/-/g, " ")}: All operations are within normal parameters across the reporting window, with 0 unverified exceptions.`,
        `${name.replace(/-/g, " ")} report complete: Caution advised on 2 pending items while primary throughput remains on target.`
      ]
    };
  }

  if (type === "chaining") {
    const text = (body + " " + (description || "")).toLowerCase();
    const chains: string[] = [];
    if (text.includes("canvas") || text.includes("chart") || text.includes("table") || text.includes("dashboard") || text.includes("metric")) {
      chains.push("interactive-ui", "surface-design");
    }
    if (text.includes("script") || text.includes("python") || text.includes("command") || text.includes("shell") || text.includes("parse")) {
      chains.push("sandbox", "shell-command");
    }
    if (text.includes("compare") || text.includes("versus") || text.includes("evaluation") || text.includes("trade-off")) {
      chains.push("compare-options");
    }
    if (text.includes("error") || text.includes("fix") || text.includes("debug") || text.includes("failure")) {
      chains.push("debug-error");
    }
    if (chains.length === 0) {
      chains.push("interactive-ui", "surface-design");
    }

    const uniqueChains = [...new Set(chains)];
    const snippet = `### Chaining Contract\n- Chain to \`${uniqueChains[0]}\` when assembling views and binding canonical collections.\n${uniqueChains.includes("surface-design") ? "- The shared `surface-design` liquid layout guidelines apply automatically.\n" : ""}${uniqueChains.includes("sandbox") ? "- Route isolated script parsing through `sandbox` and `shell-command`.\n" : ""}`;

    return {
      suggestion: snippet,
      rationale: `Recommended chaining to [${uniqueChains.join(", ")}] based on declared procedures. Enables modular multi-skill choreography without bloating individual instructions.`,
      options: uniqueChains
    };
  }

  if (type === "research") {
    const topic = (req.query || name.replace(/-/g, " ")).trim();
    const researchDoc = `# Domain Technical Reference: ${topic}

## 1. Domain Background & Core Concepts
- **Operational Scope**: Standards, metrics, and criteria governing ${topic}.
- **Verification Invariant**: All primary values must tie to verified, timestamped records without fabricated aggregates.

## 2. Standard Industry Formulas
- **Primary Metric**: Measured as the canonical sum or mean of observed entities.
- **Normalized Variance**: \\((V_\\text{observed} - V_\\text{target}) / V_\\text{target} \\times 100\\).
- **Threshold Tones**: Flag negative variance > 15% as \`caution\`, and > 30% as \`critical\`.

## 3. Recommended Canonical Data Schema
\`\`\`json
{
  "records": [
    { "id": "entity-01", "label": "Sample Unit", "value": 100, "status": "normal" }
  ]
}
\`\`\`

## 4. Operational Boundaries & Disclosure
- Supporting scripts are inert references and must only be executed through \`vak-sandbox\`.
- TTS narrative must explicitly voice the primary metric, timeframe, and highest severity variance.
`;
    return {
      suggestion: researchDoc,
      rationale: `Synthesized grounded domain technical reference for “${topic}” with standard formulas, metric definitions, and canonical record schema.`,
      options: [researchDoc]
    };
  }

  return {
    suggestion: "",
    rationale: "Unknown suggestion type."
  };
}
