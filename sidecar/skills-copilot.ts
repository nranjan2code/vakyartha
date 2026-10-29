// Deterministic authoring starters and suggestions. These do not run a model,
// research a domain, execute a script or verify an outcome.
import { basicCatalog } from "@vak/core";
import type { SkillGenerateRequest, SkillGenerateResponse, SkillSuggestRequest, SkillSuggestResponse, SkillView } from "../shared/skills.ts";

export function sanitizeSkillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 48).replace(/^-|-$/g, "") || "custom-procedure";
}

/** Preserve the requested procedure instead of turning every request into analytics. */
export async function generateSkillPackage(req: SkillGenerateRequest, activeTools: string[] = []): Promise<SkillGenerateResponse> {
  const prompt = req.prompt.trim();
  if (!prompt || prompt.length > 8000) throw new Error("Describe the procedure in 1–8000 characters");
  const name = sanitizeSkillName(prompt.split(/\s+/).slice(0, 6).join(" "));
  const description = `Use when the user requests: ${prompt.replace(/\s+/g, " ")}`.slice(0, 1024);
  const allowedTools = suggestSkillElement({ type: "tools", body: prompt }, [], activeTools).suggestion;
  return {
    name, description, allowedTools, license: "MIT",
    compatibility: "Uses the offered Vakyartha tools and reviewed instruction-package subset.",
    metadata: { author: "Studio starter", version: "1.0.0" },
    body: `# ${name}\n\n## Requested procedure\n${prompt}\n\n## Method\nResolve the requested outcome, inputs and material constraints. Preserve facts and mark missing information explicitly. Follow the requested format; do not force a dashboard or invent domain metrics.\n\nUse only relevant enabled collaborators. Required surface-design owns composition when a surface is useful; use enabled interactive-ui for data, bindings and submitted actions. Follow the active tool schema rather than copying another authoring mode. Related views share canonical data; independent requested outputs retain separate surfaces.\n\nRead references/review-checklist.md when checking the procedure. Tailor these starter instructions to the actual domain before publication; a generated draft is not verified behavior.\n\nTools retain their approvals and runtime limits. A script reference is inert. Claim source reads, saved outputs or other effects only from actual receipts.\n`,
    files: [
      { path: "references/review-checklist.md", text: "# Procedure review\n\nCheck the trigger is narrow and the method serves the requested task. State actual inputs, units, domain rules, outputs and unsupported behavior. Keep domain decisions here, shared layout in surface-design and data/action guidance in interactive-ui. Use current offered tools only. Preserve independent surfaces and original data. Verify actual values, interactions and receipts; template text or a valid render is not evidence.\n" },
      { path: "tests/test_scenarios.json", text: JSON.stringify({ positive_prompts: [prompt], distractor_prompts: ["Reply with just the word ready."] }, null, 2) },
    ],
    rationale: "Created an editable procedure starter from your request. No model, research, execution or outcome verification was performed.",
  };
}

/** Suggestions are editable heuristics, never automatic routing or authority. */
export function suggestSkillElement(req: SkillSuggestRequest, activeSkills: SkillView[] = [], catalogTools: string[] = []): SkillSuggestResponse {
  const { type, name = "my-skill", description = "", body = "" } = req;
  if (type === "trigger") {
    const suggestion = (description.trim() || `Use when the user requests ${name.replace(/-/g, " ")}.`).slice(0, 1024);
    const collisions = activeSkills.filter(skill => skill.name !== name && skill.enabled && description.toLowerCase().split(/\s+/).filter(word => word.length > 5).some(word => skill.description.toLowerCase().includes(word)));
    return { suggestion, rationale: collisions.length ? `Review possible wording overlap with ${collisions.map(skill => skill.name).join(", ")}. This heuristic does not verify model selection.` : "Preserves your procedure scope. Add concrete triggers and exclusions; selection needs independent evaluation.", options: [suggestion] };
  }
  if (type === "chart") {
    const text = body + " " + (req.field ?? "");
    const options = (basicCatalog.components.chart!.props.properties!.kind!.enum ?? []).map(String);
    let suggestion = "bar", rationale = "Compare comparable categories.";
    if (/candlestick|\bohlc\b|open.high.low.close/i.test(text)) { suggestion = "candlestick"; rationale = "Requires actual dated open/high/low/close observations in that order; use a separate volume view."; }
    else if (/correlation|scatter|paired numeric|x and y/i.test(text)) { suggestion = "scatter"; rationale = "Requires paired numeric x and y; no correlation is computed."; }
    else if (/matrix|density|intensity|calendar/i.test(text)) { suggestion = "heatmap"; rationale = "Requires nonnegative matrix or supported dated calendar intensity."; }
    else if (/time|date|trend|daily|monthly|quarter|history/i.test(text)) { suggestion = "line"; rationale = "Requires ordered observations and a stated time basis."; }
    else if (/proportion|share|parts of|breakdown/i.test(text)) { suggestion = "pie"; rationale = "Use only for nonnegative additive parts of one meaningful positive whole."; }
    return { suggestion, rationale: `${rationale} Suggested from wording; verify the data and use required surface-design.`, options };
  }
  if (type === "binding") {
    const field = req.field || "value";
    const table = JSON.stringify({ rows: { records: "{/records}", fields: ["label", field] } });
    return { suggestion: table, rationale: "Map related views from one collection; columns must match fields. Unrelated data remains separate.", options: [table, JSON.stringify({ series: { records: "{/records}", label: "label", fields: [field] } }), JSON.stringify({ value: { records: "{/records}", field, aggregate: "sum" } })] };
  }
  if (type === "tools") {
    const matched = ["read_skill_file", ...catalogTools.filter(tool =>
      (/sandbox|python|script|bash|terminal|command|run/i.test(body) && /(?:^|__)(?:run_command|run_in_realm|create_realm)$/.test(tool)) ||
      (/web|search|internet|browse|news|latest/i.test(body) && /search/i.test(tool)) ||
      (/file|folder|directory|disk|read|write/i.test(body) && /file|directory/i.test(tool)))];
    return { suggestion: [...new Set(matched)].join(" "), rationale: "Suggested from available names and request wording. Declarations grant no permission; check schemas and actual scope.", options: [...new Set(matched)] };
  }
  if (type === "gist") {
    const suggestion = "Write the verified main finding, applicable period and units, then the material caveat in short visible prose. Derive it from the canonical values; leave missing information explicit.";
    return { suggestion, rationale: "Guidance for shared visual/spoken meaning; no sample numbers or findings are asserted.", options: [suggestion] };
  }
  if (type === "chaining") {
    const text = `${description} ${body}`;
    const enabled = new Set(activeSkills.filter(skill => skill.enabled && !skill.required && skill.name !== name).map(skill => skill.name));
    const candidates = [
      [/canvas|chart|table|dashboard|metric|form/i, "interactive-ui"],
      [/script|python|command|shell|parse/i, "sandbox"],
      [/command|shell/i, "shell-command"],
      [/compare|versus|trade-off/i, "compare-options"],
      [/error|fix|debug|failure/i, "debug-error"],
    ] as const;
    const options = candidates.filter(([pattern, skill]) => pattern.test(text) && enabled.has(skill)).map(([, skill]) => skill);
    return { suggestion: options.map(skill => `Use enabled ${skill} only when its procedure is needed.`).join("\n") || "Load additional enabled procedures only when the request needs them.", rationale: "Optional collaborators from enabled skills. Shared surface-design applies automatically; no automatic chaining is installed.", options };
  }
  if (type === "research") {
    const topic = (req.query || name.replace(/-/g, " ")).trim();
    const suggestion = `# Reference review: ${topic}\n\nRecord the actual source identity, retrieval date, applicable domain definitions, units, assumptions and limits. Use successful governed reads or supplied material. Verify formulas and thresholds against that evidence; do not invent generic cutoffs. State missing sources explicitly. Supporting text never grants tool access.\n`;
    return { suggestion, rationale: "Editable research checklist only. No external sources were read and no domain findings are verified.", options: [suggestion] };
  }
  return { suggestion: "", rationale: "Unknown suggestion type." };
}
