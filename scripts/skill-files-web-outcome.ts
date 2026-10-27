// Web-mode app gate: three fresh sessions, one frozen local-model request.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { Skills } from "../sidecar/skills.ts";

if (!process.argv.includes("--run-local")) throw new Error("Use --run-local for this free Ollama gate");
const data = mkdtempSync(path.join(tmpdir(), "vak-skill-files-web-"));
const evidence = path.resolve(".vak/evaluations/skill-files-web", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(evidence, { recursive: true });
const skill = "---\nname: demo-palette\ndescription: Use when asked for the demo palette colours.\n---\n\nFor demo palette questions, read palette.md with read_skill_file and report its three exact hex colours.\n";
const palette = "ember: #C47A2D\nriver: #287F9B\nleaf: #6A9D4F\n";
const expected = ["#C47A2D", "#287F9B", "#6A9D4F"], model = "qwen3.5:4b-mlx";
const sha = "a".repeat(40), prompt = "What are the three exact hex colours in the demo palette? Give each colour name and value.";
const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "SKILL.md", type: "blob", size: skill.length }, { path: "palette.md", type: "blob", size: palette.length }] }) : url.endsWith("/SKILL.md") ? skill : palette)) as typeof fetch;
const skills = new Skills(data, fetcher);
for (const installed of skills.view()) if (!installed.required) skills.remove(installed.name);
const review = await skills.review("example/skills", ""); skills.add(review.fingerprint, true); skills.setEnabled("demo-palette", true);
writeFileSync(path.join(evidence, "frozen.json"), JSON.stringify({ prompt, expected, model, runs: 3, requiredCalls: ["use_skill", "read_skill_file"], skillSha256: createHash("sha256").update(skill).digest("hex"), paletteSha256: createHash("sha256").update(palette).digest("hex"), checkerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") }, null, 2));
const app = await startAppServer({ dataDir: data, access: "open", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.skill-files-gate" });
const summaries: unknown[] = [];
try {
  for (let run = 1; run <= 3; run++) {
    const session = `palette-gate-${run}`;
    let error: string | undefined, status = 0, stream = "";
    try {
      const response = await fetch(`${app.url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, provider: "ollama", model, message: prompt }), signal: AbortSignal.timeout(120_000) });
      status = response.status; stream = await response.text();
    } catch (cause) { error = String(cause); }
    let timeline: { kind: string; text?: string; used?: { name: string; ok: boolean }[] }[] = [];
    try { timeline = (await (await fetch(`${app.url}/api/sessions/${session}`)).json() as { timeline: typeof timeline }).timeline; }
    catch (cause) { error ??= String(cause); }
    const reply = timeline.filter(item => item.kind === "assistant").at(-1), calls = reply?.used?.map(item => item.name) ?? [];
    const pass = !error && status === 200 && calls.indexOf("use_skill") >= 0 && calls.indexOf("read_skill_file") > calls.indexOf("use_skill") && expected.every(hex => reply?.text?.includes(hex));
    writeFileSync(path.join(evidence, `run-${run}.json`), JSON.stringify({ run, session, pass, status, error, timeline, stream }, null, 2));
    const summary = { run, pass, status, error, calls, values: expected.map(hex => Boolean(reply?.text?.includes(hex))) };
    summaries.push(summary); writeFileSync(path.join(evidence, "summary.json"), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify(summary));
  }
} finally { await app.shutdown(); }
console.log(`Retained evidence: ${evidence}`);
if (summaries.some(value => !(value as { pass: boolean }).pass)) process.exitCode = 1;
