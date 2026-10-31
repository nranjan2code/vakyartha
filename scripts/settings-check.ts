// Isolated WebKit settings journey against the real app; no model or catalog calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";

const out = await mkdtemp(path.join(tmpdir(), "vak-settings-check-"));
const run = promisify(execFile), binary = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", binary]);
const setup = `const check=(ok,msg)=>{if(!ok)throw new Error(msg)};const wait=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI did not settle')};const click=label=>{const b=[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent===label);check(b,'Missing '+label);b.click()};const fits=()=>{check(document.documentElement.scrollWidth<=innerWidth,'Viewport overflow');const content=document.querySelector('#settings-content');check(content.scrollWidth<=content.clientWidth+1,'Settings overflow')};`;
for (const width of [1100, 620, 375]) {
  const dataDir = path.join(out, `data-${width}`);
  const app = await startAppServer({ dataDir, access: "open", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.settings-check" });
  const steps = [
    `document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Sandbox').click();await wait(()=>document.querySelector('.sandbox-health'));check(document.body.innerText.includes('needs the desktop app'),'Missing web-mode state');check([...document.querySelectorAll('button')].find(b=>b.textContent==='Run test command').disabled,'Test enabled outside the desktop app');fits();return 'web-mode sandbox state fits';`,
    `click('Manage tool & approvals');await wait(()=>document.body.innerText.includes('run_command'));check(document.body.innerText.includes('Sandboxed execution'),'Wrong integration');[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Sandbox').click();await wait(()=>document.querySelector('.sandbox-health'));click('Open skill');await wait(()=>document.querySelector('.skill-detail-layout'));check(document.querySelector('#settings-content h1').textContent==='sandbox','Wrong skill');fits();return 'dedicated integration and skill navigation';`,
    `const control=document.querySelector('input[aria-label="Use sandbox"]');control.click();await wait(()=>!document.querySelector('input[aria-label="Use sandbox"]').checked&&!document.querySelector('input[aria-label="Use sandbox"]').disabled);click('Instructions');check(document.querySelector('.skill-formatted'),'Missing instructions');click('Overview');click('Edit');await wait(()=>document.querySelector('textarea'));click('Cancel');await wait(()=>document.querySelector('input[aria-label="Use sandbox"]'));check(!document.querySelector('input[aria-label="Use sandbox"]').checked,'Cancel lost disabled choice');click('Open Sandbox settings');await wait(()=>document.querySelector('.sandbox-health'));fits();return 'skill toggle, instructions, editor cancel and return work';`,
  ];
  try {
    const { stdout } = await run(binary, [app.url, path.join(out, `sandbox-${width}`), ...steps.map(s => setup + s)], { env: { ...process.env, WK_WIDTH: String(width), WK_HEIGHT: "980" }, timeout: 50000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (stdout.includes(" error:") || !stdout.includes("editor cancel")) throw new Error("Settings WebKit journey failed");
  } finally { await app.shutdown(); }
}
console.log(`Settings WebKit checks passed. Screenshots: ${out}`);
