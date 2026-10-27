// Current skill-led data-contract trial. Historical baseline/native/submission
// experiments remain as retained receipts, not maintained runtime modes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { basicCatalog, SurfaceStore, walk, projectText, type ResolvedNode, type JSONSchema } from "@vak/core";
import { choosePlan, providersFromEnv, runAgent, type ChatRequest, type Provider, type Message } from "@vak/providers";
import { keychainStore } from "../sidecar/settings.ts";
import { Skills } from "../sidecar/skills.ts";
import { BUILTIN_SKILLS } from "../sidecar/skills-builtin.ts";

const arg = (name: string) => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
const providerId = arg("--provider") ?? "ollama";
if (providerId === "ollama" ? !process.argv.includes("--run-local") : !process.argv.includes("--run-authorized")) throw new Error("Use --run-local for local calls or --run-authorized for an explicitly authorized hosted trial");
const env = { ...process.env };
if (process.argv.includes("--installed-keychain") && providerId === "openai") env.OPENAI_API_KEY = keychainStore("com.nranjan2code.vakyartha").get("OPENAI_API_KEY");
const entry = providersFromEnv(env).find(provider => provider.id === providerId);
if (!entry?.available) throw new Error("Requested provider is not configured");
const model = arg("--model") ?? entry.defaultModel;
if (!model) throw new Error("Specify --model for this provider");
const actual = entry.make();
const root = path.resolve(".vak/evaluations/interactive-skill", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(root, { recursive: true });
const facts = await actual.describeModel!(model);
const plan = choosePlan({ provider: actual.id, model, facts, constrainedOutput: actual.capabilities?.constrainedOutput === true }, { userTools: true });
const effortValue = arg("--effort");
if (effortValue !== undefined && !["low", "medium", "high"].includes(effortValue)) throw new Error("Supported test efforts: low, medium, high");
const effort = effortValue as "low" | "medium" | "high" | undefined;
const skillText = BUILTIN_SKILLS.find((s) => s.includes("name: interactive-ui\n"))!;
const limits = { maxSteps: 3, toolRounds: 1, maxTokens: 2200, timeoutMs: 120_000 };
const cases = [
  { id: "records-only", request: 'Show these supplied records as exactly one interactive table: [{"label":"Cedar","value":12},{"label":"Pine","value":17}]. Show precisely these records. No totals, calculations, charts, summaries or input form.', values: [12, 17], labels: ["Cedar", "Pine"], factor: undefined },
  { id: "linked-views", request: 'Create one interactive surface for these measurements: [{"label":"East","value":9},{"label":"West","value":14}]. Show a table and a bar chart of exactly these measurements. Include a form with a numeric threshold initially 20, submit action review, and text displaying the same threshold through a binding. Editing threshold must update that text locally. Do not change the measurements or calculate totals.', values: [9, 14], labels: ["East", "West"], factor: undefined },
  { id: "submit-calculation", request: 'Create one interactive surface using supplied records [{"label":"Small","quantity":2},{"label":"Large","quantity":7}]. Include a form with numeric multiplier initially 3, submit action calculate, a table of label and quantity times multiplier, a bar chart of those same results, and a total metric. On submit, recalculate from the submitted multiplier and update this surface. Explain that recalculation happens on submit. Keep the original quantities in data. Do not claim instant local formula execution.', values: [2, 7], labels: ["Small", "Large"], factor: 3 },
];
type Case = typeof cases[number];
// Trusted fixture contracts describe structure/types, never calculated answers.
// The original independent content/interaction checks below remain unchanged.
function contract(c: Case): JSONSchema {
  const fields: Record<string, JSONSchema> = { label: { type: "string" }, value: { type: "number" } };
  if (c.factor !== undefined) fields.quantity = { type: "number" };
  const properties: Record<string, JSONSchema> = {
    records: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", additionalProperties: false, properties: fields, required: Object.keys(fields) } },
  };
  if (c.id !== "records-only") properties[c.factor === undefined ? "threshold" : "multiplier"] = { type: "number" };

  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}
function inspect(store: SurfaceStore, c: Case, factor = c.factor): string[] {
  const issues: string[] = [], all: ResolvedNode[] = [];
  const snapshots = store.list().map((s) => store.snapshot(s.id)!);
  if (snapshots.length !== 1) issues.push("Expected exactly one surface");
  for (const s of snapshots) {
    if (store.assess(s.id)?.errors) issues.push("Unresolved runtime errors");
    const r = store.resolve(s.id)?.root; if (r) walk(r, (n) => all.push(n));
  }
  const expected = c.values.map((v) => v * (factor ?? 1));
  const tables = all.filter((n) => n.type === "table");
  const rowsMatch = tables.some((n) => {
    const rows = n.props.rows, cols = n.props.columns;
    if (!Array.isArray(rows) || rows.length !== 2 || !Array.isArray(cols) || cols.length !== 2 || n.props.totals === true) return false;
    return rows.every((row, i) => {
      const cells = cols.map((col, at) => Array.isArray(row) ? row[at] : row?.[typeof col === "string" ? col : col.key]);
      return cells.includes(c.labels[i]) && cells.includes(expected[i]);
    });
  });
  if (!rowsMatch) issues.push("Table does not preserve exactly the expected labels and numeric results");
  if (c.id === "records-only") {
    if (all.some((n) => ["form", "input", "select", "chart", "stat"].includes(n.type))) issues.push("Unrequested controls, chart or summary");
    return issues;
  }
  const charts = all.filter((n) => n.type === "chart");
  if (!charts.some((n) => {
    const series = n.props.series;
    return n.props.kind === "bar" && JSON.stringify(n.props.labels) === JSON.stringify(c.labels) && Array.isArray(series) && series.length === 1 && JSON.stringify(series[0]?.values ?? series) === JSON.stringify(expected);
  })) issues.push("Chart does not match the table labels and numeric values");
  const form = all.find((n) => n.type === "form");
  const inputs = all.filter((n) => n.type === "input" && n.props.kind === "number" && n.bindPath);
  if (!form || inputs.length !== 1) issues.push("Expected one form with one numeric input");
  const input = inputs[0], s = snapshots[0];
  const initial = c.id === "linked-views" ? 20 : factor;
  if (input && input.props.value !== initial) issues.push("Numeric input is not initialized to the requested value");
  if (c.factor !== undefined && !all.some((n) => n.type === "stat" && Number(n.props.value) === expected.reduce((a, b) => a + b, 0))) issues.push("Total metric is incorrect or absent");
  if (c.id === "linked-views" && input && s && form) {
    const textBefore = all.filter((n) => n.type === "text").map((n) => String(n.props.content)).join("\n");
    store.setValue(s.id, input.bindPath!, 25);
    const after: ResolvedNode[] = []; const r = store.resolve(s.id)?.root; if (r) walk(r, (n) => after.push(n));
    const textAfter = after.filter((n) => n.type === "text").map((n) => String(n.props.content)).join("\n");
    const submitted = store.submit(s.id, form.key, "web");
    if (textAfter === textBefore || !textAfter.includes("25")) issues.push("Input edit did not update bound text locally");
    if (!submitted.action || !Object.values(submitted.action.data).includes(25)) issues.push("Form did not submit the edited numeric value");
    store.setValue(s.id, input.bindPath!, 20);
  }
  return issues;
}
const results: Record<string, unknown>[] = [];
const revision = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(path.join(root, "frozen.json"), JSON.stringify({ provider: providerId, model, effort, facts, plan, limits, cases, selectedCase: arg("--case"), skillText, dataSchemas: cases.map(c => ({ case: c.id, schema: contract(c) })), sourceHashes: Object.fromEntries(["sidecar/skills.ts", "sidecar/skills-builtin.ts", "sidecar/server.ts"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), skillSha256: createHash("sha256").update(skillText).digest("hex"), checkerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), app: revision("."), framework: revision("framework"), note: "One run per case/arm; fixed checks; no repair of the skill between cases. Submission probe uses generic transactional authoring, with no source compiler or caller outcome repair." }, null, 2));
if (arg("--case") && !cases.some(c => c.id === arg("--case"))) throw new Error("Unknown case");
for (const c of cases.filter(c => !arg("--case") || c.id === arg("--case"))) {
  const id = `${c.id}-skill`;
  const dir = path.join(root, id), store = new SurfaceStore(basicCatalog);
  mkdirSync(dir);
  const skills = new Skills(dir);
  const messages: Message[] = [{ role: "user", content: c.request }];
  const requests: unknown[] = [], events: unknown[] = [];
  const provider: Provider = { ...actual, async *stream(req: ChatRequest) {
    requests.push(structuredClone({ ...req, signal: undefined }));
    yield* actual.stream(req);
  } };
  const started = Date.now();
  const execute = () => runAgent({ provider: skills.provider(provider), model, effort, plan, store, messages, tools: skills.tool() ? [skills.tool()!] : [], instructions: "You are the assistant inside Vakyartha, a desktop app.\nToday is 2026-10-27.\n" + skills.index(), generation: "tools", surfaceSubmission: true, completion: "response", dataSchema: contract(c), surfaceCount: 1, maxSteps: limits.maxSteps, toolRounds: limits.toolRounds, maxTokens: limits.maxTokens, signal: AbortSignal.timeout(limits.timeoutMs), emit: (e) => events.push(e) });
  let result: unknown, continuation: unknown, issues: string[] = [];
  try {
    result = await execute();
    issues = inspect(store, c);
    if (!messages.some((m) => m.toolCalls?.some((t) => t.name === "use_skill" && t.arguments.includes("interactive-ui")))) issues.push("Skill was not loaded through discovery");
    if (!issues.length && c.factor !== undefined) {
      const s = store.list()[0]!; const nodes: ResolvedNode[] = []; walk(store.resolve(s.id)!.root!, (n) => nodes.push(n));
      const input = nodes.find((n) => n.type === "input" && n.bindPath)!;
      store.setValue(s.id, input.bindPath!, 4);
      const submitted = store.submit(s.id, nodes.find((n) => n.type === "form")!.key, "web");
      if (!submitted.action) issues.push("Calculation submit failed");
      else { messages.push({ role: "user", content: `[ui action] ${JSON.stringify(submitted.action)}` }); continuation = await execute(); issues.push(...inspect(store, c, 4)); }
    }
  } catch (error) { issues.push(String(error)); }
  const report = { id, result, continuation, issues, pass: issues.length === 0, requests: requests.length, seconds: (Date.now() - started) / 1000, messages, events, wireRequests: requests, surfaces: store.list().map((s) => store.snapshot(s.id)), text: store.list().map((s) => projectText(store.resolve(s.id)!)) };
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  const summary = { id, pass: report.pass, requests: report.requests, seconds: report.seconds, issues };
  results.push(summary); writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(summary));
}
console.log(`Retained evidence: ${root}`);
if (results.some((r) => !r.pass)) process.exitCode = 1;
