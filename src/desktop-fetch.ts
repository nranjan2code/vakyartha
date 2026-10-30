// Fetch-compatible IPC transport for the main Tauri window. Response chunks
// are acknowledged as the consumer drains them, bounding media/SSE buffering.
import { Channel, invoke } from "@tauri-apps/api/core";
import { DESKTOP_PROTOCOL } from "../shared/desktop-protocol.ts";

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
  if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) {
    if (url.search) throw new Error("Task controls do not accept query parameters");
    const runMatch = /^\/api\/tasks\/([A-Za-z0-9_-]{1,120})\/runs\/([A-Za-z0-9_-]{1,120})\/(output|usage)$/.exec(url.pathname);
    if (runMatch) {
      const [, taskId, runId, sub] = runMatch;
      if (sub === "output" && request.method === "GET") {
        request.signal.throwIfAborted();
        try {
          return Response.json(await invoke("control_task", { command: { kind: "outputContent", id: taskId, runId } }), { status: 200 });
        } catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
      }
      if (sub === "output" && request.method === "POST") {
        request.signal.throwIfAborted();
        const parsed = JSON.parse(body ?? "{}");
        try {
          return Response.json(await invoke("control_task", { command: { kind: "output", id: taskId, runId, revision: parsed.revision, command: parsed } }), { status: 200 });
        } catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
      }
      if (sub === "usage" && request.method === "GET") {
        request.signal.throwIfAborted();
        try {
          const view = (await invoke("control_task", { command: { kind: "read", id: taskId } })) as Record<string, unknown>;
          const runs = (view.runHistory as Array<{ id: string; usage?: unknown }>) ?? [];
          const run = runs.find((r) => r.id === runId);
          if (!run) return Response.json({ error: "Run not found in this task" }, { status: 400 });
          return Response.json(run.usage ?? { requests: 0, input: 0, output: 0 }, { status: 200 });
        } catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
      }
      return Response.json({ error: "Unsupported run control" }, { status: 405 });
    }
    const match = /^\/api\/tasks(?:\/([A-Za-z0-9_-]{1,120})(?:\/(cancel|input|review|complete))?)?$/.exec(url.pathname);
    if (!match) return Response.json({ error: "This task operation is unavailable until protected execution is connected" }, { status: 503 });
    const [, taskId, operation] = match;
    let command: Record<string, unknown>;
    if (!taskId && request.method === "GET") command = { kind: "list" };
    else if (!taskId && request.method === "POST") command = { kind: "create", request: JSON.parse(body ?? "{}") };
    else if (taskId && !operation && request.method === "GET") command = { kind: "read", id: taskId };
    else if (taskId && !operation && request.method === "DELETE") {
      const parsed = JSON.parse(body ?? "{}");
      command = { kind: "remove", id: taskId, revision: parsed.revision, confirmUncertain: Boolean(parsed.confirmUncertain) };
    }
    else if (taskId && operation === "cancel" && request.method === "POST") command = { kind: "cancel", id: taskId, revision: JSON.parse(body ?? "{}").revision };
    else if (taskId && operation === "input" && request.method === "POST") {
      const parsed = JSON.parse(body ?? "{}");
      command = { kind: "input", id: taskId, revision: parsed.revision, input: parsed };
    } else if (taskId && operation === "review" && request.method === "GET") {
      command = { kind: "review", id: taskId };
    } else if (taskId && operation === "complete" && request.method === "POST") {
      const parsed = JSON.parse(body ?? "{}");
      command = {
        kind: "complete",
        id: taskId,
        revision: parsed.revision,
        runId: parsed.runId,
        fingerprint: parsed.fingerprint,
        note: parsed.note ?? "",
        confirmed: parsed.confirmed ?? false,
      };
    } else return Response.json({ error: "Unsupported task control" }, { status: 405 });
    request.signal.throwIfAborted();
    try { return Response.json(await invoke("control_task", { command }), { status: command.kind === "create" ? 201 : 200 }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
  }
  if (url.pathname === "/api/workspaces/validate-folder" && request.method === "POST") {
    request.signal.throwIfAborted();
    const parsed = JSON.parse(body ?? "{}");
    try {
      const result = await invoke("control_validate_workspace_folder", { folder: String(parsed.folder ?? "") });
      return Response.json(result, { status: 200 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }
  }
  if (url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/")) {
    request.signal.throwIfAborted();
    const projMatch = /^\/api\/projects(?:\/([^/]+))?$/.exec(url.pathname);
    if (projMatch) {
      const projectId = projMatch[1];
      if (!projectId && request.method === "GET") {
        try {
          const projects = (await invoke("control_list_projects")) as Array<{ id: string; name: string; preferred_workspace?: string | null; revision: number }>;
          const workspaces = (await invoke("control_list_workspaces")) as Array<{ id: string; canonical_path: string }>;
          const wsMap = new Map(workspaces.map((w) => [w.id, w.canonical_path]));
          const list = projects.map((p) => ({
            id: p.id,
            name: p.name,
            folder: p.preferred_workspace ? (wsMap.get(p.preferred_workspace) ?? "") : "",
            revision: p.revision,
            sharedRealm: Boolean(p.preferred_workspace),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          return Response.json(list, { status: 200 });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 409 });
        }
      }
      if (!projectId && request.method === "POST") {
        const parsed = JSON.parse(body ?? "{}");
        const id = `project-${crypto.randomUUID().slice(0, 8)}`;
        const name = String(parsed.name ?? "").trim();
        try {
          const project = (await invoke("control_create_project", { id, name })) as { id: string; name: string; revision: number };
          let folder = "";
          if (parsed.folder) {
            const wsId = `ws-${crypto.randomUUID().slice(0, 8)}`;
            const ws = (await invoke("control_register_workspace", { id: wsId, path: String(parsed.folder) })) as { id: string; canonical_path: string };
            folder = ws.canonical_path;
            await invoke("control_set_project_preferred_workspace", { projectId: project.id, expectedRevision: project.revision, workspaceId: ws.id });
          }
          return Response.json({
            id: project.id,
            name: project.name,
            folder,
            revision: project.revision,
            sharedRealm: Boolean(parsed.sharedRealm),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }, { status: 201 });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 409 });
        }
      }
      if (projectId && request.method === "GET") {
        try {
          const project = (await invoke("control_get_project", { id: projectId })) as { id: string; name: string; preferred_workspace?: string | null; revision: number } | null;
          if (!project) return Response.json({ error: `Project '${projectId}' not found` }, { status: 404 });
          let folder = "";
          if (project.preferred_workspace) {
            const ws = (await invoke("control_get_workspace", { id: project.preferred_workspace })) as { canonical_path: string } | null;
            if (ws) folder = ws.canonical_path;
          }
          return Response.json({
            id: project.id,
            name: project.name,
            folder,
            revision: project.revision,
            sharedRealm: Boolean(project.preferred_workspace),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }, { status: 200 });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 409 });
        }
      }
      if (projectId && request.method === "DELETE") {
        try {
          await invoke("control_remove_project", { id: projectId });
          return Response.json({ ok: true }, { status: 200 });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 409 });
        }
      }
    }
  }
  if (url.pathname === "/api/workspaces/bindings" || url.pathname.startsWith("/api/workspaces/bindings/")) {
    if (!/\/(realm|export-asset|import-file)(\/|$)/.test(url.pathname)) {
      request.signal.throwIfAborted();
      const bindMatch = /^\/api\/workspaces\/bindings(?:\/([^/]+))?$/.exec(url.pathname);
      if (bindMatch) {
        const session = bindMatch[1] ? decodeURIComponent(bindMatch[1]) : undefined;
        if (!session && request.method === "GET") {
          try {
            const bindings = (await invoke("control_list_workspace_bindings")) as Array<{ id: string; session_id: string; workspace_id: string; realm_id?: string | null; mode: string; revision: number; state: string }>;
            const workspaces = (await invoke("control_list_workspaces")) as Array<{ id: string; canonical_path: string }>;
            const wsMap = new Map(workspaces.map((w) => [w.id, w.canonical_path]));
            const list = await Promise.all(bindings.map(async (b) => {
              const membership = (await invoke("control_read_project_membership", { sessionId: b.session_id })) as { project_id?: string | null } | null;
              return {
                session: b.session_id,
                projectId: membership?.project_id ?? undefined,
                folder: wsMap.get(b.workspace_id) ?? "",
                mode: b.mode === "copy_review" ? "copy_review" : "direct",
                realmId: b.realm_id ?? undefined,
                revision: b.revision,
                accessState: b.state === "admitted" ? "admitted" : "revoked",
                boundAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
            }));
            return Response.json(list, { status: 200 });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 409 });
          }
        }
        if (session && request.method === "GET") {
          try {
            const b = (await invoke("control_get_workspace_binding", { sessionId: session })) as { id: string; session_id: string; workspace_id: string; realm_id?: string | null; mode: string; revision: number; state: string } | null;
            if (!b) return Response.json({ error: `No workspace binding for session '${session}'` }, { status: 404 });
            const ws = (await invoke("control_get_workspace", { id: b.workspace_id })) as { canonical_path: string } | null;
            const membership = (await invoke("control_read_project_membership", { sessionId: session })) as { project_id?: string | null } | null;
            return Response.json({
              session: b.session_id,
              projectId: membership?.project_id ?? undefined,
              folder: ws?.canonical_path ?? "",
              mode: b.mode === "copy_review" ? "copy_review" : "direct",
              realmId: b.realm_id ?? undefined,
              revision: b.revision,
              accessState: b.state === "admitted" ? "admitted" : "revoked",
              boundAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }, { status: 200 });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 409 });
          }
        }
        if (session && request.method === "POST") {
          const parsed = JSON.parse(body ?? "{}");
          try {
            const workspaces = (await invoke("control_list_workspaces")) as Array<{ id: string; canonical_path: string }>;
            let ws = workspaces.find((w) => w.canonical_path === parsed.folder);
            if (!ws) {
              const wsId = `ws-${crypto.randomUUID().slice(0, 8)}`;
              ws = (await invoke("control_register_workspace", { id: wsId, path: String(parsed.folder) })) as { id: string; canonical_path: string };
            }
            const mode = parsed.mode === "direct" ? "direct" : "copy_review";
            const bindingId = `b-${crypto.randomUUID().slice(0, 8)}`;
            const binding = (await invoke("control_bind_workspace", {
              id: bindingId,
              sessionId: session,
              workspaceId: ws.id,
              realmId: null,
              mode,
            })) as { id: string; session_id: string; workspace_id: string; mode: string; revision: number; state: string };
            if (parsed.projectId) {
              await invoke("control_set_project_membership", { sessionId: session, projectId: parsed.projectId, expectedRevision: null });
            }
            return Response.json({
              session: binding.session_id,
              projectId: parsed.projectId,
              folder: ws.canonical_path,
              mode: binding.mode === "copy_review" ? "copy_review" : "direct",
              revision: binding.revision,
              accessState: "admitted",
              boundAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }, { status: 200 });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 409 });
          }
        }
        if (session && request.method === "DELETE") {
          try {
            await invoke("control_unbind_workspace", { sessionId: session });
            return Response.json({ ok: true }, { status: 200 });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 409 });
          }
        }
      }
    }
  }
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
      if (frame.v !== DESKTOP_PROTOCOL || frame.id !== id) { fail(new Error("Incompatible engine response")); return; }
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
