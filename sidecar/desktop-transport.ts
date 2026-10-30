// One private parent connection, multiplexed by request identity. No socket,
// URL listener or independently reachable endpoint exists in desktop mode.
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ProviderTransport } from "@vak/providers";
import type { HostCandidateCommitRequest, HostCandidateCommitReceipt, HostSessionSnapshot, HostSessionStore, SessionSummary } from "@vak/host";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
export { DESKTOP_PROTOCOL };
import { providerChannel } from "./provider-channel.ts";

const MAX_BODY = 32 * 1024 * 1024, MAX_FRAME = 48 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;
type Pending = { controller: AbortController; ack?: () => void };
type ControlHealth = { status: "ready" | "unavailable" | "overloaded" };
type ControlResult = ControlHealth | { status: "committed"; receipt: HostCandidateCommitReceipt } | { status: "loaded"; revision: number; snapshot: HostSessionSnapshot } | { status: "saved"; revision: number } | { status: "listed"; sessions: SessionSummary[] } | { status: "removed" };
type CandidateIdentity = { commitId: string; session: string; rootId: string; rootRevision: number; contractRevision: number; cancellationEpoch: number; expectedCanonicalRevision: number };
type ControlPending = { kind: "health" | "candidate" | "session"; candidate?: CandidateIdentity; accept?: (frame: Record<string, unknown>) => ControlResult; resolve(value: ControlResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export function desktopTransport(request: (r: Request) => Promise<Response>, token: string, input: Readable, output: Writable, failed: (error: Error) => void): { close(): void; pingControl(): Promise<ControlHealth>; commitCandidate(candidate: HostCandidateCommitRequest): Promise<HostCandidateCommitReceipt>; hostSessionStore: HostSessionStore; providerFetch: ProviderTransport } {
  const active = new Map<string, Pending>();
  const controlPending = new Map<string, ControlPending>();
  let closed = false;
  const providers = providerChannel(send);
  function send(message: Record<string, unknown>): Promise<void> {
    if (closed) return Promise.reject(new Error("Parent connection closed"));
    return new Promise((resolve, reject) => output.write(JSON.stringify({ v: DESKTOP_PROTOCOL, ...message }) + "\n", (error) => error ? reject(error) : resolve()));
  }
  function close(): void {
    if (closed) return;
    closed = true;
    for (const p of active.values()) { p.controller.abort(); p.ack?.(); }
    active.clear();
    for (const p of controlPending.values()) { clearTimeout(p.timer); p.reject(new Error("Parent connection closed")); }
    controlPending.clear();
    providers.close();
  }
  function pingControl(): Promise<ControlHealth> {
    if (closed) return Promise.reject(new Error("Parent connection closed"));
    if (controlPending.size >= 8) return Promise.reject(new Error("Native control queue is full"));
    const id = `ctl-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controlPending.delete(id);
        reject(new Error("Native control health request timed out"));
      }, 5000);
      timer.unref();
      controlPending.set(id, { kind: "health", resolve: (value) => resolve(value as ControlHealth), reject, timer });
      void send({ id, type: "control_request", operation: "health" }).catch((error: unknown) => {
        const pending = controlPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        controlPending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Native control write failed"));
      });
    });
  }
  function commitCandidate(candidate: HostCandidateCommitRequest): Promise<HostCandidateCommitReceipt> {
    if (closed) return Promise.reject(new Error("Native control connection closed"));
    if ([...controlPending.values()].some((pending) => pending.kind === "candidate")) return Promise.reject(new Error("Native candidate commit is already in flight"));
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(candidate.session) || !/^[A-Za-z0-9_-]{1,120}$/.test(candidate.commitId)
      || !/^[A-Za-z0-9_-]{1,120}$/.test(candidate.fence.rootId)
      || ![candidate.expectedCanonicalRevision, candidate.fence.rootRevision, candidate.fence.contractRevision, candidate.fence.cancellationEpoch].every((value) => Number.isSafeInteger(value) && value >= 0)) return Promise.reject(new Error("Native candidate identity or fence is invalid"));
    if (Buffer.byteLength(JSON.stringify(candidate)) > 8 * 1024 * 1024) return Promise.reject(new Error("Native candidate exceeds the 8 MiB limit"));
    const id = `ctl-${randomUUID()}`;
    const operation = { candidate_commit: {
      session_id: candidate.session,
      commit_id: candidate.commitId,
      fence: {
        root_id: candidate.fence.rootId,
        root_revision: candidate.fence.rootRevision,
        contract_revision: candidate.fence.contractRevision,
        cancellation_epoch: candidate.fence.cancellationEpoch,
      },
      expected_canonical_revision: candidate.expectedCanonicalRevision,
      candidate: {
        provider: candidate.provider, model: candidate.model, result: candidate.result,
        reply: candidate.reply, baseVersions: candidate.baseVersions, surfaces: candidate.surfaces,
      },
    } };
    return new Promise<ControlResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        controlPending.delete(id);
        reject(new Error("Native candidate commit timed out; retry with the same commit identity"));
      }, 30_000);
      timer.unref();
      controlPending.set(id, { kind: "candidate", candidate: {
        commitId: candidate.commitId, session: candidate.session, rootId: candidate.fence.rootId,
        rootRevision: candidate.fence.rootRevision, contractRevision: candidate.fence.contractRevision,
        cancellationEpoch: candidate.fence.cancellationEpoch,
        expectedCanonicalRevision: candidate.expectedCanonicalRevision,
      }, resolve, reject, timer });
      void send({ id, type: "control_request", operation }).catch((error: unknown) => {
        const pending = controlPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        controlPending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Native candidate commit write failed"));
      });
    }).then((result) => {
      if (result.status !== "committed") throw new Error(`Native candidate commit ${result.status}`);
      return result.receipt;
    });
  }
  function sessionCall(operation: Record<string, unknown>, accept: (frame: Record<string, unknown>) => ControlResult): Promise<ControlResult> {
    if (closed) return Promise.reject(new Error("Native control connection closed"));
    if (controlPending.size >= 16) return Promise.reject(new Error("Native control queue is full"));
    const id = `ctl-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controlPending.delete(id);
        reject(new Error("Native session operation timed out"));
      }, 30_000);
      timer.unref();
      controlPending.set(id, { kind: "session", accept, resolve, reject, timer });
      void send({ id, type: "control_request", operation }).catch((error: unknown) => {
        const pending = controlPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        controlPending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Native session request failed"));
      });
    });
  }
  const hostSessionStore: HostSessionStore = {
    async load(id) {
      try {
        const result = await sessionCall({ session_load: { session_id: id } }, (frame) => {
          if (frame.status !== "loaded" || !Number.isSafeInteger(frame.revision) || Number(frame.revision) < 1 || !frame.snapshot || typeof frame.snapshot !== "object" || Array.isArray(frame.snapshot)) throw new Error("Invalid native session snapshot");
          return { status: "loaded", revision: Number(frame.revision), snapshot: frame.snapshot as HostSessionSnapshot };
        });
        if (result.status !== "loaded") throw new Error("Invalid native session load response");
        return { revision: result.revision, snapshot: result.snapshot };
      } catch (error) {
        if (error instanceof Error && error.message.includes("session_not_found")) return undefined;
        throw error;
      }
    },
    async save(snapshot, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024) throw new Error("Native session snapshot is invalid or exceeds 8 MiB");
      const result = await sessionCall({ session_save: { session_id: snapshot.id, expected_revision: expectedRevision, snapshot } }, (frame) => {
        if (frame.status !== "saved" || !Number.isSafeInteger(frame.revision) || Number(frame.revision) !== expectedRevision + 1) throw new Error(typeof frame.error === "string" ? `Native session save refused: ${frame.error}` : "Invalid native session save response");
        return { status: "saved", revision: Number(frame.revision) };
      });
      if (result.status !== "saved") throw new Error("Invalid native session save response");
      return result.revision;
    },
    async list() {
      const result = await sessionCall({ session_list: {} }, (frame) => {
        if (frame.status !== "listed" || !Array.isArray(frame.sessions) || frame.sessions.length > 10_000) throw new Error("Invalid native session index");
        const sessions = frame.sessions.map((entry): SessionSummary => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid native session summary");
          const item = entry as Record<string, unknown>;
          if (Object.keys(item).length !== 3 || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.updated !== "string") throw new Error("Invalid native session summary");
          return { id: item.id, title: item.title, updated: item.updated };
        });
        return { status: "listed", sessions };
      });
      if (result.status !== "listed") throw new Error("Invalid native session list response");
      return result.sessions;
    },
    async remove(id, expectedRevision) {
      const result = await sessionCall({ session_remove: { session_id: id, expected_revision: expectedRevision ?? null } }, (frame) => {
        if (frame.status !== "removed") throw new Error(typeof frame.error === "string" ? `Native session removal refused: ${frame.error}` : "Invalid native session removal response");
        return { status: "removed" };
      });
      if (result.status !== "removed") throw new Error("Invalid native session removal response");
    },
  };
  async function run(id: string, frame: Record<string, unknown>): Promise<void> {
    const p: Pending = { controller: new AbortController() };
    active.set(id, p);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const method = String(frame.method), route = String(frame.path), body = frame.body;
      if (!["GET", "POST", "PUT", "DELETE"].includes(method) || !route.startsWith("/api/") || route.length > 8192 || /[\r\n#]/.test(route) || (body !== undefined && (typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY)) || (method === "GET" && body !== undefined)) throw new Error("Invalid desktop request");
      const headers = new Headers({ host: "localhost", authorization: `Bearer ${token}`, origin: "tauri://localhost" });
      const supplied = frame.headers;
      if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
        for (const [name, value] of Object.entries(supplied)) {
          if (!["content-type", "range"].includes(name.toLowerCase()) || typeof value !== "string" || value.length > 256) throw new Error("Invalid desktop request headers");
          headers.set(name, value);
        }
      }
      const response = await request(new Request(`http://localhost${route}`, { method, headers, ...(typeof body === "string" ? { body } : {}), signal: p.controller.signal }));
      await send({ id, type: "headers", status: response.status, headers: Object.fromEntries(response.headers) });
      reader = response.body?.getReader();
      if (reader) while (true) {
        const result = await reader.read();
        if (result.done) break;
        for (let offset = 0; offset < result.value.byteLength; offset += 64 * 1024) {
          p.controller.signal.throwIfAborted();
          const acknowledged = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Desktop response consumer stopped")), 30_000);
            timeout.unref();
            p.ack = () => { clearTimeout(timeout); resolve(); };
          });
          await send({ id, type: "data", data: Buffer.from(result.value.subarray(offset, offset + 64 * 1024)).toString("base64") });
          await acknowledged;
          p.ack = undefined;
        }
      }
      await send({ id, type: "end" });
    } catch (error) {
      if (!closed && !p.controller.signal.aborted) await send({ id, type: "error", message: error instanceof Error ? error.message : "Desktop request failed" }).catch(() => {});
    } finally {
      await reader?.cancel().catch(() => {});
      active.delete(id);
    }
  }
  function receive(line: string): void {
    const frame: unknown = JSON.parse(line);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid desktop frame");
    const f = frame as Record<string, unknown>, id = f.id;
    if (f.v !== DESKTOP_PROTOCOL || typeof id !== "string" || !ID.test(id)) throw new Error("Incompatible desktop frame");
    if (f.type === "control_response") {
      if (!id.startsWith("ctl-") || !["ready", "unavailable", "overloaded", "committed", "refused", "loaded", "saved", "listed", "removed"].includes(String(f.status))) throw new Error("Invalid native control response");
      const pending = controlPending.get(id);
      if (pending) {
        const expectedKeys = pending.kind === "health" ? ["v", "id", "type", "status"]
          : pending.kind === "candidate" ? f.status === "committed" ? ["v", "id", "type", "status", "receipt"] : ["v", "id", "type", "status", "error"]
            : f.status === "loaded" ? ["v", "id", "type", "status", "revision", "snapshot"]
              : f.status === "saved" ? ["v", "id", "type", "status", "revision"]
                : f.status === "listed" ? ["v", "id", "type", "status", "sessions"]
                  : f.status === "removed" ? ["v", "id", "type", "status"]
                    : ["v", "id", "type", "status", "error"];
        if (Object.keys(f).length !== expectedKeys.length || Object.keys(f).some((key) => !expectedKeys.includes(key))) throw new Error("Invalid native control response fields");
        if (pending.kind === "health" && !["ready", "unavailable", "overloaded"].includes(String(f.status))) throw new Error("Unexpected native health response");
        if (pending.kind === "candidate" && f.status === "committed") {
          const receipt = f.receipt as Record<string, unknown> | null;
          const identity = pending.candidate!;
          const receiptKeys = ["commit_id", "session_id", "root_id", "root_revision", "contract_revision", "cancellation_epoch", "expected_canonical_revision", "canonical_revision", "digest", "request_fingerprint"];
          if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
            || Object.keys(receipt).length !== receiptKeys.length || Object.keys(receipt).some((key) => !receiptKeys.includes(key))
            || receipt.commit_id !== identity.commitId || receipt.session_id !== identity.session || receipt.root_id !== identity.rootId
            || receipt.root_revision !== identity.rootRevision || receipt.contract_revision !== identity.contractRevision
            || receipt.cancellation_epoch !== identity.cancellationEpoch || receipt.expected_canonical_revision !== identity.expectedCanonicalRevision
            || receipt.canonical_revision !== identity.expectedCanonicalRevision + 1
            || typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)
            || typeof receipt.request_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.request_fingerprint)) throw new Error("Invalid native candidate receipt");
        } else if ((pending.kind === "candidate" || pending.kind === "session") && !["committed", "loaded", "saved", "listed", "removed"].includes(String(f.status)) && (typeof f.error !== "string" || f.error.length > 128)) throw new Error("Invalid native control refusal");
        clearTimeout(pending.timer);
        controlPending.delete(id);
        if (pending.kind === "session") {
          if (["refused", "unavailable", "overloaded"].includes(String(f.status))) pending.reject(new Error(`Native session operation ${String(f.status)}: ${String(f.error)}`));
          else pending.resolve(pending.accept!(f));
        } else if (f.status === "committed") {
          const receipt = f.receipt as { canonical_revision: number; root_revision: number };
          pending.resolve({ status: "committed", receipt: { canonicalRevision: receipt.canonical_revision, rootRevision: receipt.root_revision } });
        } else if (pending.kind === "candidate" && f.status === "refused") pending.reject(new Error(`Native candidate commit refused: ${String(f.error)}`));
        else pending.resolve({ status: f.status as ControlHealth["status"] });
      } else if (Object.keys(f).some((key) => !["v", "id", "type", "status", "receipt", "error", "revision", "snapshot", "sessions"].includes(key))) {
        throw new Error("Invalid late native control response");
      }
      return;
    }
    if (providers.receive(f)) return;
    if (f.type === "ack") { active.get(id)?.ack?.(); return; }
    if (f.type === "cancel") { const p = active.get(id); p?.controller.abort(); p?.ack?.(); return; }
    if (f.type !== "request" || active.has(id) || active.size >= 32) throw new Error("Invalid or excessive desktop requests");
    void run(id, f);
  }
  let parts: string[] = [], bytes = 0;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    if (closed) return;
    try {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) if (i === chunk.length || chunk[i] === "\n") {
        const part = chunk.slice(start, i);
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_FRAME) throw new Error("Desktop frame too large");
        parts.push(part);
        if (i < chunk.length) { receive(parts.join("")); parts = []; bytes = 0; }
        start = i + 1;
      }
    } catch (error) { close(); failed(error instanceof Error ? error : new Error("Desktop protocol failed")); }
  });
  input.on("end", close);
  input.on("error", (error) => { close(); failed(error); });
  output.on("error", (error) => { close(); failed(error); });
  return { close, pingControl, commitCandidate, hostSessionStore, providerFetch: providers.fetch };
}
