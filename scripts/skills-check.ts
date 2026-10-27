// Isolated WebKit proof of reviewed built-in updates. No model/network calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { Skills } from "../sidecar/skills.ts";

const out = await mkdtemp(path.join(tmpdir(), "vak-skill-updates-")), run = promisify(execFile), bin = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
for (const width of [1100, 620]) {
  const dir = path.join(out, `data-${width}`), skills = new Skills(dir);
  skills.save("---\nname: explain-simply\ndescription: Previous instructions.\n---\n\nMy existing instructions.\n", "explain-simply");
  skills.setEnabled("explain-simply", false);
  const app = await startAppServer({ dataDir: dir, keychainService: "com.nranjan2code.vakyartha.skill-updates-check", access: "open", uiDir: path.resolve("dist") });
  const setup = `const check=(ok,msg)=>{if(!ok)throw new Error(msg)};const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI did not settle')};`;
  const steps = [
    `document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Skills').click();await wait(()=>document.querySelector('.market-card'));[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Updates').click();check(document.querySelectorAll('.market-card').length===1,'Updates filter lost pending skill');const card=document.querySelector('.market-card');check(card.textContent.includes('Update available'),'Update badge missing');card.click();check(document.querySelectorAll('.skill-body').length===2,'Current/update preview missing');check(document.querySelector('.skill-body').textContent.includes('My existing instructions.'),'Existing edit was overwritten');check(!document.querySelector('#settings-content input[type="checkbox"]').checked,'Disabled skill enabled');check(document.documentElement.scrollWidth<=innerWidth,'Update preview overflow');return 'update available with current and proposed instructions';`,
    `[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent==='Update skill').click();await wait(()=>document.querySelectorAll('.skill-body').length===1);check(!document.querySelector('.skill-body').textContent.includes('My existing instructions.'),'Update not applied');check(!document.querySelector('#settings-content input[type="checkbox"]').checked,'Update changed on/off choice');const list=await(await fetch('/api/skills')).json();check(!list.find(s=>s.name==='explain-simply').update,'Update still pending');return 'reviewed update applied; disabled state preserved';`,
  ];
  try {
    const { stdout } = await run(bin, [app.url, path.join(out, `width-${width}`), ...steps.map(step => setup + step)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 30000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (stdout.includes(" error:") || !stdout.includes("disabled state preserved")) throw new Error("Skill update WebKit check failed");
  } finally { await app.shutdown(); }
}
console.log(`Skill update WebKit checks passed. Screenshots: ${out}`);
