import { checkTaskResult, parseTaskResultPolicy, resultInstructions, reviewTaskResult } from "../shared/task-result.ts";
import { reviseComparisonCriteria } from "../shared/comparison-contract.ts";
import type { ResearchRead } from "../shared/research-contract.ts";
import { parseTaskFiles, parseTaskOutput, parseDiagnosticDays } from "../shared/task-files.ts";
import { TaskFiles, digest, inputInstructions, taskMarkdown } from "./task-files.ts";
import { MAX_TOOL_OUTPUT } from "@vak/mcp/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { basicCatalog, SurfaceStore, walk, type AgentEvent } from "@vak/core";
import type { HostRunOptions, HostTurn, SessionView } from "@vak/host";
import type { AgentTool } from "@vak/providers";
import { TASK_LIMITS, TASK_BUDGET_DEFAULTS, parseTaskLimits, parseTaskSpending, type TaskSpending, parseReviewSnapshot, type ReviewSnapshot, parseTaskInput, parseTaskView, taskObject, type TaskApproval, type TaskSummary, type TaskView, type TaskRun, type TaskRunIdentity } from "../shared/task-contract.ts";
import { parseSchedule, SCHEDULE_GRACE_MS } from "../shared/schedule.ts";

interface Dependencies {
  files?: TaskFiles;
  dir: string;
  run(input: HostTurn, options: HostRunOptions): Promise<{ stop: string }>;
  view(session: string): Promise<SessionView>;
  remove?(session: string): Promise<void>;
  tools(session: string): Promise<AgentTool[]>;
  instructions(): string;
  observe(session: string, work: () => Promise<void>, run: TaskRunIdentity): Promise<void>;
  ready(provider: string, model: string, integrations: string[], confirmedFree: string[], spending: TaskSpending): void;
  permissionRevision?(server: string): number;
  permitted?(server: string, tool: string): boolean;
  warn(message: string): void;
}
type Execution = { sources: Map<string, ResearchRead>; allowance: number; reserved: boolean; run?: TaskRun; task: TaskView; inputId: string; ctrl: AbortController; remaining: number; since: number; timer?: ReturnType<typeof setTimeout> };
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length <= max ? v.trim() : "";
const identifier = (v: unknown) => typeof v === "string" && /^[\w-]{1,120}$/.test(v);

/** Product task journal. Surface content stays exclusively in the host's canonical sessions. */
export class Tasks {
  private readonly tasks = new Map<string, TaskView>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly scope = new AsyncLocalStorage<Execution>();
  private readonly running = new Map<string, Execution>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly resumptions = new Map<Execution, () => void>();
  private execution?: Execution;
  private closed = false;
  private readonly answers = new Map<string, (decision: "allow" | "deny") => void>();
  private readonly deciding = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly outputBusy = new Set<string>();
  private readonly deps: Dependencies;
  private wake?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private retention?: ReturnType<typeof setInterval>;
  private retentionWork?: Promise<void>;
  private readonly pruning = new Set<string>();

  private constructor(deps: Dependencies) { this.deps = deps; }

  static async open(deps: Dependencies): Promise<Tasks> {
    const owner = new Tasks(deps);
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(deps.dir)) {
      if (/^[\w-]{1,120}\.json\.[a-f0-9-]{36}\.tmp$/.test(file)) { await rm(path.join(deps.dir, file), { force: true }); continue; }
      if (!/^[\w-]{1,120}\.json$/.test(file)) continue;
      const t = parseTaskView(JSON.parse(await readFile(path.join(deps.dir, file), "utf8")));
      if (t.inputs?.some((input) => digest(input.content) !== input.sha256)) throw new Error("Input snapshot hash does not match its content");
      if (file !== `${t.id}.json`) throw new Error("Task identity does not match its journal");
      let recovered = false;
      for (const run of t.runHistory) if (run.output?.state === "pending" && deps.files) {
        run.output = await deps.files.verify(run.output);
        recovered = true;
      }
      for (const run of t.runHistory) if (run.state === "running") {
        run.state = "interrupted"; run.recovered = new Date().toISOString();
        run.note = "Execution stopped before a final record was saved. End time and external effects may be unknown.";
        recovered = true;
      }
      if (["queued", "running", "needs_approval"].includes(t.state) || recovered) {
        t.state = "interrupted";
        t.note = "Execution was interrupted. Check any external effects before starting a continuation.";
        delete t.approval;
        for (const op of t.operations) if (op.state === "started") op.state = "uncertain";
        await owner.persist(t);
      }
      owner.tasks.set(t.id, t);
    }
    // Past triggers are held for review after restart, never silently replayed.
    await owner.checkSchedules(true);
    owner.planWake();
    if (deps.files) {
      await owner.pruneDiagnostics();
      owner.retention = setInterval(() => {
        if (owner.retentionWork) return;
        owner.retentionWork = owner.pruneDiagnostics().catch((error: unknown) => deps.warn(`Diagnostic cleanup failed: ${String(error)}`)).finally(() => { owner.retentionWork = undefined; });
      }, 3600000);
      owner.retention.unref();
    }
    return owner;
  }

  list(): TaskSummary[] { return [...this.tasks.values()].map(({ id, session, goal, state, updated, revision, note, schedule }) => ({ id, session, goal: goal.slice(0, 120), state, updated, revision, note, ...(schedule ? { schedule: structuredClone(schedule) } : {}) })).sort((a, b) => b.updated.localeCompare(a.updated)); }
  get(id: string): TaskView { const t = this.tasks.get(id); if (!t) throw new Error("Task not found"); return this.copy(t); }
  private async pruneDiagnostics(): Promise<void> {
    for (const task of this.tasks.values()) if (!this.running.has(task.id)) {
      this.pruning.add(task.id);
      try { await this.deps.files?.prune(task.id, task.diagnosticDays ?? 7); }
      finally { this.pruning.delete(task.id); this.pump(); }
    }
  }

  private async exportResult(t: TaskView, run: TaskRun): Promise<void> {
    if (!t.output) return;
    const files = this.deps.files;
    if (!files) throw new Error("Local task output storage is unavailable");
    const view = await this.deps.view(t.session), content = taskMarkdown(view);
    const surfaces = view.surfaces.map(({ id, version }) => ({ id, version }));
    if (run.output?.surfaces && JSON.stringify(run.output.surfaces) !== JSON.stringify(surfaces)) throw new Error("Saved result versions changed; use the output of a new run");
    run.output ??= files.prepare(t.id, run.id, content, surfaces);
    await this.persist(t); // Expected identity/hash is durable before the write.
    try { run.output = await files.save(run.output, content); }
    catch (error) {
      run.output = { ...run.output, state: "failed", error: (error as Error).message.slice(0, 1000) };
      await this.persist(t);
      throw new Error(`Output could not be saved: ${run.output.error}. Review the result and retry saving; no model or tool operation will be repeated.`);
    }
    await this.persist(t);
  }

  async output(id: string, runId: string, value: unknown): Promise<TaskView> {
    const t = this.tasks.get(id), body = taskObject(value);
    if (!t || this.running.has(id) || this.outputBusy.has(id) || this.deleting.has(id) || body.revision !== t.revision) throw new Error("Wait for work to stop and refresh the task before checking its output");
    const run = t.runHistory.find((run) => run.id === runId);
    if (!run?.output || !this.deps.files || !["verify", "retry"].includes(String(body.operation))) throw new Error("Choose a recorded output and verify or retry it");
    this.outputBusy.add(id);
    try {
      if (body.operation === "verify") run.output = await this.deps.files.verify(run.output);
      else {
        if (run !== t.runHistory.at(-1) || !["end", "projected"].includes(run.stop ?? "")) throw new Error("Only the latest generated result can be saved again");
        await this.exportResult(t, run);
        if (t.state === "failed" || t.state === "interrupted") { t.state = "needs_input"; run.state = "review"; t.note = run.note = "Output saved. Review the recorded result against your criteria."; }
      }
      await this.persist(t);
      return this.copy(t);
    } finally { this.outputBusy.delete(id); }
  }
  async outputContent(id: string, runId: string): Promise<{ filename: string; content: string }> {
    const t = this.tasks.get(id), receipt = t?.runHistory.find((run) => run.id === runId)?.output;
    if (!t || !receipt || !this.deps.files || this.running.has(id) || this.deleting.has(id)) throw new Error("A saved idle task output is required");
    return { filename: receipt.filename, content: await this.deps.files.read(receipt) };
  }
  owns(session: string): boolean { return this.tasks.has(session); }
  inTask(): boolean { return Boolean(this.scope.getStore()); }
  providerSpending(id: string): TaskSpending | undefined {
    const e = this.scope.getStore();
    if (!e) return undefined;
    if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped");
    if (id !== e.task.provider) throw new Error("Task provider changed");
    return e.task.spending;
  }
  observeResult(request: { session: string; server: string; tool: string; args: Record<string, unknown> }, result: { text: string; isError?: boolean }): void {
    const e = this.scope.getStore();
    if (!e || e.task.session !== request.session || e.task.resultPolicy?.kind !== "research" || request.server !== "web" || request.tool !== "fetch_page" || result.isError || e.ctrl.signal.aborted) return;
    let url: URL;
    try { url = new URL(String(request.args.url)); } catch { return; }
    if (url.protocol === "https:" && (e.sources.size < 8 || e.sources.has(url.href))) {
      const retrievedAt = new Date().toISOString();
      e.sources.set(url.href, { text: result.text.slice(0, MAX_TOOL_OUTPUT), retrievedAt });
      if (e.run) e.run.retrievals = [...e.sources].map(([url, read]) => ({ url, retrievedAt: read.retrievedAt }));
    }
  }
  private available(e: Execution): boolean {
    if (e.remaining <= 0 || (e.timer && performance.now() - e.since >= e.remaining)) e.ctrl.abort(new Error("Active time limit reached"));
    return !e.ctrl.signal.aborted;
  }
  async beforeModelRequest(provider: string, model: string): Promise<void> {
    const e = this.scope.getStore();
    if (!e) return;
    const t = e.task, run = e.run!;
    if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped");
    if (this.execution !== e || provider !== t.provider || model !== t.model) throw new Error("Execution slot or selected model changed");
    if (run.modelRequests >= TASK_LIMITS.rounds || t.budget.modelRequests >= t.limits.modelRequests) {
      const error = new Error("Model-request budget exhausted; no further generation will start");
      e.ctrl.abort(error); throw error;
    }
    run.modelRequests++; t.budget.modelRequests++;
    await this.persist(t);
    if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped before generation");
  }
  private copy(t: TaskView): TaskView { return structuredClone(t); }

  private persist(t: TaskView): Promise<void> {
    t.updated = new Date().toISOString();
    t.revision++;
    const body = JSON.stringify(t);
    const previous = this.writes.get(t.id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const file = path.join(this.deps.dir, `${t.id}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => this.deps.warn("A temporary task checkpoint could not be removed; check storage permissions")); }
    }).catch((err: unknown) => {
      this.running.get(t.id)?.ctrl.abort(new Error("Task state could not be saved"));
      if (t.state !== "cancelled") t.state = "failed";
      t.note = "Task state could not be saved. No new work will start; check storage and retry.";
      throw err;
    });
    this.writes.set(t.id, work);
    void work.finally(() => { if (this.writes.get(t.id) === work) this.writes.delete(t.id); }).catch(() => {});
    return work;
  }

  private activity(t: TaskView, message: string): void {
    t.activity.push({ at: new Date().toISOString(), text: message });
    if (t.activity.length > 100) t.activity.shift();
  }

  async create(value: unknown): Promise<TaskView> {
    const body = taskObject(value);
    if (this.closed) throw new Error("Task service is stopping");
    if (this.tasks.size >= 200) throw new Error("Task limit reached");
    const goal = text(body.goal, 8000), criteria = text(body.criteria, 4000);
    const provider = text(body.provider, 120), model = text(body.model, 240);
    if (!goal || !criteria || !provider || !model || !Array.isArray(body.integrations) || body.integrations.length > 16 || !body.integrations.every(identifier)) throw new Error("Goal, completion criteria, model and explicit tool selection are required");
    const integrations = [...new Set(body.integrations as string[])];
    const confirmedFree = Array.isArray(body.confirmedFree) && body.confirmedFree.length <= 16 && body.confirmedFree.every(identifier) ? [...new Set(body.confirmedFree as string[])] : [];
    const resultPolicy = body.resultPolicy === undefined ? undefined : parseTaskResultPolicy(body.resultPolicy);
    const inputs = body.inputs === undefined ? undefined : parseTaskFiles(body.inputs).map((input) => ({ ...input, sha256: digest(input.content) }));
    const output = body.output === undefined ? undefined : parseTaskOutput(body.output);
    const diagnosticDays = parseDiagnosticDays(body.diagnosticDays ?? 7);
    if (output && !this.deps.files) throw new Error("Local output storage is unavailable");
    if (resultPolicy?.kind === "research" && !integrations.includes("web")) throw new Error("Source-backed research needs the ready Web pages capability selected");
    const spending = parseTaskSpending(body.spending);
    const limits = body.limits === undefined ? { ...TASK_BUDGET_DEFAULTS } : parseTaskLimits(body.limits);
    if (spending.kind === "ceiling") throw new Error("Strict monetary ceilings cannot be enforced yet. No task was started.");
    this.deps.ready(provider, model, integrations, confirmedFree, spending);
    const schedule = body.schedule === undefined ? undefined : parseSchedule(body.schedule);
    if (schedule && (schedule.status !== "armed" || Date.parse(schedule.at) <= Date.now())) throw new Error("Choose a future date and time");
    const id = randomUUID(), at = new Date().toISOString();
    const t: TaskView = { version: 5, revision: 0, id, session: id, goal, criteria, provider, model, integrations, confirmedFree, spending, ...(resultPolicy ? { resultPolicy } : {}), ...(inputs ? { inputs } : {}), ...(output ? { output } : {}), diagnosticDays, limits, budget: { modelRequests: 0, toolCalls: 0, activeMs: 0 }, state: "queued", created: at, updated: at, note: "Waiting to start", runs: 0, runHistory: [], pending: [{ id: randomUUID(), kind: "message", message: goal }], activity: [], operations: [], accepted: [] };
    if (schedule) { t.schedule = schedule; t.state = "scheduled"; t.note = "Will run once at the selected time while this app is running and the computer is awake."; }
    await this.persist(t);
    this.tasks.set(id, t);
    this.pump();
    this.planWake();
    return this.copy(t);
  }

  async input(id: string, value: unknown): Promise<TaskView> {
    if (this.outputBusy.has(id)) throw new Error("Wait for the output operation to finish");
    const body = taskObject(value), input = parseTaskInput(value);
    const t = this.tasks.get(id); if (!t) throw new Error("Task not found");
    if (this.deleting.has(id)) throw new Error("Task is being deleted");
    if (this.running.get(id)?.ctrl.signal.aborted) throw new Error("Wait for the previous run to stop before continuing");
    if (t.state === "scheduled" || t.state === "paused") throw new Error("Use Run now or change the schedule before adding inputs");
    if (!identifier(body.id)) throw new Error("Input identity required");
    if (t.pending.some((p) => p.id === body.id) || t.accepted.includes(body.id as string)) return this.copy(t);
    if (t.accepted.length >= 256 || t.runs + t.pending.filter((p) => p.id !== this.running.get(id)?.inputId).length >= t.limits.runs) throw new Error("Task continuation limit reached; start a new task");
    if (t.budget.modelRequests >= t.limits.modelRequests || t.budget.activeMs >= t.limits.activeMs) throw new Error("Task budget exhausted or reserved by active work. Review the recorded limits before starting new work.");
    if (this.closed || t.state === "needs_approval" || t.pending.length >= TASK_LIMITS.pending) throw new Error("Resolve the pending approval or wait for queued inputs");
    const uncertain = t.operations.filter((op) => op.state === "uncertain");
    if (uncertain.length) {
      if (!body.reconciliation) throw new Error("Review uncertain external effects before continuing");
      const review = taskObject(body.reconciliation), note = text(review.note, 1000), ids = review.operationIds;
      if (review.revision !== t.revision || note.length < 12 || !Array.isArray(ids) || ids.length !== uncertain.length || new Set(ids).size !== ids.length || uncertain.some((op) => !ids.includes(op.id))) throw new Error("Reconcile the current exact operation IDs and record what you checked; refresh if the task changed");
      for (const op of uncertain) { op.state = "reviewed"; op.reconciliation = { at: new Date().toISOString(), note }; }
    }
    if (["interrupted", "cancelled", "failed"].includes(t.state)) t.pending = [];
    t.pending.push(input);
    t.accepted.push(input.id);
    this.activity(t, `Input accepted: ${input.id}`);
    if (t.state !== "running") t.state = "queued";
    await this.persist(t);
    this.pump();
    return this.copy(t);
  }

  async cancel(id: string): Promise<TaskView> {
    if (this.deleting.has(id)) throw new Error("Task is being deleted");
    const t = this.tasks.get(id); if (!t) throw new Error("Task not found");
    t.state = "cancelled";
    t.note = "Stopped new work. Operations already sent may still have effects.";
    t.pending = [];
    if (t.schedule?.status === "armed") t.schedule.status = "paused";
    this.running.get(id)?.ctrl.abort();
    await this.persist(t);
    this.planWake();
    return this.copy(t);
  }

  async review(id: string): Promise<ReviewSnapshot> {
    if (this.outputBusy.has(id)) throw new Error("Wait for the output operation to finish");
    const t = this.tasks.get(id);
    if (!t || this.deleting.has(id) || t.state !== "needs_input" || t.pending.length || t.runHistory.at(-1)?.state !== "review") throw new Error("Only a saved result awaiting review can be accepted");
    if (t.operations.some((o) => o.state === "started" || o.state === "uncertain")) throw new Error("Review unresolved operations first");
    const revision = t.revision, run = t.runHistory.at(-1)!;
    if (t.output && (!run.output || !this.deps.files || (await this.deps.files.verify(run.output)).state !== "saved")) throw new Error("The requested saved output is missing or changed. Verify or retry its save before accepting the result");
    const view = await this.deps.view(t.session);
    if (run.output?.surfaces && JSON.stringify(run.output.surfaces) !== JSON.stringify(view.surfaces.map(({ id, version }) => ({ id, version })))) throw new Error("The output's surface versions are stale; review the latest saved run");
    if (this.deleting.has(id) || t.revision !== revision || t.state !== "needs_input" || t.pending.length) throw new Error("Task changed during review. Open a fresh review.");
    const assistant = view.timeline.findLast((e) => e.kind === "assistant" && Date.parse(e.at) >= Date.parse(run.started));
    if (!assistant) throw new Error("This run has no saved assistant result to review");
    return { revision, runId: run.id, assistantAt: assistant.at, fingerprint: createHash("sha256").update(JSON.stringify({ timeline: view.timeline, surfaces: view.surfaces })).digest("hex"), surfaces: view.surfaces.map((s) => ({ id: s.id, title: s.title || s.id, version: s.version })) };
  }

  async complete(id: string, value: unknown): Promise<TaskView> {
    const body = taskObject(value), submitted = parseReviewSnapshot(body);
    const note = text(body.note, 4000);
    if (body.confirmed !== true || !note) throw new Error("Confirm the criteria and record the evidence you checked");
    const snapshot = await this.review(id);
    if (submitted.revision !== snapshot.revision || submitted.runId !== snapshot.runId || submitted.fingerprint !== snapshot.fingerprint || submitted.assistantAt !== snapshot.assistantAt || JSON.stringify(submitted.surfaces) !== JSON.stringify(snapshot.surfaces)) throw new Error("The result changed while you reviewed it. Open a fresh review.");
    const t = this.tasks.get(id)!;
    if (this.deleting.has(id) || t.revision !== snapshot.revision || t.state !== "needs_input" || t.pending.length) throw new Error("Task changed during review. Open a fresh review.");
    t.state = "completed";
    t.note = "You reviewed the recorded evidence against the completion criteria.";
    const latest = t.runHistory.at(-1)!;
    latest.state = "accepted";
    latest.review = { ...snapshot, method: "user", at: new Date().toISOString(), note };
    latest.note = "Result accepted after user evidence review; not automatic verification.";
    this.activity(t, "Result accepted with a revision-bound user evidence review");
    await this.persist(t);
    return this.copy(t);
  }

  async remove(id: string, value: unknown): Promise<void> {
    if (this.outputBusy.has(id)) throw new Error("Wait for the output operation to finish");
    if (!this.deps.remove) throw new Error("Task deletion is unavailable");
    if (this.deleting.has(id)) throw new Error("Task is being deleted");
    const t = this.tasks.get(id); if (!t) throw new Error("Task not found");
    const body = taskObject(value);
    if (["queued", "running", "needs_approval"].includes(t.state) || this.running.has(id)) throw new Error("Cancel this task and wait for execution to stop before deleting it");
    if (body.revision !== t.revision) throw new Error("Task changed while you reviewed deletion; check it again");
    if (t.operations.some((op) => op.state === "uncertain" || op.state === "started") && body.confirmUncertain !== true) throw new Error("Acknowledge uncertain external effects before deleting the recovery record");
    this.deleting.add(id);
    try {
      await this.writes.get(id);
      if (body.revision !== t.revision) throw new Error("Task changed while you reviewed deletion; check it again");
      await this.deps.remove(id);
      await this.deps.files?.remove(id, t.runHistory.flatMap((run) => run.output ? [run.output] : []));
      await rm(path.join(this.deps.dir, `${id}.json`), { force: true });
      for (const file of await readdir(this.deps.dir)) if (file.startsWith(`${id}.json.`) && /^[a-f0-9-]{36}\.tmp$/.test(file.slice(id.length + 6))) await rm(path.join(this.deps.dir, file), { force: true });
      this.tasks.delete(id);
      this.planWake();
    } finally { this.deleting.delete(id); }
  }

  async changeSchedule(id: string, value: unknown): Promise<TaskView> {
    const t = this.tasks.get(id); if (!t) throw new Error("Schedule not found");
    const body = taskObject(value);
    if (this.closed || this.deleting.has(id) || this.running.has(id)) throw new Error("Wait for active work to finish");
    if (body.revision !== t.revision) throw new Error("This schedule changed. Refresh and try again.");
    if (t.state !== "scheduled" && t.state !== "paused") throw new Error("Only upcoming or paused work can be rescheduled");
    if (!t.schedule || !t.pending.length) throw new Error("No pending scheduled run");
    if (body.operation === "pause") {
      t.schedule.status = "paused"; t.state = "paused"; t.note = "Paused. Resume, change the time or run when you are ready.";
    } else if (body.operation === "resume" || body.operation === "reschedule") {
      const schedule = body.operation === "resume" ? t.schedule : parseSchedule(body.schedule);
      if (Date.parse(schedule.at) <= Date.now()) throw new Error("That time has passed. Choose a new time or Run now.");
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
      t.schedule = { ...schedule, status: "armed" }; t.state = "scheduled"; t.note = "Waiting for the selected time";
    } else if (body.operation === "run") {
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
      t.schedule.status = "dispatched"; t.state = "queued"; t.note = "Waiting to run";
    } else throw new Error("Unknown schedule operation");
    this.activity(t, `Schedule ${body.operation}`);
    await this.persist(t); this.pump(); this.planWake();
    return this.copy(t);
  }

  private planWake(): void {
    clearTimeout(this.wake);
    if (this.closed) return;
    const times = [...this.tasks.values()].filter((t) => t.state === "scheduled" && !this.deleting.has(t.id)).map((t) => Date.parse(t.schedule!.at));
    if (!times.length) return;
    // Bounded wakeups also notice clock changes and sleep without a busy polling loop.
    this.wake = setTimeout(() => {
      this.checking = this.checkSchedules().catch((err: unknown) => this.deps.warn(`Schedule check failed: ${String(err)}`)).finally(() => { this.checking = undefined; this.planWake(); });
    }, Math.max(25, Math.min(30_000, Math.min(...times) - Date.now())));
    this.wake.unref();
  }

  private async checkSchedules(startup = false): Promise<void> {
    for (const t of this.tasks.values()) {
      if (this.closed || t.state !== "scheduled" || this.deleting.has(t.id) || !t.schedule || Date.parse(t.schedule.at) > Date.now()) continue;
      if (startup || Date.now() - Date.parse(t.schedule.at) > SCHEDULE_GRACE_MS) {
        t.state = "paused"; t.schedule.status = "paused";
        t.note = "The scheduled time was missed. Review the inputs, then choose Run now or a new time.";
        this.activity(t, "Missed scheduled time; held for review");
      } else {
        t.state = "queued"; t.schedule.status = "dispatched"; t.note = "Scheduled time reached; waiting for the execution slot";
        this.activity(t, "Scheduled run queued");
      }
      await this.persist(t);
    }
    this.pump();
  }

  private pump(): void {
    if (this.execution || this.closed) return;
    // A permission decision resumes the same suspended host call before admitting new work.
    for (const [e, resume] of this.resumptions) {
      this.resumptions.delete(e);
      if (e.ctrl.signal.aborted) { resume(); continue; }
      this.execution = e;
      resume();
      return;
    }
    const t = [...this.tasks.values()].find((t) => t.state === "queued" && t.pending.length && !this.running.has(t.id) && !this.pruning.has(t.id));
    if (!t) return;
    const allowance = Math.max(0, Math.min(TASK_LIMITS.activeMs, t.limits.activeMs - t.budget.activeMs));
    const e: Execution = { sources: new Map(), allowance, reserved: false, task: t, inputId: t.pending[0]!.id, ctrl: new AbortController(), remaining: allowance, since: performance.now() };
    this.execution = e;
    this.running.set(t.id, e);
    const work = this.execute(e).catch((err) => this.deps.warn(`Task persistence/execution failed: ${(err as Error).message}`)).finally(() => {
      this.running.delete(t.id);
      this.inflight.delete(work);
      if (this.execution === e) this.execution = undefined;
      this.pump();
    });
    this.inflight.add(work);
  }

  private async acquire(e: Execution): Promise<void> {
    if (e.ctrl.signal.aborted || this.execution === e) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.resumptions.delete(e);
        e.ctrl.signal.removeEventListener("abort", finish);
        resolve();
      };
      this.resumptions.set(e, finish);
      e.ctrl.signal.addEventListener("abort", finish, { once: true });
      this.pump();
    });
  }

  private arm(e: Execution): void {
    e.since = performance.now();
    e.timer = setTimeout(() => e.ctrl.abort(new Error("Active time limit reached")), Math.max(0, e.remaining));
  }

  private async execute(e: Execution): Promise<void> {
    const t = e.task;
    const input = t.pending[0]!;
    const run: TaskRun = { id: randomUUID(), sequence: ++t.runs, inputId: input.id, inputKind: input.kind, state: "running", started: new Date().toISOString(), activeMs: 0, chargedMs: 0, toolCalls: 0, modelRequests: 0, note: "Working" };
    t.runHistory.push(run); e.run = run;
    try {
      if (e.allowance <= 0 || t.budget.modelRequests >= t.limits.modelRequests) throw new Error("Task budget exhausted; no new work started");
      // Reserve the run allowance durably. A crash keeps the reservation charged.
      t.budget.activeMs += e.allowance; run.chargedMs = e.allowance; e.reserved = true;
      t.state = "running"; t.note = "Working";
      this.activity(t, input.action ? `Form action: ${input.action.source}` : "Started a run");
      await this.persist(t);
      this.arm(e);
      if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped before execution");
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
      if (input.action) {
        const view = await this.deps.view(t.session);
        const surface = view.surfaces.find((s) => s.id === input.action!.surface);
        if (surface?.version !== input.revision) throw new Error("This surface changed. Review it and submit again.");
        if (t.resultPolicy?.kind === "comparison" && t.resultPolicy.table?.criteria) {
          const contract = t.resultPolicy.table;
          // Only a real form action with the declared bindings can revise checked
          // criteria. Model output and unrelated buttons never change the policy.
          const store = new SurfaceStore(basicCatalog); store.load(surface);
          const resolved = store.resolve(surface.id)!;
          let matched = false;
          if (resolved.root) walk(resolved.root, (node) => {
            if (node.id !== input.action!.source || node.type !== "form") return;
            const bindings: string[] = [];
            walk(node, (field) => { if (field.type === "input" && field.bindPath) bindings.push(field.bindPath); });
            matched = Object.keys(contract.criteria!).every((key) => bindings.filter((binding) => binding === `/criteria/${key}`).length === 1);
          });
          if (!matched) throw new Error("Submit the checked criteria form, using its declared input bindings");
          t.resultPolicy.table = reviseComparisonCriteria(t.resultPolicy.table, input.action.data.criteria);
          await this.persist(t);
        }
      }
      if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped before execution");
      await this.scope.run(e, () => this.deps.observe(t.session, async () => {
        let calls = 0;
        const tools = (await this.deps.tools(t.session)).filter((tool) => t.integrations.includes(tool.spec.name.split("__")[0]!)).map((tool): AgentTool => ({
          spec: tool.spec,
          execute: async (args, ctx) => {
            this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
            const previous = ctx.callId ? t.operations.find((op) => op.runId === run.id && op.id === ctx.callId) : undefined;
            if (previous) return `Operation ${previous.id} already has recorded state ${previous.state}; it was not dispatched again. Use its prior receipt or request a user review of uncertain effects.`;
            if (t.operations.some((op) => op.state === "uncertain")) throw new Error("Review uncertain operation effects before dispatching more work");
            if (t.resultPolicy?.kind === "research" && t.resultPolicy.sources && tool.spec.name === "web__fetch_page" && !t.resultPolicy.sources.includes(new URL(String(args.url)).href)) throw new Error("This page is outside the task's declared source scope");
            if (!this.available(e) || t.state === "cancelled") throw e.ctrl.signal.reason ?? new Error("Task stopped");
            if (++calls > TASK_LIMITS.tools || t.budget.toolCalls >= t.limits.toolCalls) {
              const error = new Error("Tool-call budget exhausted; no new tool attempt started");
              e.ctrl.abort(error); throw error;
            }
            const op = { id: ctx.callId ?? randomUUID(), tool: tool.spec.name, runId: run.id, state: "started" as const };
            run.toolCalls++; t.budget.toolCalls++;
            t.operations.push(op);
            await this.persist(t);
            let dispatched = false;
            try {
              if (!this.available(e)) throw e.ctrl.signal.reason ?? new Error("Task stopped before tool dispatch");
              dispatched = true;
              const previousRead = tool.spec.name === "web__fetch_page" ? e.sources.get(new URL(String(args.url)).href) : undefined;
              const result = await tool.execute(args, ctx);
              Object.assign(op, { state: e.ctrl.signal.aborted ? "uncertain" : "returned" });
              await this.persist(t);
              if (tool.spec.name === "web__fetch_page") {
                const read = e.sources.get(new URL(String(args.url)).href);
                if (read && read !== previousRead) return result + "\nApplication retrieval receipt: " + JSON.stringify({ source: new URL(String(args.url)).href, retrieved_at: read.retrievedAt });
              }
              return result;
            } catch (err) {
              Object.assign(op, { state: dispatched ? "uncertain" : "failed" });
              await this.persist(t);
              if (dispatched) e.ctrl.abort(new Error("An operation may have taken effect. Review its recorded identity and the affected service before continuing; it will not be replayed automatically."));
              throw err;
            }
          },
        }));
        const result = await this.deps.run({ session: t.session, provider: t.provider, model: t.model, message: input.message, action: input.action, ...(t.resultPolicy ? { schemaMode: "strict" } : {}), history: 10 }, {
          completion: "response", validateCompletion: t.resultPolicy ? (result) => reviewTaskResult(t.resultPolicy!, result, e.sources) : undefined, signal: e.ctrl.signal, tools, maxSteps: TASK_LIMITS.rounds,
          validateEdits: t.resultPolicy ? (result) => checkTaskResult(t.resultPolicy!, { ...result, response: "" }, e.sources) : undefined,
          // Gathering never takes the last model request: the engine keeps it for the closing answer.
          toolRounds: TASK_LIMITS.rounds - 1, maxTokens: TASK_LIMITS.outputTokens,
          instructions: `${this.deps.instructions()}\nYou are working on a task. Goal: ${t.goal}\nCompletion criteria: ${t.criteria}\nKeep every existing surface interactive. Use evidence from the available tools; do not claim an external effect without a receipt. The user reviews your result before marking the task complete.\n${resultInstructions(t.resultPolicy)}${inputInstructions(t.inputs ?? [])}${t.output ? "\nThe app will save the canonical result as Markdown in local task outputs after successful generation. Do not call a file-writing tool or claim it saved before the app issues a receipt." : ""}`,
          emit: (event) => {
            if (event.type === "tool_start") this.activity(t, `Using ${event.name}`);
            if (event.type === "error") t.note = event.message.slice(0, 2000);
          },
        });
        run.stop = result.stop;
        t.pending.shift();
        if (e.ctrl.signal.aborted) throw e.ctrl.signal.reason ?? new Error("Run stopped");
        if (["error", "max_steps", "aborted"].includes(result.stop)) throw new Error(t.note === "Working" ? `Run ended: ${result.stop}` : t.note);
        await this.exportResult(t, run);
        if (e.ctrl.signal.aborted) throw e.ctrl.signal.reason ?? new Error("Run stopped during output save");
        t.state = t.pending.length ? "queued" : "needs_input";
        t.note = t.pending.length ? "Waiting for the next input" : "Review the saved result against your criteria. Continue interacting with any surface, or open an evidence review to accept the result.";
      }, { taskId: t.id, runId: run.id }));
    } catch (err) {
      if (t.state !== "cancelled") {
        t.state = this.closed ? "interrupted" : "failed";
        t.note = (err as Error).message.slice(0, 2000);
      }
      for (const op of t.operations) if (op.state === "started") op.state = "uncertain";
    } finally {
      run.activeMs = Math.ceil(Math.min(e.allowance, Math.max(0, e.allowance - e.remaining + (e.timer ? performance.now() - e.since : 0))));
      if (e.reserved) { t.budget.activeMs -= e.allowance - run.activeMs; run.chargedMs = run.activeMs; }
      run.state = t.state === "cancelled" ? "cancelled" : t.state === "interrupted" ? "interrupted" : t.state === "failed" ? "failed" : "review";
      run.ended = new Date().toISOString(); run.note = t.note;
      clearTimeout(e.timer);
      delete t.approval;
      await this.persist(t);
      await this.deps.files?.prune(t.id, t.diagnosticDays ?? 7).catch((error: unknown) => this.deps.warn(`Diagnostic cleanup failed: ${String(error)}`));
    }
  }

  async approve(req: Omit<TaskApproval, "expires" | "capabilityRevision">, emit?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<"allow" | "deny"> {
    const e = this.scope.getStore();
    if (!e || signal?.aborted) return "deny";
    signal ??= e.ctrl.signal;
    const t = e.task;
    clearTimeout(e.timer); delete e.timer; e.remaining -= performance.now() - e.since;
    t.approval = { ...structuredClone(req), expires: new Date(Date.now() + TASK_LIMITS.approvalMs).toISOString(), capabilityRevision: this.deps.permissionRevision?.(req.server) ?? 0 };
    t.state = "needs_approval"; t.note = "Review the exact operation before it runs";
    const waiting = new Promise<"allow" | "deny">((resolve) => {
      const finish = (decision: "allow" | "deny") => {
        if (!this.answers.delete(req.id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve(decision);
      };
      const aborted = () => finish("deny");
      const timer = setTimeout(aborted, TASK_LIMITS.approvalMs);
      this.answers.set(req.id, finish);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    try { await this.persist(t); }
    catch (err) { this.answers.get(req.id)?.("deny"); throw err; }
    if (!signal.aborted) emit?.({ type: "approval", ...req });
    if (this.execution === e) this.execution = undefined;
    this.pump();
    let decision = await waiting;
    const approval = t.approval!;
    delete t.approval;
    if (!e.ctrl.signal.aborted) {
      t.state = "queued";
      t.note = "Permission reviewed; waiting for the execution slot";
    }
    this.activity(t, `Permission ${decision === "allow" ? "allowed once" : "denied"}: ${req.server} / ${req.tool}`);
    await this.persist(t);
    await this.acquire(e);
    // Authority may change while another task holds the slot. Revalidate at dispatch.
    if (!this.available(e) || signal.aborted || Date.parse(approval.expires) <= Date.now()) decision = "deny";
    if (decision === "allow") {
      try {
        this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
        if (this.deps.permitted?.(req.server, req.tool) === false || approval.capabilityRevision !== (this.deps.permissionRevision?.(req.server) ?? 0)) decision = "deny";
      } catch { decision = "deny"; }
    }
    if (decision === "deny" && !e.ctrl.signal.aborted) this.activity(t, "Operation not authorized at dispatch; no permission grant is retained");
    if (!e.ctrl.signal.aborted) {
      t.state = "running"; t.note = "Working";
      await this.persist(t);
      this.arm(e);
    }
    if (e.ctrl.signal.aborted || signal.aborted) decision = "deny";
    emit?.({ type: "approval_done", id: req.id, decision });
    return decision;
  }

  async answer(id: string, approval: string, decision: unknown): Promise<TaskView> {
    const t = this.tasks.get(id);
    if (!t?.approval || t.state !== "needs_approval" || t.approval.id !== approval || Date.parse(t.approval.expires) <= Date.now() || !this.answers.has(approval) || this.deciding.has(approval)) throw new Error("Approval expired or no longer applies");
    if (decision !== "allow" && decision !== "deny") throw new Error("Choose allow once or deny");
    if (decision === "allow") this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree, t.spending);
    if (decision === "allow" && (this.deps.permitted?.(t.approval.server, t.approval.tool) === false || t.approval.capabilityRevision !== (this.deps.permissionRevision?.(t.approval.server) ?? 0))) throw new Error("Tool access changed; deny this request and review the task again");
    this.deciding.add(approval);
    try {
      this.activity(t, `Approval decision recorded: ${approval} / ${decision}`);
      await this.persist(t);
      if (!this.answers.has(approval) || !t.approval || Date.parse(t.approval.expires) <= Date.now()) throw new Error("Approval expired while saving");
      if (decision === "allow" && (this.deps.permitted?.(t.approval.server, t.approval.tool) === false || t.approval.capabilityRevision !== (this.deps.permissionRevision?.(t.approval.server) ?? 0))) { this.answers.get(approval)!("deny"); throw new Error("Tool access changed while saving; the request was denied"); }
      this.answers.get(approval)!(decision);
    } finally { this.deciding.delete(approval); }
    return this.copy(t);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.wake);
    clearInterval(this.retention);
    for (const e of this.running.values()) e.ctrl.abort(new Error("Application stopped; review before continuing"));
    await Promise.all(this.inflight);
    await this.retentionWork;
    await this.checking;
    await Promise.all(this.writes.values());
  }
}
