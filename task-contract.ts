export type TaskState = "queued" | "running" | "needs_input" | "needs_approval" | "interrupted" | "completed" | "failed" | "cancelled";
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
export interface TaskView {
  version: 1;
  revision: number;
  id: string;
  session: string;
  goal: string;
  criteria: string;
  provider: string;
  model: string;
  integrations: string[];
  confirmedFree: string[];
  state: TaskState;
  created: string;
  updated: string;
  note: string;
  runs: number;
  pending: TaskInput[];
  approval?: TaskApproval;
  activity: TaskActivity[];
  operations: { id: string; tool: string; state: "started" | "returned" | "failed" | "uncertain" | "reviewed" }[];
  accepted: string[];
}
export type TaskSummary = Pick<TaskView, "id" | "session" | "goal" | "state" | "updated" | "revision" | "note">;
export const TASK_LIMITS = { rounds: 12, tools: 24, activeMs: 300_000, outputTokens: 4096, pending: 8, approvalMs: 300_000 } as const;
export const TASK_LABELS: Record<TaskState, string> = {
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
  if (raw.version !== 1 || !isState(raw.state)) throw new Error("Unsupported task journal version or state");
  const id = taskString(raw.id, 120), session = taskString(raw.session, 120);
  if (!/^[\w-]+$/.test(id) || session !== id) throw new Error("Invalid task identity");
  const created = taskString(raw.created, 40), updated = taskString(raw.updated, 40);
  if (!Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(updated))) throw new Error("Invalid task timestamp");
  const operations = array(raw.operations, 768).map((value) => {
    const op = taskObject(value);
    if (!isOperationState(op.state)) throw new Error("Invalid operation state");
    return { id: taskString(op.id, 120), tool: taskString(op.tool, 240), state: op.state };
  });
  const approval = raw.approval === undefined ? undefined : taskObject(raw.approval);
  const note = typeof raw.note === "string" && raw.note.length <= 4000 ? raw.note : "";
  return {
    version: 1, revision: integer(raw.revision ?? 0, Number.MAX_SAFE_INTEGER), id, session, goal: taskString(raw.goal, 8000), criteria: taskString(raw.criteria, 4000), provider: taskString(raw.provider, 120), model: taskString(raw.model, 240),
    integrations: array(raw.integrations, 16).map((v) => taskString(v, 120)), state: raw.state, created, updated, note, runs: integer(raw.runs, 32),
    confirmedFree: array(raw.confirmedFree ?? [], 16).map((v) => taskString(v, 120)),
    pending: array(raw.pending, TASK_LIMITS.pending).map(parseTaskInput), accepted: array(raw.accepted, 256).map((v) => taskString(v, 120)), operations,
    activity: array(raw.activity, 100).map((v) => { const a = taskObject(v); return { at: taskString(a.at, 40), text: taskString(a.text, 1000) }; }),
    ...(approval ? { approval: { id: taskString(approval.id, 120), server: taskString(approval.server, 120), tool: taskString(approval.tool, 240), title: taskString(approval.title, 1000), args: approval.args, expires: taskString(approval.expires, 40), capabilityRevision: integer(approval.capabilityRevision ?? 0, Number.MAX_SAFE_INTEGER) } } : {}),
  };
}

export function parseTaskSummaries(value: unknown): TaskSummary[] {
  return array(value, 200).map((item) => {
    const raw = taskObject(item);
    if (!isState(raw.state)) throw new Error("Invalid task state");
    const id = taskString(raw.id, 120), session = taskString(raw.session, 120);
    if (!/^[\w-]+$/.test(id) || id !== session) throw new Error("Invalid task identity");
    return { id, session, revision: integer(raw.revision, Number.MAX_SAFE_INTEGER), goal: taskString(raw.goal, 120), state: raw.state, updated: taskString(raw.updated, 40), note: typeof raw.note === "string" ? raw.note : "" };
  });
}
