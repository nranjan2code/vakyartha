// The local conversation model authors real plugin calls; all media provider
// I/O is mocked. This checks tool use without a paid generation or user data.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { basicCatalog, SurfaceStore, type AgentEvent } from "@vak/core";
import { ollama, runAgent } from "@vak/providers";
import { createIntegrations } from "../sidecar/integrations.ts";
import { Media } from "../sidecar/media/index.ts";
import { fileSecrets } from "../sidecar/settings.ts";

const dir = mkdtempSync(path.join(tmpdir(), "vak-media-authoring-"));
mkdirSync(path.join(dir, "logs"));
let integrations: ReturnType<typeof createIntegrations>;
let providerCalls = 0;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const media = new Media({ dir: path.join(dir, "media"), attachmentsDir: path.join(dir, "attachments"), voiceDir: path.join(dir, "voice"), env: { OPENAI_API_KEY: "offline-fixture" }, config: (kind) => integrations.view().find((i) => i.entry.id === `media-${kind}`) ?? { enabled: false, config: {} }, fetcher: (async () => { providerCalls++; return Response.json({ data: [{ b64_json: png }] }); }) as typeof fetch });
integrations = createIntegrations({ dataDir: dir, secrets: fileSecrets(path.join(dir, "settings.env")), approve: async () => "allow" }, media);
await integrations.configure("media-image", { enabled: true, config: { generate_image: "openai|gpt-image-2.5-flare" } });
const events: AgentEvent[] = [];
const store = new SurfaceStore(basicCatalog);
const model = "qwen3.5:4b-mlx";
const result = await runAgent({ provider: ollama(), model, store,
  messages: [{ role: "user", content: "Make an image of a blue songbird sitting on a branch. Use my enabled Images integration and its configured model. Start just one job and tell me where I can review it." }],
  tools: await integrations.toolsFor("authoring"), generation: "tools", completion: "response", maxSteps: 5, toolRounds: 2, maxTokens: 1800, extra: { think: false }, signal: AbortSignal.timeout(120_000), emit: (e) => events.push(e),
});
await new Promise((r) => setTimeout(r, 20));
const jobs = (await media.view("image")).jobs;
const report = { model, result, providerCalls, jobs, events, note: "Local conversation authoring only; media provider responses are mocked." };
const reportFile = path.join(dir, "report.json"); writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ model, result, providerCalls, jobs: jobs.map((j) => ({ state: j.state, selection: j.selection })), report: reportFile }));
await media.close();
if (providerCalls !== 1 || jobs.length !== 1 || jobs[0]?.state !== "succeeded") process.exitCode = 1;
