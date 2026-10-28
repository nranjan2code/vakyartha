(async()=>{
 const ipc=window.__TAURI_INTERNALS__;
 const request=(path,method='GET',value)=>new Promise((resolve,reject)=>{
  const id=crypto.randomUUID();let parts=[],status=0;
  const callback=ipc.transformCallback(raw=>{
   if(!raw.message)return;
   const f=raw.message;
   if(f.type==='headers')status=f.status;
   else if(f.type==='data'){parts.push(atob(f.data));void ipc.invoke('engine_ack',{id});}
   else if(f.type==='error')reject(Error(f.message));
   else if(f.type==='end'){ipc.unregisterCallback(callback);const text=parts.join('');try{resolve({status,data:text?JSON.parse(text):null});}catch(e){reject(e);}}
  });
  void ipc.invoke('engine_request',{id,path,method,headers:value?{'content-type':'application/json'}:{},...(value?{body:JSON.stringify(value)}:{}),channel:`__CHANNEL__:${callback}`}).catch(reject);
 });
 const check=(v,m)=>{if(!v)throw Error(m)};
 const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('native UI did not settle')};
 try{
  const backend=await ipc.invoke('backend');check(backend.url==='vak://localhost','unexpected backend');
  const info=await request('/api/info');check(info.status===200,'private info failed');
  const projected=await request('/api/project','POST',{session:'ipc-check',args:{surface:'ipc-card',title:'Private transport check',nodes:[{id:'root',type:'card',props:{title:'Private transport check',body:'Ready'}}]}});
  check(projected.status===200&&projected.data.diagnostics.length===0,'canonical projection failed');
  window.dispatchEvent(new CustomEvent('vak:media-chat',{detail:'ipc-check'}));
  await wait(()=>document.querySelector('vak-surface')?.shadowRoot?.textContent.includes('Ready'));
  document.getElementById('open-settings').click();
  await wait(()=>document.querySelector('#settings-nav-list button'));
  [...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='FinOps').click();
  await wait(()=>document.querySelector('.finops'));
  check(document.querySelector('.finops').textContent.includes('model rates configured'),'finops IPC failed');
  const timings=[];
  for(let i=0;i<20;i++){const start=performance.now();check((await request('/api/info')).status===200,'repeated IPC failed');timings.push(performance.now()-start);}
  const wav=new Uint8Array(1024*1024+44),view=new DataView(wav.buffer);
  const text=(offset,value)=>{for(let i=0;i<value.length;i++)wav[offset+i]=value.charCodeAt(i)};
  text(0,'RIFF');view.setUint32(4,wav.length-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,wav.length-44,true);
  const pieces=[];for(let offset=0;offset<wav.length;offset+=8192)pieces.push(String.fromCharCode(...wav.subarray(offset,offset+8192)));
  const uploadStart=performance.now();const attached=await request('/api/attachments?session=ipc-check','POST',{type:'audio/wav',data:btoa(pieces.join(''))});check(attached.status===200,'binary attachment over IPC failed');
  const measurements={infoMedianMs:timings.sort((a,b)=>a-b)[10],uploadBytes:wav.length,uploadMs:performance.now()-uploadStart};
  await request('/api/client-log','POST',{level:'probe',message:'NATIVE_PRIVATE_PASS '+JSON.stringify({url:backend.url,canonicalProjection:true,rendered:true,finops:true,measurements})});
 }catch(error){await request('/api/client-log','POST',{level:'probe',message:'NATIVE_PRIVATE_FAIL '+error.message}).catch(()=>{});}
})();
