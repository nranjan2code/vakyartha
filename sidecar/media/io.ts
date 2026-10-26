import { pinnedFetch } from "@vak/providers";

export const INPUT_LIMIT = 20_000_000;
export const OUTPUT_LIMIT = 100_000_000;
export const TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/flac": ".flac", "audio/ogg": ".ogg", "video/mp4": ".mp4", "video/webm": ".webm" };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid media response");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Expected text, 1–${max} characters`);
  return value.trim();
}
export function base64(value: unknown, max = OUTPUT_LIMIT): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid or oversized media data");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max) throw new Error("Empty or oversized media file");
  return bytes;
}
export function mediaType(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  const starts = (s: string, offset = 0) => b.subarray(offset, offset + s.length).toString("latin1") === s;
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
  if (starts("RIFF") && starts("WAVE", 8)) return "audio/wav";
  if (starts("ID3") || (b[0] === 255 && ((b[1] ?? 0) & 224) === 224)) return "audio/mpeg";
  if (starts("fLaC")) return "audio/flac";
  if (starts("OggS")) return "audio/ogg";
  if (starts("ftyp", 4)) return "video/mp4";
  if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return "video/webm";
  throw new Error("Unsupported media file signature");
}
export async function bounded(res: Response, max = OUTPUT_LIMIT): Promise<Buffer> {
  if (Number(res.headers.get("content-length")) > max) { await res.body?.cancel(); throw new Error("Media response is too large"); }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty media response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error("Media response is too large"); chunks.push(value); }
  } catch (err) { await reader.cancel(); throw err; }
  return Buffer.concat(chunks);
}
export async function jsonResponse(res: Response): Promise<Record<string, unknown>> {
  // Provider error bodies can echo inputs or credentials. Keep errors numeric.
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Media provider returned HTTP ${res.status}`); }
  return object(JSON.parse((await bounded(res, 32_000_000)).toString("utf8")));
}
export type Download = (url: string, signal: AbortSignal) => Promise<Buffer>;
export const download: Download = async (raw, signal) => {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) throw new Error("Unsupported media download destination");
    // pinnedFetch validates public addresses at connection time, on every hop.
    const res = await pinnedFetch(url, { signal, maxBytes: OUTPUT_LIMIT, credentials: "omit" });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) { url = new URL(res.headers.get("location")!, url).href; await res.body?.cancel(); continue; }
    if (!res.ok) throw new Error(`Media download returned HTTP ${res.status}`);
    return bounded(res);
  }
  throw new Error("Too many media download redirects");
};
