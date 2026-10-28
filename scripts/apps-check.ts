// Real WebKit + supervised helper journey, with frozen source/calculation checks.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startAppServer } from "../sidecar/server.ts";
const run = promisify(execFile);
const out = await mkdtemp(path.join(tmpdir(), "vak-app-webkit-"));
const app = await startAppServer({ dataDir: path.join(out, "data"), access: "open", uiDir: path.resolve("dist"), sandboxBin: process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb"), keychainService: "com.nranjan2code.vakyartha.apps-check" });
const source = `function project(context) { return {updates:Object.keys(context.surfaces).map(surface=>({surface,data:{input:context.state.input??0,total:context.state.total??0}}))}; }
export async function handleAction(id,value,context){context.state.input=Number(value);context.state.total=Number(value)*6;return project(context)}
export async function refresh(context){context.state.total+=5;return project(context)}`;
const surface = (id: string) => ({ id, version: 1, title: id, data: { input: 0, total: 0 }, nodes: [{ id: "root", type: "form", props: { title: "Compute", submitLabel: "Apply" }, children: ["input", "total"] }, { id: "input", type: "input", props: { kind: "number", label: "Input", bind: "/input" } }, { id: "total", type: "stat", props: { label: "Total", value: "{/total}" } }] });
try {
  const bin = path.join(out, "webkit-check");
  await run("swiftc", ["-O", "scripts/webkit-check.swift", "-o", bin]);
  for (const width of (process.env.VAK_APP_WIDTHS?.split(",").map(Number) ?? [1100, 620, 375])) {
    const id = `check-${width}`;
    await app.apps!.installApp({ id, name: `Calculation ${width}`, version: "1.0.0", entrypoints: { backend: "main.ts", surface: "surface.json" }, triggers: [{ id: "refresh", kind: "cron", expression: "* * * * *", action: "refresh" }] }, { "main.ts": source, "surface.json": JSON.stringify([surface("main"), surface("secondary")]) });
    const setup = `const style=document.createElement('style');style.textContent='.app{transition:none!important}';document.head.append(style);const check=(x,m)=>{if(!x)throw Error(m)}; const wait=ms=>new Promise(r=>setTimeout(r,ms)); const flush=()=>document.querySelectorAll('vak-surface').forEach(s=>{s.renderNow();s.shadowRoot.querySelectorAll('.enter').forEach(n=>n.classList.remove('enter'));});`;
    const steps = [
      `document.getElementById('open-apps').click();await wait(200);window.dispatchEvent(new CustomEvent('vak:run-app',{detail:${JSON.stringify(id)}}));await wait(200);flush();check(document.querySelector('#apps-page vak-surface'),'No app surface');return 'published app opened';`,
      `const input=document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('input[type=number]');check(input,'No bound input');input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));await wait(1300);flush();const d=await (await fetch('/api/apps/${id}')).json();check(d.state.total===42,'Expected 7*6=42');check(document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('.stat .value')?.textContent==='42','Calculated result not displayed');return 'direct calculation and saved receipt 42';`,
      `const s=document.querySelector('[aria-label="App surface"]');s.value='secondary';s.dispatchEvent(new Event('change'));flush();check(document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('.stat .value')?.textContent==='42','Independent surface not updated');return 'second surface retains calculation';`,
      `const r=await fetch('/api/apps/${id}/triggers/refresh/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});check(r.ok,'Refresh failed');await wait(2400);flush();check(document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('.stat .value')?.textContent==='47','Background refresh not displayed');check(document.documentElement.scrollWidth<=innerWidth+2,'Horizontal overflow');check(document.getElementById('apps-page').getBoundingClientRect().width>=Math.min(innerWidth,500)-10,'App view too narrow: '+document.body.className+' '+getComputedStyle(document.querySelector('.app')).gridTemplateColumns+' legacy='+matchMedia('(max-width:720px)').matches+' modern='+matchMedia('(width <= 720px)').matches);return 'background refresh 47 and responsive view';`,
      `document.getElementById('app-runner-back').click();await wait(100);window.dispatchEvent(new CustomEvent('vak:run-app',{detail:${JSON.stringify(id)}}));await wait(200);flush();check(document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('.stat .value')?.textContent==='47','Reopen lost current data');return 'reopen retains 47';`,
    ];
    const { stdout } = await run(bin, [app.url, path.join(out, `width-${width}`), ...steps.map(s => setup + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 45_000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (/step \d+ error:/.test(stdout) || !stdout.includes("reopen retains 47")) throw new Error(`App WebKit journey failed at ${width}`);
  }
  console.log(`Apps WebKit passed. Evidence: ${out}`);
} catch (error) { console.error(error); process.exitCode = 1; } finally { await app.shutdown(); }
