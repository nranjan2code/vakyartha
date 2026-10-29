import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { runAgent, type ChatRequest, type Provider } from "@vak/providers";
import { Skills } from "../sidecar/skills.ts";

for (const transactional of [false, true]) test(`current skills arrive once and required design survives decoding, transactional=${transactional}`, async () => {
  const dir = mkdtempSync(tmpdir() + "/vak-prompt-test-");
  try {
    const skills = new Skills(dir), requests: ChatRequest[] = [];
    const design = skills.view().find(skill => skill.required)!.body;
    const instructions = skills.view().find(skill => skill.name === "interactive-ui")!.body;
    const raw: Provider = { id: "scripted", capabilities: { constrainedOutput: true }, async *stream(req) {
      requests.push(structuredClone(req));
      if (requests.length > 1) throw new Error("capture complete");
      const names = ["assistant", "interactive-ui", "surface-design"];
      assert.match(req.messages[0]!.content, /TASK_CRITERIA_SENTINEL/);
      assert.match(req.messages[0]!.content, /the proposed form/);
      assert.ok(!req.messages[0]!.content.includes("Components ("), "selector must not copy the authoring catalog");
      yield { type: "text", delta: JSON.stringify(transactional ? { tool: "use_skill", arguments: { names } } : { names }) };
      yield { type: "done", stop: "end" };
    } };
    const result = await runAgent({ provider: skills.provider(raw), model: "test", store: new SurfaceStore(basicCatalog), messages: [{ role: "assistant", content: "Use the proposed form" }, { role: "user", content: "Do that" }], instructions: "TASK_CRITERIA_SENTINEL\n" + skills.index(), tools: skills.tools(), maxSteps: 2, toolResultChars: 16, ...(transactional ? { surfaceSubmission: true, completion: "response" as const } : {}), emit: () => {} });
    assert.equal(result.stop, "error");
    assert.equal(requests.length, 2);
    const request = requests[1]!;
    assert.equal(request.system!.split(design).length - 1, 1);
    assert.ok(request.system!.includes(instructions));
    assert.ok(!request.messages.some(message => message.content.includes(instructions)));
    assert.doesNotMatch(request.system!, /nodes` is a flat list|Tier 1|font-weight/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overlarge multi-skill selection does not unlock supporting files", () => {
  const dir = mkdtempSync(tmpdir() + "/vak-prompt-limit-");
  try {
    const skills = new Skills(dir);
    for (const name of ["large-first", "large-second"]) {
      skills.savePackage(name, { text: `---\nname: ${name}\ndescription: Large reviewed procedure\n---\n${"x".repeat(32000)}`, files: [{ path: "reference.md", text: "reference" }] });
      skills.setEnabled(name, true);
    }
    const [use, read] = skills.tools();
    assert.throws(() => use!.execute({ names: ["large-first", "large-second"] }, {}), /load fewer skills/);
    assert.match(JSON.stringify(read!.execute({ skill: "large-first", path: "reference.md" }, {})), /Load large-first/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
