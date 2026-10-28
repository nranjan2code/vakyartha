import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppRegistry } from '../sidecar/sandbox-pool/app-registry.ts';
import { SandboxPoolManager } from '../sidecar/sandbox-pool/pool-manager.ts';
import { databaseSnapshot, MAX_DATABASE_BYTES } from '../sidecar/sandbox-pool/database.ts';
import { AppToolResults } from '../sidecar/app-tool-results.ts';

test('machine source receipts retain full JSON while refusing errors, absent receipts and oversize',async()=>{
  const bridge=new AppToolResults(), text=JSON.stringify({rows:'a'.repeat(20000)});
  assert.equal(await bridge.execute(async session=>{bridge.observe(session,{text});return 'clipped';}),text);
  await assert.rejects(bridge.execute(async()=> 'denied'),/receipt/);
  await assert.rejects(bridge.execute(async session=>bridge.observe(session,{text:'failure',isError:true})),/error/);
  await assert.rejects(bridge.execute(async session=>bridge.observe(session,{text:'a'.repeat(256*1024)})),/bounds/);
  const replies=await Promise.all([1,2].map(i=>bridge.execute(async session=>{await new Promise(r=>setTimeout(r,5));bridge.observe(session,{text:String(i)});})));assert.deepEqual(replies,['1','2']);
});
test('database snapshot rejects malformed and oversized data',()=>{
  assert.equal(databaseSnapshot(undefined),undefined);
  for(const value of ['',{},'a===','YQ','YQ=','!!!!',Buffer.alloc(MAX_DATABASE_BYTES+1).toString('base64')])assert.throws(()=>databaseSnapshot(value));
});
test('DuckDB persists across sandbox invocations and restart; failed SQL and file reads cannot commit', {skip:process.platform!=='darwin'}, async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'vak-db-test-'));
  const pool=new SandboxPoolManager({sandboxBin:path.resolve('../sandbox/target/debug/vaksb')});
  const registry=new AppRegistry({dataDir:dir,pool});
  const manifest={id:'sql-app',name:'SQL app',version:'1.0.0',entrypoints:{backend:'main.ts'},entitlements:{storage:{duckdb:true}}};
  const dispatch = (id: string, value: unknown) => registry.dispatchAction('sql-app', id, value, undefined, registry.getApp('sql-app')!.revision);
  const source=`export async function handleAction(id,value,c){await c.database.run('CREATE TABLE IF NOT EXISTS data(n INTEGER)');
    if(id==='insert')await c.database.run('INSERT INTO data VALUES (?)',[value]);
    if(id==='fail'){await c.database.run('INSERT INTO data VALUES(999)');throw Error('no commit')}
    if(id==='invalid-focus'){await c.database.run('INSERT INTO data VALUES(999)');return {focusSurface:'missing'}}
    if(id==='escape')await c.database.query("SELECT * FROM read_csv('/etc/passwd')");
    if(id==='extensions')await c.database.run('INSTALL httpfs');
    if(id==='large')await c.database.query('SELECT * FROM range(11000)');
    return {rows:await c.database.query('SELECT sum(n)::INTEGER total FROM data')};}`;
  try{
    await registry.init();await registry.installApp(manifest,{'main.ts':source});
    assert.equal((await dispatch('insert',7)).rows[0].total,7);
    registry.reloadApps();
    assert.equal((await dispatch('insert',5)).rows[0].total,12);
    await assert.rejects(dispatch('fail',null),/no commit/);
    assert.equal((await dispatch('read',null)).rows[0].total,12);
    await assert.rejects(dispatch('invalid-focus',null),/Unknown app focus surface/);
    assert.equal((await dispatch('read',null)).rows[0].total,12);
    await assert.rejects(dispatch('escape',null),/disabled|permission|external/i);
    await assert.rejects(dispatch('extensions',null),/disabled|permission|external/i);
    await assert.rejects(dispatch('large',null),/bounds/);
    assert.equal((await dispatch('read',null)).rows[0].total,12);
  }finally{await registry.shutdown();await pool.shutdown();rmSync(dir,{recursive:true,force:true});}
});
