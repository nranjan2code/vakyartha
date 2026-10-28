// One invocation in the existing supervised sandbox. No host credentials or stdin.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(".vak-request.json", "utf8"));
  const context = { state: request.state, surfaces: request.surfaces, surface: request.surface, callTool };
  let sequence = 0;
  let bridge = Promise.resolve();
  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // One mailbox exchange at a time; no repeated/replayed effects.
    const previous = bridge;
    let release!: () => void;
    bridge = new Promise<void>(r => { release = r; });
    await previous;
    try {
      const id = sequence++;
      if (id >= 16) throw new Error("App tool-call allowance exceeded");
      const body = JSON.stringify({ id, name, args });
      if (Buffer.byteLength(body) > 16384) throw new Error("Tool request too large");
      writeFileSync(".vak-tool.tmp", body); renameSync(".vak-tool.tmp", ".vak-tool.json");
      const reply = `.vak-reply-${id}.json`;
      while (!existsSync(reply)) await delay(20);
      const result = JSON.parse(readFileSync(reply, "utf8"));
      if (result.error) throw new Error(result.error);
      return result.value;
    } finally { release(); }
  }
  const mod = await import(pathToFileURL(path.resolve(request.backend)).href);
  const handler = request.trigger ? mod[request.action] : mod.handleAction;
  if (typeof handler !== "function") throw new Error(`Missing app handler: ${request.trigger ? request.action : "handleAction"}`);
  const result = request.trigger
    ? await handler(context)
    : await handler(request.controlId, request.value, context, request.action);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("App handler must return an object");
  const body = JSON.stringify({ result, state: context.state });
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("App result exceeds 4 MiB");
  writeFileSync(".vak-result.json", body);
}
try { await main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
