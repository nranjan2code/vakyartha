import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startAppServer} from '../sidecar/server.ts';
test('app connection settings disclose effective policy without granting it',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vak-connections-')),app=await startAppServer({dataDir:dir,access:'open'});
 const api=async(route:string,method='GET',value?:unknown)=>{const res=await app.request(new Request(`http://localhost${route}`,{method,headers:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)}));assert.ok(res.ok);return res.json() as Promise<any>;};
 try{await api('/api/integrations/web/install','POST',{});await api('/api/integrations/web','PUT',{enabled:true});
 let rows=await api('/api/apps/news-desk/connections');assert.equal(rows.length,1);assert.equal(rows[0].policy,'ask');assert.equal(rows[0].ready,false);assert.equal(rows[0].integrationId,'web');assert.match(rows[0].reason,/Ask/);
 assert.equal((await api('/api/apps/news-desk')).revision,1);assert.deepEqual((await api('/api/apps/finance-workbench/connections')),[]);
 await api('/api/integrations/web','PUT',{policies:{fetch_page:'allow'}});rows=await api('/api/apps/news-desk/connections');assert.equal(rows[0].ready,true);
 await api('/api/integrations/web','PUT',{policies:{fetch_page:'off'}});rows=await api('/api/apps/news-desk/connections');assert.equal(rows[0].ready,false);assert.equal(rows[0].policy,'off');
 }finally{await app.shutdown();rmSync(dir,{recursive:true,force:true});}
});
