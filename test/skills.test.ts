import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSkill, Skills } from "../sidecar/skills.ts";

const SKILL = "---\nname: weekly-report\ndescription: Use when the user asks for a weekly report.\n---\n\nSummarise the week, then load skill chart-style.\n";
const dir = () => mkdtempSync(path.join(tmpdir(), "vak-skills-"));

test("parses frontmatter and rejects invalid skills", () => {
  assert.equal(parseSkill(SKILL).name, "weekly-report");
  assert.throws(() => parseSkill("no frontmatter"));
  assert.throws(() => parseSkill(SKILL.replace("weekly-report", "Bad Name")));
});

test("built-ins are planted on, once; a removed one stays removed", () => {
  const d = dir();
  const s = new Skills(d);
  const builtins = s.view().filter(x => x.builtin);
  assert.ok(builtins.length >= 10 && builtins.every(x => x.enabled));
  s.remove("plan-my-day");
  assert.ok(!new Skills(d).view().some(x => x.name === "plan-my-day"));
});

test("only enabled skills reach the prompt and the loader tool", async () => {
  const s = new Skills(dir());
  for (const b of s.view()) s.remove(b.name);
  s.save(SKILL);
  assert.equal(s.index(), ""); assert.equal(s.tool(), undefined);
  s.setEnabled("weekly-report", true);
  assert.match(s.index(), /weekly-report: Use when/);
  const tool = s.tool()!;
  assert.match(String(await tool.execute({ name: "weekly-report" }, {})), /Summarise the week/);
  assert.match(String(await tool.execute({ name: "other" }, {})), /No enabled skill/);
  s.remove("weekly-report"); assert.equal(s.view().length, 0);
});

test("catalog adds exactly the reviewed text, pinned and off", async () => {
  const sha = "a".repeat(40);
  const fetcher = (async (url: string) => {
    const body = url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "skills/weekly-report/SKILL.md", type: "blob" }, { path: "skills/weekly-report/run.sh", type: "blob" }] }) : SKILL;
    assert.ok(!url.includes("raw") || url.includes(sha));
    return new Response(body);
  }) as typeof fetch;
  const s = new Skills(dir(), fetcher);
  for (const b of s.view()) s.remove(b.name);
  const [item] = await s.search("owner/repo");
  const r = await s.review("owner/repo", item!.path);
  assert.deepEqual(r.extraFiles, ["run.sh"]);
  assert.throws(() => s.add(r.fingerprint, false));
  assert.equal(s.add(r.fingerprint, true), "weekly-report");
  const [saved] = s.view();
  assert.equal(saved!.enabled, false); assert.equal(saved!.source!.sha, sha);
  assert.throws(() => s.add(r.fingerprint, true));
});
