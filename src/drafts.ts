import { getAt, setAt, type SurfaceSnapshot } from "@vak/core";

type Edit = { base?: unknown; value?: unknown; conflict?: boolean };
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const prefix = "vak:drafts:v1:";

/** Only unsent bound field edits persist here; canonical surfaces remain host-owned. */
export class Drafts {
  private session = "";
  private edits = new Map<string, Map<string, Edit>>();
  private bases = new Map<string, Record<string, unknown>>();
  private storage: Storage;
  private warn: (message: string) => void;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(storage: Storage, warn: (message: string) => void) { this.storage = storage; this.warn = warn; }
  begin(session: string): void {
    this.flush(); this.session = session; this.edits.clear(); this.bases.clear();
    try {
      const value: unknown = JSON.parse(this.storage.getItem(prefix + session) ?? "[]");
      if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid drafts");
      for (const row of value) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !Array.isArray(row[1]) || row[1].length > 256) throw new Error("Invalid draft fields");
        const fields = new Map<string, Edit>();
        for (const field of row[1]) {
          if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== "string" || !field[0].startsWith("/") || !field[1] || typeof field[1] !== "object" || Array.isArray(field[1])) throw new Error("Invalid draft value");
          const raw: Record<string, unknown> = field[1];
          fields.set(field[0], { base: raw.base, value: raw.value, conflict: raw.conflict === true });
        }
        this.edits.set(row[0], fields);
      }
    } catch { this.warn("Saved drafts could not be restored. Existing saved results are still available."); }
  }
  record(surface: string, pointer: string, value: unknown): void {
    const base = getAt(this.bases.get(surface), pointer);
    const fields = this.edits.get(surface) ?? new Map<string, Edit>();
    this.edits.set(surface, fields);
    const previous = fields.get(pointer);
    if (equal(base, value)) fields.delete(pointer);
    else fields.set(pointer, { base: structuredClone(previous ? previous.base : base), value: structuredClone(value), conflict: previous?.conflict });
    clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 150);
  }
  receive(snapshot: SurfaceSnapshot): SurfaceSnapshot {
    this.bases.set(snapshot.id, structuredClone(snapshot.data));
    const copy = structuredClone(snapshot);
    const fields = this.edits.get(snapshot.id);
    if (!fields) return copy;
    for (const [pointer, edit] of fields) {
      if (!edit || typeof edit !== "object" || !pointer.startsWith("/")) continue;
      const latest = getAt(snapshot.data, pointer);
      if (equal(latest, edit.value)) { fields.delete(pointer); continue; }
      if (!equal(latest, edit.base)) edit.conflict = true;
      setAt(copy.data, pointer, structuredClone(edit.value));
    }
    this.flush();
    return copy;
  }
  /** Input typed into a surface that it does not hold yet. */
  pending(surface: string): boolean { return (this.edits.get(surface)?.size ?? 0) > 0; }
  conflicted(surface: string): boolean { return [...(this.edits.get(surface)?.values() ?? [])].some((edit) => edit.conflict); }
  resolve(snapshot: SurfaceSnapshot, keep: boolean): SurfaceSnapshot {
    const copy = structuredClone(snapshot), fields = this.edits.get(snapshot.id) ?? new Map<string, Edit>();
    for (const [pointer, edit] of fields) {
      if (!edit.conflict) continue;
      const latest = getAt(this.bases.get(snapshot.id), pointer);
      if (keep) { edit.base = structuredClone(latest); edit.conflict = false; }
      else { setAt(copy.data, pointer, structuredClone(latest)); fields.delete(pointer); }
    }
    this.flush(); return copy;
  }
  remove(surface: string): void { this.edits.delete(surface); this.bases.delete(surface); this.flush(); }
  clear(session: string): void {
    if (session === this.session) { this.edits.clear(); this.bases.clear(); this.session = ""; }
    try { this.storage.removeItem(prefix + session); } catch { this.warn("Draft removal failed. Try again before closing the app."); }
  }
  flush(): void {
    clearTimeout(this.timer);
    if (!this.session) return;
    try {
      const body = JSON.stringify([...this.edits].map(([id, fields]) => [id, [...fields]]));
      if (body.length > 512_000) throw new Error("Draft limit reached");
      this.storage.setItem(prefix + this.session, body);
    } catch { this.warn("Drafts could not be saved on this device. Keep this view open and copy important unsent values."); }
  }
}
