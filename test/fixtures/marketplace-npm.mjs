// Deterministic package installation stand-in. Never downloads or runs npm.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2), target = args[args.indexOf("--prefix") + 1];
writeFileSync(path.join(target, "install-args.json"), JSON.stringify(args));
const spec = args[1], pkg = spec.slice(0, spec.lastIndexOf("@"));
const dir = path.join(target, "node_modules", pkg, "dist");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "index.mjs"), `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!('id' in m))return;
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 m.method==='tools/list'?{tools:[{name:'inspect',inputSchema:{type:'object'},annotations:{readOnlyHint:true,openWorldHint:false}}]}:
 {content:[{type:'text',text:JSON.stringify({declared:Boolean(process.env.FIXTURE_TOKEN),leaked:Boolean(process.env.MARKETPLACE_PRIVATE_TEST),home:process.env.HOME})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
