// Isolated WebKit proof of reviewed updates and a local catalog package. No model/network calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { Skills } from "../sidecar/skills.ts";

const out = await mkdtemp(path.join(tmpdir(), "vak-skill-updates-")), run = promisify(execFile), bin = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
const originalFetch = globalThis.fetch;
const sha = "a".repeat(40);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("github.com") && !url.includes("githubusercontent.com")) return originalFetch(input, init);
  if (url.includes("/commits?")) return Promise.resolve(new Response(JSON.stringify([{ sha }])));
  if (url.includes("/git/trees/")) return Promise.resolve(new Response(JSON.stringify({ tree: [
    { path: "SKILL.md", type: "blob", size: 120 }, { path: "palette.md", type: "blob", size: 21 },
    { path: "references/guide.md", type: "blob", size: 20 }, { path: "run.py", type: "blob", size: 8 },
  ] })));
  if (url.endsWith("/SKILL.md")) return Promise.resolve(new Response("---\nname: catalog-file-skill\ndescription: Demonstrate supporting files in review.\n---\nRead palette.md and references/guide.md.\n"));
  if (url.endsWith("/palette.md")) return Promise.resolve(new Response("red: #aabbcc\n"));
  if (url.endsWith("/references/guide.md")) return Promise.resolve(new Response("# Guide\nExact sample.\n"));
  return Promise.resolve(new Response("not found", { status: 404 }));
}) as typeof fetch;
for (const width of [1100, 620, 375]) {
  const dir = path.join(out, `data-${width}`), skills = new Skills(dir);
  skills.save("---\nname: explain-simply\ndescription: Previous instructions.\n---\n\nMy existing instructions.\n", "explain-simply");
  skills.setEnabled("explain-simply", false);
  const savedPath = path.join(dir, "skills", "skills.json"), saved = JSON.parse(readFileSync(savedPath, "utf8"));
  delete saved["market-dashboard"].files;
  writeFileSync(savedPath, JSON.stringify(saved));
  rmSync(path.join(dir, "skills", "market-dashboard", "files"), { recursive: true });
  const app = await startAppServer({ dataDir: dir, keychainService: "com.nranjan2code.vakyartha.skill-updates-check", access: "open", uiDir: path.resolve("dist") });
  const setup = `const check=(ok,msg)=>{if(!ok)throw new Error(msg)};const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI did not settle')};`;
  const steps = [
    `document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Skills').click();await wait(()=>document.querySelector('.market-card'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Updates').click();check(document.querySelectorAll('.market-card').length===2,'Updates filter lost pending skills');const card=[...document.querySelectorAll('.market-card')].find(b=>b.querySelector('.market-name')?.textContent==='explain-simply');check(card?.textContent.includes('Update'),'Update badge missing');card.click();check(document.querySelectorAll('.skill-body').length===2,'Current/update preview missing');check(document.querySelector('.skill-body').textContent.includes('My existing instructions.'),'Existing edit was overwritten');check(!document.querySelector('#settings-content input[type="checkbox"]').checked,'Disabled skill enabled');check(document.documentElement.scrollWidth<=innerWidth,'Update preview overflow');return 'update available with current and proposed instructions';`,
    `[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Update skill').click();await wait(()=>![...document.querySelectorAll('#settings-content button')].some(b=>b.textContent==='Update skill'));const list=await(await fetch('/api/skills')).json();const changed=list.find(s=>s.name==='explain-simply');check(!changed.update,'Update still pending');check(!changed.enabled,'Update changed on/off choice');[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Instructions').click();check(!document.querySelector('.skill-formatted').textContent.includes('My existing instructions.'),'Update not applied');const design=list.find(s=>s.name==='surface-design');check(design?.required&&design.enabled,'Required skill state missing');[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent.includes('Skills')).click();await wait(()=>[...document.querySelectorAll('#settings-content button')].some(b=>b.textContent==='All'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='All').click();await wait(()=>document.querySelector('.market-card'));[...document.querySelectorAll('.market-card')].find(b=>b.querySelector('.market-name')?.textContent==='surface-design').click();check(document.body.innerText.includes('Always on'),'Always-on status missing');check(![...document.querySelectorAll('#settings-content button')].some(b=>b.textContent==='Remove'),'Required remove action shown');check(!document.querySelector('#settings-content input[type=checkbox]'),'Required toggle shown');const off=await fetch('/api/skills/surface-design',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});check(off.status===400,'API allowed required skill off');const del=await fetch('/api/skills/surface-design',{method:'DELETE'});check(del.status===400,'API allowed required skill removal');return 'reviewed update; required skill enforced in UI and API';`,
    `[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent.includes('Skills')).click();await wait(()=>document.querySelector('.market-card'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Updates').click();const card=[...document.querySelectorAll('.market-card')].find(b=>b.querySelector('.market-name')?.textContent==='market-dashboard');check(card,'Market package update missing');card.click();[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Overview').click();check(document.body.innerText.includes('Current files: none. Proposed files:'),'Package file preview missing');const row=[...document.querySelectorAll('.skill-file')].find(d=>d.textContent.includes('market-dashboard-layout.md'));check(row,'Proposed layout file missing');row.open=true;await wait(()=>row.textContent.includes('Reusable market dashboard layout'));check(document.documentElement.scrollWidth<=innerWidth,'Package preview overflow');[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Update skill').click();await wait(()=>[...document.querySelectorAll('#settings-content button')].some(b=>b.textContent==='Files (2)'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Files (2)').click();check(document.body.innerText.includes('market-dashboard-example.json'),'Installed package file missing');return 'built-in package preview and update pass';`,
    `[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent.includes('Skills')).click();await wait(()=>[...document.querySelectorAll('#settings-content button')].some(b=>b.textContent.includes('Explore catalogs')));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent.includes('Explore catalogs')).click();const field=document.querySelector('input[aria-label="Skill repository"]');field.value='example/skills';field.closest('form').querySelector('button').click();await wait(()=>document.querySelector('.skills-catalog-market .market-card'));return 'catalog listed';`,
    `document.querySelector('.skills-catalog-market .market-card').click();return 'review opened';`,
    `await wait(()=>document.body.innerText.includes('Instructions + 2 files'));return 'catalog reviewed';`,
    `check(document.body.innerText.includes('2 files will be added'),'Totals missing');check(document.body.innerText.includes('1 bundled file will be omitted'),'Omission warning missing');[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Files (2)').click();const row=[...document.querySelectorAll('.skill-file')].find(d=>d.textContent.includes('palette.md'));row.open=true;await wait(()=>row.textContent.includes('#aabbcc'));check(row.textContent.includes('red: #aabbcc'),'Exact review text missing');[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent.includes('Not added')).click();check(document.body.innerText.includes('Script · not added'),'Script classification missing');const add=[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Add skill');check(add.disabled,'Add enabled before acknowledgement');document.querySelector('.catalog-ack input').click();check(!add.disabled,'Add stayed disabled');add.click();await wait(()=>document.body.innerText.includes('catalog-file-skill')&&[...document.querySelectorAll('#settings-content button')].some(b=>b.textContent==='Files (2)'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Files (2)').click();const stored=[...document.querySelectorAll('.skill-file')].find(d=>d.textContent.includes('palette.md'));stored.open=true;await wait(()=>stored.textContent.includes('#aabbcc'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Source').click();const missing=[...document.querySelectorAll('.skill-file')].find(d=>d.textContent.includes('bundled files not added'));check(missing&&missing.textContent.includes('run.py'),'Stored omission details missing');check(document.documentElement.scrollWidth<=innerWidth,'Skills overflow viewport');return 'review and stored files verified';`,
  ];
  if (width === 375) steps[6] = `check(document.documentElement.scrollWidth<=innerWidth,'Skills overflow viewport');return 'narrow review fits';`;
  try {
    let stdout: string;
    try { ({ stdout } = await run(bin, [app.url, path.join(out, `width-${width}`), ...steps.map(step => setup + step)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 30000 })); }
    catch (err) { console.error((err as { stdout?: string }).stdout ?? "", (err as { stderr?: string }).stderr ?? ""); throw err; }
    console.log(`${width}px: ${stdout.trim()}`);
    if (stdout.includes(" error:") || !stdout.includes("required skill enforced")) throw new Error("Skills WebKit check failed");
  } finally { await app.shutdown(); }
}
console.log(`Skills WebKit checks passed. Screenshots: ${out}`);
globalThis.fetch = originalFetch;
