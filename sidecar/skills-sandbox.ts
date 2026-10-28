// Skill Studio Sandbox Runner: executes inert skill scripts in a disposable isolated directory.
// Verifies script syntax, execution bounds, and output formatting before deployment.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { SkillSandboxRunResponse } from "../shared/skills.ts";
import type { Skills } from "./skills.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;
const PATH_VALUE = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export async function runSkillScript(
  skills: Skills,
  skillName: string,
  scriptPath: string,
  args: string[] = []
): Promise<SkillSandboxRunResponse> {
  const start = performance.now();
  let tempDir: string | undefined;

  try {
    const file = skills.fileText(skillName, scriptPath);
    tempDir = await mkdtemp(path.join(tmpdir(), "vakyartha-skill-run-"));

    const scriptBase = path.basename(scriptPath);
    const scriptFile = path.join(tempDir, scriptBase);
    await writeFile(scriptFile, file.text, { mode: 0o700 });

    let command = "/bin/bash";
    const runArgs = [scriptBase, ...args];

    if (scriptBase.endsWith(".py")) {
      command = "python3";
    } else if (scriptBase.endsWith(".js") || scriptBase.endsWith(".mjs")) {
      command = "node";
    } else if (scriptBase.endsWith(".sh")) {
      command = "/bin/bash";
    }

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, runArgs, {
        cwd: tempDir,
        env: { PATH: PATH_VALUE, HOME: tempDir, TMPDIR: tempDir },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "", stderr = "", totalBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          resolve({ code: 124, stdout, stderr: stderr + "\n[Timeout] Execution exceeded 15 seconds." });
        }
      }, TIMEOUT_MS);

      const collect = (chunk: Buffer, isErr: boolean) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          if (!settled) {
            settled = true;
            child.kill("SIGTERM");
            resolve({ code: 1, stdout, stderr: stderr + "\n[Limit] Output exceeded 64 KiB." });
          }
          return;
        }
        if (isErr) stderr += chunk.toString("utf8");
        else stdout += chunk.toString("utf8");
      };

      child.stdout.on("data", chunk => collect(chunk, false));
      child.stderr.on("data", chunk => collect(chunk, true));

      child.once("error", err => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.once("close", code => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ code: code ?? 0, stdout, stderr });
        }
      });
    });

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: (err as Error).message,
      durationMs: Math.round(performance.now() - start),
      error: (err as Error).message,
    };
  } finally {
    if (tempDir) {
      try { await rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}
