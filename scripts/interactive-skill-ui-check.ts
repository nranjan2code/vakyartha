// Replay retained skill-authored surfaces in actual WebKit without model calls.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startAppServer } from "../sidecar/server.ts";

const receipt = path.resolve(process.argv[2] ?? "");
if (!receipt.startsWith(path.resolve(".vak/evaluations/interactive-skill") + path.sep)) throw new Error("Pass a retained interactive-skill trial directory");
const report = JSON.parse(await readFile(path.join(receipt, "linked-views-skill/report.json"), "utf8"));
if (!report.pass) throw new Error("The linked-views skill outcome must pass before UI verification");
const temp = await mkdtemp(path.join(tmpdir(), "vak-skill-webkit-"));
const app = await startAppServer({ dataDir: path.join(temp, "data"), access: "open", uiDir: path.resolve("dist"), keychainService: "com.nranjan2code.vakyartha.skill-check" });
const run = promisify(execFile), binary = path.join(temp, "webkit-check"), results = [];
try {
  await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", binary]);
  for (const width of [1100, 620]) {
    const steps = [`
      const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
      document.getElementById('settings-back').click();
      for(const snapshot of ${JSON.stringify(report.surfaces)}){
        const r=await fetch('/api/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:'skill-ui-${width}',tool:'vak_render',args:{surface:snapshot.id,title:snapshot.title,nodes:snapshot.nodes,data:snapshot.data}})});
        check(r.ok,'Retained surface publication failed');
      }
      for(let i=0;i<100&&!document.querySelector('vak-surface');i++)await new Promise(r=>setTimeout(r,40));
      const surface=document.querySelector('vak-surface');check(surface,'Retained surface did not mount');
      surface.renderNow();
      const root=surface.shadowRoot;
      check(root.querySelector('table tbody tr'),'Table rows absent');
      check(root.querySelector('figure svg'),'Chart SVG absent');
      const input=root.querySelector('input[type="number"]');check(input,'Numeric input absent');
      const events=[];surface.addEventListener('vak-action',e=>{events.push(e.detail.action);e.stopPropagation()});
      input.value='25';input.dispatchEvent(new Event('input',{bubbles:true}));surface.renderNow();
      check(root.textContent.includes('25'),'Bound text did not update');
      const form=root.querySelector('form');check(form,'Form absent');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      check(events.length===1&&Object.values(events[0].data).includes(25),'Submitted numeric edit missing');
      check(document.documentElement.scrollWidth<=innerWidth,'Page overflows');
      return 'table + chart rendered, edit bound, action captured, no model call';
    `];
    const script = path.join(receipt, `webkit-${width}.json`);
    await writeFile(script, JSON.stringify(steps));
    const { stdout, stderr } = await run(binary, [`${app.url}/?session=skill-ui-${width}`, path.join(receipt, `webkit-${width}`), ...steps], { env: { ...process.env, WK_WIDTH: String(width), WK_HEIGHT: "900" }, timeout: 60_000 });
    const pass = !/step \d+ error:/.test(stdout) && stdout.includes("action captured");
    results.push({ width, pass, stdout, stderr });
    console.log(JSON.stringify({ width, pass, stdout }));
  }
  await writeFile(path.join(receipt, "webkit.json"), JSON.stringify(results, null, 2));
  if (results.some(r => !r.pass)) process.exitCode = 1;
} finally { await app.shutdown(); }
