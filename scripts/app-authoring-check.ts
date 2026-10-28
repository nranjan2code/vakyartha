// Native UI proof that reference discovery and generated docs reach reviewed drafts.
// Isolated data only; no source/network/model calls or installed-data changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startAppServer } from '../sidecar/server.ts';
import { APP_DOCUMENTS } from '../shared/app-scaffold.ts';
const out=mkdtempSync(path.join(tmpdir(),'vak-app-authoring-')),run=promisify(execFile),bin=path.join(out,'webkit');
const app=await startAppServer({dataDir:path.join(out,'data'),access:'open',uiDir:path.resolve('dist'),sandboxBin:path.resolve('../sandbox/target/debug/vaksb'),keychainService:'com.nranjan2code.vakyartha.authoring-check'});
console.log('Evidence:',out);
try{
 await run('swiftc',['-O','scripts/webkit-check.swift','-o',bin]);
 for(const width of [1100,375]){
  await app.request(new Request(`${app.url}/api/apps/news-desk`,{method:'DELETE'}));
  const id=`document-check-${width}`;
  const setup=`const style=document.createElement('style');style.textContent='.app{transition:none!important}';document.head.append(style);const check=(x,m)=>{if(!x)throw Error(m)};const wait=ms=>new Promise(r=>setTimeout(r,ms));const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);`;
  const steps=[
   `document.getElementById('open-apps').click();await wait(200);button('Add Reference App').click();await wait(200);const d=document.querySelector('dialog.reference-app-dialog');check(d?.open,'Chooser absent');const select=d.querySelector('select');check(select.options.length===1&&select.value==='news-desk','Installed packages not filtered');check(d.getBoundingClientRect().right<=innerWidth+2,'Chooser overflows');return 'Reference chooser discovers remaining package';`,
   `button('Install reference').click();await wait(700);const r=await fetch('/api/apps/news-desk');check(r.ok,'Chosen package not installed');const a=await r.json();check(a.scheduling===false,'Install enabled scheduling');check(a.manifest.id==='news-desk','Wrong package');return 'Chooser installation retains scheduling opt-in';`,
   `document.getElementById('open-studio').click();await wait(300);window.prompt=()=>${JSON.stringify(id)};button('New Sandboxed App').click();await wait(100);for(const name of ${JSON.stringify(APP_DOCUMENTS)}){const row=[...document.querySelectorAll('.studio-tree-item')].find(n=>n.querySelector('.tree-path')?.textContent===name);check(row,'Missing generated '+name);row.click();check([...document.querySelectorAll('textarea')].some(t=>t.value.includes('# ')&&t.value.length>300),'Document source not editable: '+name);}check(document.documentElement.scrollWidth<=innerWidth+2,'Studio overflows');return 'All four generated documents open in Studio source editor';`,
   `button('Save Draft').click();await wait(600);const r=await fetch('/api/apps/${id}/draft');check(r.ok,'Draft was not saved');const d=await r.json();for(const name of ${JSON.stringify(APP_DOCUMENTS)})check(d.files[name]?.length>300,'Saved draft lost '+name);check(d.files['server.ts'].includes('increment'),'Starter backend absent');return 'Reviewed draft retains source and all four documents';`,
  ];
  const {stdout}=await run(bin,[app.url,path.join(out,`width-${width}`),...steps.map(s=>setup+s)],{env:{...process.env,WK_WIDTH:String(width)},timeout:45000});writeFileSync(path.join(out,`webkit-${width}.txt`),stdout);console.log(`${width}px: ${stdout.trim()}`);assert.doesNotMatch(stdout,/step \d+ error:/);assert.match(stdout,/Reviewed draft retains/);
 }
 writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'passed',widths:[1100,375],documents:APP_DOCUMENTS},null,2));
}catch(e){writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'failed',error:(e as Error).stack},null,2));console.error(e);process.exitCode=1;}finally{await app.shutdown();}
