import { WORKSPACE_INPUTS, workspaceChecks, workspaceRows } from "./workspace-reference.ts";
// Opt-in real-provider outcome checks. Isolated state, installed configuration, retained evidence.
import { COMPARISON_FIXTURE, interactiveComparisonContract, comparisonClaimIssues, comparisonReference, comparisonReview, evaluationVerdict } from "./evaluation-reference.ts";
import { copyFile, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { SessionView } from "@vak/host";
import type { IntegrationView, ToolPolicy } from "@vak/mcp/client";
import { boundFieldValues, resultText, separateFormAndTable, tableOutputText, tableRows, tablePayloads, visibleTextValues } from "./evaluation-checks.ts";
import { parseResearchSummary } from "../shared/research-contract.ts";
import { keychainStore } from "../sidecar/settings.ts";
import { CATALOG } from "../sidecar/integrations.ts";
import { startAppServer } from "../sidecar/server.ts";
import { parseTaskView, taskObject, type TaskView, type TaskApproval } from "../shared/task-contract.ts";

const revision = (cwd?: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const sourceAtStart = { app: revision(), framework: revision("framework"), workingTreeModified: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0 };
const args = process.argv.slice(2);
if (!args.includes("--run-local") && !args.includes("--run-authorized") && !args.includes("--inspect")) throw new Error("Use --run-local, --run-authorized for an explicitly approved hosted trial, or --inspect for retained evidence.");
const option = (name: string, fallback: string) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(option("data", ".vak/evaluations/agent-mvp"));
const installed = path.resolve(option("settings", path.join(homedir(), "Library/Application Support/com.nranjan2code.vakyartha")));
const model = option("model", "qwen3.5:4b-mlx");
const provider = option("provider", "ollama");
if (!args.includes("--inspect") && provider !== "ollama" && !args.includes("--run-authorized")) throw new Error("Hosted trials require explicit authorization");
if (args.includes("--installed-keychain") && provider === "openai") process.env.OPENAI_API_KEY = keychainStore("com.nranjan2code.vakyartha").get("OPENAI_API_KEY");
const source = taskObject(JSON.parse(await readFile(path.join(installed, "integrations.json"), "utf8")));
const saved = taskObject(source.integrations);
await mkdir(root, { recursive: true, mode: 0o700 });
if (!existsSync(path.join(root, "models.json")) && existsSync(path.join(installed, "models.json"))) await copyFile(path.join(installed, "models.json"), path.join(root, "models.json"));
// Reuse only non-secret local provider settings. Never copy keys or paid-service credentials.
const settings = await readFile(path.join(installed, "settings.env"), "utf8").catch(() => "");
for (const line of settings.split("\n")) {
  const pair = /^(OLLAMA_HOST|OLLAMA_MODEL)=(.*)$/.exec(line);
  if (pair) process.env[pair[1]!] = pair[2]!.replace(/^(['"])(.*)\1$/, "$2");
}
const configurations: Record<string, unknown> = {};
for (const id of ["time", "web", "memory"]) {
  if (["selected-file-report", "interactive-comparison"].includes(option("case", "all"))) continue;
  const state = saved[id] === undefined ? undefined : taskObject(saved[id]);
  if (state?.enabled !== true) continue;
  if (id === "memory") {
    const entry = CATALOG.find((e) => e.id === id)!;
    if (entry.source.kind !== "npm") throw new Error("Expected the pinned memory runtime");
    const pkg = path.join(installed, "integrations", id, "pkg");
    const manifest = taskObject(JSON.parse(await readFile(path.join(pkg, "node_modules", entry.source.package, "package.json"), "utf8")));
    if (manifest.version !== entry.source.version) throw new Error("Installed memory runtime differs from the catalog pin; review it before reuse");
    await mkdir(path.join(root, "integrations", id), { recursive: true });
    if (!existsSync(path.join(root, "integrations", id, "pkg"))) await symlink(pkg, path.join(root, "integrations", id, "pkg"));
  }
  configurations[id] = { ...state, config: {}, policies: {} };
}
if (args.includes("--run-local") || args.includes("--run-authorized") || !existsSync(path.join(root, "integrations.json"))) await writeFile(path.join(root, "integrations.json"), JSON.stringify({ integrations: configurations, custom: [] }), { mode: 0o600 });
const app = await startAppServer({ dataDir: root, access: "open", keychainService: "com.nranjan2code.vakyartha.evaluation", uiDir: path.resolve("dist"), appName: "Vakyartha evaluation" });
console.log(`Evaluation workspace: ${app.url} · ${root}`);
const request = async <T>(route: string, body?: unknown, method = "POST"): Promise<T> => {
  const response = await fetch(app.url + route, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`Evaluation API ${route}: ${JSON.stringify(result)}`);
  return result as T;
};
let active: string | undefined;
const runId = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8);
const reportDir = path.join(root, "results", runId);
await mkdir(reportDir, { recursive: true });
const urls = ["https://example.com", "https://www.iana.org/help/example-domains"];
const entity = `vakyartha-evaluation-${runId}`;
const marker = `verified-local-marker-${randomUUID()}`;
type Case = { inputs?: { name: string; content: string }[]; output?: boolean; id: string; goal: string; criteria: string; integrations: string[]; approve(req: TaskApproval): boolean; check(task: TaskView, view: SessionView, integrations: IntegrationView[]): Promise<Record<string, boolean>> };
const types = (view: SessionView) => new Set(view.surfaces.flatMap((s) => s.nodes.map((n) => n.type)));
const cases: Case[] = [
  { id: "selected-file-report", inputs: WORKSPACE_INPUTS, output: true, integrations: [], approve: () => false,
    goal: "Read only the two selected input snapshots. Prepare a fictional inventory report with TWO independent surfaces: a bound editable budget criteria form with only the supplied budget input initialized from notes.md (no invented deadline or other populated fields), and a separate report with a searchable sortable table. Use columns item, quantity, unit_cost, line_total. Calculate each item's line_total, then add a Grand total row with quantity and unit_cost both labelled Not applicable. In the report, explicitly explain total cost, available budget, remaining budget and whether the total is within budget. Name the source filenames and snapshot date. Explicitly label missing delivery dates and unverified current file freshness; do not invent them. Save the complete result as the selected Markdown output. No external tools or file changes are authorized.",
    criteria: "Correct quantities, unit costs, line totals and grand total derived from inventory.csv; budget form initialized from notes.md; separate interactive surfaces, source filenames/date, fictional/missing/freshness labels and a verified saved Markdown output with current surface references. User review required.",
    check: async (task, view) => workspaceChecks(task, view) },
  { id: "interactive-comparison", integrations: [], approve: () => false,
    goal: `Use this fictional fixture only: ${COMPARISON_FIXTURE.options.map((option) => `${option.name} costs ${option.monthlyCost} per month for ${option.seats} seats.`).join(" ")} Budget is ${COMPARISON_FIXTURE.budget} and at least ${COMPARISON_FIXTURE.minimumSeats} seats are needed. Create TWO INDEPENDENT SURFACES with distinct IDs: an editable criteria form with budget and seats inputs, and a searchable sortable comparison table showing monthly cost, seats, cost per seat and explicit boolean claims within_budget, enough_seats and meets_both. Label the data fictional. Explain which option fits. Do not combine the form and table into one surface.`,
    criteria: `Two separate interactive surfaces: editable criteria form and comparison table. ${comparisonReference(COMPARISON_FIXTURE).map((option) => `${option.name}: cost per seat ${option.costPerSeat}, meets both criteria ${option.meetsBoth}`).join("; ")}. Fictional data labelled. No automatic completion.`,
    check: async (_t, view) => { const text = resultText(view), rows = tableRows(view), fields = boundFieldValues(view); return { formalClaimsMatch: comparisonClaimIssues(view, COMPARISON_FIXTURE).length === 0, optionValuesAssociated: comparisonReference(COMPARISON_FIXTURE).map((option) => [option.name, option.monthlyCost, option.seats, option.costPerSeat]).every((expected) => rows.some((cells) => expected.every((value) => cells.includes(value)))), suppliedCriteriaInitialized: fields.some((field) => /budget/i.test(field.label) && Number(field.value) === COMPARISON_FIXTURE.budget) && fields.some((field) => /seat/i.test(field.label) && Number(field.value) === COMPARISON_FIXTURE.minimumSeats), independentSurfaces: separateFormAndTable(view), form: types(view).has("form"), table: types(view).has("table"), fixtureValuesPresent: comparisonReference(COMPARISON_FIXTURE).every((option) => text.includes(option.name) && text.includes(String(option.costPerSeat))), tableRowLabelsPresent: COMPARISON_FIXTURE.options.every((option) => tableOutputText(view).includes(option.name)), sampleLabelPresent: /fictional|sample/i.test(text) }; } },
  { id: "public-source-research", integrations: ["web"],
    goal: `Read BOTH ${urls.join(" and ")} using web__fetch_page. Based on those sources, explain whether example domains are appropriate for documentation and production application dependencies. Cite both source URLs and distinguish what you verified from missing information. Create TWO independent surfaces: a criteria form and an evidence table. No other URLs or services are authorized.`,
    criteria: "Both pages successfully read through MCP, both URLs cited, documentation purpose and production limitations explained, two independent interactive surfaces. No invented sources or claims of unavailable verification.",
    approve: (req) => req.server === "web" && req.tool === "fetch_page" && urls.some((url) => new URL(url).href === new URL(String(taskObject(req.args).url)).href),
    check: async (task, view, integrations) => { const text = resultText(view); const calls = integrations.find((i) => i.entry.id === "web")?.calls.filter((c) => c.at >= task.created && c.ok === true) ?? [];
      const receipts = task.runHistory.at(-1)?.retrievals ?? [], rows = tablePayloads(view).flatMap((table) => Array.isArray(table.rows) ? table.rows : []);
      let explanationVisible = false;
      for (const surface of view.surfaces) { try { const summary = parseResearchSummary(surface.data.research); explanationVisible ||= [summary.answer, summary.limitations].every((content) => visibleTextValues(view).some((text) => text.surface === surface.id && text.content === content)); } catch {} }
      return { explanationVisible, retrievalDatesMatch: urls.every((url) => receipts.some((receipt) => new URL(receipt.url).href === new URL(url).href && rows.some((row) => row && typeof row === "object" && row.source === receipt.url && row.retrieved_at === receipt.retrievedAt))), bothSourcesRead: urls.every((url) => calls.some((c) => new URL(String(taskObject(c.args).url)).href === new URL(url).href)), bothSourcesCited: urls.every((url) => text.includes(url)), evidenceRowsPresent: tableRows(view).filter((row) => row.some((cell) => cell !== undefined && cell !== null && cell !== "")).length >= 2, independentSurfaces: separateFormAndTable(view), form: types(view).has("form"), table: types(view).has("table"), subjectPresent: /documentation/i.test(text) && /production/i.test(text) }; } },
  { id: "memory-operation", integrations: ["memory"],
    goal: `Use memory__create_entities to create exactly one entity with name "${entity}", entityType "evaluation", observations ["${marker}"]. Then use memory__open_nodes with names ["${entity}"] to read it back. Show the actual read-back result in an interactive confirmation. Do not change any other entity. Do not claim verification without reading it back.`,
    criteria: "Exact approved create operation, separate MCP read-back and independent persisted-file confirmation of the marker. No other entities changed; result remains open for user review.",
    approve: (req) => {
      if (req.server !== "memory") return false;
      const value = taskObject(req.args);
      return req.tool === "open_nodes" ? JSON.stringify(value.names) === JSON.stringify([entity]) : req.tool === "create_entities" && Array.isArray(value.entities) && value.entities.length === 1 && taskObject(value.entities[0]).name === entity && taskObject(value.entities[0]).entityType === "evaluation" && JSON.stringify(taskObject(value.entities[0]).observations) === JSON.stringify([marker]);
    },
    check: async (task, view, integrations) => { const calls = integrations.find((i) => i.entry.id === "memory")?.calls.filter((c) => c.at >= task.created && c.ok === true) ?? []; const stored = await readFile(path.join(root, "integrations", "memory", "memory.jsonl"), "utf8").catch(() => ""); return { createReturned: calls.some((c) => c.tool === "create_entities"), readBackReturned: calls.some((c) => c.tool === "open_nodes"), persistedMarker: stored.split("\n").some((line) => { try { const row = taskObject(JSON.parse(line)); return row.name === entity && Array.isArray(row.observations) && row.observations.includes(marker); } catch { return false; } }), resultReferencesMarker: resultText(view).includes(marker), interactiveResult: view.surfaces.length > 0 }; } },
];
const results: unknown[] = [];
try {
  if (args.includes("--inspect")) {
    console.log(`Evaluation workspace: ${app.url}\nData: ${root}`);
    await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    const models = await request<{ models: string[] }>(`/api/models?provider=${encodeURIComponent(provider)}`);
    if (!models.models.includes(model)) throw new Error("The requested model is unavailable; no fallback is permitted");
    let integrations = await request<IntegrationView[]>("/api/integrations");
    for (const integration of integrations.filter((i) => ["web", "memory"].includes(i.entry.id) && i.enabled)) {
      await request(`/api/integrations/${integration.entry.id}/refresh`, {});
      integrations = await request<IntegrationView[]>("/api/integrations");
      const current = integrations.find((i) => i.entry.id === integration.entry.id)!;
      const permitted = integration.entry.id === "web" ? ["fetch_page"] : ["create_entities", "open_nodes"];
      const policies: Record<string, ToolPolicy> = Object.fromEntries(current.tools.map((tool) => [tool.name, permitted.includes(tool.name) ? "ask" : "off"]));
      await request(`/api/integrations/${integration.entry.id}`, { policies }, "PUT");
    }
    if (option("case", "all") !== "all" && !cases.some((scenario) => scenario.id === option("case", "all"))) throw new Error("Unknown evaluation case");
    for (const scenario of cases.filter((c) => option("case", "all") === "all" || c.id === option("case", "all"))) {
      integrations = await request<IntegrationView[]>("/api/integrations");
      if (scenario.integrations.some((id) => !integrations.some((i) => i.entry.id === id && i.status === "ready"))) { results.push({ case: scenario.id, verdict: "blocked", reason: "Required installed integration is not ready" }); continue; }
      const started = Date.now();
      const made = parseTaskView(await request("/api/tasks", { goal: scenario.goal, criteria: scenario.criteria, ...(scenario.inputs ? { inputs: scenario.inputs } : {}), ...(scenario.output || args.includes("--save-output") ? { output: { kind: "markdown" } } : {}), provider, model, ...(scenario.id === "selected-file-report" ? { resultPolicy: { kind: "comparison", labels: workspaceRows().map((row) => row.item), initialValues: { "/criteria/budget": 100 }, notices: ["Fictional", "2026-10-01"] } } : scenario.id === "interactive-comparison" ? { resultPolicy: { kind: "comparison", labels: COMPARISON_FIXTURE.options.map((option) => option.name), table: interactiveComparisonContract(COMPARISON_FIXTURE), notices: ["Fictional"] } } : scenario.id === "public-source-research" ? { resultPolicy: { kind: "research", sources: urls } } : {}), integrations: scenario.integrations, spending: provider === "ollama" ? { kind: "local_only" } : { kind: "api_allowed", acknowledged: true }, limits: { runs: 2, modelRequests: 12, toolCalls: 6, activeMs: 300000 } }));
      active = made.id; let task = made, nextLog = 0; const decisions: { tool: string; decision: string }[] = [], answered = new Set<string>();
      while (["queued", "running", "needs_approval"].includes(task.state)) {
        if (task.approval && !answered.has(task.approval.id)) {
          const decision = scenario.approve(task.approval) ? "allow" : "deny"; answered.add(task.approval.id); decisions.push({ tool: `${task.approval.server} / ${task.approval.tool}`, decision });
          await request(`/api/tasks/${task.id}/approve`, { approval: task.approval.id, decision });
        }
        if (Date.now() >= nextLog) { console.log(`${scenario.id}: ${task.state}, ${task.budget.modelRequests} model requests, ${Math.round((Date.now() - started) / 1000)}s`); nextLog = Date.now() + 30000; }
        if (Date.now() - started > 360000) { await request(`/api/tasks/${task.id}/cancel`, {}); throw new Error("Evaluation wall-time guard reached"); }
        await new Promise((resolve) => setTimeout(resolve, 500)); task = parseTaskView(await request(`/api/tasks/${task.id}`));
      }
      active = undefined;
      const view = await request<SessionView>(`/api/sessions/${task.id}`);
      integrations = await request<IntegrationView[]>("/api/integrations");
      const checks = { awaitingUserReview: task.state === "needs_input", ...await scenario.check(task, view, integrations), ...(scenario.output || args.includes("--save-output") ? { savedOutputVerified: await (async () => { const receipt = task.runHistory.at(-1)?.output; if (!receipt || receipt.state !== "saved") return false; const content = await readFile(path.join(root, "outputs", receipt.filename)); const { createHash } = await import("node:crypto"); return content.length === receipt.bytes && createHash("sha256").update(content).digest("hex") === receipt.sha256; })() } : {}) };
      const result = { case: scenario.id, task: task.id, verdict: evaluationVerdict(checks), checks, ...(scenario.id === "interactive-comparison" ? { comparisonReview: comparisonReview(view, COMPARISON_FIXTURE) } : {}), decisions, state: task.state, note: task.note, seconds: (Date.now() - started) / 1000, budget: task.budget, surfaces: view.surfaces.map((s) => ({ id: s.id, types: [...new Set(s.nodes.map((n) => n.type))] })), manualReviewRequired: true };
      results.push(result); await writeFile(path.join(reportDir, `${scenario.id}.json`), JSON.stringify({ result, task, view }, null, 2), { mode: 0o600 }); console.log(`${scenario.id}: ${result.verdict}`);
      if (scenario.id === "interactive-comparison" && args.includes("--change-criteria") && task.state === "needs_input") {
        const surface = view.surfaces.find((surface) => surface.nodes.some((node) => node.props?.bind === "/criteria/budget"));
        const form = surface?.nodes.find((node) => node.type === "form");
        if (!surface || !form) throw new Error("The checked criteria form is missing its declared bindings");
        const changed = { ...COMPARISON_FIXTURE, budget: 10, minimumSeats: 8 }, continuedAt = Date.now();
        await request(`/api/tasks/${task.id}/input`, { id: randomUUID(), revision: surface.version, action: { surface: surface.id, source: form.id, data: { criteria: { budget: changed.budget, seats: changed.minimumSeats } } } });
        active = task.id;
        do {
          await new Promise((resolve) => setTimeout(resolve, 500));
          task = parseTaskView(await request(`/api/tasks/${task.id}`));
          if (task.state === "needs_approval" || Date.now() - continuedAt > 360000) throw new Error("Comparison continuation exceeded its scope or wall-time guard");
        } while (["queued", "running"].includes(task.state));
        active = undefined;
        const after = await request<SessionView>(`/api/sessions/${task.id}`), fields = boundFieldValues(after);
        const checks = { awaitingUserReview: task.state === "needs_input", changedClaimsMatch: comparisonClaimIssues(after, changed).length === 0, changedControlsMatch: fields.some((field) => Number(field.value) === changed.budget) && fields.some((field) => Number(field.value) === changed.minimumSeats), independentSurfaces: separateFormAndTable(after), factsAndExpressionsPreserved: task.resultPolicy?.kind === "comparison" && JSON.stringify(task.resultPolicy.table?.rows) === JSON.stringify(made.resultPolicy?.kind === "comparison" ? made.resultPolicy.table?.rows : null) && JSON.stringify(task.resultPolicy.table?.calculations) === JSON.stringify(made.resultPolicy?.kind === "comparison" ? made.resultPolicy.table?.calculations : null) };
        const result = { case: "interactive-comparison-changed", task: task.id, verdict: evaluationVerdict(checks), checks, comparisonReview: comparisonReview(after, changed), state: task.state, seconds: (Date.now() - continuedAt) / 1000, budget: task.budget, manualReviewRequired: true };
        results.push(result); await writeFile(path.join(reportDir, "interactive-comparison-changed.json"), JSON.stringify({ result, task, view: after }, null, 2), { mode: 0o600 }); console.log(`${result.case}: ${result.verdict}`);
      }
    }
  }
} finally {
  if (active) await request(`/api/tasks/${active}/cancel`, {}).catch(() => {});
  await app.shutdown();
  await writeFile(path.join(reportDir, "summary.json"), JSON.stringify({ at: new Date().toISOString(), sourceAtStart, app: revision(), framework: revision("framework"), workingTreeModified: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0, provider, model, settingsSource: installed, results, note: "Automated checks do not verify prose semantics. Passing checks require semantic review; consult review.json where present. No release readiness is established. No tasks were automatically accepted." }, null, 2), { mode: 0o600 });
  console.log(`Evidence: ${reportDir}`);
}
