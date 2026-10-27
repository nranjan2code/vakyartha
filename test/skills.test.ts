import assert from "node:assert/strict";
import { BUILTIN_SKILLS } from "../sidecar/skills-builtin.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.throws(() => parseSkill(SKILL.replace("weekly-report", "weekly--report")));
  assert.throws(() => parseSkill(SKILL.replace("weekly-report", "weekly-report-")));
  assert.equal(parseSkill("---\nname: weekly-report\ndescription: >\n  Use when making\n  a weekly report.\ncompatibility: Requires a local document tool\n---\nSteps.\n").description, "Use when making a weekly report.");
  assert.equal(parseSkill("---\nname: weekly-report\ndescription: Use on request.\ncompatibility: Requires a local document tool\n---\nSteps.\n").compatibility, "Requires a local document tool");
});

test("built-ins are planted on, once; a removed one stays removed", () => {
  const d = dir();
  const s = new Skills(d);
  const builtins = s.view().filter(x => x.builtin);
  assert.ok(builtins.length >= 10 && builtins.every(x => x.enabled));
  const required = builtins.find(x => x.name === "surface-design")!;
  assert.equal(required.required, true);
  assert.throws(() => s.setEnabled("surface-design", false), /required/);
  assert.throws(() => s.remove("surface-design"), /required/);
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

test("required surface-design is restored and re-enabled from older saved state", () => {
  const d = dir();
  const manager = new Skills(d);
  manager.setEnabled("surface-design", true);
  const statePath = path.join(d, "skills", "skills.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state["surface-design"].enabled = false;
  writeFileSync(statePath, JSON.stringify(state));
  const restored = new Skills(d).view().find(skill => skill.name === "surface-design")!;
  assert.equal(restored.enabled, true);
  assert.equal(restored.required, true);
  state["surface-design"].builtin = false;
  writeFileSync(statePath, JSON.stringify(state));
  const reinstalled = new Skills(d).view().find(skill => skill.name === "surface-design")!;
  assert.equal(reinstalled.builtin, true);
  assert.equal(reinstalled.body, parseSkill(BUILTIN_SKILLS.find(text => text.includes("name: surface-design\n"))!).body);
});

test("only enabled skills reach the prompt and the loader tool", async () => {
  const s = new Skills(dir());
  for (const b of s.view()) if (!b.required) s.remove(b.name);
  s.save(SKILL);
  assert.match(s.index(), /surface-design: Design visual/); assert.ok(s.tool());
  s.setEnabled("surface-design", true);
  s.setEnabled("weekly-report", true);
  assert.match(s.index(), /weekly-report: Use when/);
  const tool = s.tool()!;
  assert.match(String(await tool.execute({ names: ["weekly-report"] }, {})), /Summarise the week/);
  assert.match(String(await tool.execute({ names: [] }, {})), /No skill selected/);
  assert.throws(() => tool.execute({ names: ["other"] }, {}));
  s.remove("weekly-report"); assert.deepEqual(s.view().map(skill => skill.name), ["surface-design"]);
});

test("catalog adds exactly the reviewed text, pinned and off", async () => {
  const sha = "a".repeat(40);
  const fetcher = (async (url: string) => {
    const body = url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "skills/weekly-report/SKILL.md", type: "blob" }, { path: "skills/weekly-report/run.sh", type: "blob" }] }) : SKILL;
    assert.ok(!url.includes("raw") || url.includes(sha));
    return new Response(body);
  }) as typeof fetch;
  const s = new Skills(dir(), fetcher);
  for (const b of s.view()) if (!b.required) s.remove(b.name);
  const [item] = await s.search("owner/repo");
  const r = await s.review("owner/repo", item!.path);
  assert.deepEqual(r.files.map(f => [f.path, f.status]), [["run.sh", "script"]]);
  assert.throws(() => s.add(r.fingerprint, false));
  assert.equal(s.add(r.fingerprint, true), "weekly-report");
  const saved = s.view().find(skill => skill.name === "weekly-report")!;
  assert.equal(saved.enabled, false); assert.equal(saved.source!.sha, sha);
  assert.throws(() => s.add(r.fingerprint, true));
});

test("required surface-design guidance is injected for authoring requests", async () => {
  const skills = new Skills(dir());
  const provider: Provider = { id: "scripted", async *stream(req) {
    assert.match(req.system ?? "", /Required surface-design guidance/);
    assert.match(req.system ?? "", /Before finalizing, check that a chart/);
    yield { type: "text", delta: "ok" };
  } };
  for await (const _event of skills.provider(provider).stream({ model: "test", messages: [], tools: [{ name: "vak_render", description: "", inputSchema: { type: "object" } }] })) { /* consume */ }
  let plainSystem = "plain";
  const plain: Provider = { id: "plain", async *stream(req) { plainSystem = req.system ?? ""; yield { type: "text", delta: "ok" }; } };
  for await (const _event of skills.provider(plain).stream({ model: "test", messages: [], system: "plain" })) { /* consume */ }
  assert.equal(plainSystem, "plain");
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


test("changing enabled skills cannot bypass selection for an already prepared run", async () => {
  const skills = new Skills(dir()); let requests = 0;
  const provider: Provider = { id: "fake", async *stream() { requests++; yield { type: "done", stop: "end" }; } };
  const request = { model: "fake", system: skills.index(), messages: [{ role: "user" as const, content: "Hello" }] };
  skills.setEnabled("interactive-ui", false);
  await assert.rejects(async () => { for await (const _ of skills.provider(provider).stream(request)) {} }, /Enabled skills changed/);
  assert.equal(requests, 0);
});

test("root skills disclose supporting files that will not be installed", async () => {
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha: "a".repeat(40) }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "SKILL.md", type: "blob" }, { path: "references/guide.md", type: "blob" }] }) : SKILL)) as typeof fetch;
  const skills = new Skills(dir(), fetcher);
  const review = await skills.review("owner/repo", "");
  assert.deepEqual(review.files.map(f => f.path), ["references/guide.md"]);
});

test("review classifies files, binds bytes, stores exactly reviewed text and checks integrity", async () => {
  const sha = "b".repeat(40), data = dir();
  const items = [
    { path: "SKILL.md", type: "blob", size: SKILL.length },
    { path: "palette.md", type: "blob", size: 18 },
    { path: "run.py", type: "blob", size: 10 },
    { path: "photo.png", type: "blob", size: 10 },
    { path: "huge.md", type: "blob", size: 300 * 1024 },
    { path: "bad.txt", type: "blob", size: 2 },
    { path: "../escape.md", type: "blob", size: 4 },
    { path: "a//b.md", type: "blob", size: 4 },
  ];
  let palette = "red: #f00\n";
  const fetcher = (async (url: string) => {
    if (url.includes("/commits?")) return new Response(JSON.stringify([{ sha }]));
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: items }));
    assert.ok(url.includes(sha));
    if (url.endsWith("/SKILL.md")) return new Response(SKILL);
    if (url.endsWith("/palette.md")) return new Response(palette);
    if (url.endsWith("/bad.txt")) return new Response(new Uint8Array([0xff, 0xfe]));
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const skills = new Skills(data, fetcher);
  const first = await skills.review("owner/repo", "");
  assert.deepEqual(Object.fromEntries(first.files.map(f => [f.path, f.status])), { "../escape.md": "unsupported", "a//b.md": "unsupported", "bad.txt": "not-text", "huge.md": "too-large", "palette.md": "added", "photo.png": "unsupported", "run.py": "script" });
  assert.equal(skills.reviewFile(first.fingerprint, "palette.md"), palette);
  assert.throws(() => skills.reviewFile(first.fingerprint, "run.py"), /Unknown/);
  palette = "blue: #00f\n";
  const second = await skills.review("owner/repo", "");
  assert.notEqual(first.fingerprint, second.fingerprint);
  skills.add(first.fingerprint, true);
  assert.equal(skills.view().find(s => s.name === "weekly-report")?.omitted?.length, 6);
  assert.equal(skills.fileText("weekly-report", "palette.md").text, "red: #f00\n");
  assert.throws(() => skills.fileText("weekly-report", "../skills.json"), /Unknown file/);
  const file = path.join(data, "skills", "weekly-report", "files", "palette.md");
  writeFileSync(file, "tampered");
  assert.throws(() => skills.fileText("weekly-report", "palette.md"), /changed on disk/);
  skills.remove("weekly-report");
  assert.equal(existsSync(file), false);
});

test("catalog subdirectory name follows the skill directory", async () => {
  const sha = "e".repeat(40);
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "skills/other/SKILL.md", type: "blob", size: SKILL.length }] }) : SKILL)) as typeof fetch;
  const skills = new Skills(dir(), fetcher);
  const review = await skills.review("owner/repo", "skills/other");
  assert.match(review.blocked ?? "", /parent directory/);
  assert.throws(() => skills.add(review.fingerprint, true), /parent directory/);
});

test("loaded skill files are scoped to one tool list and can be paged", async () => {
  const sha = "c".repeat(40), data = dir(), long = `${"x".repeat(100)}\n`.repeat(400);
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "SKILL.md", type: "blob", size: SKILL.length }, { path: "PALETTE.md", type: "blob", size: long.length }] }) : url.endsWith("/SKILL.md") ? SKILL : long)) as typeof fetch;
  const skills = new Skills(data, fetcher), review = await skills.review("owner/repo", ""); skills.add(review.fingerprint, true); skills.setEnabled("weekly-report", true);
  const [use, read] = skills.tools(); assert.ok(use && read);
  const before = await read.execute({ skill: "weekly-report", path: "palette.md" }, {});
  assert.match(JSON.stringify(before), /Load weekly-report/);
  await use.execute({ names: ["weekly-report"] }, {});
  let offset = 0, combined = "";
  for (;;) {
    const result = String(await read.execute({ skill: "weekly-report", path: "./palette.md", offset }, {}));
    const next = /\(characters \d+–(\d+) of \d+\)\n/.exec(result); assert.ok(next);
    const end = Number(next[1]);
    const payload = result.slice(result.indexOf("\n") + 1).replace(/\nMore: call again with offset \d+$/, "");
    combined += payload; if (end === long.length) break; offset = end;
  }
  assert.equal(combined, long);
  const other = skills.tools()[1]!;
  assert.match(JSON.stringify(await other.execute({ skill: "weekly-report", path: "PALETTE.md" }, {})), /Load weekly-report/);
  skills.save(SKILL.replace("Summarise the week", "New instructions"), "weekly-report");
  assert.equal(skills.view().find(s => s.name === "weekly-report")?.files?.length, 1);
  skills.save(SKILL.replaceAll("weekly-report", "renamed-report"), "weekly-report");
  assert.equal(skills.fileText("renamed-report", "PALETTE.md").text, long);
});

test("review enforces the count and total byte limits", async () => {
  const sha = "d".repeat(40), payload = "x".repeat(50_000);
  const tree = [{ path: "SKILL.md", type: "blob", size: SKILL.length }, ...Array.from({ length: 55 }, (_, n) => ({ path: `f${String(n).padStart(2, "0")}.md`, type: "blob", size: payload.length }))];
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree }) : url.endsWith("/SKILL.md") ? SKILL : payload)) as typeof fetch;
  const review = await new Skills(dir(), fetcher).review("owner/repo", "");
  assert.equal(review.files.filter(f => f.status === "added").length, 41);
  assert.equal(review.files.filter(f => f.status === "over-limit").length, 14);
});

test("invalid text does not consume a stored-file slot", async () => {
  const sha = "a".repeat(40);
  const tree = [{ path: "SKILL.md", type: "blob", size: SKILL.length }, ...Array.from({ length: 55 }, (_, n) => ({ path: `f${String(n).padStart(2, "0")}.md`, type: "blob", size: 4 }))];
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree }) : url.endsWith("/SKILL.md") ? SKILL : url.endsWith("/f00.md") ? new Uint8Array([0xff]) : "text")) as typeof fetch;
  const review = await new Skills(dir(), fetcher).review("owner/repo", "");
  assert.equal(review.files.find(f => f.path === "f00.md")?.status, "not-text");
  assert.equal(review.files.filter(f => f.status === "added").length, 50);
  assert.equal(review.files.filter(f => f.status === "over-limit").length, 4);
});

test("a write failure during add leaves no skill or manifest entry", async () => {
  const sha = "f".repeat(40), data = dir();
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "SKILL.md", type: "blob", size: SKILL.length }, { path: "a.md", type: "blob", size: 4 }, { path: "a.md/child.md", type: "blob", size: 4 }] }) : url.endsWith("/SKILL.md") ? SKILL : "text")) as typeof fetch;
  const skills = new Skills(data, fetcher), review = await skills.review("owner/repo", "");
  assert.throws(() => skills.add(review.fingerprint, true));
  assert.equal(skills.view().some(s => s.name === "weekly-report"), false);
  assert.equal(existsSync(path.join(data, "skills", "weekly-report")), false);
  assert.equal(existsSync(path.join(data, "skills", "weekly-report.partial")), false);
  assert.equal(JSON.parse(readFileSync(path.join(data, "skills", "skills.json"), "utf8"))["weekly-report"], undefined);
});

test("adding a catalog skill never removes an untracked folder with the same name", async () => {
  const sha = "a".repeat(40), data = dir();
  const fetcher = (async (url: string) => new Response(url.includes("/commits?") ? JSON.stringify([{ sha }]) : url.includes("/git/trees/") ? JSON.stringify({ tree: [{ path: "SKILL.md", type: "blob", size: SKILL.length }] }) : SKILL)) as typeof fetch;
  const skills = new Skills(data, fetcher), review = await skills.review("owner/repo", "");
  const folder = path.join(data, "skills", "weekly-report"); mkdirSync(folder);
  writeFileSync(path.join(folder, "note.txt"), "keep");
  assert.throws(() => skills.add(review.fingerprint, true), /folder named/);
  assert.equal(readFileSync(path.join(folder, "note.txt"), "utf8"), "keep");
});
