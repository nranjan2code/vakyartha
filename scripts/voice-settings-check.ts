// Isolated WebKit checks for capability-driven voice settings. Discovery and
// speech I/O are fixtures; this makes no inference or download/installation claim.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startAppServer } from "../sidecar/server.ts";

const run = promisify(execFile);
const out = await mkdtemp(path.join(tmpdir(), "vak-voice-settings-"));
const bin = path.join(out, "webkit-check");
await run("swiftc", ["-O", path.resolve("scripts/webkit-check.swift"), "-o", bin]);
const originalFetch = globalThis.fetch;
let empty = false;
const speechCalls: { model: string; voice: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "http://127.0.0.1:11434") throw new Error(`Unexpected provider traffic: ${url.origin}`);
  if (url.pathname === "/api/tags") return Response.json({ models: empty ? [] : [
    { name: "local-multimodal:latest", capabilities: ["completion", "audio", "speech"] },
    { name: "phonon:latest", capabilities: ["speech"] },
    { name: "local-listener:latest", capabilities: ["audio"] },
  ] });
  if (url.pathname === "/api/show") {
    const { model } = JSON.parse(String(init?.body));
    return Response.json(model === "phonon:latest" ? { voices: ["default", "Zoey"] } : { details: { family: "lfm3_omni" }, voices: ["default", "female-british-english", "male-american-english"] });
  }
  if (url.pathname === "/v1/audio/speech") {
    speechCalls.push(JSON.parse(String(init?.body)));
    return new Response(new Uint8Array(4800));
  }
  throw new Error(`Unexpected Ollama operation: ${url.pathname}`);
}) as typeof fetch;
const setup = `const check=(v,m)=>{if(!v)throw new Error(m)};const wait=async fn=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Voice UI did not settle')};const saved=()=>JSON.parse(localStorage.getItem('vak:voice:choice'));const dictated=()=>JSON.parse(localStorage.getItem('vak:dictation:choice'));const choose=(label,value)=>{const s=document.querySelector('[aria-label="'+label+'"]');check(s,'Missing '+label);s.value=value;s.dispatchEvent(new Event('change'))};const button=text=>[...document.querySelectorAll('#settings-content button')].find(b=>b.textContent===text);`;
try {
  for (const width of [1100, 620, 375]) {
    empty = false;
    const app = await startAppServer({ dataDir: path.join(out, `data-${width}`), keychainService: "com.nranjan2code.vakyartha.voice-settings-check", access: "open", uiDir: path.resolve("dist") });
    const steps = [
      `localStorage.setItem('vak:voice:choice',JSON.stringify({provider:'ollama',model:'local-multimodal:latest',voice:'female-british-english'}));localStorage.setItem('vak:dictation:choice',JSON.stringify({provider:'ollama',model:'local-listener:latest'}));document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Voice').click();await wait(()=>button('Change…'));button('Change…').click();await wait(()=>document.querySelector('[aria-label="Read-aloud model"]'));check(document.querySelector('[aria-label="Read-aloud model"]').value==='local-multimodal:latest','Saved speech model lost');check(document.querySelector('[aria-label="Read-aloud voice"]').value==='female-british-english','Saved voice lost');check(document.querySelector('[aria-label="Dictation model"]').value==='local-listener:latest','Saved listener lost');const packs=document.querySelector('.voice-downloads');check(packs&&!packs.open,'Optional packs dominate ready page');check(!document.querySelector('.lead').textContent.includes('Phonon'),'Header assumes a model');check(!document.querySelector('#settings-content').textContent.includes('Phonon has no style'),'Controls assume a model');check(![...document.querySelectorAll('[aria-label="Read-aloud model"] option')].some(o=>o.value==='local-listener:latest'),'Audio-only model offered for speech');check(![...document.querySelectorAll('[aria-label="Dictation model"] option')].some(o=>o.value==='phonon:latest'),'Speech-only model offered for dictation');check(document.documentElement.scrollWidth<=innerWidth,'Ready page overflow');return 'saved choices and separate capability lists; downloads collapsed';`,
      `choose('Read-aloud model','phonon:latest');check(document.querySelector('[aria-label="Read-aloud voice"]').value==='default','Incompatible voice retained');choose('Read-aloud voice','Zoey');check(saved().model==='local-multimodal:latest','Browsing committed a choice');check(dictated().model==='local-listener:latest','Browsing changed dictation');HTMLMediaElement.prototype.play=function(){queueMicrotask(()=>this.dispatchEvent(new Event('ended')));return Promise.resolve()};button('Preview').click();await wait(()=>button('Preview'));check(saved().model==='local-multimodal:latest','Preview committed a choice');button('Use for read aloud').click();await wait(()=>document.querySelector('[aria-label="Read-aloud voice"]')?.value==='Zoey');check(saved().model==='phonon:latest','Use did not save speech choice');check(dictated().model==='local-listener:latest','Speech save changed dictation');return 'browse and preview are temporary; explicit speech choice saves independently';`,
      `choose('Dictation model','local-multimodal:latest');check(dictated().model==='local-listener:latest','Browsing committed dictation');button('Use for dictation').click();await wait(()=>button('In use for dictation'));check(dictated().model==='local-multimodal:latest','Dictation choice not saved');check(saved().model==='phonon:latest'&&saved().voice==='Zoey','Dictation changed speech choice');button('Refresh models').click();await wait(()=>button('In use for dictation'));check(saved().voice==='Zoey'&&dictated().model==='local-multimodal:latest','Refresh changed saved choices');document.querySelector('.voice-downloads').open=true;check(document.querySelector('.voice-downloads').textContent.includes('Install · 123 MB'),'Download actions missing');check(document.documentElement.scrollWidth<=innerWidth,'Expanded page overflow');return 'dictation saves independently; refresh preserves choices; optional downloads accessible';`,
    ];
    try {
      const { stdout, stderr } = await run(bin, [app.url, path.join(out, `ready-${width}`), ...steps.map(s => setup + s)], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 45000 });
      console.log(`${width}px: ${stdout.trim()}`);
      if (stdout.includes(" error:") || !stdout.includes("optional downloads accessible")) throw new Error(stdout + stderr);
      empty = true;
      const emptyStep = `document.getElementById('open-settings').click();await wait(()=>document.querySelector('#settings-nav-list button'));[...document.querySelectorAll('#settings-nav-list button')].find(b=>b.textContent==='Voice').click();await wait(()=>button('Set up a voice'));button('Set up a voice').click();await wait(()=>document.querySelector('.voice-downloads'));check(document.querySelector('.voice-downloads').open,'Empty setup hides downloads');check(!document.querySelector('[aria-label="Read-aloud model"]'),'Empty speech selector shown');check(document.documentElement.scrollWidth<=innerWidth,'Empty setup overflow');return 'empty setup opens downloads';`;
      const result = await run(bin, [app.url, path.join(out, `empty-${width}`), setup + emptyStep], { env: { ...process.env, WK_WIDTH: String(width) }, timeout: 45000 });
      console.log(`${width}px: ${result.stdout.trim()}`);
      if (result.stdout.includes(" error:") || !result.stdout.includes("empty setup opens downloads")) throw new Error(result.stdout + result.stderr);
    } finally { await app.shutdown(); }
  }
  assert.equal(speechCalls.length, 3);
  assert.ok(speechCalls.every(c => c.model === "phonon:latest" && c.voice === "Zoey"));
  console.log(`Voice Settings WebKit checks passed. Screenshots: ${out}`);
} finally { globalThis.fetch = originalFetch; }
