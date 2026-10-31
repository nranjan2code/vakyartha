import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { basicCatalog, SurfaceStore } from '@vak/core';
import { parseFeed, canonical } from '../sidecar/builtin-apps/news-desk/feed.ts';
import { handleAction as newsAction, refresh as newsRefresh, normalize as newsNormalize, surfaceFile as newsSurfaces } from '../sidecar/builtin-apps/news-desk/server.ts';
import { items, commits, repository, handleAction as projectAction, surfaceFile as projectSurfaces } from '../sidecar/builtin-apps/project-desk/server.ts';
import { paise, records, handleAction as financeAction, normalize as financeNormalize, surfaceFile as financeSurfaces } from '../sidecar/builtin-apps/finance-workbench/server.ts';
import { handleAction as marketAction, surfaceFile as marketSurfaces } from '../sidecar/builtin-apps/market-terminal/server.ts';
import { nseTool, nseHistory, feedTool, repoTool, memoryDatabase } from './support/app-fixtures.ts';
import { view as voiceView, handleAction as voiceAction, normalize as voiceNormalize } from '../sidecar/builtin-apps/voice-desk/server.ts';
import { AppRegistry } from '../sidecar/sandbox-pool/app-registry.ts';
import { SandboxPoolManager } from '../sidecar/sandbox-pool/pool-manager.ts';
import { fingerprint } from '../sidecar/sandbox-pool/package.ts';
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
const lintUpdates=(updates:any[])=>{for(const u of updates){const st=new SurfaceStore(basicCatalog);const d=st.render({surface:u.surface,title:u.surface,data:u.data[0].value,nodes:u.nodes});assert.deepEqual([...d,...st.lint(st.get(u.surface)!)].filter((x:any)=>x.severity!=='info'),[],u.surface);}};
const dataOf=(r:any,surface:string)=>r.updates.find((u:any)=>u.surface===surface).data[0].value;
const offline=async()=>{throw Error('Tool is not declared or available for this app');};
test('news refreshes feeds, keeps source times through failures and bookmarks from the same records',async()=>{
  const c:any={state:{},callTool:offline};
  let r:any=await newsAction('refresh',null,c,'refresh');lintUpdates(r.updates);
  assert.match(c.state.problem,/4 of 4 feeds failed.*Settings → Integrations/);assert.ok(r.updates[0].nodes.some((n:any)=>n.id==='news-empty'));
  c.state.feeds=[feed];c.callTool=feedTool;r=await newsAction('refresh',null,c,'refresh');lintUpdates(r.updates);
  assert.equal(c.state.problem,undefined);const original=c.state.articles[0];assert.equal(original.url,'https://example.org/feed/story');
  assert.deepEqual(dataOf(r,'headlines').byFeed,[{label:'Test feed',articles:1}]);
  r=await newsAction('save_article',{id:original.id},c,'save_article');lintUpdates(r.updates);assert.equal(dataOf(r,'saved').saved.length,1);
  c.callTool=offline;r=await newsRefresh(c);assert.equal(c.state.articles[0].retrievedAt,original.retrievedAt);assert.match(c.state.problem,/1 of 1/);assert.equal(dataOf(r,'saved').saved.length,1);
  await newsAction('/newFeed/url','http://insecure.example/feed',c);await assert.rejects(newsAction('add_feed',null,c,'add_feed'),/name and a category/);
  await newsAction('/newFeed/name','Ex',c);await newsAction('/newFeed/category','Tech',c);await assert.rejects(newsAction('add_feed',null,c,'add_feed'),/HTTPS/);
  await assert.rejects(newsAction('remove_feed',{id:feed.url},c,'remove_feed'),/at least one/);
  assert.equal(newsNormalize({feeds:JSON.stringify([feed]) as any}).feeds![0]!.url,feed.url);
});
test('repository records enforce source identity, charts come from the sample and lanes never write',async()=>{
  const row={number:1,title:'Review',state:'open',html_url:'https://github.com/owner/repo/issues/1',updated_at:'2026-10-28T10:00:00Z',labels:[],user:{login:'author'}};
  assert.equal(items([row,{...row,pull_request:{}}],'owner/repo').length,1);assert.throws(()=>items([row],'wrong/repo'));assert.throws(()=>repository('../repo'));assert.throws(()=>commits([{sha:'bad',html_url:'https://github.com/owner/repo/commit/bad'}],'owner/repo'));
  const c:any={state:{},callTool:repoTool};
  await projectAction('/repoDraft','owner/repo',c);let r:any=await projectAction('refresh',null,c,'refresh');lintUpdates(r.updates);
  assert.equal(c.state.issues.length,2);assert.deepEqual(dataOf(r,'triage').byState,[{label:'open',issues:1},{label:'closed',issues:1}]);assert.equal(dataOf(r,'activity').commitDays[0].commits,1);
  c.callTool=async()=>{throw Error('No external operation allowed');};
  r=await projectAction('/cards',[{id:row.html_url,column:'Watch'}],c);assert.equal(c.state.triage[row.html_url],'Watch');assert.equal(dataOf(r,'triage').cards[0].column,'Watch');
  await assert.rejects(projectAction('/cards',[{id:'https://github.com/x/y/issues/9',column:'Watch'}],c),/Invalid triage/);
  await projectAction('/repoDraft','another/repo',c);r=await projectAction('refresh',null,c,'refresh');lintUpdates(r.updates);assert.deepEqual(c.state.issues,[]);assert.deepEqual(c.state.triage,{});assert.match(c.state.problem,/3 of 3/);
  await projectAction('/repoDraft','not a repo',c);await assert.rejects(projectAction('refresh',null,c,'refresh'),/owner\/repository/);
});
test('finance preserves exact paise, imports CSV or JSON atomically and charts the same ledger',async()=>{
  assert.equal(paise('-12.50'),-1250);assert.equal(paise('0.01'),1);for(const v of [12.5,'1e3','NaN','1.234',''])assert.throws(()=>paise(v));
  const input=[{id:'income',date:'2026-10-01',description:'Synthetic inflow',category:'Income',amount:'100.01'},{id:'cost',date:'2026-10-02',description:'Synthetic expense',category:'Food',amount:'-12.50'},{id:'prior',date:'2026-09-30',description:'Prior window',category:'Other',amount:'-5.00'}];
  assert.equal(records(JSON.stringify(input)).length,3);assert.throws(()=>records(JSON.stringify([...input,input[0]])),/unique/);
  assert.deepEqual(records('id,date,description,category,amount\nx,2026-10-01,"Lunch, ""team""",Food,-1.5')[0],{id:'x',date:'2026-10-01',description:'Lunch, "team"',category:'Food',amount:'-1.5'});
  assert.throws(()=>records('id,date,amount\nx,2026-10-01,1'),/header/);
  const m=await memoryDatabase();const c:any={state:{importText:JSON.stringify(input),budget:'20.00'},database:m.database,now:()=>new Date('2026-10-31T10:00:00Z')};
  try{
    let r:any=await financeAction('import',null,c,'import_records');lintUpdates(r.updates);assert.equal(r.focusSurface,'overview');assert.equal(c.state.month,'2026-10');
    const o=dataOf(r,'overview');assert.deepEqual(o.totals.map((t:any)=>t.value),['₹100.01','₹12.50','₹87.51','2']);assert.equal(o.categories[0].amount,12.5);assert.equal(o.budgetUsed,12.5);assert.equal(o.budgetMax,20);assert.equal(o.running.at(-1).cumulative,87.51);assert.equal(o.monthly.length,2);
    assert.equal(dataOf(r,'ledger').transactions.length,2);
    c.state.importText=JSON.stringify([{...input[1],id:'new'},input[0]]);await assert.rejects(financeAction('import',null,c,'import_records'),/Already imported: income/);
    r=await financeAction('recalculate',null,c,'recalculate');assert.equal(dataOf(r,'ledger').transactions.length,2);
    r=await financeAction('/budget','12.',c);lintUpdates(r.updates);assert.ok(r.updates[0].nodes.some((n:any)=>n.id==='budget-hint'));
    r=await financeAction('/month','2026-09',c);lintUpdates(r.updates);assert.equal(dataOf(r,'ledger').transactions.length,1);
    await financeAction('ask_clear',null,c,'ask_clear');r=await financeAction('clear_ledger',null,c,'clear_ledger');lintUpdates(r.updates);assert.ok(r.updates[0].nodes.some((n:any)=>n.id==='fin-empty'));
    assert.deepEqual(financeNormalize({lastImport:'2026-10-01T00:00:00Z',lastCount:3} as any).lastImport,{at:'2026-10-01T00:00:00Z',count:3});
  }finally{m.close();}
});
test('market terminal validates NSE reads, stores history in DuckDB and derives every view from it',async()=>{
  const m=await memoryDatabase();const c:any={state:{watchlist:'RELIANCE,TCS'},database:m.database,callTool:offline};
  try{
    let r:any=await marketAction('refresh_market',null,c,'refresh_market');lintUpdates(r.updates);
    assert.match(c.state.problem,/5 of 5 reads failed.*Settings → Integrations/);assert.ok(r.updates[0].nodes.some((n:any)=>n.id==='market-empty'));assert.equal(c.state.receipts.length,5);
    c.callTool=nseTool;r=await marketAction('refresh_market',null,c,'refresh_market');lintUpdates(r.updates);assert.equal(c.state.problem,undefined);
    const market=dataOf(r,'market');assert.deepEqual(market.headline.map((h:any)=>h.label),['NIFTY 50','NIFTY BANK']);assert.equal(market.watch.length,2);assert.equal(market.moves[0].changePct,1.01);assert.equal(market.sectors[0].label,'NIFTY IT');
    r=await marketAction('open_instrument',{symbol:'TCS'},c,'open_instrument');lintUpdates(r.updates);assert.equal(r.focusSurface,'instrument');
    const inst=dataOf(r,'instrument'),source=nseHistory('TCS');
    assert.deepEqual(inst.history.map((x:any)=>[x.date,x.close]),source.data.map(x=>[x.date,x.close]));
    assert.equal(inst.stats.priceReturn,`+${((source.data.at(-1)!.close/source.data[0]!.close-1)*100).toFixed(2)}%`);assert.equal(inst.sma.length,3);assert.equal(inst.returns.length,21);
    c.state.watchDraft='RELIANCE, bad sym!';await assert.rejects(marketAction('refresh_market',null,c,'refresh_market'),/not an NSE equity symbol/);
    await assert.rejects(marketAction('open_instrument',{symbol:'WIPRO'},c,'open_instrument'),/no longer on the watchlist/);
    c.callTool=offline;r=await marketAction('fetch_instrument',null,c,'fetch_instrument');assert.equal(dataOf(r,'instrument').history.length,22,'a failed read keeps the saved history');
  }finally{m.close();}
});
test('each modernized app ships its empty view as surface.json',()=>{
  for(const [id,file] of [['market-terminal',marketSurfaces()],['news-desk',newsSurfaces()],['project-desk',projectSurfaces()],['finance-workbench',financeSurfaces()]] as const)
    assert.deepEqual(JSON.parse(readFileSync(`sidecar/builtin-apps/${id}/surface.json`,'utf8')),file,`${id}: run node scripts/app-surfaces.ts`);
});
test('reference discovery follows bundled packages without a separate hard-coded registry',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'vak-reference-list-')),pool=new SandboxPoolManager(),registry=new AppRegistry({dataDir:dir,pool});
  try{assert.deepEqual(registry.listBuiltins().map(m=>m.id).sort(),['finance-workbench','market-terminal','news-desk','project-desk','voice-desk']);}finally{await registry.shutdown();await pool.shutdown();rmSync(dir,{recursive:true,force:true});}
});
test('voice-desk captures spoken or typed notes, keeps a checklist and speaks from the same data',async()=>{
  const lint=(updates:any[])=>{for(const u of updates){const st=new SurfaceStore(basicCatalog);const d=st.render({surface:u.surface,title:u.surface,data:u.data[0].value,nodes:u.nodes});assert.deepEqual([...d,...st.lint(st.get(u.surface)!)].filter((x:any)=>x.severity!=='info'),[],u.surface);}};
  lint(voiceView({}));
  const c:any={state:{},now:()=>new Date('2026-10-31T10:00:00Z')};
  await assert.rejects(voiceAction('save_capture',null,c,'save_capture'),/Speak or type/);
  await voiceAction('/capture','Call the bank about the loan.\nDraft the Q3 plan',c);
  let r:any=await voiceAction('save_capture',null,c,'save_capture');
  assert.equal(c.state.notes.length,1);
  assert.equal(c.state.capture,'');
  assert.equal(r.focusSurface,'desk');
  const desk=()=>r.updates.find((u:any)=>u.surface==='desk').data[0].value;
  const tasks=()=>r.updates.find((u:any)=>u.surface==='actions').data[0].value;
  assert.equal(desk().note.body,'Call the bank about the loan.\nDraft the Q3 plan');
  // Fields save as they change; tags are cleaned; the title falls back to the first line.
  await voiceAction('/note/tags','#Work, ideas work',c);
  assert.deepEqual(c.state.notes[0].tags,['work','ideas']);
  await voiceAction('/newAction','Call the bank',c);
  r=await voiceAction('add_action',null,c,'add_action');
  lint(r.updates);
  assert.equal(tasks().open.length,1);
  assert.match(tasks().spoken.actions,/1 open action item\. Call the bank about the loan: Call the bank\./);
  assert.match(desk().spoken.note,/Open action items: Call the bank\./);
  // Ticking an item in the action list ticks it in its note.
  r=await voiceAction('/open/0/done',true,c);
  assert.equal(c.state.notes[0].actions[0].done,true);
  assert.equal(tasks().open.length,0);
  // A second note, switching, and a two-step delete.
  await voiceAction('/capture','Second thought',c);
  await voiceAction('save_capture',null,c,'save_capture');
  assert.equal(c.state.openId,c.state.notes[0].id);
  await voiceAction('open_note',{id:c.state.notes[1].id},c,'open_note');
  r=await voiceAction('ask_delete',null,c,'ask_delete');
  lint(r.updates);
  assert.ok(r.updates[0].nodes.some((n:any)=>n.id==='delete-yes'));
  await voiceAction('delete_note',null,c,'delete_note');
  assert.equal(c.state.notes.length,1);
  // Voice is declared, never performed here: buttons name host voice actions.
  const nodes=voiceView(c.state)[0]!.nodes;
  assert.ok(nodes.some((n:any)=>n.props?.action==='voice.dictate'&&n.props.payload.into==='capture-text'));
  assert.ok(nodes.some((n:any)=>n.props?.action==='voice.read'&&n.props.payload.text==='/spoken/note'));
  // Untrusted input stays inert text; unknown inputs fail.
  await voiceAction('/capture','$(rm -rf /) ; ../../etc/passwd',c);
  await voiceAction('save_capture',null,c,'save_capture');
  assert.equal(c.state.notes[0].body,'$(rm -rf /) ; ../../etc/passwd');
  await assert.rejects(voiceAction('bad_action',null,c,'bad_action'),/Unknown Voice Desk action/);
  await assert.rejects(voiceAction('/state/notes',[],c),/Unknown Voice Desk field/);
  await assert.rejects(voiceAction('open_note',{id:'missing'},c,'open_note'),/no longer exists/);
});

test('voice-desk surface.json is the empty view, and older note shapes load',()=>{
  const shipped=JSON.parse(readFileSync('sidecar/builtin-apps/voice-desk/surface.json','utf8'));
  assert.deepEqual(shipped.map((s:any)=>({id:s.id,data:s.data,nodes:s.nodes})),voiceView({}).map(u=>({id:u.surface,data:u.data[0]!.value,nodes:u.nodes})));
  const s=voiceNormalize({notes:[{id:'n1',title:'Old',content:'Body',tags:'#a #b',actions:[{id:'a1',task:'Do it',status:'Done'}]}] as any});
  assert.deepEqual(s.notes![0]!.actions,[{id:'a1',text:'Do it',done:true}]);
  assert.equal(s.notes![0]!.body,'Body');
  assert.deepEqual(s.notes![0]!.tags,['a','b']);
});

test('app registry detects updates and updates built-in app while preserving durable state', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vak-app-update-'));
  const pool = new SandboxPoolManager();
  const registry = new AppRegistry({ dataDir: dir, pool });
  try {
    const app = await registry.installBuiltin('voice-desk');
    assert.equal(app.manifest.id, 'voice-desk');

    let list = registry.listApps();
    let vd = list.find(a => a.id === 'voice-desk');
    assert.ok(vd);
    assert.equal(vd.isBuiltin, true);
    assert.equal(vd.updateAvailable, false);

    // Simulate an older version installed
    const recordFile = path.join(dir, 'app-state', 'voice-desk.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8'));
    record.published.manifest.version = '0.0.1';
    record.fingerprint = fingerprint(record.published);
    record.state = { notes: [{ id: 'custom-note', title: 'My Custom Note', tags: ['personal'], body: 'Important ideas', actions: [], created: '2026-10-30T00:00:00Z', updated: '2026-10-30T00:00:00Z' }] };
    writeFileSync(recordFile, JSON.stringify(record));

    registry.reloadApps();

    // Now listApps should detect updateAvailable = true
    list = registry.listApps();
    vd = list.find(a => a.id === 'voice-desk');
    assert.ok(vd);
    assert.equal(vd.updateAvailable, true);

    // Update app to latest
    const { baseFingerprint, baseRevision, candidateFingerprint } = registry.previewAppUpdate('voice-desk');
    const updated = await registry.updateAppToLatest('voice-desk', { baseFingerprint, baseRevision, candidateFingerprint });
    assert.equal(updated.manifest.id, 'voice-desk');
    assert.equal((updated.state as any).notes[0].title, 'My Custom Note'); // Preserves user durable state!

    // After update, updateAvailable is false
    list = registry.listApps();
    vd = list.find(a => a.id === 'voice-desk');
    assert.equal(vd?.updateAvailable, false);
  } finally {
    await registry.shutdown();
    await pool.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
