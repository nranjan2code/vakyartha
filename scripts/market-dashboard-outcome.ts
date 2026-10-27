// Frozen fictional-data outcome for the bundled market-dashboard package.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { Skills } from "../sidecar/skills.ts";

if (!process.argv.includes("--run-local")) throw new Error("Use --run-local for free Ollama");
const data = mkdtempSync(path.join(tmpdir(), "vak-market-dashboard-"));
const evidence = path.resolve(".vak/evaluations/market-dashboard", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(evidence, { recursive: true });
const model = "qwen3.5:4b-mlx", session = "market-dashboard-outcome";
const history = [
  { date: "2026-10-19", close: 100 }, { date: "2026-10-20", close: 102 },
  { date: "2026-10-21", close: 101 }, { date: "2026-10-22", close: 103 },
  { date: "2026-10-23", close: 105 },
];
const prompt = `Using the bundled market-dashboard procedure and its reusable layout reference, make one interactive dashboard from ONLY the following fictional supplied source snapshot. Instrument: Sample Index, exchange: fictional, timezone UTC, unit: index points, return basis: price return, source: "supplied fictional snapshot", retrieved 2026-10-27 12:00 UTC. Dated closes: ${history.map(row => `${row.date} ${row.close}`).join("; ")}. Compare 2026-10-19 through 2026-10-23 inclusive. Show the checked whole-window price return, a dated trend and an exact close-history table from one canonical history collection. Say visibly that this is fictional and not live, and that dividends and corporate-action adjustments are unknown. Do not claim a live market source, total return or forecast. No external reads, writes, trades or export.`;
const frozen = { model, prompt, history, expectedReturnPercent: 5, requiredCalls: ["use_skill", "read_skill_file"], checkerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") };
writeFileSync(path.join(evidence, "frozen.json"), JSON.stringify(frozen, null, 2));
const skills = new Skills(data);
for (const installed of skills.view()) if (!installed.required && !["market-dashboard", "dashboard", "interactive-ui"].includes(installed.name)) skills.remove(installed.name);
const app = await startAppServer({ dataDir: data, access: "open", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.market-gate" });
try {
  let status = 0, stream = "", error: string | undefined;
  try {
    const response = await fetch(`${app.url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, provider: "ollama", model, message: prompt }), signal: AbortSignal.timeout(180_000) });
    status = response.status; stream = await response.text();
  } catch (cause) { error = String(cause); }
  const state = await (await fetch(`${app.url}/api/sessions/${session}`)).json() as { timeline?: { kind: string; text?: string; used?: { name: string; ok: boolean }[] }[]; surfaces?: { id: string; title?: string; nodes?: { type: string; props?: Record<string, unknown> }[]; data?: Record<string, unknown> }[] };
  const answer = state.timeline?.filter(item => item.kind === "assistant").at(-1), calls = answer?.used?.map(item => item.name) ?? [];
  const surface = state.surfaces?.find(item => item.nodes?.some(node => node.type === "chart"));
  const nodes = surface?.nodes ?? [], records = surface?.data?.history;
  const chart = nodes.find(node => node.type === "chart"), table = nodes.find(node => node.type === "table");
  const allText = JSON.stringify({ answer: answer?.text, surfaces: state.surfaces }).toLowerCase();
  const checks = {
    status: status === 200 && !error,
    skill: calls.includes("use_skill"),
    reference: calls.includes("read_skill_file"),
    canonicalHistory: Array.isArray(records) && records.length === history.length && history.every((expected, i) => {
      const actual = records[i] as { date?: unknown; close?: unknown } | undefined;
      return actual?.date === expected.date && actual.close === expected.close && Object.keys(actual).length === 2;
    }),
    chartMapped: Boolean(chart && JSON.stringify(chart.props?.series).includes("{/history}")),
    tableMapped: Boolean(table && JSON.stringify(table.props?.rows).includes("{/history}")),
    period: allText.includes("2026-10-19") && allText.includes("2026-10-23"),
    return: allText.includes("5%") || allText.includes('"weekpricereturnpercent":5'),
    caveat: allText.includes("fictional") && allText.includes("dividend") && allText.includes("adjustment"),
  };
  const pass = Object.values(checks).every(Boolean);
  writeFileSync(path.join(evidence, "run.json"), JSON.stringify({ status, error, checks, calls, state, stream }, null, 2));
  writeFileSync(path.join(evidence, "summary.json"), JSON.stringify({ pass, checks, calls, evidence }, null, 2));
  console.log(JSON.stringify({ pass, checks, calls, evidence }));
  if (!pass) process.exitCode = 1;
} finally { await app.shutdown(); }
