import { parseSchedule, type OnceSchedule } from "./schedule.ts";

export type TaskSpending = { kind: "local_only" } | { kind: "api_allowed"; acknowledged: true } | { kind: "ceiling"; usd: number };
export function parseTaskSpending(value: unknown): TaskSpending {
  const raw = taskObject(value);
  if (raw.kind === "local_only") return { kind: "local_only" };
  if (raw.kind === "api_allowed" && raw.acknowledged === true) return { kind: "api_allowed", acknowledged: true };
  if (raw.kind === "ceiling" && typeof raw.usd === "number" && Number.isFinite(raw.usd) && raw.usd > 0) return { kind: "ceiling", usd: raw.usd };
  throw new Error("Choose a spending policy and acknowledge any model API charges");
}
export interface TaskLimits { runs: number; modelRequests: number; toolCalls: number; activeMs: number }
export interface TaskBudget { modelRequests: number; toolCalls: number; activeMs: number }
export const TASK_BUDGET_DEFAULTS: TaskLimits = { runs: 32, modelRequests: 96, toolCalls: 96, activeMs: 1_800_000 };
export const TASK_BUDGET_MAX: TaskLimits = { runs: 32, modelRequests: 384, toolCalls: 768, activeMs: 9_600_000 };
export function parseTaskLimits(value: unknown): TaskLimits {
  const raw = taskObject(value);
  const limit = (key: keyof TaskLimits, minimum = 1): number => {
    const n = integer(raw[key], TASK_BUDGET_MAX[key]);
    if (n < minimum) throw new Error("Task limits must be finite and within the supported range");
    return n;
  };
  return { runs: limit("runs"), modelRequests: limit("modelRequests"), toolCalls: limit("toolCalls", 0), activeMs: limit("activeMs", 1000) };
}
export type TaskState = "scheduled" | "paused" | "queued" | "running" | "needs_input" | "needs_approval" | "interrupted" | "completed" | "failed" | "cancelled";
export type TaskInput = { id: string } & (
  | { kind: "message"; message: string; action?: never; revision?: never }
  | { kind: "action"; message?: never; action: { surface: string; source: string; data: Record<string, unknown> }; revision: number }
);
export interface TaskApproval {
  id: string;
  server: string;
  tool: string;
  title: string;
  args: unknown;
  expires: string;
  capabilityRevision: number;
}
export interface TaskActivity { at: string; text: string }
export type TaskRunState = "running" | "review" | "accepted" | "failed" | "cancelled" | "interrupted";
export interface TaskRunIdentity { taskId: string; runId: string }
export interface TaskRun {
  id: string;
  sequence: number;
  inputId: string;
  inputKind: TaskInput["kind"];
  state: TaskRunState;
  started: string;
  ended?: string;
  recovered?: string;
  activeMs: number;
  chargedMs: number;
  toolCalls: number;
  modelRequests: number;
  stop?: string;
  note: string;
  review?: ResultReview;
}
export const TASK_RUN_LABELS: Record<TaskRunState, string> = { running: "In progress", review: "Ready for review", accepted: "Accepted", failed: "Could not finish", cancelled: "Cancelled", interrupted: "Interrupted" };
export interface TaskView {
  version: 5;
  revision: number;
  id: string;
  session: string;
  goal: string;
  criteria: string;
  provider: string;
  model: string;
  integrations: string[];
  confirmedFree: string[];
  spending: TaskSpending;
  limits: TaskLimits;
  budget: TaskBudget;
  state: TaskState;
  created: string;
  updated: string;
  note: string;
  runs: number;
  runHistory: TaskRun[];
  pending: TaskInput[];
  approval?: TaskApproval;
  activity: TaskActivity[];
  operations: { id: string; tool: string; runId?: string; state: "started" | "returned" | "failed" | "uncertain" | "reviewed" }[];
  accepted: string[];
  schedule?: OnceSchedule;
}
export type TaskSummary = Pick<TaskView, "id" | "session" | "goal" | "state" | "updated" | "revision" | "note" | "schedule">;
export const TASK_LIMITS = { rounds: 12, tools: 24, activeMs: 300_000, outputTokens: 4096, pending: 8, approvalMs: 300_000 } as const;
export const TASK_LABELS: Record<TaskState, string> = {
  scheduled: "Upcoming", paused: "Paused",
  queued: "Queued", running: "Working", needs_input: "Review result", needs_approval: "Needs approval",
  interrupted: "Interrupted", completed: "Completed", failed: "Could not finish", cancelled: "Cancelled",
};

export function taskObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function taskString(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Required text is missing or too long");
  return value.trim();
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid task collection");
  return value;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid task count or revision");
  return value;
}
function isState(value: unknown): value is TaskState { return typeof value === "string" && Object.hasOwn(TASK_LABELS, value); }
function isOperationState(value: unknown): value is TaskView["operations"][number]["state"] { return value === "started" || value === "returned" || value === "failed" || value === "uncertain" || value === "reviewed"; }
export function parseTaskInput(value: unknown): TaskInput {
  const raw = taskObject(value), id = taskString(raw.id, 120);
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid input identity");
  if (raw.action !== undefined) {
    if (raw.message !== undefined || (raw.kind !== undefined && raw.kind !== "action")) throw new Error("Choose a message or a surface action");
    const action = taskObject(raw.action);
    return { id, kind: "action", action: { surface: taskString(action.surface, 240), source: taskString(action.source, 240), data: taskObject(action.data) }, revision: integer(raw.revision, Number.MAX_SAFE_INTEGER) };
  }
  if (raw.kind !== undefined && raw.kind !== "message") throw new Error("Invalid input kind");
  return { id, kind: "message", message: taskString(raw.message, 8000) };
}
export function parseTaskView(value: unknown): TaskView {
  const raw = taskObject(value);
  if (raw.version !== 5 || !isState(raw.state)) throw new Error("Unsupported task journal version or state");
  const id = taskString(raw.id, 120), session = taskString(raw.session, 120);
  if (!/^[\w-]+$/.test(id) || session !== id) throw new Error("Invalid task identity");
  const created = taskString(raw.created, 40), updated = taskString(raw.updated, 40);
  if (!Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(updated))) throw new Error("Invalid task timestamp");
  const operations = array(raw.operations, 768).map((value) => {
    const op = taskObject(value);
    if (!isOperationState(op.state)) throw new Error("Invalid operation state");
    return { id: taskString(op.id, 120), tool: taskString(op.tool, 240), state: op.state, ...(op.runId === undefined ? {} : { runId: taskString(op.runId, 120) }) };
  });
  const runs = integer(raw.runs, 32);
  const runHistory = array(raw.runHistory, 32).map(parseTaskRun);
  const identities = new Set<string>();
  let sequence = 0;
  for (const run of runHistory) {
    if (identities.has(run.id) || run.sequence <= sequence || run.sequence > runs) throw new Error("Invalid run history identity or order");
    identities.add(run.id); sequence = run.sequence;
  }
  if (runHistory.length !== runs || runHistory.some((run, i) => run.sequence !== i + 1)) throw new Error("Run history must account for every run");
  if (runHistory.some((r, i) => r.state === "running" && i !== runHistory.length - 1)) throw new Error("Only the latest run may be in progress");
  if (operations.some((op) => op.runId !== undefined && !identities.has(op.runId))) throw new Error("Operation references an unknown run");
  const limits = parseTaskLimits(raw.limits), used = taskObject(raw.budget);
  const budget: TaskBudget = { modelRequests: integer(used.modelRequests, limits.modelRequests), toolCalls: integer(used.toolCalls, limits.toolCalls), activeMs: integer(used.activeMs, limits.activeMs) };
  if (runs > limits.runs || runHistory.reduce((n, run) => n + run.modelRequests, 0) !== budget.modelRequests || runHistory.reduce((n, run) => n + run.toolCalls, 0) !== budget.toolCalls || runHistory.reduce((n, run) => n + run.chargedMs, 0) !== budget.activeMs) throw new Error("Task budget does not match its run records");
  const approval = raw.approval === undefined ? undefined : taskObject(raw.approval);
  const schedule = raw.schedule === undefined ? undefined : parseSchedule(raw.schedule);
  if ((raw.state === "scheduled" && schedule?.status !== "armed") || (raw.state === "paused" && schedule?.status !== "paused")) throw new Error("Schedule state does not match its trigger");
  const note = typeof raw.note === "string" && raw.note.length <= 4000 ? raw.note : "";
  return {
    version: 5, revision: integer(raw.revision, Number.MAX_SAFE_INTEGER), id, session, goal: taskString(raw.goal, 8000), criteria: taskString(raw.criteria, 4000), provider: taskString(raw.provider, 120), model: taskString(raw.model, 240),
    integrations: array(raw.integrations, 16).map((v) => taskString(v, 120)), state: raw.state, created, updated, note, runs, runHistory, limits, budget,
    spending: parseTaskSpending(raw.spending), confirmedFree: array(raw.confirmedFree, 16).map((v) => taskString(v, 120)),
    pending: array(raw.pending, TASK_LIMITS.pending).map(parseTaskInput), accepted: array(raw.accepted, 256).map((v) => taskString(v, 120)), operations,
    activity: array(raw.activity, 100).map((v) => { const a = taskObject(v); return { at: taskString(a.at, 40), text: taskString(a.text, 1000) }; }),
    ...(schedule ? { schedule } : {}),
    ...(approval ? { approval: { id: taskString(approval.id, 120), server: taskString(approval.server, 120), tool: taskString(approval.tool, 240), title: taskString(approval.title, 1000), args: approval.args, expires: taskString(approval.expires, 40), capabilityRevision: integer(approval.capabilityRevision, Number.MAX_SAFE_INTEGER) } } : {}),
  };
}

export function parseTaskSummaries(value: unknown): TaskSummary[] {
  return array(value, 200).map((item) => {
    const raw = taskObject(item);
    if (!isState(raw.state)) throw new Error("Invalid task state");
    const id = taskString(raw.id, 120), session = taskString(raw.session, 120);
    if (!/^[\w-]+$/.test(id) || id !== session) throw new Error("Invalid task identity");
    return { id, session, revision: integer(raw.revision, Number.MAX_SAFE_INTEGER), goal: taskString(raw.goal, 120), state: raw.state, updated: taskString(raw.updated, 40), note: typeof raw.note === "string" ? raw.note : "", ...(raw.schedule === undefined ? {} : { schedule: parseSchedule(raw.schedule) }) };
  });
}


function parseTaskRun(value: unknown): TaskRun {
  const raw = taskObject(value);
  if (typeof raw.state !== "string" || !Object.hasOwn(TASK_RUN_LABELS, raw.state) || (raw.inputKind !== "message" && raw.inputKind !== "action")) throw new Error("Invalid run state or input kind");
  const timestamp = (value: unknown): string => {
    const at = taskString(value, 40);
    if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid run timestamp");
    return at;
  };
  const sequence = integer(raw.sequence, 32);
  if (sequence < 1) throw new Error("Invalid run sequence");
  const started = timestamp(raw.started), ended = raw.ended === undefined ? undefined : timestamp(raw.ended), recovered = raw.recovered === undefined ? undefined : timestamp(raw.recovered);
  if ((raw.state === "running" && (ended || recovered)) || (["review", "accepted", "failed", "cancelled"].includes(raw.state) && !ended) || (raw.state !== "interrupted" && recovered) || (ended && Date.parse(ended) < Date.parse(started))) throw new Error("Run timestamps do not match its state");
  if (integer(raw.activeMs, TASK_LIMITS.activeMs) > integer(raw.chargedMs, TASK_LIMITS.activeMs)) throw new Error("Recorded active time exceeds its budget charge");
  const review = raw.review === undefined ? undefined : parseResultReview(raw.review);
  if ((raw.state === "accepted") !== Boolean(review) || (review && review.runId !== raw.id)) throw new Error("Acceptance requires a matching user review");
  return { ...(review ? { review } : {}), id: taskString(raw.id, 120), sequence, inputId: taskString(raw.inputId, 120), inputKind: raw.inputKind, state: raw.state as TaskRunState, started, activeMs: integer(raw.activeMs, TASK_LIMITS.activeMs), chargedMs: integer(raw.chargedMs, TASK_LIMITS.activeMs), toolCalls: integer(raw.toolCalls, TASK_LIMITS.tools), modelRequests: integer(raw.modelRequests, TASK_LIMITS.rounds), note: typeof raw.note === "string" && raw.note.length <= 4000 ? raw.note : "", ...(ended ? { ended } : {}), ...(recovered ? { recovered } : {}), ...(raw.stop === undefined ? {} : { stop: taskString(raw.stop, 120) }) };
}


export interface ReviewSnapshot {
  revision: number;
  runId: string;
  fingerprint: string;
  assistantAt: string;
  surfaces: { id: string; title: string; version: number }[];
}
export interface ResultReview extends ReviewSnapshot {
  method: "user";
  at: string;
  note: string;
}
export function parseReviewSnapshot(value: unknown): ReviewSnapshot {
  const raw = taskObject(value);
  const count = (n: unknown): number => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid review revision");
    return n;
  };
  if (typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint) || !Array.isArray(raw.surfaces) || raw.surfaces.length > 1000) throw new Error("Invalid result evidence");
  const assistantAt = taskString(raw.assistantAt, 40);
  if (!Number.isFinite(Date.parse(assistantAt))) throw new Error("Invalid result timestamp");
  const surfaces = raw.surfaces.map((value) => {
    const s = taskObject(value);
    return { id: taskString(s.id, 240), title: taskString(s.title, 1000), version: count(s.version) };
  });
  if (new Set(surfaces.map((s) => s.id)).size !== surfaces.length) throw new Error("Duplicate evidence surface");
  return { revision: count(raw.revision), runId: taskString(raw.runId, 120), fingerprint: raw.fingerprint, assistantAt, surfaces };
}
export function parseResultReview(value: unknown): ResultReview {
  const raw = taskObject(value), at = taskString(raw.at, 40);
  if (raw.method !== "user" || !Number.isFinite(Date.parse(at))) throw new Error("Invalid user review");
  return { ...parseReviewSnapshot(raw), method: "user", at, note: taskString(raw.note, 4000) };
}
