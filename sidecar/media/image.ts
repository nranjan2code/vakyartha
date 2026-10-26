import { base64, jsonResponse, object } from "./io.ts";
import { falRun, key, post, request, type Context, type MediaRequest, type MediaResult } from "./remote.ts";

export async function image(req: MediaRequest, ctx: Context): Promise<MediaResult> {
  if (req.chosen.provider === "fal") return falRun(req, ctx);
  if (req.chosen.provider === "openai") {
    const headers = { authorization: `Bearer ${key("openai", ctx)}` };
    const fields = { model: req.chosen.model, prompt: req.prompt, size: req.ratio === "16:9" ? "1536x1024" : req.ratio === "9:16" ? "1024x1536" : "1024x1024", quality: req.quality, background: req.background, output_format: "png", n: 1 };
    let result: Record<string, unknown>;
    if (req.input) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
      form.set("image[]", new Blob([new Uint8Array(req.input.bytes)], { type: req.input.type }), "input");
      if (req.mask) form.set("mask", new Blob([new Uint8Array(req.mask.bytes)], { type: req.mask.type }), "mask.png");
      result = await jsonResponse(await request(ctx, "https://api.openai.com/v1/images/edits", { method: "POST", headers, body: form }));
    } else result = await post(ctx, "https://api.openai.com/v1/images/generations", headers, fields);
    if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error("Provider did not return one image");
    return { files: [base64(object(result.data[0]).b64_json)], usage: result.usage };
  }
  if (req.chosen.provider === "gemini") {
    const parts: Record<string, unknown>[] = [{ text: req.prompt }];
    if (req.input) parts.push({ inlineData: { mimeType: req.input.type, data: req.input.bytes.toString("base64") } });
    const result = await post(ctx, `https://generativelanguage.googleapis.com/v1beta/models/${req.chosen.model}:generateContent`, { "x-goog-api-key": key("gemini", ctx) }, { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.ratio } } });
    const candidates = result.candidates;
    if (!Array.isArray(candidates) || !candidates.length) throw new Error("Provider returned no image candidate");
    const out = object(object(candidates[0]).content).parts;
    if (!Array.isArray(out)) throw new Error("Provider returned no image content");
    const data = out.map(object).filter((p) => p.thought !== true && p.inlineData).map((p) => object(p.inlineData));
    if (data.length !== 1) throw new Error("Provider did not return one final image");
    return { files: [base64(data[0]!.data)], usage: result.usageMetadata };
  }
  throw new Error("Unsupported image provider");
}
