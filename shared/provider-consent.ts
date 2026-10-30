export interface ProviderConsent {
  root_id: string; session_id: string; goal: string; remaining_seconds: number;
  approval: { ticket_id: string; fingerprint: string; disclosure: { provider: string; model: string; operation: string; destination: string; max_output_tokens: number; preview: string } };
}
export interface ConsentRequestSlice { offset: number; next: number; total: number; text: string }
export interface ConsentReceipt { ticket_id: string; state: "allowed" | "denied" | "refused" | "cancelled"; operation_id: string | null }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => text(value, 120) && /^[A-Za-z0-9_-]+$/.test(value);
export function parseProviderConsents(value: unknown): ProviderConsent[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("Invalid permission queue");
  const seen = new Set<string>();
  for (const view of value) {
    if (!object(view) || !keys(view, ["root_id", "session_id", "goal", "remaining_seconds", "approval"]) || !id(view.root_id) || !id(view.session_id) || !text(view.goal, 8000) || !Number.isInteger(view.remaining_seconds) || Number(view.remaining_seconds) < 0 || Number(view.remaining_seconds) > 300 || !object(view.approval)) throw new Error("Invalid permission request");
    const a = view.approval, d = a.disclosure;
    if (!keys(a, ["ticket_id", "fingerprint", "disclosure"]) || !id(a.ticket_id) || seen.has(a.ticket_id) || typeof a.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(a.fingerprint) || !object(d) || !keys(d, ["provider", "model", "operation", "destination", "max_output_tokens", "preview"])
      || !text(d.provider, 64) || !text(d.model, 256) || !text(d.operation, 64) || !text(d.destination, 512) || !Number.isInteger(d.max_output_tokens) || Number(d.max_output_tokens) < 1 || Number(d.max_output_tokens) > 4096 || typeof d.preview !== "string" || d.preview.length > 1024) throw new Error("Invalid permission disclosure");
    seen.add(a.ticket_id);
  }
  return value as ProviderConsent[];
}
export function parseConsentSlice(value: unknown): ConsentRequestSlice {
  if (!object(value) || !keys(value, ["offset", "next", "total", "text"]) || ![value.offset, value.next, value.total].every(n => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 8 * 1024 * 1024)
    || Number(value.total) === 0 || Number(value.offset) > Number(value.next) || Number(value.next) === Number(value.offset) && Number(value.next) < Number(value.total) || Number(value.next) > Number(value.total) || Number(value.next) - Number(value.offset) > 4096 || typeof value.text !== "string" || value.text.length > 4096 || new TextEncoder().encode(value.text).length !== Number(value.next) - Number(value.offset)) throw new Error("Invalid request page");
  return value as unknown as ConsentRequestSlice;
}
export function parseConsentReceipt(value: unknown, ticket: string): ConsentReceipt {
  if (!object(value) || !keys(value, ["ticket_id", "state", "operation_id"]) || value.ticket_id !== ticket || !["allowed", "denied", "refused", "cancelled"].includes(String(value.state)) || !(value.operation_id === null || id(value.operation_id)) || value.state === "allowed" && !id(value.operation_id) || value.state === "denied" && value.operation_id !== null) throw new Error("Unconfirmed permission decision");
  return value as unknown as ConsentReceipt;
}
