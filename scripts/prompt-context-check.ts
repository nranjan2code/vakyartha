// Frozen prompt-assembly checks; optional free primary-provider selection only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { runAgent, ollama, type Provider, type ChatRequest } from "@vak/providers";
import { Skills } from "../sidecar/skills.ts";
import { evaluateSkillPrompts } from "../sidecar/skills-eval.ts";

const out = path.resolve(".vak/evaluations/prompt-cleanup", new Date().toISOString().replaceAll(":", "-"));
await mkdir(out, { recursive: true });
const cases = [{ prompt: "Create an editable form and a linked table from supplied records; submitting criteria should update the affected views together.", expected: true, forbidden: ["app-authoring"] }, { prompt: "Write a brief polite thank-you email for a helpful introduction.", expected: false }];
await writeFile(path.join(out, "contract.json"), JSON.stringify({ model: "qwen3.5:4b-mlx", target: "interactive-ui", cases, assertions: ["one required design body", "selected body complete in system only", "historical instructions absent", "source history retained", "schema-constrained parity", "native/decoded original numeric facts separately gated"], localSelection: process.argv.includes("--run-local-selection") }, null, 2), { flag: "wx" });
const dir = await mkdtemp(path.join(tmpdir(), "vak-prompt-check-"));
try {
  const skills = new Skills(dir), design = skills.view().find(skill => skill.required)!.body, interactive = skills.view().find(skill => skill.name === "interactive-ui")!.body;
  const captures: Record<string, ChatRequest[]> = {};
  for (const mode of ["native", "decoded", "history", "plain"]) {
    const seen: ChatRequest[] = [];
    const decoded = mode === "decoded";
    const names = mode === "plain" || mode === "history" ? [] : ["assistant", "interactive-ui", "surface-design"];
    const provider: Provider = { id: "offline", capabilities: { constrainedOutput: true }, async *stream(request) {
      seen.push(structuredClone(request));
      if (seen.length > 1) throw new Error("capture complete");
      yield { type: "text", delta: JSON.stringify(decoded ? { tool: "use_skill", arguments: { names } } : { names }) };
      yield { type: "done", stop: "end" };
    } };
    const messages: import("@vak/providers").Message[] = mode === "history" ? [{ role: "assistant", content: "", toolCalls: [{ id: "old", name: "use_skill", arguments: '{"names":["dashboard"]}' }] }, { role: "tool", toolName: "use_skill", toolCallId: "old", content: "OLD_PROCEDURE_SENTINEL" }] : [];
    messages.push({ role: "user", content: mode === "plain" ? "Reply with one short sentence." : "Create a form and linked table." });
    await runAgent({ provider: skills.provider(provider), model: "offline", store: new SurfaceStore(basicCatalog), messages, instructions: skills.index(), tools: skills.tools(), plan: { generation: "tools", tier: "core", examples: true, authoring: "inline", maxSteps: 4, reasons: [] }, toolResultChars: 16, ...(decoded ? { surfaceSubmission: true, completion: "response" as const } : {}), emit: () => {} });
    assert.equal(seen.length, 2);
    const answer = seen[1]!;
    assert.equal(answer.system!.split(design).length - 1, 1);
    if (names.length) { assert.ok(answer.system!.includes(interactive)); assert.ok(!answer.messages.some(message => message.content.includes(interactive))); }
    if (mode === "history") { assert.ok(!JSON.stringify(answer).includes("OLD_PROCEDURE_SENTINEL")); assert.equal(messages[1]!.content, "OLD_PROCEDURE_SENTINEL"); }
    captures[mode] = seen;
  }
  await writeFile(path.join(out, "offline-requests.json"), JSON.stringify(captures, null, 2));
  const result: Record<string, unknown> = { offline: "pass", skillCount: skills.view().length, indexChars: skills.index().length, bodyChars: { design: design.length, interactive: interactive.length }, metrics: Object.fromEntries(Object.entries(captures).map(([mode, requests]) => [mode, requests.map(request => ({ systemChars: request.system?.length ?? 0, schemaChars: JSON.stringify(request.tools ?? request.responseSchema).length, messageChars: request.messages.reduce((sum, message) => sum + message.content.length, 0) }))])) };
  if (process.argv.includes("--run-local-selection")) {
    const actual = ollama(), wire: unknown[] = [];
    const provider: Provider = { ...actual, async *stream(request) { const record = { request: structuredClone({ ...request, signal: undefined }), events: [] as unknown[] }; wire.push(record); for await (const event of actual.stream(request)) { record.events.push(event); yield event; } } };
    const selection = await evaluateSkillPrompts(skills, "interactive-ui", cases, { provider, model: "qwen3.5:4b-mlx" });
    await writeFile(path.join(out, "local-selection-wire.json"), JSON.stringify(wire, null, 2));
    result.selection = selection;
    result.selectionScopePass = selection.every((item, index) => !(cases[index]?.forbidden ?? []).some(name => item.selectedSkills.includes(name)));
    if (selection.some(item => !item.passed) || !result.selectionScopePass) process.exitCode = 1;
  }
  await writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ evidence: out, ...result }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
