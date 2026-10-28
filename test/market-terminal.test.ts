import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { basicCatalog, SurfaceStore } from '@vak/core';
import { initialize, saveHistory, analyze, type Database } from '../sidecar/builtin-apps/market-terminal/analytics.ts';
import { decode, history, quote, indices } from '../sidecar/builtin-apps/market-terminal/source.ts';
import { handleAction, type Context } from '../sidecar/builtin-apps/market-terminal/server.ts';
const bars=[100,110,99,108].map((close,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,open:close,high:close+2,low:close-2,close,volume:100+i}));
async function database() {
  const instance=await DuckDBInstance.create(':memory:',{enable_external_access:'false'}), c=await instance.connect();
  const db: Database={async run(sql,values){await c.run(sql,values);},async query(sql,values){return (await c.runAndReadAll(sql,values)).getRowObjectsJson();}};
  await initialize(db);return {db,close(){c.closeSync();instance.closeSync();}};
}
test('market package has three validated canonical surfaces without invented market values',()=>{
  const surfaces=JSON.parse(readFileSync('sidecar/builtin-apps/market-terminal/surface.json','utf8'));
  assert.deepEqual(surfaces.map((s:any)=>s.id),['market','instrument','analytics']);
  for(const s of surfaces){const store=new SurfaceStore(basicCatalog);assert.deepEqual(store.render({surface:s.id,title:s.title,data:s.data,nodes:s.nodes}),[]);assert.deepEqual(s.data.history,[]);assert.equal(s.data.quotePrice,'Unavailable');}
});
test('DuckDB calculations preserve row identity, sample volatility, drawdown and SMA warm-up',async()=>{
  const {db,close}=await database();
  try{
    await saveHistory(db,'TEST',bars);const a=await analyze(db,'TEST');
    assert.equal(a.sessions,4);assert.ok(Math.abs(a.priceReturn!-8)<1e-10);assert.ok(Math.abs(a.maxDrawdown!+10)<1e-10);
    assert.deepEqual(a.rows.map(r=>r.date),bars.map(r=>r.date));assert.deepEqual(a.rows.map(r=>r.sma20),[null,null,null,null]);
    const returns=[.1,-.1,108/99-1],mean=returns.reduce((a,b)=>a+b,0)/3;
    const expected=Math.sqrt(returns.reduce((sum,r)=>sum+(r-mean)**2,0)/2)*Math.sqrt(252)*100;
    assert.ok(Math.abs(a.volatility!-expected)<1e-10);
    const twenty=Array.from({length:21},(_,i)=>({...bars[0]!,date:`2026-10-${String(i+1).padStart(2,'0')}`,close:100+i,open:100+i,high:102+i,low:98+i}));
    await saveHistory(db,'TEST',twenty);const b=await analyze(db,'TEST');assert.equal(b.rows[18]!.sma20,null);assert.equal(b.rows[19]!.sma20,109.5);assert.equal(b.rows[20]!.sma20,110.5);
  }finally{close();}
});
test('NSE decoding rejects mismatched, missing, malformed or inconsistent observations',()=>{
  const valid={symbol:'TEST',data:bars.map(b=>({...b,symbol:'TEST',series:'EQ'}))};
  assert.deepEqual(history(decode(JSON.stringify(valid)),'TEST'),bars);
  for(const data of [[],[valid.data[0],valid.data[0]],[{...valid.data[0],close:0}],[{...valid.data[0],date:'2026-02-30'}],[{...valid.data[0],volume:null}],[{...valid.data[0],symbol:'WRONG'}]])assert.throws(()=>history({...valid,data},'TEST'));
  assert.throws(()=>decode({isError:true,text:'{}'}));assert.throws(()=>decode('<tool_output>clipped'));
  assert.throws(()=>quote({stock:{symbol:'WRONG'}},'TEST'));
  assert.equal(indices({indices:{broad:[{indexName:'INDIA VIX',last:16.36,previousClose:16.4,percChange:-0.28,timeVal:'source'}]}},'broad')[0]!.changePct,-0.28);
  assert.throws(()=>indices({indices:{sectoral:[{indexName:'INDEX',last:110,previousClose:100,percChange:5,timeVal:'date'}]}},'sectoral'));
});
test('failed refresh retains database observations and records failure without manufacturing freshness',async()=>{
  const {db,close}=await database();
  try{
    await saveHistory(db,'RELIANCE',bars);
    const ctx:Context={state:{},surfaces:{market:{},instrument:{},analytics:{}},database:db,async callTool(){throw Error('read policy denied');}};
    const result=await handleAction('refresh-instrument',null,ctx,'refresh_instrument');
    assert.equal(result.updates[0]!.data.history.length,4);assert.match(ctx.state.message!,/incomplete/);assert.equal(ctx.state.receipts!.length,2);assert.ok(ctx.state.receipts!.every(r=>r.status.startsWith('Failed:')));
    const before=JSON.stringify(ctx.state);await assert.rejects(handleAction('/symbol','bad symbol',ctx),/exact/);assert.equal(JSON.stringify(ctx.state),before);
  }finally{close();}
});
