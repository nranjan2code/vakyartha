// Real WebKit + deterministic numeric telemetry. No provider/model calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { startAppServer } from "../sidecar/server.ts";
import { emptyShape, type Turn } from "../shared/finops.ts";
const run = promisify(execFile), out = mkdtempSync(path.join(tmpdir(), "vak-finops-check-")), bin = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
for (const width of [1100, 620]) {
  const dir = path.join(out, String(width)); mkdirSync(path.join(dir, "logs"), { recursive: true });
  const file = path.join(dir, "logs/finops.jsonl");
  const turn = (id: string, session: string, local: boolean): Turn => ({ id, session, at: new Date().toISOString(), provider: "fixture", model: local ? "local" : "hosted", local, ms: 1000, source: "recorded", context: emptyShape(), output: emptyShape(), steps: [{ ms: 1000, context: emptyShape(), output: emptyShape(), systemChars: 20, schemaChars: 30, nativeChars: 0, projectionCalls: 0, externalCalls: 0, complete: true, input: 100, cachedInput: 40, outputTokens: 25 }], projectionCalls: 0, externalCalls: 0, errors: 0, complete: true });
  appendFileSync(file, JSON.stringify(turn("first", "one", true)) + "\n" + JSON.stringify(turn("second", "two", false)) + "\n");
  const app = await startAppServer({ dataDir: dir, access: "open", transport: "stdio", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.finops-check" });
  const server = createServer(async (req, res) => {
    if (req.url === "/__check/advance") { appendFileSync(file, JSON.stringify(turn("third", "two", false)) + "\n"); res.writeHead(204).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const abort = new AbortController(); res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    const response = await app.request(new Request(`http://localhost${req.url}`, { method: req.method, signal: abort.signal, headers: Object.fromEntries(Object.entries(req.headers).filter(([,v]) => typeof v === "string")) as Record<string,string>, ...(body.length ? { body, duplex: "half" } : {}) } as RequestInit));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) { const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream); stream.on("error", () => res.end()); res.on("close", () => stream.destroy()); stream.pipe(res); } else res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const setup = `const check=(v,m)=>{if(!v)throw new Error(m)};const wait=async fn=>{for(let i=0;i<240;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('FinOps did not settle')};`;
  const steps = [
    `Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='FinOps').click();await wait(()=>document.querySelector('.finops'));check(document.querySelector('.finops').textContent.includes('2 measured turns'),'Measured count missing');check(document.querySelector('.finops').textContent.includes('0 model rates configured'),'Missing rates not disclosed');const filter=document.querySelector('[aria-label="FinOps chat"]');filter.value='two';filter.dispatchEvent(new Event('change'));const select=document.querySelector('[aria-label="Inspect turn"]');select.value='second';select.dispatchEvent(new Event('change'));check(document.querySelector('.finops-detail').textContent.includes('Unknown'),'Hosted cost fabricated');const input=document.querySelector('[aria-label="Input USD per million tokens"]');input.value='7';check(document.documentElement.scrollWidth<=innerWidth,'FinOps overflow');return 'real numeric history and unknown prices shown';`,
    `const box=document.querySelector('.finops');await fetch('/__check/advance');document.activeElement?.blur();await wait(()=>box.textContent.includes('3 measured turns'));check(document.querySelector('.finops')===box,'Polling replaced the page');check(document.querySelector('[aria-label="FinOps chat"]').value==='two','Polling lost chat filter');check(document.querySelector('[aria-label="Inspect turn"]').value==='second','Polling lost selected turn');check(document.querySelector('[aria-label="Input USD per million tokens"]').value==='7','Polling overwrote draft rate');check(box.querySelector('.lead').textContent.startsWith('2 turns'),'Filter was not applied to fresh records');return 'automatic refresh preserves filter, turn and draft';`,
    `const fields=[...document.querySelectorAll('.finops input[type="number"]')];fields[0].value='2';fields[1].value='0.2';fields[2].value='8';[...document.querySelectorAll('.finops button')].find(b=>b.textContent==='Save rates').click();await wait(()=>document.querySelector('.finops').textContent.includes('1 model rates configured'));check(document.querySelector('.finops-detail').textContent.includes('$0.000328'),'Configured estimate incorrect');const box=document.querySelector('.finops');[...box.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click();await wait(()=>![...box.querySelectorAll('button')].find(b=>b.textContent==='Refresh').disabled);check(document.querySelector('.finops')===box,'Refresh rebuilt Settings');check(document.querySelector('[aria-label="FinOps chat"]').value==='two','Refresh lost filter');check(document.documentElement.scrollWidth<=innerWidth,'FinOps overflow after refresh');return 'saved rates recompute exact estimate; manual refresh preserves state';`,
  ];
  try {
    let stdout: string, stderr: string;
    try { ({ stdout, stderr } = await run(bin, [url, path.join(out, `width-${width}`), ...steps.map((s) => setup + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 45000 })); } catch (e) { console.error((e as {stdout?:string}).stdout, (e as {stderr?:string}).stderr); throw e; }
    console.log(`${width}px: ${stdout.trim()}`);
    if (stdout.includes(" error:") || !stdout.includes("exact estimate")) throw new Error(stdout + stderr);
  } finally { server.closeAllConnections(); server.close(); await app.shutdown(); }
}
console.log(`FinOps WebKit checks passed. Screenshots: ${out}`);
