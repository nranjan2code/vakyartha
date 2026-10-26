// Whistle: speech-to-text on this Mac. The engine is Cactus Compute's prebuilt
// `needle` binary (no published source), so it is treated as untrusted code:
// both files are pinned to Hugging Face commits at least 14 days old and to
// their SHA-256, it gets no environment, and on macOS it runs with networking
// denied. It reads the 16 kHz WAV the window already records.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface PinnedFile { name: string; url: string; bytes: number; sha256: string; mode: number }

const ENGINE_REV = "93e88ede867e4311c39151285e74df513e4b835b"; // Cactus-Compute/needle3, 2026-10-10
const WEIGHTS_REV = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5"; // Cactus-Compute/whistle, 2026-10-10

/** The one pack: the macOS arm64 engine and the weights. Both Apache 2.0. */
export const WHISTLE_PACK = {
  id: `whistle@${WEIGHTS_REV.slice(0, 12)}`,
  label: "Whistle · seven languages",
  size: "18 MB",
  license: "Apache 2.0",
  files: [
    { name: "needle", url: `https://huggingface.co/Cactus-Compute/needle3/resolve/${ENGINE_REV}/macos-arm64/needle`, bytes: 1_106_424, sha256: "1e7e698b492904a92496e2b168844a3101e671928ffa6372970d897512251c48", mode: 0o755 },
    { name: "whistle.cact", url: `https://huggingface.co/Cactus-Compute/whistle/resolve/${WEIGHTS_REV}/whistle.cact`, bytes: 16_919_407, sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb", mode: 0o644 },
  ] satisfies PinnedFile[],
};

/** What the model was trained on; anything else would come out as another language's words. */
export const WHISTLE_LANGUAGES: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", nl: "Dutch", pl: "Polish" };

export const whistleSupported = (platform = process.platform, arch = process.arch) => platform === "darwin" && arch === "arm64";

/** The pack's folder: one per pinned pair, so a new pin never mixes with an old install. */
export const whistleDir = (dir: string) => path.join(dir, "whistle", `${ENGINE_REV.slice(0, 12)}-${WEIGHTS_REV.slice(0, 12)}`);

/** Installed when every pinned file is present at its pinned size (the hash was checked when it was written). */
export async function whistleInstalled(dir: string): Promise<boolean> {
  for (const file of WHISTLE_PACK.files) {
    const s = await stat(path.join(whistleDir(dir), file.name)).catch(() => undefined);
    if (s?.size !== file.bytes) return false;
  }
  return true;
}

/** Download, check each file against its pin, then move the folder into place whole. */
export async function installWhistle(dir: string, f: typeof fetch = fetch): Promise<void> {
  if (!whistleSupported()) throw new Error("Whistle runs on Apple Silicon Macs");
  const target = whistleDir(dir);
  const staging = `${target}.part`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const file of WHISTLE_PACK.files) {
      let res: Response;
      try {
        res = await f(file.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      } catch {
        throw new Error("Hugging Face is not reachable");
      }
      if (!res.ok) throw new Error(`downloading ${file.name} failed: ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      const sha = createHash("sha256").update(body).digest("hex");
      if (body.length !== file.bytes || sha !== file.sha256) throw new Error(`${file.name} does not match its pinned checksum`);
      await writeFile(path.join(staging, file.name), body, { mode: file.mode });
      await chmod(path.join(staging, file.name), file.mode);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

const SANDBOX = "/usr/bin/sandbox-exec";
const NO_NETWORK = "(version 1)(allow default)(deny network*)";

/** One recording to text. `language` is a code from WHISTLE_LANGUAGES, or undefined to detect it. */
export async function runWhistle(dir: string, audio: Uint8Array, language: string | undefined, signal?: AbortSignal): Promise<string> {
  const home = whistleDir(dir);
  const clip = path.join(home, `clip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(clip, audio, { mode: 0o600 });
  try {
    const args = ["--model", path.join(home, "whistle.cact"), "--audio", clip, ...(language ? ["--audio-language", language] : [])];
    const [cmd, argv] = existsSync(SANDBOX) ? [SANDBOX, ["-p", NO_NETWORK, path.join(home, "needle"), ...args]] : [path.join(home, "needle"), args];
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, argv, { env: {}, cwd: home, stdio: ["ignore", "pipe", "pipe"], signal, timeout: 120_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d; });
      child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d).slice(-2000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Whistle stopped (${code ?? "killed"}): ${stderr.trim().split("\n").pop() ?? ""}`)));
    });
    const last = out.trim().split("\n").pop() ?? "";
    return String((JSON.parse(last) as { text?: unknown }).text ?? "").trim();
  } finally {
    await rm(clip, { force: true });
  }
}
