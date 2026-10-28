// Geometry and interaction checks for mixed dynamic layouts in real WebKit.
// Scripted records isolate renderer behavior from model authoring quality.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAppServer } from "../sidecar/server.ts";

const run = promisify(execFile), out = await mkdtemp(path.join(tmpdir(), "vak-surface-design-"));
const bin = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
const marketExample = JSON.parse(await readFile(path.resolve("sidecar/builtin-skills/market-dashboard/references/market-dashboard-example.json"), "utf8")).surfaces[0];
const marketSurface = { surface: marketExample.surface, title: marketExample.title, data: marketExample.data, nodes: [{ id: "root", ...marketExample.root }] };
const records = Array.from({ length: 30 }, (_, i) => ({ label: `Team ${i + 1}`, value: i + 1 }));
const surface = { surface: "operations", title: "Operations review", data: { records, owner: "Asha" }, nodes: [{ id: "root", type: "stack", props: { gap: "lg" }, children: [
  { id: "intro", type: "text", props: { content: "Weekly delivery · supplied snapshot", variant: "heading" } },
  { id: "metrics", type: "grid", props: { columns: 4, minItemWidth: "sm" }, children: [
    { id: "metric", type: "stat", props: { label: "Items in scope", value: { records: "{/records}", field: "value", aggregate: "count" } } },
  ] },
  { id: "panels", type: "stack", props: { direction: "horizontal", align: "start", gap: "lg" }, children: [
    { id: "summary", type: "card", props: { title: "Review status", body: "Ready for your review", maxWidth: "sm", tone: "info" } },
    { id: "context", type: "section", props: { title: "Reporting context", maxWidth: "md" }, children: [
      { id: "notes", type: "text", props: { content: "These are supplied records, not live business data.\n\nThe table can be searched and sorted locally. Its filter does not change the chart or total scope.\n\nReview the owner before submitting." } },
    ] },
  ] },
  { id: "review", type: "form", props: { submit: "review", submitLabel: "Review owner", maxWidth: "md" }, children: [
    { id: "owner", type: "input", props: { label: "Owner", bind: "/owner", checks: ["required"] } },
  ] },
  { id: "detail", type: "table", props: { columns: ["Team", "Items"], rows: { records: "{/records}", fields: ["label", "value"] }, searchable: true, sortable: true, pageSize: 5, maxWidth: "full" } },
  { id: "visuals", type: "grid", props: { columns: 2, minItemWidth: "sm" }, children: [
    { id: "compact", type: "chart", props: { kind: "pie", maxWidth: "sm", labels: ["Ready", "Pending"], series: [8, 2] } },
    { id: "trend", type: "chart", props: { kind: "bar", series: { records: "{/records}", label: "label", fields: ["value"] } } },
  ] },
  { id: "defaultChart", type: "chart", props: { kind: "line", series: { records: "{/records}", label: "label", fields: ["value"] } } },
  { id: "wideChart", type: "chart", props: { kind: "line", maxWidth: "full", series: { records: "{/records}", label: "label", fields: ["value"] } } },
] }] };
const kinds = ["bar", "stacked", "line", "area", "pie", "scatter", "heatmap", "radar"];
const gallery = { surface: "chart-gallery", title: "Chart capability review · supplied examples", nodes: [{ id: "root", type: "grid", props: { columns: 2, minItemWidth: "sm" }, children: [
  ...kinds.map((kind) => ({ id: kind, type: "section", props: { title: kind }, children: [
    { id: `${kind}-context`, type: "text", props: { content: "Supplied sample values, in units. No live feed is connected." } },
    { id: `${kind}-chart`, type: "chart", props: { kind, labels: ["Alpha", "Beta", "Gamma"], series: kind === "scatter" ? [{ name: "Reading in units", x: [1, 2, 3], values: [12, 17, 8] }] : kind === "pie" ? [{ name: "Items", values: [12, 17, 8] }] : [{ name: "First", values: [12, 17, 8] }, { name: "Second", values: [5, 9, 3] }] } },
  ] })),
  { id: "ohlc", type: "section", props: { title: "Observed OHLC · supplied interval data" }, children: [{ id: "ohlc-chart", type: "chart", props: { kind: "candlestick", height: "md", yLabel: "Price units", labels: ["A", "B"], series: [{ values: [100, 110] }, { values: [112, 114] }, { values: [98, 99] }, { values: [110, 101] }] } }] },
  { id: "ranking", type: "section", props: { title: "Signed category ranking" }, children: [{ id: "ranking-chart", type: "chart", props: { kind: "bar", orientation: "horizontal", colorBy: "sign", labels: ["A long category name", "Another category"], series: [{ values: [3, -2] }] } }] },
  { id: "dated-heat", type: "section", props: { title: "Dated intensity" }, children: [{ id: "dated-chart", type: "chart", props: { kind: "heatmap", labels: ["2026-10-01", "2026-10-02", "2026-10-03"], series: [{ name: "Items", values: [2, 5, 3] }] } }] },
] }] };
try {
for (const width of [1440, 1100, 620]) {
  const app = await startAppServer({ dataDir: path.join(out, `data-${width}`), keychainService: "com.nranjan2code.vakyartha.surface-design-check", access: "open", uiDir: path.resolve("dist") });
  const setup = `const check=(ok,msg)=>{if(!ok)throw new Error(msg)};const flush=()=>document.querySelectorAll('vak-surface').forEach(s=>{s.renderNow();s.shadowRoot.querySelectorAll('.enter').forEach(n=>n.classList.remove('enter'))});const project=async(tool,args)=>{const r=await fetch('/api/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:'surface-design-check',tool,args})});check(r.ok,await r.text());await new Promise(r=>setTimeout(r,200));flush()};`;
  const steps = [
    `document.documentElement.dataset.mode='light';document.getElementById('settings-back').click();await project('vak_render',${JSON.stringify(surface)});document.querySelector('#canvas-content vak-surface').setAttribute('theme','light');document.getElementById('canvas-expand').click();await new Promise(r=>setTimeout(r,200));flush();return 'mixed surface mounted';`,
    `const s=document.querySelector('#canvas-content vak-surface');window.qaDesign=s;const q=s.shadowRoot;const grid=q.querySelector('.grid.fixed-columns');const metric=q.querySelector('.stat');const tracks=getComputedStyle(grid).gridTemplateColumns.split(' ').length;check(metric.getBoundingClientRect().width<grid.getBoundingClientRect().width/tracks+3,'orphan metric expanded across requested columns');const summary=q.querySelector('.card');check(summary.getBoundingClientRect().width<=321,'compact card stretched');const panels=q.querySelector('.stack.horizontal');const a=panels.children[0].getBoundingClientRect(),b=panels.children[1].getBoundingClientRect();if(Math.abs(a.left-b.left)>20)check(Math.abs(a.top-b.top)<2,'panel top alignment ignored');check(q.querySelector('form').getBoundingClientRect().width<=721,'form exceeded readable measure');const charts=[...q.querySelectorAll('.chart-box')];check(charts[0].getBoundingClientRect().width<=321,'compact chart stretched');check(charts[2].getBoundingClientRect().width<=721,'default chart stretched');if(s.clientWidth>800)check(charts[3].getBoundingClientRect().width>charts[2].getBoundingClientRect().width+30,'explicit full width ignored');check(document.documentElement.scrollWidth<=innerWidth,'page overflow');return 'grid rhythm, card/form/chart measures and panel alignment pass';`,
    `const s=window.qaDesign,q=s.shadowRoot;window.qaActions=0;s.addEventListener('vak-action',e=>{window.qaActions++;e.stopPropagation()});const input=q.querySelector('input:not(.filter)');input.value='Meera';input.dispatchEvent(new Event('input',{bubbles:true}));const filter=q.querySelector('.table-box .filter');filter.value='Team 30';filter.dispatchEvent(new Event('input',{bubbles:true}));check(q.querySelector('tbody').textContent.includes('Team 30'),'local search failed');check(window.qaActions===0,'local edit/filter dispatched action');await project('vak_update',{surface:'operations',nodes:[{id:'notes',props:{content:'Snapshot reviewed. No live synchronization.'}}]});check(s===document.querySelector('#canvas-content vak-surface'),'surface replaced');check(s.shadowRoot.querySelector('input:not(.filter)').value==='Meera','draft lost on layout update');check(s.shadowRoot.querySelector('tbody').textContent.includes('Team 30'),'table filter lost');return 'local controls and drafts preserved';`,
    `await project('vak_update',{surface:'operations',nodes:[{id:'panels',props:{align:'end'}}]});const row=window.qaDesign.shadowRoot.querySelector('.stack.horizontal');check(getComputedStyle(row).alignItems==='flex-end','explicit row alignment ignored');document.documentElement.dataset.mode='dark';document.documentElement.dataset.theme='ocean';window.qaDesign.setAttribute('theme','dark');return 'explicit alignment and dark theme pass';`,
    `await project('vak_render',${JSON.stringify(gallery)});const s=document.querySelector('#canvas-content vak-surface');check(s.surfaceId==='chart-gallery','chart gallery not active');s.setAttribute('theme','dark');await new Promise(r=>setTimeout(r,200));flush();const charts=[...s.shadowRoot.querySelectorAll('.chart')];check(charts.length===11,'missing supported chart kind, ranking or dated heatmap');for(const chart of charts){const svg=chart.querySelector('svg[role="img"]');check(svg&&svg.childElementCount>0,'chart did not draw');check(!/NaN|Infinity/.test(svg.outerHTML),'nonfinite chart geometry');check(svg.getBoundingClientRect().width<=chart.getBoundingClientRect().width+1,'chart overflow');}check(document.documentElement.scrollWidth<=innerWidth,'gallery page overflow');return 'all nine chart kinds, horizontal ranking and dated heatmap render without overflow';`,
    `await project('vak_render',${JSON.stringify(marketSurface)});const s=document.querySelector('#canvas-content vak-surface');check(s.surfaceId==='illustrative-market-review','market template not active');const q=s.shadowRoot;check(q.textContent.includes('fictional figures'),'market caveat missing');check(q.querySelectorAll('.stat').length===2,'market measures missing');check(q.querySelector('.chart svg[role="img"]'),'market trend missing');check(q.querySelectorAll('tbody tr').length===5,'market exact rows missing');check(!q.querySelector('.table-box').textContent.includes('Total'),'price table has an unwanted total');check(document.documentElement.scrollWidth<=innerWidth,'market template overflow');return 'market reference template renders with dated trend, exact rows and caveat';`,
  ];
  try {
    const { stdout } = await run(bin, [`${app.url}/?session=surface-design-check`, path.join(out, `width-${width}`), ...steps.map(step => setup + step)], { env: { ...process.env, WK_WIDTH: String(width), WK_HEIGHT: "1200" }, timeout: 45000 });
    console.log(`${width}px: ${stdout.trim()}`);
    if (stdout.includes(" error:") || !stdout.includes("market reference template renders")) throw new Error("Surface design WebKit checks failed");
  } finally { await app.shutdown(); }
}
console.log(`Surface design checks passed. Screenshots: ${out}`);
} catch (error) { console.error(error); process.exitCode = 1; }
