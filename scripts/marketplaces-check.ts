// Off-screen WebKit verification of discovery/review/setup and fallback states.
// Uses isolated data and catalog fixtures; no model calls or outside installs.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startAppServer, type AppServerOptions } from "../sidecar/server.ts";
const run = promisify(execFile), root = fileURLToPath(new URL("..", import.meta.url));
const out = await mkdtemp(path.join(tmpdir(), "vak-marketplaces-check-"));
const serverOptions: AppServerOptions = { dataDir: path.join(out, "data"), keychainService: "com.nranjan2code.vakyartha.marketplace-check", access: "open", uiDir: path.join(root, "dist"), marketplaceFetch: async url => {
  const u = new URL(String(url));
  if (u.hostname === "api.mcp.github.com") return new Response("", { status: 503 });
  if (u.hostname === "desktop.docker.com") return Response.json({ registry: { local: { title: "Local container", image: "mcp/fixture@sha256:abc", description: "A separately managed container integration." } } });
  const empty = u.searchParams.get("search") === "no-results";
  const more = u.searchParams.has("cursor");
  return Response.json({ servers: empty ? [] : Array.from({ length: 4 }, (_, index) => ({ server: { name: `org.example/${more ? "more-" : ""}docs-${index}`, title: `${index ? "Knowledge " + index : "Public documentation"}${more ? " continued" : ""}`, description: "Search project documentation and retrieve current reference material. Choose access before connecting.", version: "1.0.0", repository: { url: "https://github.com/example/docs" }, remotes: [{ type: "streamable-http", url: `https://mcp.example.org/docs-${more ? "more-" : ""}${index}` }] } })), metadata: { nextCursor: !empty && !more ? "next-page" : undefined } });
} };
const setup = `
const check=(ok,m)=>{if(!ok)throw new Error(m)};
const wait=async fn=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw new Error('UI did not settle')};
const click=text=>{const b=[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent===text);check(b,'missing '+text);b.click();};
const fit=()=>check(document.documentElement.scrollWidth<=innerWidth,'horizontal overflow');
`;
const steps = [
  `document.documentElement.dataset.mode=innerWidth>720?'light':'dark';document.querySelector('.app').style.transition='none';document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Integrations').click();await wait(()=>document.querySelector('.catalog-tabs'));click('External catalogs');await wait(()=>document.querySelectorAll('.external-card').length===4);check(document.querySelectorAll('.catalog-source').length===3,'source choices');check(document.querySelector('.catalog-source').getAttribute('aria-pressed')==='true','source selection');fit();return 'external discovery in app theme';`,
  `click('Load more');await wait(()=>document.querySelectorAll('.external-card').length===8);document.querySelector('.external-card').click();await wait(()=>document.querySelector('.catalog-ack'));check(document.querySelector('.catalog-next .primary').disabled,'review must require acknowledgement');check(document.activeElement.classList.contains('catalog-review'),'review focus');fit();return 'connection review, provenance, costs and consent';`,
  `document.querySelector('.catalog-ack input').click();click('Add and configure');await wait(()=>document.querySelector('.int-head h1')?.textContent==='Public documentation');check(document.querySelector('.catalog-notice').textContent.includes('MCP Registry'),'provenance lost');check(!document.querySelector('.int-controls .switch').checked,'import started enabled');fit();return 'import opens existing lifecycle setup and stays off';`,
  `click('‹ All integrations');await wait(()=>document.querySelector('.catalog-tabs'));click('In use');check([...document.querySelectorAll('.market-name')].some(n=>n.textContent==='Public documentation'),'added integration missing from In use');check(![...document.querySelectorAll('.market-name')].some(n=>n.textContent==='GitHub'),'unconfigured hosted entry counted as in use');click('External catalogs');await wait(()=>document.querySelectorAll('.external-card').length===4);document.querySelectorAll('.catalog-source')[1].click();await wait(()=>document.querySelector('.catalog-empty h3')?.textContent.includes("couldn't"));check(document.querySelector('.catalog-empty button').textContent==='Try again','retry absent');fit();return 'catalog failure with retry';`,
  `document.querySelectorAll('.catalog-source')[2].click();await wait(()=>document.querySelector('.external-card'));document.querySelector('.external-card').click();await wait(()=>document.querySelector('.catalog-notice'));check(document.querySelector('.catalog-notice').textContent.includes('runtime'),'container limitation absent');check(!document.querySelector('.catalog-ack'),'unsupported entry offered import');fit();return 'unsupported runtime explained without install';`,
  `click('‹ Back to results');document.querySelectorAll('.catalog-source')[0].click();await wait(()=>document.querySelectorAll('.external-card').length===4);const s=document.querySelector('.catalog-search input');s.value='no-results';document.querySelector('.catalog-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>document.querySelector('.catalog-empty h3')?.textContent==='No matches yet');fit();return 'empty search, responsive layout and completion';`,
];
try {
  const bin = path.join(out,"webkit-check"); await run("swiftc",["-O",path.join(root,"scripts/webkit-check.swift"),"-o",bin]);
  for(const width of (process.env.WK_WIDTH ? [Number(process.env.WK_WIDTH)] : [1100,620])) {
    // A fresh origin/data folder avoids reusing an off-screen WebKit network
    // process's prior connections and makes each width an independent install.
    const app = await startAppServer({ ...serverOptions, dataDir: path.join(out, `data-${width}`) });
    try {
    const {stdout}=await run(bin,[app.url+`/?session=catalog-check-${width}`,path.join(out,`width-${width}`),...steps.map(s=>setup+s)],{env:{...process.env,WK_WIDTH:String(width)},timeout:60_000});
    console.log(`${width}px: ${stdout.trim()}`);
    if(/step \d+ error:/.test(stdout)||!stdout.includes("responsive layout and completion"))throw new Error(`Marketplace WebKit check failed at ${width}px`);
    } finally { await app.shutdown(); }
  }
  console.log(`Marketplace WebKit checks passed. Screenshots: ${out}`);
} catch (err) {
  const e = err as {stdout?:string;stderr?:string;code?:unknown;signal?:unknown};
  console.error(JSON.stringify({code:e.code,signal:e.signal,stdout:e.stdout,stderr:e.stderr,out})); process.exitCode=1;
}
