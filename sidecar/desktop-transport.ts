// One private parent connection, multiplexed by request identity. No socket,
// URL listener or independently reachable endpoint exists in desktop mode.
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
export { DESKTOP_PROTOCOL };

const MAX_BODY = 32 * 1024 * 1024, MAX_FRAME = 48 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;
type Pending = { controller: AbortController; ack?: () => void };
type ControlHealth = { status: "ready" | "unavailable" | "overloaded" };
type ControlPending = { resolve(value: ControlHealth): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export function desktopTransport(request: (r: Request) => Promise<Response>, token: string, input: Readable, output: Writable, failed: (error: Error) => void): { close(): void; pingControl(): Promise<ControlHealth> } {
  const active = new Map<string, Pending>();
  const controlPending = new Map<string, ControlPending>();
  let closed = false;
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
  return { close, pingControl };
}
