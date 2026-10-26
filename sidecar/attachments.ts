// Files attached in the chat. The window can't hand the engine a path (a
// browser never sees one), so the bytes are copied into the app's data folder
// and the message carries that path; tools such as OCR then read it there.
// Lifecycle: <data>/attachments/<chat id>/<random>.<ext>, owner-only; the
// folder goes when its chat is deleted.

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { json } from "@vak/host";

const TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp", "image/tiff": ".tiff" };
const MAX_BYTES = 20_000_000;
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function attachmentsRoute(dir: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const gone = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (gone && req.method === "DELETE") {
      const id = decodeURIComponent(gone[1]!);
      if (CHAT_ID.test(id)) await rm(path.join(dir, id), { recursive: true, force: true });
      return false; // the host still deletes the chat itself
    }
    if (url.pathname !== "/api/attachments" || req.method !== "POST") return false;
    const chat = url.searchParams.get("session") ?? "";
    if (!CHAT_ID.test(chat)) return json(res, 400, { error: "unknown chat" }), true;
    // JSON only: the host refuses other bodies on POST, so the bytes come base64.
    let raw = "";
    for await (const c of req as AsyncIterable<Buffer>) {
      raw += c;
      if (raw.length > MAX_BYTES * 1.4) return json(res, 413, { error: "Attachments are limited to 20 MB." }), true;
    }
    const body = JSON.parse(raw || "{}") as { type?: string; data?: string };
    const ext = TYPES[String(body.type)];
    if (!ext) return json(res, 415, { error: "Only images can be attached for now." }), true;
    const bytes = Buffer.from(String(body.data ?? ""), "base64");
    if (!bytes.length || bytes.length > MAX_BYTES) return json(res, 413, { error: "Attachments are limited to 20 MB." }), true;
    const folder = path.join(dir, chat);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${randomUUID()}${ext}`);
    await writeFile(file, bytes, { mode: 0o600 });
    json(res, 200, { path: file });
    return true;
  };
}
