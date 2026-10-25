// Inspect retained real-model outputs in WebKit; typing/filtering must not call a model.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";
import { taskObject } from "../task-contract.ts";

const report = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !report.includes(`${path.sep}.vak${path.sep}evaluations${path.sep}`)) throw new Error("Pass a retained evaluation report directory under .vak/evaluations");
const dataDir = path.dirname(path.dirname(report));
const app = await startAppServer({ dataDir, access: "open", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.evaluation", appName: "Vakyartha evaluation" });
const run = promisify(execFile), bin = path.join(await mkdtemp(path.join(tmpdir(), "vak-evaluation-webkit-")), "webkit-check");
try {
  await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
  for (const scenario of ["interactive-comparison", "public-source-research", "memory-operation"]) {
    const raw = taskObject(JSON.parse(await readFile(path.join(report, `${scenario}.json`), "utf8")));
    const result = taskObject(raw.result), task = String(result.task);
    for (const width of [1100, 620]) {
      const steps = [`
        const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40))}throw new Error('Real output did not mount')};
        const check=(value,message)=>{if(!value)throw new Error(message)};
        document.documentElement.dataset.mode=innerWidth>720?'light':'dark';document.getElementById('settings-back').click();
        await wait(()=>document.querySelectorAll('vak-surface').length>0);
        const before=await(await fetch('/api/tasks/${task}')).json();
        const first=document.querySelector('.surface-head button');if(first)first.click();
        const picker=document.getElementById('canvas-pick');
        const select=id=>{picker.value=id;picker.dispatchEvent(new Event('change'));const surface=document.querySelector('#canvas-content vak-surface');surface.renderNow();surface.shadowRoot.querySelectorAll('.enter').forEach(node=>node.classList.remove('enter'));return surface};
        let edited=0,filtered=0;
        for(const option of Array.from(picker.options)){
          const surface=select(option.value);await new Promise(r=>setTimeout(r,40));
          const input=surface.shadowRoot.querySelector('form input:not([type="checkbox"])');
          if(input){input.value=input.type==='number'?'20':'Evaluation draft';input.dispatchEvent(new Event('input',{bubbles:true}));edited++;}
          const search=surface.shadowRoot.querySelector('input[type="search"]');
          if(search){search.value='Birch';search.dispatchEvent(new Event('input',{bubbles:true}));surface.renderNow();filtered++;search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));surface.renderNow();}
        }
        const shown=document.querySelector('#canvas-content vak-surface');shown.renderNow();shown.shadowRoot.querySelectorAll('.enter').forEach(node=>node.classList.remove('enter'));
        const after=await(await fetch('/api/tasks/${task}')).json();check(before.budget.modelRequests===after.budget.modelRequests,'Local controls called a model');
        check(document.documentElement.scrollWidth<=innerWidth,'Real output caused page overflow');
        return JSON.stringify({surfaces:picker.options.length,edited,filtered,modelRequestsUnchanged:true});
      `];
      const shot = path.join(report, `${scenario}-${width}`);
      const { stdout } = await run(bin, [`${app.url}/?session=${task}`, shot, ...steps], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 30000 });
      await writeFile(`${shot}.txt`, stdout, { mode: 0o600 });
      console.log(`${scenario} ${width}px: ${stdout.trim()}`);
      if (stdout.includes(" error:")) throw new Error("Real-output WebKit interaction failed");
    }
  }
} finally { await app.shutdown(); }
