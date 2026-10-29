import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Skills } from "../sidecar/skills.ts";
import { generateSkillPackage, suggestSkillElement } from "../sidecar/skills-copilot.ts";
import { evaluateSkillPrompts } from "../sidecar/skills-eval.ts";
import { runSkillScript } from "../sidecar/skills-sandbox.ts";

test("Skill Studio: savePackage and getPackage persist full multi-file packages", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-test-"));
  try {
    const skills = new Skills(dir);
    const text = `---
name: revenue-health
description: Evaluate recurring revenue metrics and churn risk from supplied accounting records.
allowed-tools: run_command read_skill_file
metadata:
  version: "1.0.0"
---

Analyze revenue metrics using canonical records and project a 3-tier liquid canvas.
`;

    const files = [
      { path: "references/rules.md", text: "# Rules\nCheck NRR > 100%." },
      { path: "schemas/data.json", text: JSON.stringify({ records: [{ id: 1, val: 500 }] }) },
      { path: "scripts/calc.py", text: "print('computed: 500')" }
    ];

    skills.savePackage("revenue-health", { text, files });

    const pkg = skills.getPackage("revenue-health");
    assert.equal(pkg.skill.name, "revenue-health");
    assert.equal(pkg.skill.description, "Evaluate recurring revenue metrics and churn risk from supplied accounting records.");
    assert.equal(pkg.files.length, 3);
    assert.equal(pkg.files.find(f => f.path === "references/rules.md")?.text, "# Rules\nCheck NRR > 100%.");
    assert.equal(pkg.files.find(f => f.path === "scripts/calc.py")?.text, "print('computed: 500')");

    // Updating files prune deleted ones
    const updatedFiles = [
      { path: "references/rules.md", text: "# Rules\nCheck NRR > 110%." }
    ];
    skills.savePackage("revenue-health", { text, files: updatedFiles });

    const next = skills.getPackage("revenue-health");
    assert.equal(next.files.length, 1);
    assert.equal(next.files[0]?.path, "references/rules.md");
    assert.equal(next.files[0]?.text, "# Rules\nCheck NRR > 110%.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill Studio: drafts persist across sessions without affecting published live skill until publishDraft", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-draft-"));
  try {
    const skills = new Skills(dir);
    const publishedText = `---
name: analytics-pro
description: Published version running in live assistant.
---
Live published instructions.
`;
    skills.savePackage("analytics-pro", { text: publishedText });

    // Live assistant sees published version
    assert.equal(skills.view().find(s => s.name === "analytics-pro")?.description, "Published version running in live assistant.");

    // User works on a draft for days
    const draftText = `---
name: analytics-pro
description: Work-in-progress draft with experimental changes.
---
WIP instructions being edited.
`;
    const draftFiles = [{ path: "references/wip.md", text: "experimental draft note" }];
    const saveRes = skills.saveDraft("analytics-pro", { text: draftText, files: draftFiles });
    assert.equal(saveRes.hasDraft, true);

    // CRITICAL INVARIANT: The live assistant still sees ONLY the published version!
    const live = skills.view().find(s => s.name === "analytics-pro")!;
    assert.equal(live.description, "Published version running in live assistant.");
    assert.equal(live.body, "Live published instructions.");

    // Studio retrieves the working draft
    const draft = skills.getDraft("analytics-pro");
    assert.equal(draft.hasDraft, true);
    assert.equal(draft.package.skill.description, "Work-in-progress draft with experimental changes.");
    assert.equal(draft.package.files.find(f => f.path === "references/wip.md")?.text, "experimental draft note");

    // Finally user explicitly publishes
    const published = skills.publishDraft("analytics-pro");
    assert.equal(published.description, "Work-in-progress draft with experimental changes.");
    assert.equal(published.body, "WIP instructions being edited.");

    // After publish, draft is cleared and live assistant sees new version
    assert.equal(skills.getDraft("analytics-pro").hasDraft, false);
    assert.equal(skills.view().find(s => s.name === "analytics-pro")?.description, "Work-in-progress draft with experimental changes.");

    // User can also publish directly with payload
    const directPayloadText = `---
name: analytics-pro
description: Directly published version.
---
Direct body.
`;
    const directPublished = skills.publishDraft("analytics-pro", { text: directPayloadText });
    assert.equal(directPublished.description, "Directly published version.");
    assert.equal(skills.view().find(s => s.name === "analytics-pro")?.description, "Directly published version.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill Studio: starter preserves requested scope without fabricated analytics or fixed layout", async () => {
  const generated = await generateSkillPackage(
    { prompt: "Customer Churn and Retention Risk Analysis" },
    ["run_command", "brave_search", "filesystem"]
  );

  assert.ok(generated.name.includes("customer-churn"));
  assert.ok(generated.description.length > 20);
  assert.ok(generated.description.length <= 1024);
  assert.ok(generated.body.includes("Customer Churn and Retention Risk Analysis"));
  assert.doesNotMatch(generated.body, /Tier [123]|columns: 4/);
  assert.ok(!generated.allowedTools?.includes("run_command"), "unrelated execution is not suggested");
  assert.ok(generated.files.some(f => f.path.startsWith("references/")));
  assert.ok(!generated.files.some(f => f.path.startsWith("schemas/")), "no invented domain schema");
  assert.ok(!generated.files.some(f => f.path.startsWith("scripts/")), "no unrelated canned script");
  assert.ok(generated.files.some(f => f.path.startsWith("tests/")));
});

test("Skill Studio: smart element suggestions advise triggers, charts, and bindings", () => {
  const trigger = suggestSkillElement({
    type: "trigger",
    name: "cloud-spend-monitor",
    description: "monitor cloud",
  }, []);
  assert.equal(trigger.suggestion, "monitor cloud");
  assert.ok(trigger.rationale.length > 10);

  const chart = suggestSkillElement({
    type: "chart",
    body: "Display monthly revenue trend and dated observations over time."
  });
  assert.equal(chart.suggestion, "line");

  const pieChart = suggestSkillElement({
    type: "chart",
    body: "Show breakdown of expense share and distribution across departments."
  });
  assert.equal(pieChart.suggestion, "pie");

  const binding = suggestSkillElement({
    type: "binding",
    field: "amount"
  });
  assert.ok(binding.suggestion.includes("{/records}"));
  assert.ok(binding.suggestion.includes("amount"));

  const gist = suggestSkillElement({
    type: "gist",
    name: "pipeline-review"
  });
  assert.ok(gist.suggestion.length > 20);
});

test("Skill Studio: rehearsal fails closed without authorized OS containment", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-sandbox-"));
  try {
    const skills = new Skills(dir);
    const text = "---\nname: test-runner-skill\ndescription: Test scripts\n---\nInstructions";
    const script = "echo should-not-run";
    skills.savePackage("test-runner-skill", { text, files: [{ path: "scripts/hello.sh", text: script }] });
    const refused = await runSkillScript(skills, "test-runner-skill", "scripts/hello.sh");
    assert.notEqual(refused.exitCode, 0); assert.match(refused.error!, /Enable sandbox/);
    const options = { binaryPath: path.join(dir, "missing-helper"), enabled: () => true, authorized: () => true, scriptSha256: createHash("sha256").update(script).digest("hex") };
    const missing = await runSkillScript(skills, "test-runner-skill", "scripts/hello.sh", [], options);
    assert.notEqual(missing.exitCode, 0); assert.match(missing.error!, /helper|macOS/);
    const changed = await runSkillScript(skills, "test-runner-skill", "scripts/hello.sh", [], { ...options, scriptSha256: "0".repeat(64) });
    assert.match(changed.error!, /changed/);
    const denied = await runSkillScript(skills, "test-runner-skill", "scripts/hello.sh", [], { ...options, authorized: () => false });
    assert.match(denied.error!, /Enable sandbox/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Skill Studio: saved drafts run only through the real sandbox and cannot read outside", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-sandbox-real-"));
  try {
    const skills = new Skills(dir);
    const binaryPath = path.resolve("../sandbox/target/debug/vaksb");
    assert.ok(existsSync(binaryPath), "Build the sandbox helper before this integration test");
    const text = "---\nname: test-runner-skill\ndescription: Test scripts\n---\nInstructions";
    const outside = path.join(dir, "outside"); writeFileSync(outside, "outside-canary");
    const script = `printf 'draft-receipt\\n'\nprintf 'stderr-note\\n' >&2\nif cat '${outside}'; then exit 9; fi\ncat references/value.txt\n`;
    skills.savePackage("test-runner-skill", { text, files: [{ path: "scripts/hello.sh", text: "echo published" }] });
    skills.saveDraft("test-runner-skill", { text, files: [{ path: "scripts/hello.sh", text: script }, { path: "references/value.txt", text: "supporting-file" }] });
    const result = await runSkillScript(skills, "test-runner-skill", "scripts/hello.sh", [], {
      binaryPath, enabled: () => true, authorized: () => true, scriptSha256: createHash("sha256").update(script).digest("hex"),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.source, "saved-draft"); assert.match(result.stdout, /draft-receipt/); assert.match(result.stdout, /supporting-file/);
    assert.doesNotMatch(result.stdout, /outside-canary|published/); assert.match(result.stderr, /stderr-note/);
    assert.equal(skills.fileText("test-runner-skill", "scripts/hello.sh").text, "echo published");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Skill Studio: evaluation uses the real selection contract and positive/negative expectations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-eval-"));
  try {
    const skills = new Skills(dir);
    skills.save("---\nname: fleet-telemetry\ndescription: Monitor vehicle fleet telemetry and route anomalies.\n---\nInstructions");
    skills.setEnabled("fleet-telemetry", true);
    const cases = [{ prompt: "Check vehicle fleet telemetry", expected: true }, { prompt: "Say ready", expected: false }];
    let requests = 0;
    const provider: import("@vak/providers").Provider = { id: "scripted", capabilities: { constrainedOutput: true }, async *stream(req) {
      assert.equal(req.model, "chosen-model");
      assert.match(req.system!, /Select enabled skills/);
      assert.ok(req.responseSchema?.properties?.names);
      yield { type: "text", delta: JSON.stringify({ names: requests++ === 0 ? ["fleet-telemetry"] : [] }) };
      yield { type: "done", stop: "end" };
    } };
    await assert.rejects(evaluateSkillPrompts(skills, "fleet-telemetry", cases), /Choose an available provider/);
    const results = await evaluateSkillPrompts(skills, "fleet-telemetry", cases, { provider, model: "chosen-model" });
    assert.equal(requests, 2);
    assert.ok(results.every(result => result.passed));
    assert.deepEqual(results.map(result => result.expected), [true, false]);
    skills.setEnabled("fleet-telemetry", false);
    await assert.rejects(evaluateSkillPrompts(skills, "fleet-telemetry", cases, { provider, model: "chosen-model" }), /Enable the published/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Skill Studio: tool hints use offered names without inventing sandbox aliases", async () => {
  const generated = await generateSkillPackage({ prompt: "Run shell script" }, ["run_command"]);
  assert.equal(generated.allowedTools, "read_skill_file run_command");
  const result = suggestSkillElement({ type: "tools", body: "Run sandbox script" }, [], ["run_command", "unrelated_tool"]);
  assert.equal(result.suggestion, "read_skill_file run_command");
  assert.doesNotMatch(result.suggestion, /sandbox_exec|unrelated_tool/);
});

test("Studio suggestions preserve explicit scope and use current chart/data contracts", async () => {
  const email = await generateSkillPackage({ prompt: "Draft a polite thank-you email" });
  assert.ok(email.body.includes("Draft a polite thank-you email"));
  assert.doesNotMatch(email.body, /Tier [123]|columns:|156,600|financial and revenue/);
  const chart = suggestSkillElement({ type: "chart", body: "Plot actual dated OHLC candlestick observations" });
  assert.equal(chart.suggestion, "candlestick");
  assert.ok(chart.options!.includes("candlestick"));
  assert.doesNotMatch(chart.rationale, /unsupported candlestick/);
  assert.doesNotMatch(suggestSkillElement({ type: "gist" }).suggestion, /156,600|4 active|0 unverified/);
  const reference = suggestSkillElement({ type: "research", query: "queue aging" });
  assert.doesNotMatch(reference.suggestion, /15%|30%|Threshold Tones/);
  assert.match(reference.rationale, /No external sources were read/);
});
