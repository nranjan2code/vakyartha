import { falRun, lumaRun, type Context, type MediaRequest, type MediaResult } from "./remote.ts";
export async function video(req: MediaRequest, ctx: Context): Promise<MediaResult> {
  if (req.chosen.provider === "fal") return falRun(req, ctx);
  if (req.chosen.provider === "luma") return lumaRun(req, ctx);
  throw new Error("Unsupported video provider");
}
