// OCR as an integration: one built-in tool that reads the text in an image
// with an OCR model already pulled into the local Ollama. It is a catalog
// entry like any other, so other OCR engines (an MCP server, a hosted
// service) can sit beside it in the catalog and the user picks which to turn on.

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { timeServer } from "@vak/mcp/client";
import { ollamaBase } from "./voice/transport.ts";

type BuiltinServer = ReturnType<typeof timeServer>;

/** Ollama OCR models in order of preference; the first one installed is used. */
export const OCR_MODELS = ["glm-ocr"];

const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const MAX_BYTES = 20_000_000;
const PATH = { type: "string", description: "Absolute path to the image, e.g. from an [Attached image …] line" };

/** One tool per GLM-OCR task. Text, table and figure prompts are from its Ollama page; formula and extraction were checked against glm-ocr. */
const TASKS: Record<string, { title: string; description: string; prompt: (args: Record<string, unknown>) => string; extra?: Record<string, unknown>; required?: string[]; writes?: boolean }> = {
  read_text_from_image: { title: "Read text from an image", description: "All the text in an image (a photo, scan, screenshot or attached image) in reading order.", prompt: () => "Text Recognition:" },
  read_table_from_image: { title: "Read a table from an image", description: "A table in an image, kept as a table with its rows and columns.", prompt: () => "Table Recognition:" },
  read_formula_from_image: { title: "Read a formula from an image", description: "Mathematical formulas in an image as LaTeX.", prompt: () => "Formula Recognition:" },
  export_markdown_from_image: {
    title: "Export an image to Markdown",
    description: "Convert a document image to Markdown and save it as a .md file next to the image (never overwriting one). Returns the saved path and the Markdown.",
    prompt: () => "Text Recognition:",
    writes: true,
  },
  read_figure_from_image: { title: "Read a figure from an image", description: "A chart, diagram or figure in an image, read into text.", prompt: () => "Figure Recognition:" },
  extract_fields_from_image: {
    title: "Extract fields from an image",
    description: "Pull named fields (invoice number, date, total, name…) out of a document image as JSON.",
    // GLM-OCR is trained on this Chinese instruction ("output the image's information in this JSON format").
    prompt: (args) => `请按下列JSON格式输出图中信息:\n${JSON.stringify(Object.fromEntries((args.fields as string[]).map((f) => [String(f), ""])))}`,
    extra: { fields: { type: "array", items: { type: "string" }, description: "Field names to extract" } },
    required: ["fields"],
  },
};

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

/** Writes <image name>.md beside the image; an existing file is never replaced. */
async function saveBeside(image: string, markdown: string): Promise<string> {
  const stem = image.slice(0, -path.extname(image).length);
  for (let n = 0; n < 100; n++) {
    const out = `${stem}${n ? `-${n}` : ""}.md`;
    try {
      await writeFile(out, markdown, { flag: "wx" });
      return out;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("too many Markdown exports beside this image");
}

export function ollamaOcrServer(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): BuiltinServer {
  return {
    tools: Object.entries(TASKS).map(([name, t]) => ({
      name,
      title: t.title,
      description: `${t.description} Uses a local OCR model; give an absolute path to a png, jpg, webp, gif, bmp or tiff.`,
      inputSchema: { type: "object", properties: { path: PATH, ...t.extra }, required: ["path", ...(t.required ?? [])] },
      annotations: { readOnlyHint: !t.writes, destructiveHint: false, openWorldHint: false, title: t.title },
    })),
    async callTool(name, args, signal) {
      const task = TASKS[name];
      if (!task) return { text: `unknown tool ${name}`, isError: true };
      if (task.required?.includes("fields") && (!Array.isArray(args.fields) || !args.fields.length)) return { text: "fields must list at least one name", isError: true };
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
          body: JSON.stringify({ model, prompt: task.prompt(args), images: [image], stream: false }),
          signal,
        });
        if (!r.ok) return { text: `Ollama answered ${r.status}`, isError: true };
        const text = ((await r.json()) as { response?: string }).response?.trim() ?? "";
        if (!task.writes) return { text: text || "(no text found)", isError: false };
        if (!text) return { text: "No text found; nothing saved.", isError: true };
        const saved = await saveBeside(file, `${text}\n`);
        return { text: `Saved to ${saved}\n\n${text}`, isError: false };
      } catch (e) {
        return { text: `OCR failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
