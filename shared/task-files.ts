export type TaskFileInput = { name: string; content: string; sha256: string; bytes: number };
export type TaskOutput = { kind: "markdown" };
export type OutputReceipt = { state: "pending" | "saved" | "failed" | "missing" | "modified"; filename: string; sha256: string; bytes: number; at: string; surfaces?: { id: string; version: number }[]; error?: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function parseTaskFiles(value: unknown, persisted = false): TaskFileInput[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("Choose up to four UTF-8 text, Markdown, CSV or JSON files");
  const names = new Set<string>();
  let total = 0;
  return value.map((input) => {
    if (!object(input) || Object.keys(input).some((key) => !["name", "content", ...(persisted ? ["sha256", "bytes"] : [])].includes(key)) || typeof input.name !== "string" || input.name.length > 120 || !/^[^/\\\u0000-\u001f]+\.(txt|md|csv|json)$/i.test(input.name) || names.has(input.name) || typeof input.content !== "string" || input.content.includes("\u0000")) throw new Error("Inputs need distinct supported filenames and UTF-8 text contents, without paths");
    names.add(input.name);
    const bytes = new TextEncoder().encode(input.content).length, sha256 = persisted ? input.sha256 : "";
    total += bytes;
    if (bytes > 16000 || total > 48000) throw new Error("Inputs are limited to 16,000 bytes each and 48,000 bytes in total");
    if (persisted && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || input.bytes !== bytes)) throw new Error("Input snapshot does not match its recorded hash and size");
    return { name: input.name, content: input.content, sha256: sha256 as string, bytes };
  });
}
export function parseTaskOutput(value: unknown): TaskOutput {
  if (!object(value) || Object.keys(value).length !== 1 || value.kind !== "markdown") throw new Error("Choose the local task Markdown destination");
  return { kind: "markdown" };
}
export function parseDiagnosticDays(value: unknown): number {
  if (typeof value !== "number" || ![0, 1, 7, 30].includes(value)) throw new Error("Choose diagnostic retention of 0, 1, 7 or 30 days");
  return value;
}
export function parseOutputReceipt(value: unknown): OutputReceipt {
  if (!object(value) || !["pending", "saved", "failed", "missing", "modified"].includes(String(value.state)) || typeof value.filename !== "string" || !/^[\w-]{1,120}--[\w-]{1,120}\.md$/.test(value.filename) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 2_000_000 || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || value.error !== undefined && (typeof value.error !== "string" || value.error.length > 1000)) throw new Error("Invalid output receipt");
  if (value.surfaces !== undefined && (!Array.isArray(value.surfaces) || value.surfaces.length > 64 || value.surfaces.some((surface) => !object(surface) || typeof surface.id !== "string" || !surface.id || surface.id.length > 240 || typeof surface.version !== "number" || !Number.isSafeInteger(surface.version) || surface.version < 0))) throw new Error("Invalid output surface references");
  const surfaces = (value.surfaces as { id: string; version: number }[] | undefined)?.map((surface) => ({ id: surface.id as string, version: surface.version as number }));
  if (surfaces && new Set(surfaces.map((surface) => surface.id)).size !== surfaces.length) throw new Error("Duplicate output surface references");
  return { state: value.state as OutputReceipt["state"], filename: value.filename, sha256: value.sha256, bytes: value.bytes, at: value.at, ...(surfaces ? { surfaces } : {}), ...(typeof value.error === "string" ? { error: value.error } : {}) };
}
