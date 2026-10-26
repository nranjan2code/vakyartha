// OCR as an integration: one built-in tool that reads the text in an image
// with an OCR model already pulled into the local Ollama. It is a catalog
// entry like any other, so other OCR engines (an MCP server, a hosted
// service) can sit beside it in the catalog and the user picks which to turn on.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { timeServer } from "@vak/mcp/client";
import { ollamaBase } from "./voice/speech.ts";

type BuiltinServer = ReturnType<typeof timeServer>;

/** Ollama OCR models in order of preference; the first one installed is used. */
export const OCR_MODELS = ["glm-ocr"];

const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const MAX_BYTES = 20_000_000;
/** GLM-OCR's documented task prompts (ollama.com/library/glm-ocr). */
const PROMPTS: Record<string, string> = { text: "Text Recognition:", table: "Table Recognition:", figure: "Figure Recognition:" };

async function installedOcrModel(fetcher: typeof fetch, base: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await fetcher(`${base}/api/tags`, { signal });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  const names = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  for (const want of OCR_MODELS) {
    const hit = names.find((n) => n === want || n.startsWith(`${want}:`));
    if (hit) return hit;
  }
  return undefined;
}

export function ollamaOcrServer(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): BuiltinServer {
  return {
    tools: [
      {
        name: "read_text_from_image",
        title: "Read text from an image",
        description: "Extract text from an image file on this computer with a local OCR model. Give an absolute path to a png, jpg, webp, gif, bmp or tiff; mode \"table\" for a table, \"figure\" for a chart or diagram, otherwise \"text\".",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path to the image" }, mode: { type: "string", enum: ["text", "table", "figure"] } }, required: ["path"] },
        annotations: { readOnlyHint: true, openWorldHint: false, title: "Read text from an image" },
      },
    ],
    async callTool(name, args, signal) {
      if (name !== "read_text_from_image") return { text: `unknown tool ${name}`, isError: true };
      const file = String(args.path ?? "");
      if (!path.isAbsolute(file)) return { text: "path must be absolute", isError: true };
      if (!IMAGE_TYPES.has(path.extname(file).toLowerCase())) return { text: "not an image file", isError: true };
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_BYTES) return { text: "not a file, or larger than 20 MB", isError: true };
        const base = ollamaBase(env);
        const model = await installedOcrModel(fetcher, base, signal);
        if (!model) return { text: `No OCR model in Ollama. Install one with: ollama pull ${OCR_MODELS[0]}`, isError: true };
        const image = (await readFile(file)).toString("base64");
        const r = await fetcher(`${base}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: PROMPTS[String(args.mode)] ?? PROMPTS.text, images: [image], stream: false }),
          signal,
        });
        if (!r.ok) return { text: `Ollama answered ${r.status}`, isError: true };
        const text = ((await r.json()) as { response?: string }).response?.trim() ?? "";
        return { text: text || "(no text found)", isError: false };
      } catch (e) {
        return { text: `OCR failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
