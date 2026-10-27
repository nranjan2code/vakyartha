import assert from "node:assert/strict";
import { BUILTIN_SKILLS } from "../sidecar/skills-builtin.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSkill, Skills } from "../sidecar/skills.ts";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { runAgent, ToolGenerationError, type Provider, type ProviderEvent } from "@vak/providers";

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

test("builtin updates require a current preview and preserve edits, removals and disabled state", () => {
  const d = dir(), manager = new Skills(d), name = "explain-simply";
  manager.setEnabled(name, false);
  const previous = "---\nname: explain-simply\ndescription: Previous default.\n---\nPrevious instructions.\n";
  writeFileSync(path.join(d, "skills", name, "SKILL.md"), previous);
  const upgraded = new Skills(d), preview = upgraded.view().find(skill => skill.name === name)!;
  assert.equal(preview.enabled, false); assert.equal(preview.body, "Previous instructions."); const update = preview.update; assert.ok(update);
  assert.throws(() => upgraded.updateBuiltin(name, "stale", update.currentFingerprint), /review/);
  upgraded.updateBuiltin(name, update.fingerprint, update.currentFingerprint);
  assert.equal(upgraded.view().find(skill => skill.name === name)!.enabled, false);
  assert.equal(upgraded.view().find(skill => skill.name === name)!.update, undefined);
  assert.equal(readFileSync(path.join(d, "skills", name, "SKILL.md"), "utf8"), BUILTIN_SKILLS.find(skill => skill.includes("name: explain-simply\n")));
  const custom = previous.replace("Previous instructions.", "My instructions."); upgraded.save(custom, name);
  const pending = upgraded.view().find(skill => skill.name === name)!.update!;
  assert.equal(new Skills(d).view().find(skill => skill.name === name)!.body, "My instructions.");
  upgraded.save(custom.replace("My instructions.", "Changed after preview."), name);
  assert.throws(() => upgraded.updateBuiltin(name, pending.fingerprint, pending.currentFingerprint), /review/);
  upgraded.remove(name); assert.ok(!new Skills(d).view().some(skill => skill.name === name));
});

test("only enabled skills reach the prompt and the loader tool", async () => {
  const s = new Skills(dir());
  for (const b of s.view()) s.remove(b.name);
  s.save(SKILL);
  assert.equal(s.index(), ""); assert.equal(s.tool(), undefined);
  s.setEnabled("weekly-report", true);
  assert.match(s.index(), /weekly-report: Use when/);
  const tool = s.tool()!;
  assert.match(String(await tool.execute({ names: ["weekly-report"] }, {})), /Summarise the week/);
  assert.match(String(await tool.execute({ names: [] }, {})), /No skill selected/);
  assert.throws(() => tool.execute({ names: ["other"] }, {}));
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

test("skill selection precedes answer tools inside the existing counted loop", async () => {
  const skills = new Skills(dir()); let requests = 0;
  const provider: Provider = { id: "scripted", capabilities: { constrainedOutput: true }, async *stream(req) {
    requests++;
    if (requests === 1) {
      assert.equal(req.tools, undefined); assert.ok(req.responseSchema);
      assert.ok(!req.system?.includes("Components ("));
      yield { type: "text", delta: JSON.stringify({ names: ["assistant", "interactive-ui"] }) };
      yield { type: "done", stop: "end", usage: { input: 7, output: 3 } }; return;
    }
    assert.ok(req.tools?.some(t => t.name === "vak_render"));
    assert.ok(req.messages.some(m => m.role === "tool" && m.content.includes("Skill interactive-ui instructions:")));
    yield { type: "text", delta: "Ready" }; yield { type: "done", stop: "end" };
  } };
  const messages = [{ role: "user" as const, content: "Build an interactive chart" }];
  const result = await runAgent({ provider: skills.provider(provider), model: "test", store: new SurfaceStore(basicCatalog), messages, instructions: skills.index(), tools: [skills.tool()!], maxSteps: 2, toolRounds: 0, emit: () => {} });
  assert.equal(result.stop, "end"); assert.equal(requests, 2);
});

test("selection preserves transactional wire shape and explicit no-match", async () => {
  const skills = new Skills(dir()); let calls = 0;
  const provider: Provider = { id: "scripted", capabilities: { constrainedOutput: true }, async *stream(req) {
    calls++; assert.equal(req.tools, undefined);
    assert.equal(req.responseSchema?.properties?.tool?.const, "use_skill");
    yield { type: "text", delta: '{"tool":"use_skill","arguments":{"names":[]}}' }; yield { type: "done", stop: "end" };
  } };
  const request = { model: "test", system: skills.index(), messages: [{ role: "user" as const, content: "Hello" }], responseSchema: { type: "object" as const } };
  const events = [];
  for await (const e of skills.provider(provider).stream(request)) events.push(e);
  assert.equal(calls, 1); assert.equal(events[0]?.type, "text");
  assert.deepEqual(request.responseSchema, { type: "object" });
  assert.match(String(await skills.tool()!.execute({ names: [] }, {})), /No skill selected/);
});

test("native selection cannot dispatch an answer or external call first", async () => {
  const skills = new Skills(dir());
  const provider: Provider = { id: "scripted", async *stream(req) {
    assert.deepEqual(req.tools?.map(t => t.name), ["use_skill"]);
    yield { type: "tool_start", id: "bad", name: "external_write" };
    yield { type: "done", stop: "tool_use" };
  } };
  const visible: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const e of skills.provider(provider).stream({ model: "test", system: skills.index(), messages: [] })) visible.push(e); }, /Select skills before answering/);
  assert.deepEqual(visible, []);
});

test("unrelated provider uses bypass selection and cancelled selection dispatches nothing", async () => {
  const skills = new Skills(dir()), ctrl = new AbortController(); let calls = 0;
  const provider: Provider = { id: "scripted", capabilities: { constrainedOutput: true }, async *stream(req) {
    calls++;
    if (!req.responseSchema) { yield { type: "text", delta: "Unrelated resolver" }; return; }
    yield { type: "text", delta: '{"names":["interactive-ui"]}' };
    ctrl.abort(); yield { type: "done", stop: "end" };
  } };
  const events = [];
  for await (const e of skills.provider(provider).stream({ model: "test", messages: [] })) events.push(e);
  assert.equal(events.length, 1);
  const visible: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const e of skills.provider(provider).stream({ model: "test", system: skills.index(), messages: [], signal: ctrl.signal })) visible.push(e); });
  assert.equal(calls, 2); assert.deepEqual(visible, []);
});

test("a failed selection cannot unlock answer tools on a retry", async () => {
  const skills = new Skills(dir()); let calls = 0;
  const provider: Provider = { id: "scripted", async *stream(req) {
    assert.deepEqual(req.tools?.map(t => t.name), ["use_skill"]);
    if (++calls === 1) throw new ToolGenerationError("scripted", "syntax rejected");
    yield { type: "tool_start", id: "selection", name: "use_skill" };
    yield { type: "tool_args", id: "selection", delta: '{"names":[]}' };
    yield { type: "tool_end", id: "selection" }; yield { type: "done", stop: "tool_use" };
  } };
  const wrapped = skills.provider(provider), request = { model: "test", system: skills.index(), messages: [] };
  await assert.rejects(async () => { for await (const _ of wrapped.stream(request)) { /* consume */ } }, /syntax rejected/);
  const events = []; for await (const e of wrapped.stream(request)) events.push(e);
  assert.equal(calls, 2); assert.equal(events[0]?.type, "tool_start");
});
