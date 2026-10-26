/** One-time triggers store an instant, never a long-lived timer or a recurring wall-clock rule. */
export interface OnceSchedule {
  kind: "once";
  at: string;
  timezone: string;
  status: "armed" | "paused" | "dispatched";
  missed: "review";
}
export const SCHEDULE_GRACE_MS = 60_000;

export function parseSchedule(value: unknown): OnceSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schedule");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "once" || raw.missed !== "review" || (raw.status !== "armed" && raw.status !== "paused" && raw.status !== "dispatched")) throw new Error("Unsupported schedule type or status");
  if (typeof raw.at !== "string" || !/^\d{4}-\d\d-\d\dT/.test(raw.at) || !Number.isFinite(Date.parse(raw.at))) throw new Error("Choose a valid date and time");
  if (typeof raw.timezone !== "string" || raw.timezone.length > 100) throw new Error("Choose a valid time zone");
  try { new Intl.DateTimeFormat("en", { timeZone: raw.timezone }); } catch { throw new Error("Choose a valid time zone"); }
  return { kind: "once", at: new Date(raw.at).toISOString(), timezone: raw.timezone, status: raw.status, missed: "review" };
}

export function scheduleLabel(schedule?: OnceSchedule): string {
  if (!schedule) return "Run now";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: schedule.timezone }).format(new Date(schedule.at)) + ` · ${schedule.timezone}`;
}
