// Fetch-compatible IPC transport for the main Tauri window. Response chunks
// are acknowledged as the consumer drains them, bounding media/SSE buffering.
import { Channel, invoke } from "@tauri-apps/api/core";

type Frame = { v: number; id: string } & ({ type: "headers"; status: number; headers: Record<string, string> } | { type: "data"; data: string } | { type: "end" } | { type: "error"; message: string });

export const desktopFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "vak:" || url.hostname !== "localhost" || !url.pathname.startsWith("/api/")) throw new Error("Invalid desktop engine destination");
  request.signal.throwIfAborted();
  const id = crypto.randomUUID();
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "range"]) { const value = request.headers.get(name); if (value) headers[name] = value; }
  const body = request.body ? await request.text() : undefined;
  if (body && new TextEncoder().encode(body).length > 32 * 1024 * 1024) throw new Error("Desktop request is too large");
  return await new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>, closed = false, awaitingAck = false;
    const send = (command: string) => { void invoke(command, { id }).catch((error) => fail(error)); };
    const ack = () => { if (awaitingAck && !closed) { awaitingAck = false; send("engine_ack"); } };
    const cleanup = () => { closed = true; request.signal.removeEventListener("abort", abort); };
    const fail = (reason: unknown) => {
      if (closed) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      cleanup(); reject(error); controller.error(error);
      void invoke("engine_cancel", { id }).catch(() => {});
    };
    const abort = () => fail(request.signal.reason ?? new DOMException("Request aborted", "AbortError"));
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      pull() { ack(); },
      cancel() { cleanup(); void invoke("engine_cancel", { id }).catch(() => {}); },
    }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength });
    const channel = new Channel<Frame>();
    channel.onmessage = (frame) => {
      if (closed) return;
      if (frame.v !== 1 || frame.id !== id) { fail(new Error("Incompatible engine response")); return; }
      if (frame.type === "headers") resolve(new Response([204, 205, 304].includes(frame.status) ? null : stream, { status: frame.status, headers: frame.headers }));
      else if (frame.type === "data") {
        if (frame.data.length > 90_000 || awaitingAck) { fail(new Error("Engine response exceeded its flow-control limit")); return; }
        try {
          const decoded = atob(frame.data), bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
          controller.enqueue(bytes); awaitingAck = true;
          if ((controller.desiredSize ?? 0) > 0) ack();
        } catch (error) { fail(error); }
      } else if (frame.type === "end") { cleanup(); controller.close(); }
      else fail(new Error(frame.message));
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    void invoke("engine_request", { id, method: request.method, path: url.pathname + url.search, headers, body, channel }).then(() => {
      if (closed) void invoke("engine_cancel", { id }).catch(() => {});
    }).catch(fail);
  });
};
