// Real WebKit smoke test with an isolated app server and deterministic surfaces.
// No model calls. Build the UI first, then: node scripts/canvas-check.ts
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startAppServer } from "../sidecar/server.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const out = await mkdtemp(path.join(tmpdir(), "vak-canvas-check-"));
const app = await startAppServer({ dataDir: path.join(out, "data"), keychainService: "com.nranjan2code.vakyartha.canvas-check", port: 0, access: "open", uiDir: path.join(root, "dist") });
const setup = `
  const style = document.createElement('style'); style.textContent='.app {transition:none!important}'; document.head.append(style);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  // An off-screen WKWebView pauses animation frames; flush its renderer and
  // entry animations explicitly, as the real foreground window would do.
  const flush = () => document.querySelectorAll('vak-surface').forEach(s => {
    s.renderNow(); s.shadowRoot.querySelectorAll('.enter').forEach(n => n.classList.remove('enter'));
  });
  const project = async (tool, args) => {
    const r = await fetch('/api/project', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({session:'canvas-check',tool,args})});
    check(r.ok, 'projection failed');
    await new Promise(r => setTimeout(r, 150)); flush();
  };
`;
const steps = [
  `document.getElementById('settings-back').click();
   await project('vak_render', {surface:'signup',title:'Newsletter signup',nodes:[{id:'root',type:'form',props:{submit:'subscribe',submitLabel:'Subscribe'},children:[{id:'name',type:'input',props:{label:'Name',bind:'/name',checks:['required']}},{id:'email',type:'input',props:{label:'Email',bind:'/email',checks:['required','email']}}]}]});
   check(document.getElementById('canvas').hidden, 'small form should stay in the conversation');
   const inline = document.querySelector('.surface-home vak-surface');
   check(document.querySelector('.surface-home').classList.contains('inline') && !inline.hidden && getComputedStyle(inline).display !== 'none', 'small form not shown inline'); return 'small interface inline';`,
  `await project('vak_render', {surface:'hotels',title:'Hotels',nodes:[{id:'root',type:'compare',props:{action:'book_hotel',options:[{name:'Hilton',price:'¥32,000'},{name:'Ryokan',price:'¥18,000'}]}}]});
   const s=[...document.querySelectorAll('vak-surface')].find(x => x.surfaceId === 'hotels'); check(s, 'compare not mounted');
   const seen=[]; s.addEventListener('vak-action', e => {seen.push(e.detail.action); e.stopPropagation();});
   check(s.activate('root#1') === true, 'activate did not send');
   check(s.activate('root#0') === false, 'a second activation went through while busy');
   s.releaseAction(); flush();
   const click=[...s.shadowRoot.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Choose Ryokan'); check(click, 'no button for Ryokan'); click.click();
   check(seen.length === 2 && JSON.stringify(seen[0]) === JSON.stringify(seen[1]) && seen[0].data.option === 'Ryokan', 'activate differs from a click: '+JSON.stringify(seen));
   s.releaseAction(); await project('vak_remove', {surface:'hotels'}); return 'activate equals a click';`,
  `const s = document.querySelector('vak-surface'); window.qaSurface = s;
   const field = s.shadowRoot.querySelector('input'); field.value='Draft name'; field.dispatchEvent(new Event('input',{bubbles:true}));
   document.querySelector('.surface-head button').click(); flush();
   check(s === document.querySelector('#canvas-content vak-surface') && !s.hidden, 'live surface did not open');
   check(s.shadowRoot.querySelector('input').value === 'Draft name', 'draft lost on open');
   document.getElementById('canvas-expand').click();
   check(document.getElementById('canvas').clientWidth === document.getElementById('workspace').clientWidth, 'full view failed');
   document.getElementById('canvas-close').click();
   check(s === document.querySelector('.surface-home vak-surface'), 'surface not returned after close');
   check(s.shadowRoot.querySelector('input').value === 'Draft name', 'draft lost on close');
   check(!s.hidden && getComputedStyle(s).display !== 'none', 'small form not back in the conversation'); return 'live draft, full view, back inline';`,
  `await project('vak_render', {surface:'sales',title:'Sales overview',nodes:[{id:'root',type:'stack',children:[{id:'heading',type:'text',props:{content:'Monthly sales'}},{id:'table',type:'table',props:{columns:['Month','Revenue'],rows:[['January','$4,200'],['February','$5,100']]}}]}]});
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId === 'sales', 'large surface did not auto-open');
   check(!document.querySelector('.surface-home:not(.inline)').classList.contains('inline'), 'table left inline');
   check(document.querySelector('#canvas-pick').options.length === 2, 'picker missing surfaces');
   check(document.documentElement.scrollWidth <= innerWidth, 'horizontal page overflow');
   if (innerWidth < 720) check(document.querySelector('.main').getBoundingClientRect().width === 0, 'narrow canvas not full width');
   return 'automatic canvas and responsive layout';`,
  `await project('vak_update', {surface:'sales',title:'Updated sales',nodes:[{id:'heading',props:{content:'Updated monthly sales'}}]});
   document.getElementById('canvas-text').click();
   check(document.getElementById('canvas-text-content').textContent.includes('Updated monthly sales'), 'text view stale');
   check(document.getElementById('canvas-content').hidden, 'preview still visible');
   document.getElementById('canvas-pick').value='signup'; document.getElementById('canvas-pick').dispatchEvent(new Event('change'));
   check(document.querySelector('#canvas-content vak-surface') === window.qaSurface, 'picker did not switch to live form');
   check(!document.getElementById('canvas-content').hidden, 'switch should show preview');
   document.getElementById('canvas-pick').value='sales'; document.getElementById('canvas-pick').dispatchEvent(new Event('change'));
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId === 'sales', 'picker did not switch');
   return 'updates, text view and picker';`,
  `document.getElementById('canvas-close').click();
   window.qaRealFetch=window.fetch.bind(window);
   window.fetch=async (url, init) => String(url).endsWith('/api/chat')
     ? new Response(new ReadableStream({start(c){window.qaController=c}}),{headers:{'content-type':'text/event-stream'}})
     : window.qaRealFetch(url,init);
   window.qaEmit=e=>window.qaController.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\\n\\n'));
   const pick=document.getElementById('model-pick'); const value=JSON.stringify(['qa','scripted']); pick.add(new Option('Scripted',value)); pick.value=value; pick.dispatchEvent(new Event('change'));
   window.qaSubmit=()=>{document.getElementById('input').value='Update the artifact';document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))};
   window.qaSubmit(); await new Promise(r=>setTimeout(r,30));
   window.qaEmit({type:'tool_start',id:'u1',name:'vak_update'}); await new Promise(r=>setTimeout(r,30));
   check(document.getElementById('canvas').hidden,'a closed canvas should wait for the snapshot to decide placement');
   const session=new URLSearchParams(location.search).get('session');
   const view=await (await window.qaRealFetch('/api/sessions/'+session)).json(); window.qaSnapshot=view.surfaces.find(s=>s.id==='sales');
   window.qaEmit({type:'surface',snapshot:window.qaSnapshot}); await new Promise(r=>setTimeout(r,30)); flush();
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId==='sales','large update did not open its target');
   window.qaEmit({type:'tool_start',id:'u1b',name:'vak_submit'}); await new Promise(r=>setTimeout(r,30));
   check(!document.getElementById('canvas-progress').hidden,'open canvas shows no progress');
   document.getElementById('canvas-close').click();
   window.qaEmit({type:'surface',snapshot:window.qaSnapshot}); window.qaEmit({type:'tool_start',id:'u2',name:'vak_update'}); await new Promise(r=>setTimeout(r,30));
   check(document.getElementById('canvas').hidden,'stream reopened canvas after manual close');
   window.qaEmit({type:'run_end',stop:'done'}); window.qaController.close(); await new Promise(r=>setTimeout(r,30));
   window.qaSubmit(); await new Promise(r=>setTimeout(r,30));
   window.qaEmit({type:'tool_start',id:'u3',name:'vak_render'}); window.qaEmit({type:'surface',snapshot:window.qaSnapshot}); await new Promise(r=>setTimeout(r,30)); flush();
   check(!document.getElementById('canvas').hidden,'next turn should reopen canvas');
   window.qaEmit({type:'error',message:'Scripted failure'}); window.qaEmit({type:'run_end',stop:'error'}); window.qaController.close(); await new Promise(r=>setTimeout(r,30));
   check(document.getElementById('canvas-progress').hidden,'failed generation left progress showing');
   window.fetch=window.qaRealFetch; return 'snapshot placement, progress, manual close and failure cleanup';`,
  `window.fetch=async (url, init) => String(url).endsWith('/api/chat')
     ? new Response(new ReadableStream({start(c){window.qaController=c}}),{headers:{'content-type':'text/event-stream'}})
     : window.qaRealFetch(url,init);
   const turn=async (snap)=>{ window.qaSubmit(); await new Promise(r=>setTimeout(r,30)); window.qaEmit({type:'surface',snapshot:snap}); window.qaEmit({type:'run_end',stop:'done'}); window.qaController.close(); await new Promise(r=>setTimeout(r,60)); flush(); };
   await turn(window.qaSnapshot);
   const next=JSON.parse(JSON.stringify(window.qaSnapshot).replace('Updated monthly sales','Revised monthly sales')); next.version=window.qaSnapshot.version+1;
   await turn(next);
   check(!document.getElementById('canvas-versions').hidden,'rewritten surface shows no versions');
   check(document.getElementById('canvas-version-label').textContent.startsWith('Latest'),'live version not shown as latest');
   document.getElementById('canvas-older').click(); flush();
   const old=document.querySelector('#canvas-content .canvas-old vak-surface');
   check(old && old.inert,'earlier version is not shown read-only');
   document.getElementById('canvas-text').click();
   check(document.getElementById('canvas-text-content').textContent.includes('Updated monthly sales'),'text view does not follow the earlier version');
   document.getElementById('canvas-preview').click();
   document.querySelector('.canvas-old-note button').click(); flush();
   check(!document.querySelector('.canvas-old') && document.getElementById('canvas-version-label').textContent.startsWith('Latest'),'back to latest failed');
   // Leave the live surface as the server has it for the steps that follow.
   await turn({...window.qaSnapshot, version: next.version+1});
   window.fetch=window.qaRealFetch; return 'versions of a surface rewritten in place';`,
  `window.fetch=async (url, init) => String(url).endsWith('/api/chat')
     ? new Response(new ReadableStream({start(c){window.qaController=c}}),{headers:{'content-type':'text/event-stream'}})
     : window.qaRealFetch(url,init);
   const session=new URLSearchParams(location.search).get('session');
   const form=(await (await window.qaRealFetch('/api/sessions/'+session)).json()).surfaces.find(s=>s.id==='signup');
   const turn=async (snap)=>{ window.qaSubmit(); await new Promise(r=>setTimeout(r,30)); window.qaEmit({type:'surface',snapshot:snap}); window.qaEmit({type:'run_end',stop:'done'}); window.qaController.close(); await new Promise(r=>setTimeout(r,60)); flush(); };
   await turn({...form, id:'step-a', title:'First step', version:1});
   await turn({...form, id:'step-b', title:'Second step', version:1});
   const home=id=>document.querySelector('.surface-home[data-surface="'+id+'"]');
   check(home('step-a').classList.contains('folded'),'finished earlier interface did not fold');
   check(!home('step-b').classList.contains('folded'),'latest interface folded');
   check(!home('signup').classList.contains('folded'),'interface with unsent input folded');
   home('step-a').querySelector('.surface-head > span').click();
   check(!home('step-a').classList.contains('folded'),'folded title did not open it');
   window.qaSubmit(); await new Promise(r=>setTimeout(r,30));
   for (const id of ['step-a','step-b']) window.qaEmit({type:'surface_removed',id});
   window.qaEmit({type:'run_end',stop:'done'}); window.qaController.close(); await new Promise(r=>setTimeout(r,60)); flush();
   window.fetch=window.qaRealFetch; return 'earlier interfaces fold to one line';`,
  `document.getElementById('open-artifacts').click(); await new Promise(r => setTimeout(r, 250));
   check(!document.getElementById('artifacts-page').hidden && document.getElementById('workspace').hidden, 'library did not open');
   check(document.querySelectorAll('.artifact-card').length === 2, 'library missing saved surfaces'); return 'artifact library rendered';`,
  `const search=document.getElementById('artifacts-search'); search.value='Updated sales'; search.dispatchEvent(new Event('input'));
   check(document.querySelectorAll('.artifact-card').length === 1, 'library search failed');
   search.value=''; search.dispatchEvent(new Event('input')); document.querySelector('.artifact-filter[data-kind="Form"]').click();
   document.querySelector('.artifact-card').click(); await new Promise(r => setTimeout(r, 150)); flush();
   check(document.getElementById('artifacts-page').hidden, 'library stayed open');
   check(document.querySelector('#canvas-content vak-surface') === window.qaSurface, 'library discarded current live surface');
   check(window.qaSurface.shadowRoot.querySelector('input').value === 'Draft name', 'library discarded form draft');
   document.getElementById('open-artifacts').click(); await new Promise(r => setTimeout(r, 150));
   const searchAgain=document.getElementById('artifacts-search'); searchAgain.value='no-such-title'; searchAgain.dispatchEvent(new Event('input'));
   check(document.querySelector('.artifact-empty h2').textContent === 'No matching artifacts', 'empty search state missing');
   document.querySelector('.artifact-empty button').click();
   document.querySelector('.artifact-filter[data-kind="Table"]').click();
   check(document.querySelectorAll('.artifact-card').length === 1, 'type filter failed');
   document.querySelector('.artifact-card').click(); await new Promise(r => setTimeout(r, 150)); flush();
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId === 'sales', 'library opened wrong artifact'); return 'artifact page, search, filters and live draft';`,
  `window.qaExport={}; URL.createObjectURL=blob => {window.qaExport.blob=blob;return 'blob:qa-export'};
   HTMLAnchorElement.prototype.click=function(){window.qaExport.filename=this.download};
   document.getElementById('canvas-download').click();
   check(window.qaExport.filename === 'Updated sales.md', 'download filename wrong');
   check((await window.qaExport.blob.text()).includes('Updated monthly sales'), 'download content stale');
   document.querySelector('.chat[aria-current="true"] .open').click(); await new Promise(r => setTimeout(r, 250)); flush();
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId === 'sales', 'selection not restored'); return 'export and saved selection';`,
  `await project('vak_remove', {surface:'sales'});
   check(document.getElementById('canvas').hidden, 'removed canvas stayed open');
   check(document.querySelector('#canvas-pick').options.length === 1, 'removed surface stayed in picker');
   document.querySelector('.surface-head button').click(); flush();
   const s=document.querySelector('#canvas-content vak-surface'); let detail;
   s.addEventListener('vak-action', e => {detail=e.detail; e.stopPropagation();});
   const fields=s.shadowRoot.querySelectorAll('input');
   fields[0].value='Alice'; fields[0].dispatchEvent(new Event('input',{bubbles:true}));
   fields[1].value='alice@example.com'; fields[1].dispatchEvent(new Event('input',{bubbles:true})); flush();
   s.shadowRoot.querySelector('button').click();
   check(detail?.action?.action === 'subscribe' && detail.data.name === 'Alice' && detail.data.email === 'alice@example.com', 'canvas form action lost data');
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',metaKey:true,altKey:true,bubbles:true}));
   check(document.getElementById('canvas').hidden, 'keyboard hide failed');
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',metaKey:true,altKey:true,bubbles:true}));
   check(!document.getElementById('canvas').hidden, 'keyboard reopen failed'); return 'removal, submit and keyboard toggle';`,
  `for (let i=0;i<26;i++) {
     const r=await fetch('/api/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:'library-other',tool:'vak_render',args:{surface:'notes-'+i,title:'Notes '+String(i).padStart(2,'0'),nodes:[{id:'root',type:'text',props:{content:'Saved notes'}}]}})});
     check(r.ok, 'could not seed library');
   }
   document.getElementById('open-artifacts').click(); await new Promise(r=>setTimeout(r,200));
   document.querySelector('.artifact-filter[data-kind="All"]').click();
   check(document.querySelectorAll('.artifact-card').length === 24, 'library should page large collections');
   document.querySelector('#artifacts-more button').click();
   check(document.querySelectorAll('.artifact-card').length === 27, 'show more failed');
   const sort=document.getElementById('artifacts-sort'); sort.value='name'; sort.dispatchEvent(new Event('change'));
   check(document.querySelector('.artifact-card strong').textContent === 'Newsletter signup', 'name sort failed');
   document.querySelector('.artifact-card[data-session="library-other"][data-surface="notes-0"]').click(); await new Promise(r=>setTimeout(r,250)); flush();
   check(document.getElementById('artifacts-page').hidden, 'cross-chat artifact did not open');
   check(document.querySelector('#canvas-content vak-surface')?.surfaceId === 'notes-0', 'wrong surface after switching chats');
   return 'pagination, sorting and cross-chat artifact';`,
];

try {
  const bin = path.join(out, "webkit-check");
  await run("swiftc", ["-O", path.join(root, "scripts/webkit-check.swift"), "-o", bin]);
  for (const width of [1100, 620]) {
    // Give the second run a fresh session while testing the identical code.
    const session = `canvas-check-${width}`;
    const { stdout } = await run(bin, [`${app.url}/?session=${session}`, path.join(out, `width-${width}`), ...steps.map(s => setup.replaceAll("'canvas-check'", JSON.stringify(session)) + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 60_000 });
    console.log(`${width}px: ${stdout.trim()}`);
    const saved = await (await fetch(`${app.url}/api/sessions`)).json() as { id: string }[];
    for (const s of saved) await fetch(`${app.url}/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    if (/step \d+ error:/.test(stdout) || !stdout.includes("pagination, sorting and cross-chat artifact")) throw new Error(`WebKit canvas checks failed at ${width}px`);
  }
  console.log(`Canvas WebKit checks passed. Screenshots: ${out}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.shutdown();
}
