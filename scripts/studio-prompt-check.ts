// WebKit proof of the selection UI request and truthful preview/DAG labels.
// The evaluator response is mocked; this is not a real-provider outcome test.
// Off-screen WebKit pauses grid transitions; inspect their settled CSS geometry.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { startAppServer } from "../sidecar/server.ts";
const out = await mkdtemp(path.join(tmpdir(), "vak-studio-prompt-")), run = promisify(execFile), bin = path.join(out, "webkit");
const app = await startAppServer({ dataDir: path.join(out, "data"), keychainService: "com.nranjan2code.vakyartha.studio-prompt-check", access: "open", uiDir: path.resolve("dist") });
console.log("Evidence:", out);
try {
  await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
  for (const width of [1100, 375]) {
    const setup = `const check=(ok,msg)=>{if(!ok)throw new Error(msg)};const ready=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI did not settle')};const click=text=>{const b=[...document.querySelectorAll('#skills-studio-page button')].find(b=>b.textContent.trim()===text);check(b,'Missing button '+text);b.click()};`;
    const steps = [
      `const motion=document.createElement('style');motion.textContent='.app{transition:none!important}';document.head.append(motion);document.getElementById('open-studio').click();await ready(()=>document.querySelector('.studio-card-title'));return 'Studio hub opened';`,
      `const search=document.querySelector('.studio-search-box input');search.value='interactive-ui';search.dispatchEvent(new Event('input',{bubbles:true}));await ready(()=>[...document.querySelectorAll('.studio-card-title')].some(n=>n.textContent==='interactive-ui'));return 'Requested skill found by local filter';`,
      `const card=[...document.querySelectorAll('.studio-card')].find(c=>c.querySelector('.studio-card-title')?.textContent==='interactive-ui');check(card,'Interactive skill not visible');card.click();await ready(()=>document.querySelector('.studio-header'));return 'Published package opened';`,
      `click('Sandbox & Tests');await ready(()=>document.body.textContent.includes('Evaluate Published Selection'));return 'Published selection controls opened';`,
      `const fetchOriginal=window.fetch;window.fetch=async(input,init)=>{if(String(input).includes('/api/skills/eval')){const b=JSON.parse(init.body);check(Array.isArray(b.cases)&&b.cases.some(c=>c.expected===true)&&b.cases.some(c=>c.expected===false),'Expected polarity lost');check(typeof b.provider==='string'&&b.provider&&typeof b.model==='string'&&b.model,'Chosen model missing');window.qaEval=b;return new Response(JSON.stringify(b.cases.map(c=>({...c,passed:true,selectedSkills:c.expected?[b.name]:[],durationMs:1}))),{headers:{'content-type':'application/json'}})}return fetchOriginal(input,init)};click('Evaluate Published Selection');await ready(()=>window.qaEval);await ready(()=>document.querySelector('.test-meta')?.textContent.includes('expected:'));check(!document.body.textContent.includes('active local model'),'Unproved local model claim');const bounds=[...document.querySelectorAll('.studio-header,.studio-header button,.studio-workspace,.studio-left-col,.studio-center-col,.studio-sandbox-view,.studio-form-card')].map(n=>({name:n.className,x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width}));check(bounds.every(b=>b.x>=-2&&b.right<=innerWidth+2),'Editor clipped: '+JSON.stringify({bounds,body:document.body.className,grid:getComputedStyle(document.querySelector('.app')).gridTemplateColumns,viewport:innerWidth,media:matchMedia('(max-width:720px)').matches,scroll:document.querySelector('#skills-studio-page').scrollLeft}));check(document.querySelector('.studio-center-col').clientWidth>=Math.min(300,innerWidth-32),'Editor squeezed');return 'Explicit model and positive/negative selection request retained';`,
      `click('Live Preview');await ready(()=>document.body.textContent.includes('Illustrative sample preview'));check(!document.body.textContent.includes('Layout Compliant'),'Heuristic called compliance');check(document.documentElement.scrollWidth<=innerWidth+2,'Preview overflow');click('Flow DAG');await ready(()=>document.body.textContent.includes('Content-driven Surface'));check(!document.body.textContent.includes('3-Tier Canvas'),'Stale tier label');return 'Illustrative preview and content-driven graph are labelled honestly';`,
    ];
    const { stdout } = await run(bin, [app.url, path.join(out, `width-${width}`), ...steps.map(step => setup + step)], { env: { ...process.env, WK_WIDTH: String(width), WK_HEIGHT: "1000" }, timeout: 60000 }).catch(async error => { await writeFile(path.join(out, `failure-${width}.txt`), String(error.stdout ?? "") + "\n" + String(error.stderr ?? "")); throw error; });
    await writeFile(path.join(out, `webkit-${width}.txt`), stdout);
    assert.doesNotMatch(stdout, /step \d+ error:/);
    assert.match(stdout, /labelled honestly/);
    console.log(width, stdout.trim());
  }
  console.log("Studio prompt UI passed. Evidence:", out);
} finally { await app.shutdown(); }
