// Frozen live acceptance: real MCP → governed bridge → sandbox SQL → canonical surfaces → WebKit.
// Reads public NSE data only with --live; settings are isolated from the user's app.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startAppServer } from '../sidecar/server.ts';
// The desktop host runs sandboxes over its private pipe; this headless check uses the same helper directly.
import { helperSandbox } from '../test/support/sandbox-run.ts';
if (!process.argv.includes('--live')) throw new Error('Pass --live to read the official public NSE endpoints');
const run=promisify(execFile), out=mkdtempSync(path.join(tmpdir(),'vak-market-check-'));
const report:Record<string,unknown>={at:new Date().toISOString(),out,checks:[]};
console.log(`Evidence: ${out}`);
process.env.VAK_DATA_DIR=path.join(out,'data');process.env.TMPDIR=path.join(out,'data','tmp');mkdirSync(process.env.TMPDIR,{recursive:true});
const app=await startAppServer({dataDir:path.join(out,'data'),sandbox:helperSandbox(process.env.VAK_TEST_SANDBOX_BIN??path.resolve('../sandbox/target/debug/vaksb')),access:'open',uiDir:path.resolve('dist'),sandboxBin:process.env.VAK_TEST_SANDBOX_BIN??path.resolve('../sandbox/target/debug/vaksb'),keychainService:'com.nranjan2code.vakyartha.market-check'});
async function api(route:string,method='GET',body?:unknown):Promise<any>{
  const res=await app.request(new Request(`http://localhost${route}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
  const value=await res.json();if(!res.ok)throw Error(`${route}: ${JSON.stringify(value)}`);return value;
}
const checked=(message:string)=>{(report.checks as string[]).push(message);console.log(message);};
try{
  for(const [id,policies] of Object.entries({nse:{get_stock_history:'allow'},'nse-cmmkt':{cm_get_live_indices:'allow',cm_get_stock_quote:'allow'}})){
    await api(`/api/integrations/${id}/install`,'POST',{});await api(`/api/integrations/${id}`,'PUT',{enabled:true,policies});
  }
  const action=async(controlId:string,action?:string,value:unknown=null)=>{
    const current=await api('/api/apps/market-terminal');
    return api('/api/apps/market-terminal/action','POST',{controlId,action,value,revision:current.revision});
  };
  await action('refresh_market','refresh_market');
  await action('fetch_instrument','fetch_instrument');
  let details=await api('/api/apps/market-terminal');
  writeFileSync(path.join(out,'after-fetch.json'),JSON.stringify(details,null,2));
  const data=details.surfaces.instrument.data, market=details.surfaces.market.data;
  assert.ok(data.history.length>1,'History must contain dated observations');
  assert.equal(details.state.receipts.filter((r:any)=>r.status.startsWith('Failed:')).length,0,JSON.stringify(details.state.receipts));
  assert.deepEqual(market.headline.slice(0,2).map((h:any)=>h.label),['NIFTY 50','NIFTY BANK'],'Headline indices must be populated');assert.ok(market.indices.length>0);assert.ok(market.sectors.length>0);assert.equal(market.moves.length,4);
  checked('Live NSE reads reached all three canonical surfaces through the governed sandbox bridge');
  const independent=await api('/api/integrations/nse/test','POST',{tool:'get_stock_history',args:{symbol:'RELIANCE',months:1,endDate:'today'}});
  assert.equal(independent.isError,false);const source=JSON.parse(independent.text);
  writeFileSync(path.join(out,'independent-history.json'),JSON.stringify(source,null,2));
  const expected=source.data.filter((r:any)=>r.series==='EQ').sort((a:any,b:any)=>a.date.localeCompare(b.date));
  assert.deepEqual(data.history.map((r:any)=>[r.date,r.open,r.high,r.low,r.close,r.volume]),expected.map((r:any)=>[r.date,r.open,r.high,r.low,r.close,r.volume]));
  const fmt=(n:number)=>`${n>=0?'+':''}${n.toFixed(2)}%`;
  assert.equal(data.stats.priceReturn,fmt((expected.at(-1).close/expected[0].close-1)*100));
  let peak=0,drawdown=0;for(const r of expected){peak=Math.max(peak,r.close);drawdown=Math.min(drawdown,(r.close/peak-1)*100);}assert.equal(data.stats.maxDrawdown,fmt(drawdown));
  const returns=expected.slice(1).map((r:any,i:number)=>r.close/expected[i].close-1),mean=returns.reduce((a:number,b:number)=>a+b,0)/returns.length;
  const vol=Math.sqrt(returns.reduce((sum:number,r:number)=>sum+(r-mean)**2,0)/(returns.length-1))*Math.sqrt(252)*100;assert.equal(data.stats.volatility,`${vol.toFixed(2)}%`);
  const quote=await api('/api/integrations/nse-cmmkt/test','POST',{tool:'cm_get_stock_quote',args:{symbol:'RELIANCE'}});const stock=JSON.parse(quote.text).stock;
  assert.equal(details.state.quotes.RELIANCE.last,stock.lastTradedPrice);
  checked('Independent source rows, quote, return, sample volatility and maximum drawdown match exactly');
  const saved=JSON.stringify(data.history), callsBefore=readFileSync(path.join(out,'data/logs/tools.jsonl'),'utf8').split('\n').length;
  app.apps!.reloadApps();await action('recalculate','recalculate');details=await api('/api/apps/market-terminal');
  assert.equal(JSON.stringify(details.surfaces.instrument.data.history),saved);
  assert.equal(readFileSync(path.join(out,'data/logs/tools.jsonl'),'utf8').split('\n').length,callsBefore);
  checked('Registry reload and SQL recalculation retain identical history without external calls');
  const bin=path.join(out,'webkit');await run('swiftc',['-O','scripts/webkit-check.swift','-o',bin]);
  for(const width of [1440,1100,620,375]){
    const setup=`const motion=document.createElement('style');motion.textContent='.app{transition:none!important}';document.head.append(motion);const check=(v,m)=>{if(!v)throw Error(m)};const wait=ms=>new Promise(r=>setTimeout(r,ms));const flush=()=>document.querySelectorAll('vak-surface').forEach(s=>{s.renderNow();s.shadowRoot.querySelectorAll('.enter').forEach(n=>n.classList.remove('enter'))});`;
    const steps=[
      `document.getElementById('open-apps').click();await wait(200);window.dispatchEvent(new CustomEvent('vak:run-app',{detail:'market-terminal'}));await wait(200);flush();check(document.querySelector('#apps-page vak-surface'),'No terminal surface');return 'Market mounted';`,
      `const s=document.querySelector('#apps-page vak-surface');const open=[...s.shadowRoot.querySelectorAll('button')].find(b=>b.textContent==='Open');check(open,'Watchlist Open action absent');open.click();await wait(8000);flush();check(document.querySelector('.app-surface-nav > button[aria-pressed="true"]').textContent==='Instrument','Focus action did not navigate after commit');return 'Explicit focus opens independent Instrument view';`,
      ...['market','instrument','sources'].map(view=>`const view=[...document.querySelectorAll('.app-surface-nav > button')].find(b=>b.textContent==='${view[0]!.toUpperCase()+view.slice(1)}');check(view,'Visible view navigation absent');view.click();flush();const s=document.querySelector('#apps-page vak-surface');const root=s.shadowRoot;check(!root.textContent.includes('NaN'),'NaN visible');check(document.documentElement.scrollWidth<=innerWidth+2,'Document overflow');check(s.getBoundingClientRect().right<=innerWidth+2,'Surface overflow');const panel=document.querySelector('#apps-page').getBoundingClientRect();check(panel.width>=Math.min(innerWidth,500)-10,'App panel leaves unusable empty column');for(const c of document.querySelectorAll('.app-runner-top > *')){const b=c.getBoundingClientRect();check(b.left>=panel.left&&b.right<=innerWidth+2,'Header control clipped');}if('${view}'!=='sources')check(root.querySelectorAll('svg').length>0,'Charts absent');if('${view}'==='instrument'){const live=(await(await fetch('/api/apps/market-terminal')).json()).surfaces.instrument.data.history;check(root.querySelectorAll('.chart g[aria-label]').length===live.length,'OHLC candles missing or duplicated');const figure=root.querySelector('.chart');figure.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));check(figure.querySelector('.chart-inspector').textContent.startsWith(live[0].date),'Keyboard point inspection failed');const mark=figure.querySelector('[data-observation=\"1\"]');mark.dispatchEvent(new MouseEvent('click',{bubbles:true}));check(figure.querySelector('.chart-inspector').textContent.startsWith(live[1].date),'Touch/click point inspection failed');}if('${view}'==='market'){check(root.querySelector('.stat .value'),'Headline index missing');const f=root.querySelector('.filter');f.value='RELIANCE';f.dispatchEvent(new Event('input',{bubbles:true}));}return '${view} visible, charts present, no page overflow';`),
      `document.querySelector('.app-surface-nav > button').click();flush();check(document.querySelector('#apps-page vak-surface').shadowRoot.querySelector('.filter').value==='RELIANCE','View switch lost local table filter');[...document.querySelectorAll('.app-surface-nav > button')].find(b=>b.textContent==='Instrument').click();flush();return 'Local filter retained across views';`,
      `const before=await(await fetch('/api/apps/market-terminal')).json();const s=document.querySelector('#apps-page vak-surface');const pick=[...s.shadowRoot.querySelectorAll('.seg button')].find(b=>b.textContent==='2 months');check(pick,'History window choice absent');pick.click();await wait(3200);flush();const after=await(await fetch('/api/apps/market-terminal')).json();check(after.revision>before.revision,'Field edit did not commit');check(after.surfaces.instrument.data.stats.priceReturn===before.surfaces.instrument.data.stats.priceReturn,'Calculation changed');return 'UI SQL action committed and value retained';`,
    ];
    const {stdout}=await run(bin,[app.url,path.join(out,`width-${width}`),...steps.map(s=>setup+s)],{env:{...process.env,WK_WIDTH:String(width),WK_HEIGHT:'1100'},timeout:60000});
    writeFileSync(path.join(out,`webkit-${width}.txt`),stdout);console.log(`${width}px: ${stdout.trim()}`);
    if (/step \d+ error:/.test(stdout)||!stdout.includes('UI SQL action committed'))throw Error(`WebKit failed at ${width}`);
  }
  checked('WebKit checks all three surfaces and a real UI SQL action at 1440/1100/620/375px');
  report.status='passed';report.finalRevision=(await api('/api/apps/market-terminal')).revision;
}catch(error){report.status='failed';report.error=(error as Error).stack;console.error(error);process.exitCode=1;}
finally{writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await app.shutdown();console.log(`Report: ${out}/report.json`);}
