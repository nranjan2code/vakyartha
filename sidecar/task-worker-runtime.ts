// One candidate invocation, explicit context only. No application server,
// session transport, integrations, credentials, task journal or output writer.
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { createHost, type HostCandidateResult } from "@vak/host";
import type { SurfaceSnapshot } from "@vak/core";
import { ollama, ProfileCache, type ProviderTransport } from "@vak/providers";
import path from "node:path";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
import { inputInstructions, parseTaskFiles, type TaskFileInput } from "../shared/task-files.ts";
import { providerChannel } from "./provider-channel.ts";

export const MAX_TASK_FRAME = 20 * 1024 * 1024;
const MAX_CONTEXT = 8 * 1024 * 1024;
export interface TaskWorkerJob {
  runId: string; session: string; provider: "ollama"; model: string;
  goal: string; criteria: string; instructions: string;
  inputs: TaskFileInput[]; initialSurfaces: SurfaceSnapshot[];
  maxSteps: number; maxTokens: number; activeMs: number;
  skills?: Array<{ name: string; description?: string }>;
  continuation?: Array<{ role: string; content: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value) <= max && !value.includes("\0");
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export function parseTaskWorkerJob(value: unknown): TaskWorkerJob {
  const requiredKeys = ["runId", "session", "provider", "model", "goal", "criteria", "instructions", "inputs", "initialSurfaces", "maxSteps", "maxTokens", "activeMs"];
  const optionalKeys = ["skills", "continuation"];
  if (!object(value)) throw new Error("Invalid task worker context");
  for (const key of Object.keys(value)) {
    if (!requiredKeys.includes(key) && !optionalKeys.includes(key)) throw new Error("Invalid task worker context key: " + key);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw new Error("Missing required task worker context key: " + key);
  }
  if (typeof value.runId !== "string" || !/^run-[1-9][0-9]{0,19}$/.test(value.runId)
    || typeof value.session !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value.session)
    || value.provider !== "ollama" || !text(value.model, 240) || !text(value.goal, 8000) || !text(value.criteria, 4000)
    || typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 64_000 || value.instructions.includes("\0")
    || !integer(value.maxSteps, 1, 12) || !integer(value.maxTokens, 1, 4096) || !integer(value.activeMs, 1000, 300_000)
    || !Array.isArray(value.initialSurfaces) || value.initialSurfaces.length > 16 || Buffer.byteLength(JSON.stringify(value.initialSurfaces)) > MAX_CONTEXT) throw new Error("Invalid task worker context");
  const inputs = parseTaskFiles(value.inputs, true);
  if (inputs.some(input => createHash("sha256").update(input.content).digest("hex") !== input.sha256)) throw new Error("Invalid task input fingerprint");
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > 16 || value.skills.some(s => !object(s) || typeof s.name !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(s.name) || (s.description !== undefined && (typeof s.description !== "string" || s.description.length > 1000)))) throw new Error("Invalid skills context");
  }
  if (value.continuation !== undefined) {
    if (!Array.isArray(value.continuation) || value.continuation.length > 16 || value.continuation.some(c => !object(c) || typeof c.role !== "string" || !["user", "assistant", "system"].includes(c.role) || typeof c.content !== "string" || c.content.length > 16000 || c.content.includes("\0"))) throw new Error("Invalid continuation context");
  }
  // Projection validates every surface in its isolated store. This parser only
  // bounds the envelope; it does not interpret model output or grant completion.
  return structuredClone({ ...value, inputs }) as unknown as TaskWorkerJob;
}

export async function generateTaskCandidate(job: TaskWorkerJob, scratch: string, transport: ProviderTransport, signal: AbortSignal): Promise<HostCandidateResult> {
  const boundTransport: ProviderTransport = (provider, input, init, context) => {
    if (provider !== job.provider) return Promise.reject(new Error("Task provider changed"));
    return transport(provider, input, init, { ...context!, sessionId: job.session, runId: job.runId });
  };
  const host = createHost({
    providers: () => [{ id: "ollama", label: "Local model", available: true, make: options => ollama({ think: options?.think, transport: boundTransport }) }],
    profiles: new ProfileCache(path.join(scratch, "profiles.json")),
    instructions: job.instructions, log: () => {},
  });
  let skillInstructions = "";
  if (job.skills && job.skills.length > 0) {
    skillInstructions = "\n\nAvailable procedural skills:\n" + job.skills.map(s => `- ${s.name}: ${s.description ?? "Procedural guidance"}`).join("\n");
  }
  let continuationContext = "";
  if (job.continuation && job.continuation.length > 0) {
    continuationContext = "\n\nContinuation history from prior runs:\n" + job.continuation.map(c => `[${c.role}]: ${c.content}`).join("\n\n");
  }
  return host.runCandidate({ session: job.session, provider: job.provider, model: job.model, message: job.goal, initialSurfaces: job.initialSurfaces }, {
    signal, tools: [], maxSteps: job.maxSteps, maxTokens: job.maxTokens,
    instructions: `Completion criteria supplied by the user: ${JSON.stringify(job.criteria)}\n${inputInstructions(job.inputs)}${skillInstructions}${continuationContext}\nReturn a candidate for independent review. Do not claim canonical publication, saved output or task completion.`,
  });
}

export function taskWorkerRuntime(input: Readable, output: Writable, scratch: string, finished: (code: number) => void): { close(): void } {
  let started = false, closed = false, finishedOnce = false;
  let waitingConsent = false, activeRemaining = 0, activeSince = 0;
  const finish = (code: number) => { if (!finishedOnce) { finishedOnce = true; finished(code); } };
  const abort = new AbortController();
  const send = (frame: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    if (closed) { reject(new Error("Task channel closed")); return; }
    const bytes = JSON.stringify({ v: DESKTOP_PROTOCOL, ...frame }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_TASK_FRAME) { reject(new Error("Task frame exceeds its bound")); return; }
    output.write(bytes, error => error ? reject(error) : resolve());
  });
  const providers = providerChannel(send, 1, 300_000);
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); abort.abort(); providers.close(); finish(1); };
  const terminal = async (frame: Record<string, unknown>, code: number) => {
    if (closed) return;
    // Fence all input synchronously before awaiting an output flush.
    closed = true; clearTimeout(timer); abort.abort(); providers.close();
    const bytes = JSON.stringify({ v: DESKTOP_PROTOCOL, ...frame }) + "\n";
    const flushDeadline = setTimeout(() => finish(1), 3000);
    try {
      if (Buffer.byteLength(bytes) > MAX_TASK_FRAME) throw new Error("Task result exceeds its bound");
      await new Promise<void>((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
      finish(code);
    } catch { finish(1); }
    finally { clearTimeout(flushDeadline); }
  };
  const fail = (code: string) => { void terminal({ type: "task_failed", code }, 1).catch(() => {}); };
  let timer = setTimeout(() => fail("bootstrap_timeout"), 10_000);
  const receive = (frame: unknown) => {
    if (!object(frame) || frame.v !== DESKTOP_PROTOCOL) throw new Error("Invalid task frame");
    if (providers.receive(frame)) return;
    if (frame.type === "task_cancel" && Object.keys(frame).length === 2) { fail("cancelled"); return; }
    if (started && frame.type === "task_consent" && Object.keys(frame).length === 3 && typeof frame.waiting === "boolean") {
      if (waitingConsent === frame.waiting) throw new Error("Duplicate consent phase");
      clearTimeout(timer);
      if (frame.waiting) {
        activeRemaining = Math.max(0, activeRemaining - (performance.now() - activeSince));
        if (activeRemaining === 0) { fail("active_time_limit"); return; }
        timer = setTimeout(() => fail("consent_time_limit"), 300_000);
      } else {
        activeSince = performance.now();
        timer = setTimeout(() => fail("active_time_limit"), activeRemaining);
      }
      waitingConsent = frame.waiting;
      return;
    }
    if (started || frame.type !== "task_start" || Object.keys(frame).length !== 3) throw new Error("Unexpected task command family");
    const job = parseTaskWorkerJob(frame.job); started = true;
    activeRemaining = job.activeMs; activeSince = performance.now();
    clearTimeout(timer); timer = setTimeout(() => fail("active_time_limit"), activeRemaining);
    void generateTaskCandidate(job, scratch, providers.fetch, abort.signal).then(candidate => {
      if (!closed) return terminal({ type: "task_candidate", runId: job.runId, candidate }, 0);
    }).catch(() => { if (!closed) fail("generation_error"); });
  };
  let parts: string[] = [], bytes = 0;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    if (closed) return;
    try {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) if (i === chunk.length || chunk[i] === "\n") {
        const part = chunk.slice(start, i); bytes += Buffer.byteLength(part); parts.push(part);
        if (bytes > MAX_TASK_FRAME || parts.length > 1024) throw new Error("Task frame exceeds its bound");
        if (i < chunk.length) { receive(JSON.parse(parts.join(""))); parts = []; bytes = 0; if (closed) return; }
        start = i + 1;
      }
    } catch { fail("protocol_error"); }
  });
  input.on("end", close); input.on("error", close); output.on("error", close);
  void send({ type: "task_ready" }).catch(close);
  return { close };
}
