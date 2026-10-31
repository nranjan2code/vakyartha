import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { SandboxPoolManager } from "../sidecar/sandbox-pool/pool-manager.ts";
import { helperRun } from "./support/sandbox-run.ts";

export const helper = process.env.VAK_TEST_SANDBOX_BIN ?? path.resolve("../sandbox/target/debug/vaksb");
const native = process.platform === "darwin";
const invocation = (source: string, value: unknown = 42) => ({ backend: "main.ts", files: { "main.ts": source }, state: {}, surfaces: {}, controlId: "value", value });

test("app runtime fails closed with a missing helper or outside the desktop app", async () => {
  const p = new SandboxPoolManager({ run: helperRun("/nonexistent/vaksb") });
  await assert.rejects(p.execute("missing-app", invocation("export function handleAction(){return {ok:true}}")), /helper|macOS/);
  const web = new SandboxPoolManager({});
  await assert.rejects(web.execute("web-app", invocation("")), /desktop app/);
  await p.shutdown(); await web.shutdown();
});

test("real helper executes declared async entrypoint with no ambient environment or outside authority", { skip: !native }, async () => {
  assert.ok(existsSync(helper), "Build the existing sandbox helper before native acceptance");
  const tmp = mkdtempSync(path.join(tmpdir(), "vak-app-canary-"));
  const p = new SandboxPoolManager({ run: helperRun(helper) });
  writeFileSync(path.join(tmp, "outside"), "canary");
  const listener = createServer((_req, res) => res.end("reachable"));
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  process.env.VAK_REVIEW_SENTINEL = "synthetic-only";
  try {
    const result = await p.execute("contained-app", invocation(`import {readFileSync,writeFileSync} from 'node:fs';
      export async function handleAction(id,value,ctx){
        let readDenied=false,writeDenied=false,networkDenied=false;
        try{readFileSync(${JSON.stringify(path.join(tmp, "outside"))})}catch{readDenied=true}
        try{writeFileSync(${JSON.stringify(path.join(tmp, "outside"))},'changed')}catch{writeDenied=true}
        try{await fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(1000)})}catch{networkDenied=true}
        await new Promise(r=>setTimeout(r,20));ctx.state.value=value;
        return {value,readDenied,writeDenied,networkDenied,envAbsent:process.env.VAK_REVIEW_SENTINEL===undefined};
      }`));
    assert.deepEqual(result, { result: { value: 42, readDenied: true, writeDenied: true, networkDenied: true, envAbsent: true }, state: { value: 42 } });
    assert.equal(readFileSync(path.join(tmp, "outside"), "utf8"), "canary");
  } finally { delete process.env.VAK_REVIEW_SENTINEL; listener.close(); await p.shutdown(); rmSync(tmp, { recursive: true, force: true }); }
});

test("concurrent invocations retain tenant identity and bounded capacity", { skip: !native }, async () => {
  const p = new SandboxPoolManager({ run: helperRun(helper), maxActiveWorkers: 2 });
  let max = 0; const timer = setInterval(() => { max = Math.max(max, p.getFleetSnapshot().activeCount); }, 5);
  try {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => p.execute(`tenant-${i}`, invocation("export async function handleAction(id,value){await new Promise(r=>setTimeout(r,40));return {tenant:value}}", i))));
    assert.deepEqual(responses.map(r => r.result.tenant), [0, 1, 2, 3, 4, 5]);
    assert.ok(max <= 2); assert.equal(p.getFleetSnapshot().activeCount, 0);
    assert.equal(p.getFleetSnapshot().standbyCount, 0);
  } finally { clearInterval(timer); await p.shutdown(); }
});

test("missing handlers, rejected handlers and timeouts fail without a success receipt", { skip: !native }, async () => {
  const p = new SandboxPoolManager({ run: helperRun(helper) });
  try {
    await assert.rejects(p.execute("missing-app", invocation("export const other=1")), /Missing app handler/);
    await assert.rejects(p.execute("reject-app", invocation("export async function handleAction(){throw new Error('original failure')}")), /original failure/);
    await assert.rejects(p.execute("timeout-app", { ...invocation("export function handleAction(){while(true){}}"), timeoutMs: 1000 }), /limit|failed/);
  } finally { await p.shutdown(); }
});

test("brokered data reaches ordinary app code through a bounded declared exchange", { skip: !native }, async () => {
  const p = new SandboxPoolManager({ run: helperRun(helper) });
  const calls: unknown[] = [];
  try {
    const response = await p.execute("data-app", { ...invocation("export async function handleAction(id,value,ctx){const rows=await ctx.callTool('source__read',{table:'items'});ctx.state.total=rows.reduce((n,r)=>n+r.amount,0);return {total:ctx.state.total}}"), callTool: async (name, args) => { calls.push({ name, args }); return [{ amount: 7 }, { amount: 11 }]; } });
    assert.equal(response.result.total, 18); assert.equal(response.state.total, 18);
    assert.deepEqual(calls, [{ name: "source__read", args: { table: "items" } }]);
  } finally { await p.shutdown(); }
});
