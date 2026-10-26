// Deterministic task + multi-surface WebKit check. No model or external service calls.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startAppServer } from "../sidecar/server.ts";

const run = promisify(execFile), root = fileURLToPath(new URL("..", import.meta.url));
const out = await mkdtemp(path.join(tmpdir(), "vak-task-check-"));
let calls = 0;
const fake = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "scripted" }] })); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  const parsed: unknown = JSON.parse(body || "{}");
  const messages: unknown = parsed && typeof parsed === "object" && "messages" in parsed ? parsed.messages : [];
  const action = Array.isArray(messages) && messages.some((m: unknown) => m && typeof m === "object" && "role" in m && m.role === "user" && "content" in m && typeof m.content === "string" && m.content.startsWith("[ui action]"));
  calls++;
  if (Array.isArray(messages) && messages.at(-1)?.role === "tool") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Ready for review" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const renders = action ? [{ name: "vak_update", args: { surface: "first", data: { acknowledged: true } } }] : ["first", "second", "table"].map((surface) => ({ name: "vak_render", args: {
    surface, title: `${surface} workspace`, nodes: surface === "table" ? [{ id: "root", type: "table", props: { columns: ["Name", "Value"], rows: Array.from({ length: 30 }, (_, i) => [`Row ${i}`, 30 - i]), searchable: true, sortable: true, pageSize: 10 } }] : [{ id: "root", type: "form", props: { submit: "save", submitLabel: "Save" }, children: [{ id: "name", type: "input", props: { label: "Name", bind: "/name", checks: ["required"] } }] }],
  } }));
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: renders.map((r, index) => ({ index, id: `call-${calls}-${index}`, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const previous = process.env.OPENAI_COMPAT_BASE_URL;
process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
const taskDir = path.join(out, "data", "tasks");
await mkdir(taskDir, { recursive: true });
for (const width of [1100, 620]) {
  const id = `recovery-${width}`, runId = `recovery-run-${width}`, at = new Date(Date.now() - 10000).toISOString();
  await writeFile(path.join(taskDir, `${id}.json`), JSON.stringify({ version: 5, revision: 0, id, session: id, goal: "Review interrupted operation", criteria: "Record exact reviewed effect before continuing", provider: "compatible", model: "scripted", integrations: [], confirmedFree: [], spending: { kind: "api_allowed", acknowledged: true }, limits: { runs: 3, modelRequests: 6, toolCalls: 6, activeMs: 60000 }, budget: { modelRequests: 0, toolCalls: 1, activeMs: 0 }, state: "interrupted", created: at, updated: at, note: "Check the uncertain operation", runs: 1, runHistory: [{ id: runId, sequence: 1, inputId: "original", inputKind: "message", state: "interrupted", started: at, recovered: at, activeMs: 0, chargedMs: 0, modelRequests: 0, toolCalls: 1, note: "Effect may have happened" }], pending: [], activity: [], accepted: [], operations: [{ id: `effect-${width}`, tool: "service__write", runId, state: "uncertain" }] }));
}
const app = await startAppServer({ dataDir: path.join(out, "data"), keychainService: "com.nranjan2code.vakyartha.task-check", access: "open", uiDir: path.join(root, "dist") });
const setup = `
 // Offscreen WebKit may leave grid transitions at their first frame. Check the settled layout.
 document.querySelector('.app').style.transition='none';
 const check=(ok,message)=>{if(!ok)throw new Error(message)};
 const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40))}throw new Error('UI did not settle')};
 const flush=()=>document.querySelectorAll('vak-surface').forEach(s=>{s.renderNow();s.shadowRoot.querySelectorAll('.enter').forEach(n=>n.classList.remove('enter'))});
 const pick=id=>{const p=document.getElementById('canvas-pick');p.value=id;p.dispatchEvent(new Event('change'));flush();return document.querySelector('#canvas-content vak-surface')};
 const task=async()=>await(await fetch('/api/tasks/'+window.qaTask)).json();
`;
const steps = [
  `document.documentElement.dataset.mode=innerWidth>720?'light':'dark';document.getElementById('settings-back').click();document.getElementById('open-schedule').click();
   await wait(()=>document.getElementById('schedule-title')?.textContent==='Schedule');
   check(document.querySelector('#open-schedule svg'),'missing calendar icon');
   check(document.getElementById('workspace').hidden,'workspace visible under Schedule');
   check(!document.querySelector('#task-create'),'old creation modal remains');
   check(document.querySelectorAll('.schedule-template').length===3 || document.querySelector('.schedule-card'),'missing overview');
   check(document.documentElement.scrollWidth<=innerWidth,'Schedule overview overflow');
   return 'Schedule overview and icon';`,
  `document.getElementById('settings-back').click();
   const p=document.getElementById('model-pick'),v=JSON.stringify(['compatible','scripted']);p.add(new Option('Scripted',v));p.value=v;p.dispatchEvent(new Event('change'));
   document.getElementById('open-schedule').click();document.getElementById('create-schedule').click();
   await wait(()=>!document.getElementById('schedule-compose').hidden&&!document.getElementById('task-create-start').disabled);check(!document.querySelector('dialog[open]'),'creation should be a page');
   check(document.getElementById('task-spending').value==='local_only','local-only is not the default');
   const layout=document.getElementById('task-result-layout');layout.value='research';layout.dispatchEvent(new Event('change'));
   check(!document.getElementById('task-result-inputs-row').hidden&&document.getElementById('task-result-inputs').required,'research source manifest is not required');
   check(document.getElementById('task-result-inputs-label').textContent.includes('source URLs'),'research manifest label missing');
   document.getElementById('task-result-inputs').value='https://example.com/';
   check(!document.getElementById('task-result-notices-row').hidden,'visible notice input missing');
   document.getElementById('task-result-notices').value='Fictional data';
   check(document.documentElement.scrollWidth<=innerWidth,'result setup overflow');
   check(innerWidth>720||document.getElementById('schedule-page').getBoundingClientRect().left===0,'collapsed sidebar leaves a blank gutter');
   layout.value='comparison';layout.dispatchEvent(new Event('change'));const exact=document.getElementById('task-comparison-checks-row');check(!exact.hidden,'exact comparison checks missing');exact.open=true;document.getElementById('task-comparison-checks').value=JSON.stringify({identityColumn:'option',rows:[{option:'First',eligible:false},{option:'Second',eligible:true}]});exact.scrollIntoView({block:'center'});return 'typed result layout, visible notices and exact comparison checks';`,
  `const layout=document.getElementById('task-result-layout');
   layout.value='';layout.dispatchEvent(new Event('change'));check(document.getElementById('task-result-notices-row').hidden,'flexible work retained notice input');check(document.getElementById('task-comparison-checks-row').hidden,'flexible work retained exact checks');check(!document.getElementById('task-result-inputs').required,'flexible layout retained manifest requirement');
   document.getElementById('task-spending').value='api_allowed';document.getElementById('task-spending').dispatchEvent(new Event('change'));document.getElementById('task-spending-ack').checked=true;
   window.dispatchEvent(new Event('vak:model'));check(!document.getElementById('task-spending-ack').checked,'model change retained spending acknowledgement');
   check(!document.getElementById('task-create-form').checkValidity(),'API charges require no acknowledgement');
   document.getElementById('task-goal').value='Create two independent forms and a table';document.getElementById('task-criteria').value='All three stay interactive';
   const selected=new DataTransfer();selected.items.add(new File(['A bounded input snapshot'],'facts.txt',{type:'text/plain'}));document.getElementById('task-files').files=selected.files;
   document.getElementById('task-output').value='markdown';document.getElementById('task-diagnostic-days').value='0';
   document.getElementById('task-budget-runs').value='3';document.getElementById('task-budget-model').value='6';document.getElementById('task-budget-tools').value='0';
   const oldIds=(await(await fetch('/api/tasks')).json()).map(t=>t.id);
   document.getElementById('task-spending').value='api_allowed';document.getElementById('task-spending').dispatchEvent(new Event('change'));document.getElementById('task-spending-ack').checked=true;document.getElementById('task-create-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(async()=>{const list=await(await fetch('/api/tasks')).json();window.qaTask=list.find(t=>!oldIds.includes(t.id))?.id;return Boolean(window.qaTask)});
   await wait(async()=>(await task()).state==='needs_input');
   await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>document.querySelectorAll('vak-surface').length===3);flush();
   await wait(()=>!document.getElementById('task-bar').hidden);
   check(document.getElementById('canvas-pick').options.length===3,'missing task surfaces');
   const saved=await task();check(saved.state==='needs_input','task should require review');check(saved.runHistory[0].output.state==='saved'&&saved.runHistory[0].output.surfaces.length===3,'output receipt missing');check(saved.diagnosticDays===0,'diagnostic retention not saved');check(saved.inputs[0].name==='facts.txt'&&saved.inputs[0].sha256.length===64,'input snapshot was not recorded');return 'task setup, saved output receipt and three live surfaces';`,
  `const a=pick('first');window.qaFirst=a;a.shadowRoot.querySelector('button').click();flush();
   check(Boolean(a.shadowRoot.querySelector('.invalid')),'invalid form was not checked');
   check((await task()).runs===1,'invalid form ran the agent');
   const input=a.shadowRoot.querySelector('input');input.value='Alice';input.dispatchEvent(new Event('input',{bubbles:true}));
   const b=pick('second');window.qaSecond=b;const other=b.shadowRoot.querySelector('input');other.value='Bob';other.dispatchEvent(new Event('input',{bubbles:true}));
   const table=pick('table');window.qaTable=table;
   const search=table.shadowRoot.querySelector('input');check(Boolean(search),'table filter absent');search.value='Row 2';search.dispatchEvent(new Event('input',{bubbles:true}));flush();
   const heading=table.shadowRoot.querySelector('th button');if(heading)heading.click();flush();
   check((await task()).runs===1,'local table operation called agent');
   document.getElementById('canvas-text').click();document.getElementById('canvas-preview').click();
   check(pick('first')===window.qaFirst,'picker recreated first form');
   check(pick('second').shadowRoot.querySelector('input').value==='Bob','second form lost draft');return 'validation, independent drafts and local table controls';`,
  `document.getElementById('canvas-close').click();document.querySelector('.surface-head button').click();flush();
   document.getElementById('open-artifacts').click();await wait(()=>document.querySelector('.artifact-card[data-session="'+window.qaTask+'"]'));
   document.querySelector('.artifact-card[data-session="'+window.qaTask+'"][data-surface="first"]').click();await new Promise(r=>setTimeout(r,100));flush();
   check(document.querySelector('#canvas-content vak-surface')===window.qaFirst,'library duplicated live form');
   document.getElementById('new-chat').click();document.getElementById('open-schedule').click();await wait(()=>document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]'));document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]').click();await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>document.querySelectorAll('vak-surface').length===3);flush();
   check(pick('first').shadowRoot.querySelector('input').value==='Alice','navigation lost first draft');
   check(pick('second').shadowRoot.querySelector('input').value==='Bob','navigation lost second draft');return 'library identity and draft restoration across navigation';`,
  `const a=pick('first');a.shadowRoot.querySelector('button').click();
   await wait(async()=>(await task()).runs===2);document.getElementById('new-chat').click();
   await wait(async()=>(await task()).state==='needs_input');
   document.getElementById('open-schedule').click();await wait(()=>document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]'));document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]').click();await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>document.querySelectorAll('vak-surface').length===3);flush();
   check(pick('second').shadowRoot.querySelector('input').value==='Bob','background update lost unrelated draft');
   const view=await(await fetch('/api/sessions/'+window.qaTask)).json();
   check(view.timeline.filter(e=>e.kind==='action').length===1,'action not delivered exactly once');
   const denied=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:window.qaTask,provider:'compatible',model:'scripted',message:'bypass'})});
   check(denied.status===409,'task ownership bypass');return 'background continuation, scoped action and mutation protection';`,
  `window.qaReviewedSurface=pick('second');await wait(()=>Array.from(document.querySelectorAll('#task-bar button')).some(b=>b.textContent==='Review result'));
   Array.from(document.querySelectorAll('#task-bar button')).find(b=>b.textContent==='Review result').click();await wait(()=>document.getElementById('review-evidence'));
   check(document.getElementById('schedule-title').textContent==='Review the result','review is not a full page');check(document.documentElement.scrollWidth<=innerWidth,'review overflow');return 'full-page evidence review and saved surface references';`,
  `document.getElementById('review-evidence').value='Checked both interactive forms and the table against the saved criteria.';document.getElementById('review-confirm').checked=true;
   document.querySelector('.schedule-review-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(async()=>(await task()).state==='completed');
   await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>document.querySelectorAll('vak-surface').length===3);flush();
   const b=pick('second');check(b===window.qaReviewedSurface,'review return recreated a live surface');flush();check(!b.shadowRoot.querySelector('button').disabled,'completion disabled a surface');b.shadowRoot.querySelector('button').click();
   await wait(async()=>(await task()).runs===3);await wait(async()=>(await task()).state==='needs_input');
   await new Promise(r=>setTimeout(r,2200));flush();check(pick('second')===b,'status refresh recreated an interactive surface');
   check(document.documentElement.scrollWidth<=innerWidth,'page overflow');return 'reviewed completion and interactive continuation';`,
  `document.getElementById('open-schedule').click();await wait(()=>document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]'));document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]').click();
   await wait(()=>document.querySelectorAll('.schedule-run').length===3);
   const history=await task();check(history.runHistory.length===3,'run records missing');check(history.limits.runs===3&&history.limits.modelRequests===6&&history.budget.modelRequests===6,'cumulative limits or counters missing');check(history.runHistory[1].state==='accepted','review decision absent from run history');
   document.querySelector('.schedule-run summary').click();check(document.querySelector('.schedule-run').open,'run receipt will not expand');check(document.querySelector('.schedule-run-id').textContent.includes(history.runHistory[2].id),'wrong run receipt');
   document.querySelector('.schedule-run-usage').click();await wait(()=>document.querySelector('.schedule-run [role="status"]').textContent.includes('Model API estimate'));
   check(document.querySelector('.schedule-run [role="status"]').textContent.includes('unknown'),'missing usage became zero');
   check(document.documentElement.scrollWidth<=innerWidth,'run history overflow');
   const output=history.runHistory[2].output;check(output.state==='saved','latest output was not saved');
   const content=await(await fetch('/api/tasks/'+window.qaTask+'/runs/'+history.runHistory[2].id+'/output')).json();check(content.filename===output.filename&&content.content.includes('Row 0'),'saved output download did not read canonical Markdown');
   const verified=await fetch('/api/tasks/'+window.qaTask+'/runs/'+history.runHistory[2].id+'/output',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'verify',revision:history.revision})});check(verified.ok,'output verification failed');
   check((await task()).budget.modelRequests===history.budget.modelRequests,'output verification dispatched model work');
   return 'distinct run history, accepted outcome and verified downloadable receipts';`,
  `Array.from(document.querySelectorAll('.schedule-run button')).find(b=>b.textContent==='Open FinOps').click();
   await wait(()=>document.querySelector('[aria-label="FinOps work type"]'));
   const scope=document.querySelector('[aria-label="FinOps work type"]');scope.value='tasks';scope.dispatchEvent(new Event('change'));
   const current=await task();check(document.querySelector('.finops-detail').textContent.includes(current.runHistory[2].id),'FinOps missing run identity');
   scope.value='chats';scope.dispatchEvent(new Event('change'));check(!document.querySelector('.finops-detail').textContent.includes(current.id),'task leaked into ordinary chat filter');
   scope.value='tasks';scope.dispatchEvent(new Event('change'));check(document.documentElement.scrollWidth<=innerWidth,'FinOps overflow');
   return 'FinOps attribution, work-type filters and responsive details';`,
  `document.getElementById('settings-back').click();document.getElementById('open-schedule').click();document.getElementById('create-schedule').click();
   await wait(()=>!document.getElementById('schedule-compose').hidden&&!document.getElementById('task-create-start').disabled);
   document.getElementById('task-goal').value='Future review';document.getElementById('task-criteria').value='An explicit reviewed result';
   const resultLayout=document.getElementById('task-result-layout');resultLayout.value='comparison';resultLayout.dispatchEvent(new Event('change'));
   document.getElementById('task-result-inputs').value='First\\nSecond';document.getElementById('task-result-notices').value='Fictional data';
   check(!document.getElementById('task-comparison-checks-row').hidden,'exact comparison input missing');
   document.getElementById('task-comparison-checks').value=JSON.stringify({identityColumn:'option',rows:[{option:'First',seats:4},{option:'Second',seats:8}],criteria:{minimumSeats:6},calculations:{eligible:{op:'gte',args:[{column:'seats'},{criterion:'minimumSeats'}]}}});
   const timing=document.getElementById('schedule-timing');timing.value='once';timing.dispatchEvent(new Event('change'));
   const d=new Date(Date.now()+3600000);document.getElementById('schedule-at').value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
   const before=(await(await fetch('/api/tasks')).json()).map(t=>t.id);
   document.getElementById('task-spending').value='api_allowed';document.getElementById('task-spending').dispatchEvent(new Event('change'));document.getElementById('task-spending-ack').checked=true;document.getElementById('task-create-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(async()=>{const all=await(await fetch('/api/tasks')).json();window.qaScheduled=all.find(t=>!before.includes(t.id))?.id;return Boolean(window.qaScheduled)});
   await wait(()=>document.querySelector('#schedule-page .schedule-badge.scheduled'));
   check((await(await fetch('/api/tasks/'+window.qaScheduled)).json()).runs===0,'scheduled work ran early');
   check((await(await fetch('/api/tasks/'+window.qaScheduled)).json()).resultPolicy.notices[0]==='Fictional data','visible notice was not saved');
   check((await(await fetch('/api/tasks/'+window.qaScheduled)).json()).resultPolicy.table.criteria.minimumSeats===6,'typed comparison criterion was not saved');
   check(document.querySelector('.schedule-facts').textContent.includes('submitted criteria'),'computed comparison detail missing');
   check(document.querySelector('.schedule-facts').textContent.includes('Fictional data'),'saved notice absent from detail');
   Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Pause').click();
   await wait(()=>document.querySelector('#schedule-page .schedule-badge.paused'));
   check(document.querySelector('.schedule-reschedule'),'rescheduling controls missing');
   document.querySelector('.schedule-delete').click();await wait(()=>document.getElementById('ask').open);document.getElementById('ask-ok').click();
   await wait(()=>document.getElementById('schedule-title')?.textContent==='Schedule');
   check(!(await(await fetch('/api/tasks')).json()).some(t=>t.id===window.qaScheduled),'paused schedule not deleted');
   check(document.documentElement.scrollWidth<=innerWidth,'schedule detail overflow');
   return 'one-time setup, paused lifecycle and guarded deletion';`,
  `document.getElementById('open-schedule').click();await wait(()=>document.querySelector('.schedule-card[data-task="recovery-'+innerWidth+'"]'));document.querySelector('.schedule-card[data-task="recovery-'+innerWidth+'"]').click();await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>!document.getElementById('task-bar').hidden);
   document.getElementById('input').value='Continue after checking the effect';document.getElementById('input').dispatchEvent(new Event('input'));document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(()=>document.querySelector('dialog.schedule-reconcile[open]'));const dialog=document.querySelector('dialog.schedule-reconcile');check(dialog.textContent.includes('effect-'+innerWidth),'exact operation ID missing');check(!dialog.querySelector('form').checkValidity(),'reconciliation accepts no evidence');check(dialog.getBoundingClientRect().width<=innerWidth,'reconciliation overflow');return 'exact operation reconciliation and required evidence note';`,
  `const dialog=document.querySelector('dialog.schedule-reconcile');dialog.querySelector('input[type="checkbox"]').checked=true;dialog.querySelector('textarea').value='Checked the service and confirmed the prior operation effect; no repeat requested.';dialog.querySelector('button[value="reviewed"]').click();
   await wait(async()=>(await(await fetch('/api/tasks/recovery-'+innerWidth)).json()).state==='needs_input');const checked=await(await fetch('/api/tasks/recovery-'+innerWidth)).json();check(checked.operations[0].state==='reviewed'&&checked.operations[0].reconciliation.note.includes('Checked the service'),'reconciliation evidence not persisted');check(checked.runs===2,'reconciliation did not continue exactly once');return 'reviewed operation evidence persists and continuation stays bounded';`,
];
try {
  const bin = path.join(out, "webkit-check");
  await run("swiftc", ["-O", path.join(root, "scripts/webkit-check.swift"), "-o", bin]);
  for (const width of [1100, 620]) {
    const { stdout } = await run(bin, [`${app.url}/?session=task-start-${width}`, path.join(out, `width-${width}`), ...steps.map((s) => setup + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 60_000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (/step \d+ error:/.test(stdout) || !stdout.includes("interactive continuation")) throw new Error(`Task WebKit check failed at ${width}px`);
  }
  if (calls !== 16) throw new Error(`Unexpected model calls: ${calls}; local interaction must not call the model`);
  console.log(`Task WebKit checks passed. Screenshots: ${out}`);
} catch (err) {
  console.error(err); process.exitCode = 1;
} finally {
  await app.shutdown(); fake.closeAllConnections(); fake.close();
  if (previous === undefined) delete process.env.OPENAI_COMPAT_BASE_URL; else process.env.OPENAI_COMPAT_BASE_URL = previous;
}
