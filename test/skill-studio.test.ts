import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
allowed-tools: sandbox_exec read_skill_file
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

test("Skill Studio: YOLO package generator synthesizes a valid Agent Skills package", async () => {
  const generated = await generateSkillPackage(
    { prompt: "Customer Churn and Retention Risk Analysis" },
    ["sandbox_exec", "brave_search", "filesystem"]
  );

  assert.ok(generated.name.includes("customer-churn"));
  assert.ok(generated.description.length > 20);
  assert.ok(generated.description.length <= 1024);
  assert.ok(generated.body.includes("3-Tier liquid layout architecture"));
  assert.ok(generated.allowedTools?.includes("sandbox_exec"));
  assert.ok(generated.files.some(f => f.path.startsWith("references/")));
  assert.ok(generated.files.some(f => f.path.startsWith("schemas/")));
  assert.ok(generated.files.some(f => f.path.startsWith("scripts/")));
  assert.ok(generated.files.some(f => f.path.startsWith("tests/")));
});

test("Skill Studio: smart element suggestions advise triggers, charts, and bindings", () => {
  const trigger = suggestSkillElement({
    type: "trigger",
    name: "cloud-spend-monitor",
    description: "monitor cloud",
  }, []);
  assert.ok(trigger.suggestion.includes("cloud spend monitor"));
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

test("Skill Studio: sandbox script runner executes Python and captures output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-sandbox-"));
  try {
    const skills = new Skills(dir);
    const text = `---
name: test-runner-skill
description: Run test scripts
---
Instructions
`;
    const files = [
      { path: "scripts/hello.py", text: "import sys\nprint('hello from sandbox python')\nsys.stderr.write('logged note\\n')\n" }
    ];
    skills.savePackage("test-runner-skill", { text, files });

    const res = await runSkillScript(skills, "test-runner-skill", "scripts/hello.py");
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes("hello from sandbox python"));
    assert.ok(res.stderr.includes("logged note"));
    assert.ok(res.durationMs >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill Studio: evaluation harness checks prompt matching", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-studio-eval-"));
  try {
    const skills = new Skills(dir);
    const text = `---
name: fleet-telemetry
description: Monitor vehicle fleet telemetry, fuel efficiency, and route anomalies.
---
Instructions
`;
    skills.save(text);

    const results = await evaluateSkillPrompts(
      skills,
      "fleet-telemetry",
      [
        "Check vehicle fleet telemetry anomalies and fuel use",
        "How is the weather in Miami today?"
      ]
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.passed, true);
    assert.equal(results[1]?.passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
