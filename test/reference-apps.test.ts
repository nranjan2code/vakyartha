import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { basicCatalog, SurfaceStore } from '@vak/core';
import { DuckDBInstance } from '@duckdb/node-api';
import { parseFeed, canonical } from '../sidecar/builtin-apps/news-desk/feed.ts';
import { project as newsProject, handleAction as newsAction, refresh as newsRefresh } from '../sidecar/builtin-apps/news-desk/server.ts';
import { items, commits, repository, handleAction as projectAction } from '../sidecar/builtin-apps/project-desk/server.ts';
import { paise, records, handleAction as financeAction, project as financeProject } from '../sidecar/builtin-apps/finance-workbench/server.ts';
import { AppRegistry } from '../sidecar/sandbox-pool/app-registry.ts';
import { SandboxPoolManager } from '../sidecar/sandbox-pool/pool-manager.ts';
import { APP_DOCUMENTS } from '../shared/app-scaffold.ts';
const fixture='<rss version="2.0"><channel><item><title><![CDATA[Science &amp; facts]]></title><link>https://example.org/article?utm_source=feed</link><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Source excerpt</p>]]></description></item></channel></rss>';
const feed={name:'Test feed',category:'Science',url:'https://example.org/feed.xml'};
test('all shipped references contain complete docs and valid empty canonical surfaces',()=>{
  for(const id of readdirSync('sidecar/builtin-apps')){
    const root=`sidecar/builtin-apps/${id}`;
    for(const doc of APP_DOCUMENTS)assert.ok(readFileSync(`${root}/${doc}`,'utf8').trim().length>300);
    const input=JSON.parse(readFileSync(`${root}/surface.json`,'utf8'));for(const s of Array.isArray(input)?input:[input])assert.deepEqual(new SurfaceStore(basicCatalog).render({surface:s.id,title:s.title,data:s.data,nodes:s.nodes}),[],`${id}/${s.id}`);
  }
});
test('news parses bounded RSS/Atom/JSON Feed and rejects malformed/unsafe input',()=>{
  const rows=parseFeed(fixture,feed,'2026-10-28T11:00:00Z');assert.equal(rows.length,1);assert.equal(rows[0]!.title,'Science & facts');assert.equal(rows[0]!.url,'https://example.org/article');assert.equal(rows[0]!.excerpt,'Source excerpt');assert.equal(rows[0]!.publishedAt,'2026-10-28T10:00:00.000Z');
  assert.equal(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="https://example.org/a"/><updated>2026-10-28T10:00:00Z</updated></entry></feed>',feed,'now')[0]!.title,'A');
  assert.equal(parseFeed(JSON.stringify({version:'https://jsonfeed.org/version/1.1',items:[{id:'a',title:'A',url:'https://example.org/a',content_text:'B'}]}),feed,'now')[0]!.publishedAt,null);
  for(const bad of ['<!DOCTYPE rss>'+fixture,fixture.replace('</item>','</wrong>'),fixture.slice(0,-7),'<html>not a feed</html>'])assert.throws(()=>parseFeed(bad,feed,'now'));
  for(const url of ['http://example.org/a','https://user:secret@example.org/a','file:///tmp/a'])assert.throws(()=>canonical(url));
});
test('news bookmarks and source failures preserve identity, source times and local reading state',async()=>{
  const c:any={state:{feeds:JSON.stringify([feed])},surfaces:{headlines:{},saved:{},sources:{}},async callTool(){return `URL: ${feed.url}\n\n${fixture}`;}};
  await newsRefresh(c);const original=c.state.articles[0];await newsAction('save', {id:original.id},c,'save_article');assert.deepEqual(c.state.saved,[original.id]);
  c.callTool=async()=>{throw Error('offline')};await newsRefresh(c);assert.equal(c.state.articles[0].publishedAt,original.publishedAt);assert.equal(c.state.articles[0].retrievedAt,original.retrievedAt);assert.match(c.state.message,/0\/1/);assert.equal(newsProject(c).updates[0]!.data.savedArticles.length,1);
});
test('repository records enforce source identity and local lanes never call a write tool',async()=>{
  const row={number:1,title:'Review',state:'open',html_url:'https://github.com/owner/repo/issues/1',updated_at:'2026-10-28T10:00:00Z',labels:[],user:{login:'author'}};
  assert.equal(items([row,{...row,pull_request:{}}],'owner/repo').length,1);assert.throws(()=>items([row],'wrong/repo'));assert.throws(()=>repository('../repo'));assert.throws(()=>commits([{sha:'bad',html_url:'https://github.com/owner/repo/commit/bad'}],'owner/repo'));
  const c:any={state:{repository:'owner/repo',issues:items([row],'owner/repo')},surfaces:{triage:{}},async callTool(){throw Error('No external operation allowed');}};
  await projectAction('/cards',[{id:row.html_url,column:'Watch'}],c);assert.equal(c.state.triage[row.html_url],'Watch');await projectAction('/repository','another/repo',c);assert.deepEqual(c.state.issues,[]);assert.deepEqual(c.state.triage,{});
});
test('finance preserves exact paise, validates batches and rolls back duplicate imports atomically',async()=>{
  assert.equal(paise('-12.50'),-1250);assert.equal(paise('0.01'),1);for(const v of [12.5,'1e3','NaN','1.234',''])assert.throws(()=>paise(v));
  const input=[{id:'income',date:'2026-10-01',description:'Synthetic inflow',category:'Income',amount:'100.01'},{id:'cost',date:'2026-10-02',description:'Synthetic expense',category:'Food',amount:'-12.50'},{id:'prior',date:'2026-09-30',description:'Prior window',category:'Other',amount:'-5.00'}];assert.equal(records(JSON.stringify(input)).length,3);assert.throws(()=>records(JSON.stringify([...input,input[0]])));
  const instance=await DuckDBInstance.create(':memory:',{enable_external_access:'false'}),conn=await instance.connect();
  const c:any={state:{month:'2026-10',importText:JSON.stringify(input),budget:'20.00'},surfaces:{overview:{},ledger:{},import:{}},database:{async run(sql:string,args:any[]){await conn.run(sql,args);},async query(sql:string,args:any[]){return (await conn.runAndReadAll(sql,args)).getRowObjectsJson();}}};
  try{const result=await financeAction('import',null,c,'import_records');assert.ok('focusSurface' in result);assert.equal(result.focusSurface,'ledger');const data=result.updates[0]!.data;assert.equal(data.income,'₹100.01');assert.equal(data.spent,'₹12.50');assert.equal(data.net,'₹87.51');assert.equal(data.transactions.length,2);assert.equal(data.categories[0]!.amount,12.5);assert.equal(data.budgetUsed,12.5);assert.equal(data.budgetMax,20);
    c.state.importText=JSON.stringify([{...input[1],id:'new'},input[0]]);await assert.rejects(financeAction('import',null,c,'import_records'),/atomically/);assert.equal((await financeProject(c)).updates[0]!.data.transactions.length,2);
  }finally{conn.closeSync();instance.closeSync();}
});
test('reference discovery follows bundled packages without a separate hard-coded registry',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'vak-reference-list-')),pool=new SandboxPoolManager(),registry=new AppRegistry({dataDir:dir,pool});
  try{assert.deepEqual(registry.listBuiltins().map(m=>m.id).sort(),['finance-workbench','market-terminal','news-desk','project-desk']);}finally{await registry.shutdown();await pool.shutdown();rmSync(dir,{recursive:true,force:true});}
});
