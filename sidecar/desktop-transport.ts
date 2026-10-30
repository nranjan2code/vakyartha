// One private parent connection, multiplexed by request identity. No socket,
// URL listener or independently reachable endpoint exists in desktop mode.
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ProviderTransport, ProviderTransportContext } from "@vak/providers";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
export { DESKTOP_PROTOCOL };

const MAX_BODY = 32 * 1024 * 1024, MAX_FRAME = 48 * 1024 * 1024;
const MAX_PROVIDER_BODY = 8 * 1024 * 1024, MAX_PROVIDER_CALLS = 4;
const ID = /^[A-Za-z0-9-]{1,64}$/;
type Pending = { controller: AbortController; ack?: () => void };
type ControlHealth = { status: "ready" | "unavailable" | "overloaded" };
type ControlPending = { resolve(value: ControlHealth): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type ProviderPending = {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  queued?: { seq: number; bytes: Uint8Array };
  waitingPull?: () => void;
  lastDelivered?: number;
  ended: boolean;
  settled: boolean;
  signal?: AbortSignal;
  abort?: () => void;
};

export function desktopTransport(request: (r: Request) => Promise<Response>, token: string, input: Readable, output: Writable, failed: (error: Error) => void): { close(): void; pingControl(): Promise<ControlHealth>; providerFetch: ProviderTransport } {
  const active = new Map<string, Pending>();
  const controlPending = new Map<string, ControlPending>();
  const providerPending = new Map<string, ProviderPending>();
  const retiredProviderIds = new Set<string>();
  let closed = false;
  function retireProvider(id: string): void {
    retiredProviderIds.add(id);
    if (retiredProviderIds.size > 256) retiredProviderIds.delete(retiredProviderIds.values().next().value!);
  }
  function lateProviderFrame(id: string): boolean {
    if (providerPending.has(id)) return false;
    if (retiredProviderIds.has(id)) return true;
    throw new Error("Unexpected provider response identity");
  }
  function finishProvider(id: string, pending: ProviderPending): void {
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort!);
    providerPending.delete(id);
    retireProvider(id);
  }
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
    for (const p of providerPending.values()) { clearTimeout(p.timer); p.signal?.removeEventListener("abort", p.abort!); try { p.controller?.error(new Error("Parent connection closed")); } catch {} p.reject(new Error("Parent connection closed")); }
    providerPending.clear();
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
      controlPending.set(id, { resolve, reject, timer });
      void send({ id, type: "control_request", operation: "health" }).catch((error: unknown) => {
        const pending = controlPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        controlPending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Native control write failed"));
      });
    });
  }
  const providerFetch: ProviderTransport = (provider, input, init = {}, context?: ProviderTransportContext) => {
    if (closed) return Promise.reject(new Error("Native provider transport is unavailable"));
    if (providerPending.size >= MAX_PROVIDER_CALLS) return Promise.reject(new Error("Native provider queue is full"));
    const method = String(init.method ?? "GET").toUpperCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(provider) || !["GET", "POST"].includes(method)) return Promise.reject(new Error("Unsupported native provider operation"));
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return Promise.reject(new Error("Invalid provider URL")); }
    if (url.username || url.password || url.hash || url.searchParams.size > 0 || (provider !== "ollama" && url.protocol !== "https:")) return Promise.reject(new Error("Provider URL contains unsupported authority or query data"));
    const body = init.body;
    if (body !== undefined && typeof body !== "string") return Promise.reject(new Error("Native provider requests require a bounded JSON body"));
    if (body !== undefined && Buffer.byteLength(body) > MAX_PROVIDER_BODY) return Promise.reject(new Error("Provider request is too large"));
    if (method === "GET" && body !== undefined) return Promise.reject(new Error("GET provider requests cannot include a body"));
    const headers: Record<string, string> = {};
    try {
      new Headers(input instanceof Request ? input.headers : init.headers).forEach((value, name) => {
        if (["authorization", "x-api-key", "x-goog-api-key", "api-key"].includes(name.toLowerCase())) return;
        if (name.toLowerCase() !== "content-type" || value.length > 256 || /[\r\n]/.test(value)) throw new Error("Unsupported native provider header");
        headers[name.toLowerCase()] = value;
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("Invalid provider headers")); }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(new Error("Provider request was cancelled"));
    const id = `gen-${randomUUID()}`;
    const operation = context?.operationId && /^[A-Za-z0-9_-]{1,128}$/.test(context.operationId) ? context.operationId : randomUUID();
    const attempt = context?.attempt ?? 0;
    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 16) return Promise.reject(new Error("Invalid provider attempt identity"));
    return new Promise<Response>((resolve, reject) => {
      let abort: (() => void) | undefined;
      const timer = setTimeout(() => {
        const error = new Error("Native provider request timed out");
        pending.settled = true;
        providerPending.delete(id);
        retireProvider(id);
        signal?.removeEventListener("abort", abort!);
        void send({ id, type: "provider_cancel" }).catch(() => {});
        if (pending.controller) pending.controller.error(error);
        else reject(error);
      }, 125_000);
      timer.unref();
      const pending: ProviderPending = { resolve, reject, timer, ended: false, settled: false, signal };
      providerPending.set(id, pending);
      abort = () => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(timer);
        providerPending.delete(id);
        retireProvider(id);
        signal?.removeEventListener("abort", abort!);
        pending.controller?.error(new Error("Provider request was cancelled"));
        void send({ id, type: "provider_cancel" }).catch(() => {});
        if (!pending.controller) reject(new Error("Provider request was cancelled"));
      };
      pending.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      const message = {
        id,
        type: "provider_request",
        provider,
        url: url.toString(),
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        operationId: operation,
        attempt,
      };
      void send(message).catch((error: unknown) => {
        if (providerPending.delete(id)) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort!);
          reject(error instanceof Error ? error : new Error("Native provider write failed"));
        }
      });
    });
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
      if (Object.keys(f).length !== 4 || !id.startsWith("ctl-") || !["ready", "unavailable", "overloaded"].includes(String(f.status))) throw new Error("Invalid native control response");
      const pending = controlPending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        controlPending.delete(id);
        pending.resolve({ status: f.status as ControlHealth["status"] });
      }
      return;
    }
    if (f.type === "provider_headers") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "status", "headers"].includes(key)) || !id.startsWith("gen-") || !Number.isInteger(f.status) || Number(f.status) < 100 || Number(f.status) > 599 || [204, 205, 304].includes(Number(f.status)) || !f.headers || typeof f.headers !== "object" || Array.isArray(f.headers)) throw new Error("Invalid provider response headers");
      if (lateProviderFrame(id)) return;
      const pending = providerPending.get(id);
      if (!pending || pending.settled || pending.controller) throw new Error("Unexpected provider response headers");
      const headers = new Headers();
      for (const [name, value] of Object.entries(f.headers as Record<string, unknown>)) {
        if (!/^(content-type|retry-after)$/.test(name.toLowerCase()) || typeof value !== "string" || value.length > 256 || /[\r\n]/.test(value)) throw new Error("Invalid provider response header");
        headers.set(name, value);
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { pending.controller = controller; },
        pull() {
          if (pending.queued) {
            const { seq, bytes } = pending.queued;
            pending.queued = undefined;
            pending.lastDelivered = seq;
            pending.controller?.enqueue(bytes);
            void send({ id, type: "provider_ack", seq }).catch(() => {});
            if (pending.ended) {
              pending.controller?.close();
              finishProvider(id, pending);
            }
            return;
          }
          if (pending.ended) { pending.controller?.close(); return; }
          return new Promise<void>((resolve) => { pending.waitingPull = resolve; });
        },
        cancel() {
          if (!pending.settled) {
            pending.settled = true;
            clearTimeout(pending.timer);
            providerPending.delete(id);
            retireProvider(id);
            pending.signal?.removeEventListener("abort", pending.abort!);
            void send({ id, type: "provider_cancel" }).catch(() => {});
          }
        },
      });
      pending.resolve(new Response(stream, { status: Number(f.status), headers }));
      return;
    }
    if (f.type === "provider_data") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "seq", "data"].includes(key)) || !id.startsWith("gen-") || !Number.isSafeInteger(f.seq) || typeof f.data !== "string" || f.data.length > 88_000) throw new Error("Invalid provider response data");
      if (lateProviderFrame(id)) return;
      const pending = providerPending.get(id);
      if (!pending?.controller || pending.settled || pending.queued || Number(f.seq) !== (pending.lastDelivered ?? -1) + 1) throw new Error("Unexpected provider response data");
      const bytes = Buffer.from(f.data, "base64");
      if (bytes.byteLength > 64 * 1024 || bytes.toString("base64") !== f.data) throw new Error("Invalid provider response chunk");
      pending.queued = { seq: Number(f.seq), bytes };
      pending.waitingPull?.();
      pending.waitingPull = undefined;
      return;
    }
    if (f.type === "provider_end") {
      if (Object.keys(f).length !== 3 || !id.startsWith("gen-")) throw new Error("Invalid provider response end");
      if (lateProviderFrame(id)) return;
      const pending = providerPending.get(id);
      if (!pending?.controller || pending.settled || pending.ended) throw new Error("Unexpected provider response end");
      pending.ended = true;
      pending.waitingPull?.();
      pending.waitingPull = undefined;
      if (!pending.queued) {
        pending.controller.close();
        finishProvider(id, pending);
      }
      return;
    }
    if (f.type === "provider_error") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "message"].includes(key)) || !id.startsWith("gen-") || typeof f.message !== "string" || f.message.length > 512) throw new Error("Invalid provider response error");
      if (lateProviderFrame(id)) return;
      const pending = providerPending.get(id);
      if (!pending || pending.settled) throw new Error("Unexpected provider response error");
      const error = new Error(f.message || "Native provider request failed");
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort!);
      providerPending.delete(id);
      retireProvider(id);
      if (pending.controller) pending.controller.error(error);
      else pending.reject(error);
      return;
    }
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
  return { close, pingControl, providerFetch };
}
