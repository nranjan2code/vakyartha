// Deterministic task + multi-surface WebKit check. No model or external service calls.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
const app = await startAppServer({ dataDir: path.join(out, "data"), keychainService: "com.nranjan2code.vakyartha.task-check", access: "open", uiDir: path.join(root, "dist") });
const setup = `
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
   document.getElementById('task-goal').value='Create two independent forms and a table';document.getElementById('task-criteria').value='All three stay interactive';
   const oldIds=(await(await fetch('/api/tasks')).json()).map(t=>t.id);
   document.getElementById('task-create-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(async()=>{const list=await(await fetch('/api/tasks')).json();window.qaTask=list.find(t=>!oldIds.includes(t.id))?.id;return Boolean(window.qaTask)});
   await wait(async()=>(await task()).state==='needs_input');
   await wait(()=>document.querySelector('#schedule-page .schedule-detail-actions'));Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Open workspace').click();await wait(()=>document.querySelectorAll('vak-surface').length===3);flush();
   await wait(()=>!document.getElementById('task-bar').hidden);
   check(document.getElementById('canvas-pick').options.length===3,'missing task surfaces');
   check((await task()).state==='needs_input','task should require review');return 'task setup and three live surfaces';`,
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
  `await wait(()=>Array.from(document.querySelectorAll('#task-bar button')).some(b=>b.textContent==='Mark complete'));
   Array.from(document.querySelectorAll('#task-bar button')).find(b=>b.textContent==='Mark complete').click();await wait(()=>document.getElementById('ask').open);document.getElementById('ask-ok').click();
   await wait(async()=>(await task()).state==='completed');
   const b=pick('second');flush();check(!b.shadowRoot.querySelector('button').disabled,'completion disabled a surface');b.shadowRoot.querySelector('button').click();
   await wait(async()=>(await task()).runs===3);await wait(async()=>(await task()).state==='needs_input');
   await new Promise(r=>setTimeout(r,2200));flush();check(pick('second')===b,'status refresh recreated an interactive surface');
   check(document.documentElement.scrollWidth<=innerWidth,'page overflow');return 'reviewed completion and interactive continuation';`,
  `document.getElementById('open-schedule').click();await wait(()=>document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]'));document.querySelector('.schedule-card[data-task="'+window.qaTask+'"]').click();
   await wait(()=>document.querySelectorAll('.schedule-run').length===3);
   const history=await task();check(history.runHistory.length===3,'run records missing');check(history.runHistory[1].state==='accepted','review decision absent from run history');
   document.querySelector('.schedule-run summary').click();check(document.querySelector('.schedule-run').open,'run receipt will not expand');check(document.querySelector('.schedule-run-id').textContent.includes(history.runHistory[2].id),'wrong run receipt');
   check(document.documentElement.scrollWidth<=innerWidth,'run history overflow');
   return 'distinct run history, accepted outcome and expandable receipts';`,
  `document.getElementById('open-schedule').click();document.getElementById('create-schedule').click();
   await wait(()=>!document.getElementById('schedule-compose').hidden&&!document.getElementById('task-create-start').disabled);
   document.getElementById('task-goal').value='Future review';document.getElementById('task-criteria').value='An explicit reviewed result';
   const timing=document.getElementById('schedule-timing');timing.value='once';timing.dispatchEvent(new Event('change'));
   const d=new Date(Date.now()+3600000);document.getElementById('schedule-at').value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
   const before=(await(await fetch('/api/tasks')).json()).map(t=>t.id);
   document.getElementById('task-create-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
   await wait(async()=>{const all=await(await fetch('/api/tasks')).json();window.qaScheduled=all.find(t=>!before.includes(t.id))?.id;return Boolean(window.qaScheduled)});
   await wait(()=>document.querySelector('#schedule-page .schedule-badge.scheduled'));
   check((await(await fetch('/api/tasks/'+window.qaScheduled)).json()).runs===0,'scheduled work ran early');
   Array.from(document.querySelectorAll('#schedule-page button')).find(b=>b.textContent==='Pause').click();
   await wait(()=>document.querySelector('#schedule-page .schedule-badge.paused'));
   check(document.querySelector('.schedule-reschedule'),'rescheduling controls missing');
   document.querySelector('.schedule-delete').click();await wait(()=>document.getElementById('ask').open);document.getElementById('ask-ok').click();
   await wait(()=>document.getElementById('schedule-title')?.textContent==='Schedule');
   check(!(await(await fetch('/api/tasks')).json()).some(t=>t.id===window.qaScheduled),'paused schedule not deleted');
   check(document.documentElement.scrollWidth<=innerWidth,'schedule detail overflow');
   return 'one-time setup, paused lifecycle and guarded deletion';`,
];
try {
  const bin = path.join(out, "webkit-check");
  await run("swiftc", ["-O", path.join(root, "scripts/webkit-check.swift"), "-o", bin]);
  for (const width of [1100, 620]) {
    const { stdout } = await run(bin, [`${app.url}/?session=task-start-${width}`, path.join(out, `width-${width}`), ...steps.map((s) => setup + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 60_000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (/step \d+ error:/.test(stdout) || !stdout.includes("interactive continuation")) throw new Error(`Task WebKit check failed at ${width}px`);
  }
  if (calls !== 6) throw new Error(`Unexpected model calls: ${calls}; local interaction must not call the model`);
  console.log(`Task WebKit checks passed. Screenshots: ${out}`);
} catch (err) {
  console.error(err); process.exitCode = 1;
} finally {
  await app.shutdown(); fake.closeAllConnections(); fake.close();
  if (previous === undefined) delete process.env.OPENAI_COMPAT_BASE_URL; else process.env.OPENAI_COMPAT_BASE_URL = previous;
}
