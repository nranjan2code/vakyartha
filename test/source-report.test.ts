import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { basicCatalog, SurfaceStore } from "@vak/core";
import { createHost } from "@vak/host";
import { ProfileCache, type Provider } from "@vak/providers";
import { Tasks } from "../sidecar/tasks.ts";
import { TaskFiles, digest } from "../sidecar/task-files.ts";

test("generic authored records, controls and output receipts survive a revised criterion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-source-report-"));
  let requests = 0;
  const provider: Provider = { id: "scripted", async *stream(request) {
    const cap = requests++ ? 20 : 50;
    assert.ok(request.system!.includes("Coffee,4,2.5"), "selected snapshots remain available as untrusted data");
    assert.ok(request.tools!.some(tool => tool.name === "vak_submit"));
    assert.ok(!request.tools!.some(tool => /derive|prepare_table/.test(tool.name)), "no specialized preparation tools");
    const name = "vak_submit";
    // Scripted authoring proves the ordinary transaction/task receipt path;
    // arithmetic correctness of a real provider is evaluated independently.
    const args = { surfaces: [
      { op: "replace", surface: "criteria", data: { criteria: { cap } }, root: { type: "form", props: { submit: "apply" }, children: [{ type: "input", props: { label: "Cap", kind: "number", bind: "/criteria/cap" } }] } },
      { op: "replace", surface: "report", data: { records: [
        { item: "Coffee", units: 4, rate: 2.5, amount: 10 }, { item: "Tea", units: 3, rate: 6, amount: 18 },
        { item: "All items", units: "Not applicable", rate: "Not applicable", amount: 28 },
      ] }, root: { type: "stack", children: [
        { type: "text", props: { content: `Available cap: ${cap}. Remaining cap: ${cap - 28}. Within cap: ${cap >= 28 ? "yes" : "no"}.` } },
        { type: "text", props: { content: "drinks.csv / notes.md — Fictional captured data. Freshness unverified." } },
        { type: "table", props: { columns: ["item", "units", "rate", "amount"], rows: { records: "{/records}", fields: ["item", "units", "rate", "amount"] } } },
      ] } },
    ] };
    yield { type: "tool_start", id: `step-${requests}`, name };
    yield { type: "tool_args", id: `step-${requests}`, delta: JSON.stringify(args) };
    yield { type: "tool_end", id: `step-${requests}` }; yield { type: "done", stop: "tool_use" };
  } };
  const files = new TaskFiles(path.join(dir, "outputs"), path.join(dir, "transcripts"));
  const host = createHost({ providers: () => [{ id: "scripted", label: "Scripted", available: true, make: () => provider }], profiles: new ProfileCache(path.join(dir, "profiles.json")), instructions: "test", sessionsDir: path.join(dir, "sessions"), log: () => {} });
  const tasks = await Tasks.open({ dir: path.join(dir, "tasks"), files, run: host.run, view: host.view, tools: async () => [], instructions: () => "test", observe: async (_session, work) => work(), ready: () => {}, warn: () => {} });
  const wait = async (id: string) => {
    const end = Date.now() + 5000;
    while (["queued", "running"].includes(tasks.get(id).state)) { if (Date.now() > end) throw new Error("Source report did not finish"); await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(tasks.get(id).state, "needs_input");
  };
  try {
    const task = await tasks.create({ goal: "Show the selected source with amount=units*rate and compare its total with cap", criteria: "Separate editable criteria and source report; all source facts preserved", provider: "scripted", model: "fake", integrations: [], spending: { kind: "local_only" }, output: { kind: "markdown" }, inputs: [{ name: "drinks.csv", content: "item,units,rate\nCoffee,4,2.5\nTea,3,6\n" }, { name: "notes.md", content: "Fictional captured data. Freshness unverified." }], resultPolicy: { kind: "comparison", labels: ["Coffee", "Tea", "All items"], notices: ["Fictional"], initialValues: { "/criteria/cap": 50 } } });
    await wait(task.id);
    for (const [index, cap] of [50, 20].entries()) {
      const view = await host.view(task.id), saved = tasks.get(task.id);
      assert.equal(requests, index + 1);
      assert.deepEqual(view.surfaces.map((surface) => surface.id), ["criteria", "report"]);
      assert.deepEqual(view.surfaces[0]!.data, { criteria: { cap } });
      const store = new SurfaceStore(basicCatalog); view.surfaces.forEach(surface => store.load(surface));
      const table = store.resolve("report")!.root!.children.find(node => node.type === "table")!;
      assert.deepEqual(table.props!.rows, [["Coffee", 4, 2.5, 10], ["Tea", 3, 6, 18], ["All items", "Not applicable", "Not applicable", 28]]);
      const receipt = saved.runHistory.at(-1)!.output!;
      assert.equal(receipt.state, "saved");
      const markdown = await readFile(path.join(files.outputsDir, receipt.filename), "utf8");
      assert.equal(Buffer.byteLength(markdown), receipt.bytes); assert.equal(digest(markdown), receipt.sha256);
      assert.ok(markdown.includes(`Available cap: ${cap}. Remaining cap: ${cap - 28}. Within cap: ${cap >= 28 ? "yes" : "no"}.`));
      assert.ok(markdown.includes("drinks.csv") && markdown.includes("notes.md") && markdown.includes("Freshness unverified"));
      assert.ok(saved.runHistory.every((run) => run.review === undefined));
      assert.equal(saved.state, "needs_input");
      if (!index) { await tasks.input(task.id, { id: "new-cap", revision: view.surfaces[0]!.version, action: { surface: "criteria", source: "root", data: { criteria: { cap: 20 } } } }); await wait(task.id); }
    }
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});
