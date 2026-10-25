import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@vak/core";
import type { HostRunOptions, HostTurn, SessionView } from "@vak/host";
import type { AgentTool } from "@vak/providers";
import { TASK_LIMITS, parseTaskInput, parseTaskView, taskObject, type TaskApproval, type TaskSummary, type TaskView, type TaskRun } from "../task-contract.ts";
import { parseSchedule, SCHEDULE_GRACE_MS } from "../schedule.ts";

interface Dependencies {
  dir: string;
  run(input: HostTurn, options: HostRunOptions): Promise<{ stop: string }>;
  view(session: string): Promise<SessionView>;
  remove?(session: string): Promise<void>;
  tools(session: string): Promise<AgentTool[]>;
  instructions(): string;
  observe(session: string, work: () => Promise<void>): Promise<void>;
  ready(provider: string, model: string, integrations: string[], confirmedFree: string[]): void;
  permissionRevision?(server: string): number;
  permitted?(server: string, tool: string): boolean;
  warn(message: string): void;
}
type Execution = { task: TaskView; inputId: string; ctrl: AbortController; remaining: number; since: number; timer?: ReturnType<typeof setTimeout> };
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
  private readonly deps: Dependencies;
  private wake?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;

  private constructor(deps: Dependencies) { this.deps = deps; }

  static async open(deps: Dependencies): Promise<Tasks> {
    const owner = new Tasks(deps);
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(deps.dir)) {
      if (!/^[\w-]{1,120}\.json$/.test(file)) continue;
      const t = parseTaskView(JSON.parse(await readFile(path.join(deps.dir, file), "utf8")));
      if (file !== `${t.id}.json`) throw new Error("Task identity does not match its journal");
      let recovered = false;
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
    return owner;
  }

  list(): TaskSummary[] { return [...this.tasks.values()].map(({ id, session, goal, state, updated, revision, note, schedule }) => ({ id, session, goal: goal.slice(0, 120), state, updated, revision, note, ...(schedule ? { schedule: structuredClone(schedule) } : {}) })).sort((a, b) => b.updated.localeCompare(a.updated)); }
  get(id: string): TaskView { const t = this.tasks.get(id); if (!t) throw new Error("Task not found"); return this.copy(t); }
  owns(session: string): boolean { return this.tasks.has(session); }
  inTask(): boolean { return Boolean(this.scope.getStore()); }
  private copy(t: TaskView): TaskView { return structuredClone(t); }

  private persist(t: TaskView): Promise<void> {
    t.updated = new Date().toISOString();
    t.revision++;
    const body = JSON.stringify(t);
    const previous = this.writes.get(t.id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const file = path.join(this.deps.dir, `${t.id}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
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
    this.deps.ready(provider, model, integrations, confirmedFree);
    const schedule = body.schedule === undefined ? undefined : parseSchedule(body.schedule);
    if (schedule && (schedule.status !== "armed" || Date.parse(schedule.at) <= Date.now())) throw new Error("Choose a future date and time");
    const id = randomUUID(), at = new Date().toISOString();
    const t: TaskView = { version: 2, revision: 0, id, session: id, goal, criteria, provider, model, integrations, confirmedFree, state: "queued", created: at, updated: at, note: "Waiting to start", runs: 0, runHistory: [], pending: [{ id: randomUUID(), kind: "message", message: goal }], activity: [], operations: [], accepted: [] };
    if (schedule) { t.schedule = schedule; t.state = "scheduled"; t.note = "Will run once at the selected time while this app is running and the computer is awake."; }
    await this.persist(t);
    this.tasks.set(id, t);
    this.pump();
    this.planWake();
    return this.copy(t);
  }

  async input(id: string, value: unknown): Promise<TaskView> {
    const body = taskObject(value), input = parseTaskInput(value);
    const t = this.tasks.get(id); if (!t) throw new Error("Task not found");
    if (this.deleting.has(id)) throw new Error("Task is being deleted");
    if (this.running.get(id)?.ctrl.signal.aborted) throw new Error("Wait for the previous run to stop before continuing");
    if (t.state === "scheduled" || t.state === "paused") throw new Error("Use Run now or change the schedule before adding inputs");
    if (!identifier(body.id)) throw new Error("Input identity required");
    if (t.pending.some((p) => p.id === body.id) || t.accepted.includes(body.id as string)) return this.copy(t);
    if (t.accepted.length >= 256 || t.runs + t.pending.filter((p) => p.id !== this.running.get(id)?.inputId).length >= 32) throw new Error("Task continuation limit reached; start a new task");
    if (this.closed || t.state === "needs_approval" || t.pending.length >= TASK_LIMITS.pending) throw new Error("Resolve the pending approval or wait for queued inputs");
    if (t.operations.some((o) => o.state === "uncertain") && body.reconciled !== true) throw new Error("Review uncertain external effects before continuing");
    if (body.reconciled === true) for (const op of t.operations) if (op.state === "uncertain") op.state = "reviewed";
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

  async complete(id: string): Promise<TaskView> {
    if (this.deleting.has(id)) throw new Error("Task is being deleted");
    const t = this.tasks.get(id); if (!t || t.state !== "needs_input" || t.pending.length) throw new Error("Only a result awaiting review can be completed");
    if (!t.runs || t.operations.some((o) => o.state === "started" || o.state === "uncertain")) throw new Error("Review unresolved operations first");
    const view = await this.deps.view(t.session);
    if (this.deleting.has(id) || t.state !== "needs_input" || t.pending.length) throw new Error("Task changed while reviewing; check it again");
    if (!view.timeline.some((e) => e.kind === "assistant")) throw new Error("No saved result to review");
    t.state = "completed";
    t.note = "You confirmed that the saved result meets the completion criteria.";
    const latest = t.runHistory.at(-1);
    if (latest?.state === "review") { latest.state = "accepted"; latest.note = "You accepted the saved result against the completion criteria."; }
    this.activity(t, "Result accepted by the user");
    await this.persist(t);
    return this.copy(t);
  }

  async remove(id: string, value: unknown): Promise<void> {
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
      await rm(path.join(this.deps.dir, `${id}.json`), { force: true });
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
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
      t.schedule = { ...schedule, status: "armed" }; t.state = "scheduled"; t.note = "Waiting for the selected time";
    } else if (body.operation === "run") {
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
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
    const t = [...this.tasks.values()].find((t) => t.state === "queued" && t.pending.length && !this.running.has(t.id));
    if (!t) return;
    const e: Execution = { task: t, inputId: t.pending[0]!.id, ctrl: new AbortController(), remaining: TASK_LIMITS.activeMs, since: Date.now() };
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
    e.since = Date.now();
    e.timer = setTimeout(() => e.ctrl.abort(new Error("Active time limit reached")), Math.max(0, e.remaining));
  }

  private async execute(e: Execution): Promise<void> {
    const t = e.task;
    const input = t.pending[0]!;
    const run: TaskRun = { id: randomUUID(), sequence: ++t.runs, inputId: input.id, inputKind: input.kind, state: "running", started: new Date().toISOString(), activeMs: 0, toolCalls: 0, note: "Working" };
    t.runHistory.push(run);
    try {
      this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
      if (input.action) {
        const view = await this.deps.view(t.session);
        if (view.surfaces.find((s) => s.id === input.action!.surface)?.version !== input.revision) throw new Error("This surface changed. Review it and submit again.");
      }
      if (e.ctrl.signal.aborted || t.state === "cancelled") throw new Error("Task stopped before execution");
      t.state = "running"; t.note = "Working";
      this.activity(t, input.action ? `Form action: ${input.action.source}` : "Started a run");
      await this.persist(t);
      this.arm(e);
      await this.scope.run(e, () => this.deps.observe(t.session, async () => {
        let calls = 0;
        const tools = (await this.deps.tools(t.session)).filter((tool) => t.integrations.includes(tool.spec.name.split("__")[0]!)).map((tool): AgentTool => ({
          spec: tool.spec,
          execute: async (args, ctx) => {
            this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
            if (e.ctrl.signal.aborted || t.state === "cancelled" || ++calls > TASK_LIMITS.tools) { e.ctrl.abort(new Error("Tool-call limit reached or task stopped")); throw new Error("Tool-call limit reached or task stopped"); }
            const op = { id: ctx.callId ?? randomUUID(), tool: tool.spec.name, runId: run.id, state: "started" as const };
            run.toolCalls++;
            t.operations.push(op);
            await this.persist(t);
            try {
              const result = await tool.execute(args, ctx);
              Object.assign(op, { state: e.ctrl.signal.aborted ? "uncertain" : "returned" });
              await this.persist(t);
              return result;
            } catch (err) {
              Object.assign(op, { state: "uncertain" });
              await this.persist(t);
              throw err;
            }
          },
        }));
        const result = await this.deps.run({ session: t.session, provider: t.provider, model: t.model, message: input.message, action: input.action, history: 10 }, {
          signal: e.ctrl.signal, tools, maxSteps: TASK_LIMITS.rounds, maxTokens: TASK_LIMITS.outputTokens,
          instructions: `${this.deps.instructions()}\nYou are working on a task. Goal: ${t.goal}\nCompletion criteria: ${t.criteria}\nKeep every existing surface interactive. Use evidence from the available tools; do not claim an external effect without a receipt. The user reviews your result before marking the task complete.`,
          emit: (event) => {
            if (event.type === "tool_start") this.activity(t, `Using ${event.name}`);
            if (event.type === "error") t.note = event.message.slice(0, 2000);
          },
        });
        run.stop = result.stop;
        t.pending.shift();
        if (e.ctrl.signal.aborted) throw e.ctrl.signal.reason ?? new Error("Run stopped");
        if (["error", "max_steps", "aborted"].includes(result.stop)) throw new Error(t.note === "Working" ? `Run ended: ${result.stop}` : t.note);
        t.state = t.pending.length ? "queued" : "needs_input";
        t.note = t.pending.length ? "Waiting for the next input" : "Review the saved result against your criteria. Continue interacting with any surface, or mark the task complete.";
      }));
    } catch (err) {
      if (t.state !== "cancelled") {
        t.state = this.closed ? "interrupted" : "failed";
        t.note = (err as Error).message.slice(0, 2000);
      }
      for (const op of t.operations) if (op.state === "started") op.state = "uncertain";
    } finally {
      run.activeMs = Math.min(TASK_LIMITS.activeMs, Math.max(0, TASK_LIMITS.activeMs - e.remaining + (e.timer ? Date.now() - e.since : 0)));
      run.state = t.state === "cancelled" ? "cancelled" : t.state === "interrupted" ? "interrupted" : t.state === "failed" ? "failed" : "review";
      run.ended = new Date().toISOString(); run.note = t.note;
      clearTimeout(e.timer);
      delete t.approval;
      await this.persist(t);
    }
  }

  async approve(req: Omit<TaskApproval, "expires" | "capabilityRevision">, emit?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<"allow" | "deny"> {
    const e = this.scope.getStore();
    if (!e || signal?.aborted) return "deny";
    signal ??= e.ctrl.signal;
    const t = e.task;
    clearTimeout(e.timer); delete e.timer; e.remaining -= Date.now() - e.since;
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
    if (e.ctrl.signal.aborted || signal.aborted || Date.parse(approval.expires) <= Date.now()) decision = "deny";
    if (decision === "allow") {
      try {
        this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
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
    if (decision === "allow") this.deps.ready(t.provider, t.model, t.integrations, t.confirmedFree);
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
    for (const e of this.running.values()) e.ctrl.abort(new Error("Application stopped; review before continuing"));
    await Promise.all(this.inflight);
    await this.checking;
    await Promise.all(this.writes.values());
  }
}
