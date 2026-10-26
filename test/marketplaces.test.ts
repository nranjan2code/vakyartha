import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Marketplaces, normalizeListings } from "../sidecar/marketplaces.ts";
import { createIntegrations } from "../sidecar/integrations.ts";
import { fileSecrets } from "../sidecar/settings.ts";
import { startAppServer } from "../sidecar/server.ts";

const remote = { name: "org.example/docs", title: "Example Docs", version: "1.0.0", description: "Search documentation", repository: { url: "https://github.com/example/docs" }, remotes: [{ type: "streamable-http", url: "https://mcp.example.org/mcp", headers: [{ name: "Authorization", value: "Bearer {TOKEN}", isRequired: true }] }] };
const npm = { name: "org.example/local", title: "Local fixture", version: "1.2.3", repository: { url: "https://github.com/example/local" }, packages: [{ registryType: "npm", identifier: "@fixture/local", version: "1.2.3", transport: { type: "stdio" }, environmentVariables: [{ name: "FIXTURE_TOKEN", isRequired: true, isSecret: true }] }] };
const registry = (...servers: unknown[]) => ({ servers: servers.map(server => ({ server, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } })), metadata: { count: servers.length } });
function setup(fetcher: typeof fetch) {
  const dir = mkdtempSync(path.join(tmpdir(), "vak-marketplaces-")); mkdirSync(path.join(dir,"logs"));
  const market = new Marketplaces(dir, [], fetcher);
  const deps = { dataDir: dir, secrets: fileSecrets(path.join(dir, "settings.env")), npm: new URL("./fixtures/marketplace-npm.mjs", import.meta.url).pathname, approve: async () => "deny" as const };
  const list = createIntegrations(deps, undefined, market.catalog);
  return { dir, market, list, deps };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const fetchRegistry = (data: unknown): typeof fetch => async () => json(data);

test("all discovery formats normalize, deduplicate versions and preserve unsupported paths", () => {
  const rows = normalizeListings("mcp", registry(remote, remote, npm));
  assert.equal(rows.length, 2); assert.equal(rows[0]!.options[0]!.kind,"http");
  assert.equal(rows[1]!.options[0]!.kind,"npm");
  const docker = normalizeListings("docker", { registry: {
    hosted: { title:"Hosted", remote:{transport_type:"streamable-http",url:"https://mcp.example.org/mcp",headers:{"X-Api-Key":"${TOKEN}"}},metadata:{owner:"example"} },
    local: { title:"Container", image:"mcp/example@sha256:abc" },
  } });
  assert.equal(docker[0]!.options[0]!.fields[0]!.header!.format,"{value}");
  assert.match(docker[1]!.options[0]!.blocked!,/runtime/);
  assert.throws(()=>normalizeListings("github", {error:"bad"}),/unsupported response/);
});

test("catalog metadata cannot inject endpoints, launch arguments, routing headers or loader environment", () => {
  for (const url of ["http://mcp.example.org", "https://127.0.0.1/mcp", "https://[::1]/mcp", "https://service.internal/mcp", "https://user:pass@mcp.example.org/mcp", "https://mcp.example.org/?token=secret", "https://{tenant}.example.org/mcp"]) {
    const r = normalizeListings("mcp", registry({...remote, remotes:[{type:"streamable-http",url}]}));
    assert.ok(r[0]!.options[0]!.blocked, url);
  }
  for(const name of ["Host","Cookie","Content-Length","Proxy-Authorization","X-Test\r\nInjected"]) {
    assert.ok(normalizeListings("mcp", registry({...remote,remotes:[{type:"streamable-http",url:remote.remotes[0]!.url,headers:[{name}]}]}))[0]!.options[0]!.blocked);
  }
  for(const env of ["PATH","NODE_OPTIONS","DYLD_INSERT_LIBRARIES"]) {
    const p = {...npm.packages[0],environmentVariables:[{name:env}]};
    assert.ok(normalizeListings("mcp",registry({...npm,packages:[p]}))[0]!.options[0]!.blocked);
  }
  const p = {...npm.packages[0],runtimeArguments:[{value:"--eval"}]};
  assert.ok(normalizeListings("mcp",registry({...npm,packages:[p]}))[0]!.options[0]!.blocked);
});

test("discovery uses fixed origins, no credentials, cursor encoding, cache and coalesced requests", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (u, init) => { calls++; const url=new URL(String(u)); assert.equal(url.origin,"https://api.mcp.github.com"); assert.equal(url.searchParams.get("cursor"),"https://evil.example/?a=b"); assert.equal(init?.redirect,"error"); assert.deepEqual(init?.headers,{accept:"application/json"}); return json(registry(remote)); };
  const { dir, market } = setup(fetcher);
  try {
    const a = await Promise.all([market.search("github","docs","https://evil.example/?a=b"),market.search("github","docs","https://evil.example/?a=b")]);
    assert.equal(calls,1); assert.deepEqual(a[0],a[1]);
    const restarted=new Marketplaces(dir,[],async()=>{throw new Error("must use cache")});
    assert.equal((await restarted.search("github","docs","https://evil.example/?a=b")).items.length,1);
    await assert.rejects(market.search("bad" as "mcp"),/Unknown marketplace/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("local package import delegates install, secret handling, tools, denial, restart and removal to the lifecycle", async () => {
  const fetcher: typeof fetch = async url => String(url).startsWith("https://registry.npmjs.org/") ? json({time:{"1.2.3":"2025-01-01T00:00:00Z"},versions:{"1.2.3":{name:"@fixture/local",version:"1.2.3",bin:{fixture:"dist/index.mjs"},dependencies:{},scripts:{postinstall:"never runs"}}}}) : json(registry(npm));
  const {dir,market,list,deps}=setup(fetcher);
  process.env.MARKETPLACE_PRIVATE_TEST="private-test-value";
  try {
    const p=await market.search("mcp"), item=p.items[0]!;
    const review=await market.review("mcp","","",item.key,item.options[0]!.key);
    assert.equal(review.blocked,undefined); assert.equal(review.bin,"dist/index.mjs");
    assert.throws(()=>market.add(review.fingerprint,false),/acknowledge/);
    const id=market.add(review.fingerprint,true); assert.equal(market.add(review.fingerprint,true),id);
    assert.equal(list.view()[0]!.status,"not-installed"); assert.equal(list.view()[0]!.enabled,false);
    await list.install(id);
    const args=JSON.parse(readFileSync(path.join(dir,"integrations",id,"pkg/install-args.json"),"utf8"));
    assert.ok(args.includes("--ignore-scripts")); assert.ok(args.includes("@fixture/local@1.2.3")); assert.ok(args.some((a:string)=>a.startsWith("--before=")));
    await list.configure(id,{secrets:{credential0:"fixture-token"},enabled:true});
    assert.equal(list.view()[0]!.status,"ready"); assert.equal(list.view()[0]!.tools[0]!.policy,"ask");
    const tools=await list.toolsFor("test"), denied=await tools[0]!.execute({},{});
    assert.match(JSON.stringify(denied),/denied|declined/i);
    const result=await list.test(id,"inspect",{});
    assert.match(result.text,/"declared":true/); assert.match(result.text,/"leaked":false/);
    assert.doesNotMatch(JSON.stringify(list.view()),/fixture-token|private-test-value/);
    await list.configure(id,{enabled:false}); assert.deepEqual(await list.toolsFor("test"),[]);
    await list.stopAll();
    const again=new Marketplaces(dir,[],fetcher), restarted=createIntegrations(deps,undefined,again.catalog);
    assert.equal(restarted.view()[0]!.enabled,false); assert.equal(restarted.view()[0]!.installed,true);
    assert.equal(again.provenance(id)!.source,"MCP Registry");
    await restarted.uninstall(id); again.remove(id);
    assert.equal(restarted.view().length,0); assert.equal(new Marketplaces(dir,[],fetcher).catalog.length,0);
    assert.equal(deps.secrets.get(`INTEGRATION_${id.replace(/[^a-z0-9]/gi,"_").toUpperCase()}_CREDENTIAL0`),undefined);
  } finally { delete process.env.MARKETPLACE_PRIVATE_TEST; await list.stopAll(); rmSync(dir,{recursive:true,force:true}); }
});

test("too-new packages, ranges, ambiguous bins and unsupported options cannot be added", async () => {
  for(const manifest of [
    {time:{"1.2.3":new Date().toISOString()},versions:{"1.2.3":{name:"@fixture/local",version:"1.2.3",bin:"dist/index.mjs"}}},
    {time:{"1.2.3":"2025-01-01"},versions:{"1.2.3":{name:"@fixture/local",version:"1.2.3",bin:{a:"a.js",b:"b.js"}}}},
  ]) {
    const {dir,market}=setup(async url=>json(String(url).includes("registry.npmjs.org")?manifest:registry(npm)));
    try { const p=await market.search("mcp"),i=p.items[0]!,r=await market.review("mcp","","",i.key,i.options[0]!.key); assert.ok(r.blocked);assert.throws(()=>market.add(r.fingerprint,true)); }
    finally {rmSync(dir,{recursive:true,force:true});}
  }
  assert.ok(normalizeListings("mcp",registry({...npm,packages:[{...npm.packages[0],version:"latest"}]}))[0]!.options[0]!.blocked);
});

test("external catalog routes require the window token and import without activation", async () => {
  const dir=mkdtempSync(path.join(tmpdir(),"vak-marketplace-http-"));
  const app=await startAppServer({dataDir:dir,access:"token",marketplaceFetch:fetchRegistry(registry(remote))});
  const headers={authorization:`Bearer ${app.token}`,"content-type":"application/json"};
  try {
    assert.equal((await fetch(app.url+"/api/marketplaces/mcp")).status,401);
    const page=await(await fetch(app.url+"/api/marketplaces/github",{headers})).json();
    const r=await(await fetch(app.url+"/api/marketplaces/github/review",{method:"POST",headers,body:JSON.stringify({key:page.items[0].key,option:"remote-0"})})).json();
    const result=await(await fetch(app.url+"/api/marketplaces/github/add",{method:"POST",headers,body:JSON.stringify({fingerprint:r.fingerprint,acknowledged:true})})).json();
    const list=await(await fetch(app.url+"/api/integrations",{headers})).json(), i=list.find((x:any)=>x.entry.id===result.id);
    assert.equal(i.enabled,false); assert.equal(i.status,"needs-setup"); assert.equal(i.entry.trust,"custom"); assert.equal(i.provenance.source,"GitHub");
    const removed=await fetch(app.url+`/api/integrations/${result.id}/uninstall`,{method:"POST",headers}); assert.equal(removed.status,200);
    assert.equal((await(await fetch(app.url+"/api/integrations",{headers})).json()).some((x:any)=>x.entry.id===result.id),false);
  } finally {await app.shutdown();rmSync(dir,{recursive:true,force:true});}
});

test("hosted imports retain headers and approvals through failed credentials, reconnect and restart", async () => {
  const {dir,market,list,deps}=setup(fetchRegistry(registry(remote)));
  const originalFetch=globalThis.fetch;
  let requests=0, handshakes=0;
  globalThis.fetch=async (_url, init) => {
    requests++;
    const headers=init!.headers as Record<string,string>;
    if(headers.Authorization!=="Bearer valid-fixture")return new Response("",{status:401});
    const msg=JSON.parse(String(init?.body));
    if(!("id" in msg))return new Response(null,{status:202});
    if(msg.method==="initialize")handshakes++;
    return json({jsonrpc:"2.0",id:msg.id,result:msg.method==="initialize"?{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:msg.method==="tools/list"?{tools:[{name:"lookup",inputSchema:{type:"object"},annotations:{readOnlyHint:true,openWorldHint:false}}]}:{content:[{type:"text",text:"Fixture result"}]}});
  };
  try {
    const p=await market.search("mcp"),i=p.items[0]!,r=await market.review("mcp","","",i.key,i.options[0]!.key);
    const id=market.add(r.fingerprint,true);assert.equal(requests,0);
    await list.configure(id,{enabled:true,secrets:{credential0:"wrong-fixture"}});
    assert.equal(list.view()[0]!.status,"error");assert.match(list.view()[0]!.error!,/401/);
    await list.configure(id,{secrets:{credential0:"valid-fixture"}});
    assert.equal(list.view()[0]!.status,"ready");assert.equal(list.view()[0]!.tools[0]!.policy,"ask");
    const count=requests;await (await list.toolsFor("test"))[0]!.execute({},{});assert.equal(requests,count,"denied tool must never reach remote");
    assert.equal((await list.test(id,"lookup",{})).text,"Fixture result");
    await list.configure(id,{enabled:false});assert.deepEqual(await list.toolsFor("test"),[]);
    await list.configure(id,{enabled:true});assert.equal(handshakes,2);
    await list.stopAll();
    const again=new Marketplaces(dir,[],fetchRegistry(registry(remote))),restarted=createIntegrations(deps,undefined,again.catalog);
    await restarted.refresh(id);assert.equal(restarted.view()[0]!.status,"ready");assert.equal(handshakes,3);
    assert.doesNotMatch(JSON.stringify(restarted.view()),/valid-fixture/);
    await restarted.uninstall(id);again.remove(id);assert.equal(restarted.view().length,0);
  } finally {globalThis.fetch=originalFetch;await list.stopAll();rmSync(dir,{recursive:true,force:true});}
});


test("expired metadata remains browseable during outages but cannot authorize imports", async () => {
  const {dir,market}=setup(fetchRegistry(registry(remote)));
  try {
    await market.search("mcp");
    const file=path.join(dir,"catalog-cache",readdirSync(path.join(dir,"catalog-cache"))[0]!);
    const saved=JSON.parse(readFileSync(file,"utf8"));saved.fetchedAt="2020-01-01T00:00:00Z";writeFileSync(file,JSON.stringify(saved));
    const offline=new Marketplaces(dir,[],async()=>{throw new Error("offline")});
    const p=await offline.search("mcp");assert.equal(p.stale,true);assert.equal(p.items.length,1);
    await assert.rejects(offline.review("mcp","","",p.items[0]!.key,"remote-0"),/Reconnect/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("damaged imported definitions preserve normal catalog availability and cannot be overwritten", async () => {
  const {dir}=setup(fetchRegistry(registry(remote)));
  try {
    writeFileSync(path.join(dir,"external-catalog.json"),"broken-json");
    const market=new Marketplaces(dir,[],fetchRegistry(registry(remote)));
    await assert.rejects(market.search("mcp"),/Restore external-catalog/);
    assert.throws(()=>market.add("invalid",true),/Restore external-catalog/);
    assert.equal(readFileSync(path.join(dir,"external-catalog.json"),"utf8"),"broken-json");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
