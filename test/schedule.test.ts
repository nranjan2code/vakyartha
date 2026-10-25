import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Tasks } from "../sidecar/tasks.ts";
import { parseSchedule, scheduleLabel } from "../schedule.ts";
import { parseTaskView } from "../task-contract.ts";

const schedule = (ms: number) => ({ kind: "once", at: new Date(Date.now() + ms).toISOString(), timezone: "Asia/Kolkata", status: "armed", missed: "review" });
const input = { goal: "Synthetic scheduled work", criteria: "Review result", provider: "local", model: "fake", integrations: [] };
async function ready(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("Schedule did not reach expected state");
}
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "vak-schedule-"));
  const calls: string[] = [];
  const deps = { dir, run: async (turn: { session: string }) => { calls.push(turn.session); return { stop: "end" }; }, view: async (id: string) => ({ id, title: "", updated: "", timeline: [], surfaces: [] }), tools: async () => [], instructions: () => "", observe: async (_id: string, work: () => Promise<void>) => work(), ready: () => {}, warn: () => {} };
  return { dir, calls, deps, tasks: await Tasks.open(deps) };
}

test("one-time trigger waits without model work, dispatches once through the existing queue and remains reviewable", async () => {
  const { dir, calls, tasks } = await setup();
  try {
    const t = await tasks.create({ ...input, schedule: schedule(150) });
    assert.equal(t.state, "scheduled"); assert.equal(t.runs, 0); assert.deepEqual(calls, []);
    await ready(() => tasks.get(t.id).state === "needs_input");
    assert.deepEqual(calls, [t.id]); assert.equal(tasks.get(t.id).schedule?.status, "dispatched");
    await new Promise((r) => setTimeout(r, 100)); assert.equal(calls.length, 1);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("pause, resume, reschedule and Run now enforce revisions and cannot take over active work", async () => {
  const { dir, calls, tasks } = await setup();
  try {
    let t = await tasks.create({ ...input, schedule: schedule(60_000) });
    await assert.rejects(tasks.changeSchedule(t.id, { operation: "pause", revision: -1 }), /changed/);
    t = await tasks.changeSchedule(t.id, { operation: "pause", revision: t.revision });
    assert.equal(t.state, "paused"); assert.equal(calls.length, 0);
    await assert.rejects(tasks.input(t.id, { id: "bypass", message: "Run early" }), /Run now/);
    t = await tasks.changeSchedule(t.id, { operation: "resume", revision: t.revision });
    assert.equal(t.state, "scheduled");
    t = await tasks.changeSchedule(t.id, { operation: "reschedule", revision: t.revision, schedule: schedule(90_000) });
    t = await tasks.changeSchedule(t.id, { operation: "run", revision: t.revision });
    await ready(() => tasks.get(t.id).state === "needs_input");
    assert.equal(calls.length, 1);
    await assert.rejects(tasks.changeSchedule(t.id, { operation: "run", revision: tasks.get(t.id).revision }), /upcoming or paused|active work/);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("future schedules survive restart; past due triggers pause instead of replaying work", async () => {
  const setupResult = await setup(), { dir, deps, calls } = setupResult;
  let tasks = setupResult.tasks;
  try {
    const t = await tasks.create({ ...input, schedule: schedule(90_000) });
    await tasks.close(); tasks = await Tasks.open(deps);
    assert.equal(tasks.get(t.id).state, "scheduled"); assert.equal(calls.length, 0);
    await tasks.close();
    const file = path.join(dir, `${t.id}.json`), saved = parseTaskView(JSON.parse(await readFile(file, "utf8")));
    saved.schedule!.at = new Date(Date.now() - 5000).toISOString(); await writeFile(file, JSON.stringify(saved));
    tasks = await Tasks.open(deps);
    const paused = tasks.get(t.id); assert.equal(paused.state, "paused"); assert.match(paused.note, /missed/); assert.equal(calls.length, 0);
    await assert.rejects(tasks.changeSchedule(t.id, { operation: "resume", revision: paused.revision }), /time has passed/);
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});

test("invalid schedules fail closed; cancelling or deleting upcoming work prevents dispatch", async () => {
  assert.throws(() => parseSchedule({ ...schedule(10_000), timezone: "Unreal/Zone" }));
  assert.throws(() => parseSchedule({ ...schedule(10_000), kind: "daily" }));
  assert.match(scheduleLabel(parseSchedule(schedule(10_000))), /Asia\/Kolkata/);
  const { dir, calls, tasks } = await setup();
  try {
    await assert.rejects(tasks.create({ ...input, schedule: schedule(-100) }), /future/);
    const t = await tasks.create({ ...input, schedule: schedule(100) });
    await tasks.cancel(t.id); await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 0); assert.equal(tasks.get(t.id).state, "cancelled");
  } finally { await tasks.close(); await rm(dir, { recursive: true, force: true }); }
});
