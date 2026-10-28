import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { basicCatalog, SurfaceStore } from '@vak/core';
import { createAppScaffold, APP_DOCUMENTS } from '../shared/app-scaffold.ts';
import { parseAppManifest } from '../shared/app-manifest.ts';
import { Skills } from '../sidecar/skills.ts';
import { SandboxPoolManager } from '../sidecar/sandbox-pool/pool-manager.ts';
import { AppRegistry } from '../sidecar/sandbox-pool/app-registry.ts';

test('Studio starter includes coherent in-package docs and an honest executable surface',()=>{
  const {manifest,files}=createAppScaffold('My New App');assert.equal(parseAppManifest(manifest).id,'my-new-app');
  for(const name of APP_DOCUMENTS){assert.ok(files[name]?.trim());assert.doesNotMatch(files[name]!,/TODO|TBD/);}
  assert.deepEqual(manifest.triggers,[]);assert.deepEqual(manifest.entitlements.mcpTools,[]);
  const surface=JSON.parse(files['surface.json']!);assert.deepEqual(new SurfaceStore(basicCatalog).render({surface:surface.id,data:surface.data,nodes:surface.nodes}),[]);
  assert.equal(surface.data.count,0);assert.doesNotMatch(files['surface.json']!,/Sandbox Security|Worker Process/);
});
test('app authoring/maintenance templates load through the real enabled skill mechanism',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'vak-app-method-'));
  try{
    const skills=new Skills(dir),[use,read]=skills.tools();
    await use!.execute({names:['app-authoring','app-maintainer','app-debugger']},{});
    const template=String(await read!.execute({skill:'app-authoring',path:'references/package-template.md'},{}));
    for(const name of APP_DOCUMENTS)assert.ok(template.includes(name));
    assert.match(String(await read!.execute({skill:'app-maintainer',path:'references/change-checklist.md'},{})),/Schema|schema/);
    for(const name of ['app-authoring','app-maintainer','app-operator','app-admin','app-debugger']){
      const body=skills.view().find(s=>s.name===name)!.body;
      for(const doc of APP_DOCUMENTS)assert.ok(body.includes(doc),`${name} lacks ${doc}`);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('documented Studio starter publishes and persists actual sandbox counter behavior', {skip:process.platform!=='darwin'},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'vak-starter-')),pool=new SandboxPoolManager({sandboxBin:path.resolve('../sandbox/target/debug/vaksb')}),apps=new AppRegistry({dataDir:dir,pool});
  try{await apps.init();const {manifest,files}=createAppScaffold('method-check');await apps.installApp(manifest,files);
    for(const value of [1,2]){const result=await apps.dispatchAction(manifest.id,'increment',null,'increment',apps.getApp(manifest.id)!.revision);assert.equal(result.surfaces['method-check-main'].data.count,value);}
    apps.reloadApps();assert.equal(apps.getApp(manifest.id)!.state.count,2);
  }finally{await apps.shutdown();await pool.shutdown();rmSync(dir,{recursive:true,force:true});}
});
