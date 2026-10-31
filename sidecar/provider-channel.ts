// Shared provider framing only. This channel has no HTTP, session-store or
// canonical commit operation; authority still belongs to the native recipient.
import { randomUUID } from "node:crypto";
import type { ProviderTransport, ProviderTransportContext } from "@vak/providers";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";
const MAX_PROVIDER_BODY = 8 * 1024 * 1024;
const PROVIDER_OPERATIONS: Record<string, Map<string, string>> = {
  openai: new Map([
    ["api.openai.com|/v1/responses", "responses"],
    ["api.openai.com|/v1/chat/completions", "chat_completions"],
    ["api.openai.com|/v1/models", "models"],
  ]),
  anthropic: new Map([
    ["api.anthropic.com|/v1/messages", "messages"],
    ["api.anthropic.com|/v1/models", "models"],
  ]),
  mistral: new Map([
    ["api.mistral.ai|/v1/chat/completions", "chat_completions"],
    ["api.mistral.ai|/v1/models", "models"],
  ]),
  xai: new Map([
    ["api.x.ai|/v1/chat/completions", "chat_completions"],
    ["api.x.ai|/v1/models", "models"],
  ]),
  deepseek: new Map([
    ["api.deepseek.com|/v1/chat/completions", "chat_completions"],
    ["api.deepseek.com|/v1/models", "models"],
  ]),
  groq: new Map([
    ["api.groq.com|/openai/v1/chat/completions", "chat_completions"],
    ["api.groq.com|/openai/v1/models", "models"],
  ]),
  cerebras: new Map([
    ["api.cerebras.ai|/v1/chat/completions", "chat_completions"],
    ["api.cerebras.ai|/v1/models", "models"],
  ]),
  openrouter: new Map([
    ["openrouter.ai|/api/v1/chat/completions", "chat_completions"],
    ["openrouter.ai|/api/v1/models", "models"],
  ]),
  together: new Map([
    ["api.together.xyz|/v1/chat/completions", "chat_completions"],
    ["api.together.xyz|/v1/models", "models"],
  ]),
  fireworks: new Map([
    ["api.fireworks.ai|/inference/v1/chat/completions", "chat_completions"],
    ["api.fireworks.ai|/inference/v1/models", "models"],
  ]),
  moonshot: new Map([
    ["api.moonshot.ai|/v1/chat/completions", "chat_completions"],
    ["api.moonshot.ai|/v1/models", "models"],
  ]),
  dashscope: new Map([
    ["dashscope-intl.aliyuncs.com|/compatible-mode/v1/chat/completions", "chat_completions"],
    ["dashscope-intl.aliyuncs.com|/compatible-mode/v1/models", "models"],
  ]),
  qwen: new Map([
    ["dashscope-intl.aliyuncs.com|/compatible-mode/v1/chat/completions", "chat_completions"],
    ["dashscope-intl.aliyuncs.com|/compatible-mode/v1/models", "models"],
  ]),
  typesafe: new Map([
    ["api.typesafe.ai|/v1/chat/completions", "chat_completions"],
    ["api.typesafe.ai|/v1/models", "models"],
  ]),
};
type ProviderPending = {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  queue: { seq: number; bytes: Uint8Array }[];
  waitingPull?: () => void;
  nextExpectedSeq: number;
  lastDelivered: number;
  ended: boolean;
  settled: boolean;
  signal?: AbortSignal;
  abort?: () => void;
};

export function providerChannel(send: (message: Record<string, unknown>) => Promise<void>, maxCalls = 16, consentWaitMs = 0): { fetch: ProviderTransport; receive(frame: Record<string, unknown>): boolean; close(): void } {
  if (!Number.isInteger(consentWaitMs) || consentWaitMs < 0 || consentWaitMs > 300_000) throw new Error("Invalid provider consent allowance");
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw new Error("Invalid provider channel capacity");
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
  function close(): void {
    if (closed) return;
    closed = true;
    for (const p of providerPending.values()) { clearTimeout(p.timer); p.signal?.removeEventListener("abort", p.abort!); try { p.controller?.error(new Error("Parent connection closed")); } catch {} p.reject(new Error("Parent connection closed")); }
    providerPending.clear();
  }
  const providerFetch: ProviderTransport = (provider, input, init = {}, context?: ProviderTransportContext) => {
    if (closed) return Promise.reject(new Error("Native provider transport is unavailable"));
    if (providerPending.size >= maxCalls) return Promise.reject(new Error("Native provider queue is full"));
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!Object.hasOwn(PROVIDER_OPERATIONS, provider) && provider !== "gemini" && provider !== "ollama" && provider !== "lmstudio") return Promise.reject(new Error("Unsupported native provider"));
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return Promise.reject(new Error("Invalid provider URL")); }
    if (url.username || url.password || url.hash) return Promise.reject(new Error("Provider URL contains unsupported authority data"));
    const body = init.body ?? (input instanceof Request && input.body ? input.body : undefined);
    if (body !== undefined && typeof body !== "string") return Promise.reject(new Error("Native provider requests require a bounded JSON body"));
    if (body !== undefined && Buffer.byteLength(body) > MAX_PROVIDER_BODY) return Promise.reject(new Error("Provider request is too large"));
    if (method === "GET" && body !== undefined) return Promise.reject(new Error("GET provider requests cannot include a body"));
    let operation: string | undefined;
    let routeModel: string | undefined;
    if (provider === "ollama") {
      if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.port !== "11434" || url.searchParams.size) return Promise.reject(new Error("Unsupported local model operation"));
      if (method === "GET" && url.pathname === "/api/tags") {
        operation = "ollama_tags";
      } else if (method === "POST" && url.pathname === "/api/show") {
        operation = "ollama_show";
      } else if (method === "POST" && url.pathname === "/api/chat") {
        operation = "ollama_chat";
      } else {
        return Promise.reject(new Error("Unsupported local model operation"));
      }
    } else if (provider === "lmstudio") {
      if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.port !== "1234" || url.searchParams.size) return Promise.reject(new Error("Unsupported local model operation"));
      if (method === "GET" && url.pathname === "/v1/models") {
        operation = "models";
      } else if (method === "POST" && url.pathname === "/v1/chat/completions") {
        operation = "chat_completions";
      } else {
        return Promise.reject(new Error("Unsupported local model operation"));
      }
    } else if (provider === "gemini") {
      if (url.protocol !== "https:" || url.hostname !== "generativelanguage.googleapis.com" || (url.port && url.port !== "443")) return Promise.reject(new Error("Unsupported native provider operation"));
      const streamMatch = url.pathname.match(/^\/v1beta\/models\/([A-Za-z0-9._:-]{1,128}):streamGenerateContent$/);
      const modelMatch = url.pathname.match(/^\/v1beta\/models\/([A-Za-z0-9._:-]{1,128})$/);
      if (method === "POST" && url.search === "?alt=sse" && streamMatch) {
        operation = "stream_generate_content";
        routeModel = streamMatch[1];
      } else if (method === "GET" && url.pathname === "/v1beta/models" && (url.search === "" || url.search === "?pageSize=200")) {
        operation = "models";
      } else if (method === "GET" && modelMatch && url.search === "") {
        operation = "models";
        routeModel = modelMatch[1];
      } else {
        return Promise.reject(new Error("Unsupported native provider operation"));
      }
    } else {
      if (url.protocol !== "https:" || (url.port && url.port !== "443")) return Promise.reject(new Error("Unsupported native provider operation"));
      if ((provider === "anthropic" || provider === "openai") && method === "GET") {
        const modelMatch = url.pathname.match(/^\/v1\/models\/([A-Za-z0-9._:-]{1,128})$/);
        if (url.pathname === "/v1/models" && (url.search === "" || url.search === "?limit=100")) {
          operation = "models";
        } else if (modelMatch && url.search === "") {
          operation = "models";
          routeModel = modelMatch[1];
        } else {
          return Promise.reject(new Error("Unsupported native provider operation"));
        }
      } else {
        if (url.search) return Promise.reject(new Error("Unsupported native provider operation"));
        operation = PROVIDER_OPERATIONS[provider]?.get(`${url.hostname}|${url.pathname}`);
        if (!operation) return Promise.reject(new Error("Unsupported native provider operation"));
        if (method === "GET" && operation !== "models") return Promise.reject(new Error("Unsupported native provider operation"));
        if (method === "POST" && operation === "models") return Promise.reject(new Error("Unsupported native provider operation"));
      }
    }
    if (method === "POST" && typeof body !== "string") return Promise.reject(new Error("Native provider requests require a bounded JSON body"));
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
    if (!context || !/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) return Promise.reject(new Error("Missing provider operation identity"));
    const isDiscovery = operation === "models" || operation === "ollama_tags" || operation === "ollama_show";
    if (!isDiscovery) {
      if (!context.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(context.sessionId)
        || !context.runId || !/^[A-Za-z0-9_-]{1,128}$/.test(context.runId)) {
        return Promise.reject(new Error("Missing provider execution identity"));
      }
    } else {
      if (context.sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(context.sessionId)) {
        return Promise.reject(new Error("Invalid provider execution identity"));
      }
      if (context.runId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(context.runId)) {
        return Promise.reject(new Error("Invalid provider execution identity"));
      }
    }
    const operationId = context.operationId;
    const attempt = context.attempt;
    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 16) return Promise.reject(new Error("Invalid provider attempt identity"));
    return new Promise<Response>((resolve, reject) => {
      let abort: (() => void) | undefined;
      const timer = setTimeout(() => {
        const error = new Error("Native provider request timed out");
        pending.settled = true;
        providerPending.delete(id);
        retireProvider(id);
        signal?.removeEventListener("abort", abort!);
        void send({ v: DESKTOP_PROTOCOL, id, type: "provider_cancel" }).catch(() => {});
        if (pending.controller) pending.controller.error(error);
        else reject(error);
      }, 125_000 + consentWaitMs);
      timer.unref();
      const pending: ProviderPending = { resolve, reject, timer, queue: [], nextExpectedSeq: 0, lastDelivered: -1, ended: false, settled: false, signal };
      providerPending.set(id, pending);
      abort = () => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(timer);
        providerPending.delete(id);
        retireProvider(id);
        signal?.removeEventListener("abort", abort!);
        pending.controller?.error(new Error("Provider request was cancelled"));
        void send({ v: DESKTOP_PROTOCOL, id, type: "provider_cancel" }).catch(() => {});
        if (!pending.controller) reject(new Error("Provider request was cancelled"));
      };
      pending.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      const message = {
        v: DESKTOP_PROTOCOL,
        id,
        type: "provider_request",
        provider,
        operation,
        ...(routeModel === undefined ? {} : { routeModel }),
        body: typeof body === "string" ? body : "",
        operationId,
        attempt,
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.runId ? { runId: context.runId } : {}),
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
  function receive(f: Record<string, unknown>): boolean {
    if (typeof f.type !== "string" || !f.type.startsWith("provider_")) return false;
    if (f.v !== DESKTOP_PROTOCOL || typeof f.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(f.id)) throw new Error("Invalid provider response identity");
    const id = f.id;
    if (f.type === "provider_headers") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "status", "headers"].includes(key)) || !id.startsWith("gen-") || !Number.isInteger(f.status) || Number(f.status) < 100 || Number(f.status) > 599 || [204, 205, 304].includes(Number(f.status)) || !f.headers || typeof f.headers !== "object" || Array.isArray(f.headers)) throw new Error("Invalid provider response headers");
      if (lateProviderFrame(id)) return true;
      const pending = providerPending.get(id);
      if (!pending || pending.settled || pending.controller) throw new Error("Unexpected provider response headers");
      const headers = new Headers();
      for (const [name, value] of Object.entries(f.headers as Record<string, unknown>)) {
        if (!/^(content-type|retry-after)$/.test(name.toLowerCase()) || typeof value !== "string" || value.length > 256 || /[\r\n]/.test(value)) throw new Error("Invalid provider response header");
        headers.set(name, value);
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { pending.controller = controller; },
        async pull() {
          // A pull that resolves without enqueuing is not repeated for a read already
          // waiting, so a pull that has to wait delivers the frame itself once it arrives.
          if (pending.queue.length === 0 && !pending.ended) await new Promise<void>((resolve) => { pending.waitingPull = resolve; });
          if (pending.settled) return;
          if (pending.queue.length > 0) {
            const { seq, bytes } = pending.queue.shift()!;
            pending.lastDelivered = seq;
            pending.controller?.enqueue(bytes);
            void send({ v: DESKTOP_PROTOCOL, id, type: "provider_ack", seq }).catch(() => {});
            if (pending.ended && pending.queue.length === 0) {
              pending.controller?.close();
              finishProvider(id, pending);
            }
            return;
          }
          if (pending.ended) {
            pending.controller?.close();
            finishProvider(id, pending);
          }
        },
        cancel() {
          if (!pending.settled) {
            pending.settled = true;
            clearTimeout(pending.timer);
            providerPending.delete(id);
            retireProvider(id);
            pending.signal?.removeEventListener("abort", pending.abort!);
            void send({ v: DESKTOP_PROTOCOL, id, type: "provider_cancel" }).catch(() => {});
          }
        },
      });
      pending.resolve(new Response(stream, { status: Number(f.status), headers }));
      return true;
    }
    if (f.type === "provider_data") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "seq", "data"].includes(key)) || !id.startsWith("gen-") || !Number.isSafeInteger(f.seq) || typeof f.data !== "string" || f.data.length > 88_000) throw new Error("Invalid provider response data");
      if (lateProviderFrame(id)) return true;
      const pending = providerPending.get(id);
      if (!pending?.controller || pending.settled || Number(f.seq) !== pending.nextExpectedSeq) throw new Error("Unexpected provider response data");
      const bytes = Buffer.from(f.data, "base64");
      if (bytes.byteLength > 64 * 1024 || bytes.toString("base64") !== f.data) throw new Error("Invalid provider response chunk");
      pending.nextExpectedSeq++;
      pending.queue.push({ seq: Number(f.seq), bytes });
      pending.waitingPull?.();
      pending.waitingPull = undefined;
      return true;
    }
    if (f.type === "provider_end") {
      if (Object.keys(f).some((key) => !["v", "id", "type"].includes(key)) || !id.startsWith("gen-")) throw new Error("Invalid provider response end");
      if (lateProviderFrame(id)) return true;
      const pending = providerPending.get(id);
      if (!pending?.controller || pending.settled || pending.ended) throw new Error("Unexpected provider response end");
      pending.ended = true;
      pending.waitingPull?.();
      pending.waitingPull = undefined;
      if (pending.queue.length === 0) {
        pending.controller.close();
        finishProvider(id, pending);
      }
      return true;
    }
    if (f.type === "provider_error") {
      if (Object.keys(f).some((key) => !["v", "id", "type", "message"].includes(key)) || !id.startsWith("gen-") || typeof f.message !== "string" || f.message.length > 512) throw new Error("Invalid provider response error");
      if (lateProviderFrame(id)) return true;
      const pending = providerPending.get(id);
      if (!pending || pending.settled) throw new Error("Unexpected provider response error");
      const error = new Error(f.message || "Native provider request failed");
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort!);
      providerPending.delete(id);
      retireProvider(id);
      if (pending.controller) pending.controller.error(error);
      else pending.reject(error);
      return true;
    }
    throw new Error("Unexpected provider response family");
  }
  return { fetch: providerFetch, receive, close };
}
