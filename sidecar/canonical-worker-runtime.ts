// One pure preparation operation. Only Rust selects and persists the result.
import type { Readable, Writable } from "node:stream";
import { prepareCandidatePublication, type HostSessionSnapshot } from "@vak/host";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";

const MAX_FRAME = 20 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function canonicalWorkerRuntime(input: Readable, output: Writable, finished: (code: number) => void): { close(): void } {
  let closed = false, done = false, parts: string[] = [], bytes = 0;
  const finish = (code: number) => { if (!done) { done = true; finished(code); } };
  const close = () => { if (!closed) { closed = true; clearTimeout(timer); finish(1); } };
  const terminal = (frame: Record<string, unknown>, code: number) => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    const timeout = setTimeout(() => finish(1), 3000);
    const body = JSON.stringify({ v: DESKTOP_PROTOCOL, ...frame }) + "\n";
    if (Buffer.byteLength(body) > MAX_FRAME) { clearTimeout(timeout); finish(1); return; }
    output.write(body, error => { clearTimeout(timeout); finish(error ? 1 : code); });
  };
  const timer = setTimeout(() => terminal({ type: "canonical_failed", code: "bootstrap_timeout" }, 1), 10_000);
  const receive = (frame: unknown) => {
    if (!object(frame) || Object.keys(frame).length !== 3 || frame.v !== DESKTOP_PROTOCOL || frame.type !== "canonical_prepare" || !object(frame.context)) throw new Error("Invalid canonical command");
    const context = frame.context;
    if (Object.keys(context).some(key => !["id", "candidate", "base", "message", "at"].includes(key)) || typeof context.id !== "string" || !/^publication-[a-f0-9]{64}$/.test(context.id)
      || typeof context.message !== "string" || typeof context.at !== "string") throw new Error("Invalid canonical context");
    const snapshot = prepareCandidatePublication({ candidate: context.candidate, base: context.base as HostSessionSnapshot | undefined, message: context.message, at: context.at });
    terminal({ type: "canonical_prepared", id: context.id, snapshot }, 0);
  };
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    if (closed) return;
    try {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) if (i === chunk.length || chunk[i] === "\n") {
        const part = chunk.slice(start, i); bytes += Buffer.byteLength(part); parts.push(part);
        if (bytes > MAX_FRAME || parts.length > 1024) throw new Error("Canonical frame exceeds bound");
        if (i < chunk.length) { receive(JSON.parse(parts.join(""))); parts = []; bytes = 0; if (closed) return; }
        start = i + 1;
      }
    } catch { terminal({ type: "canonical_failed", code: "invalid_candidate_or_protocol" }, 1); }
  });
  input.on("end", close); input.on("error", close); output.on("error", () => { clearTimeout(timer); finish(1); closed = true; });
  output.write(JSON.stringify({ v: DESKTOP_PROTOCOL, type: "canonical_ready" }) + "\n", error => { if (error) close(); });
  return { close };
}
