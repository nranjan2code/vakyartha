// Studio rehearsal is an explicit user operation using the same bounded helper
// as the sandbox integration. A temporary directory alone is never containment.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { SkillSandboxRunResponse } from "../shared/skills.ts";
import type { Skills } from "./skills.ts";
import { runScratch } from "./sandbox-execution.ts";
import type { SandboxCall } from "./desktop-transport.ts";

export interface SkillRehearsalOptions {
  sandbox?: SandboxCall;
  authorized: () => boolean;
  scriptSha256: string;
}
const relative = (value: string) => value.length <= 512 && value.length > 0 && !value.includes("\0") && !value.includes("\\") && !path.isAbsolute(value) && !value.split("/").some(part => !part || part === "." || part === "..");

export async function runSkillScript(skills: Skills, skillName: string, scriptPath: string, args: string[] = [], options?: SkillRehearsalOptions): Promise<SkillSandboxRunResponse> {
  const start = performance.now();
  let temporary: string | undefined;
  try {
    if (!options?.authorized()) throw new Error("Enable sandbox execution and its run_command integration policy before rehearsing scripts. No command was run.");
    if (!/^[a-z0-9-]{1,64}$/.test(skillName) || !relative(scriptPath) || !/^scripts\/.+\.(?:py|sh|js|mjs|cjs)$/.test(scriptPath)) throw new Error("Choose a supported script under scripts/.");
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Script arguments must be strings without NUL characters.");
    const draft = skills.getDraft(skillName);
    const pkg = draft.package;
    const script = pkg.files.find(file => file.path === scriptPath && file.status !== "unsupported" && typeof file.text === "string");
    if (!script) throw new Error("Script is not readable in the saved skill package.");
    const scriptSha256 = createHash("sha256").update(script.text).digest("hex");
    if (scriptSha256 !== options.scriptSha256) throw new Error("The saved script changed. Save and review the current script before running it.");
    temporary = await mkdtemp(path.join(tmpdir(), "vakyartha-skill-run-"));
    let bytes = 0;
    for (const file of [{ path: "SKILL.md", text: pkg.skill.text }, ...pkg.files]) {
      if (!relative(file.path)) throw new Error("Invalid supporting file path.");
      bytes += Buffer.byteLength(file.text);
      if (bytes > 8 * 1024 * 1024 || pkg.files.length > 500) throw new Error("Skill rehearsal package exceeds its 8 MiB/500-file bound.");
      const target = path.join(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.text, { mode: 0o600, flag: "wx" });
    }
    // Disablement during staging also revokes this not-yet-started operation.
    if (!options.authorized()) throw new Error("Sandbox access changed before execution. No command was run.");
    const command = scriptPath.endsWith(".py") ? "python3" : /\.(?:mjs|cjs|js)$/.test(scriptPath) ? process.execPath : "/bin/bash";
    const result = await runScratch(options.sandbox, temporary, [command, scriptPath, ...args], 15000);
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, durationMs: Math.round(performance.now() - start), scriptPath, scriptSha256, source: draft.hasDraft ? "saved-draft" : "published" };
  } catch (error) {
    const message = (error as Error).message;
    return { exitCode: 1, stdout: "", stderr: message, error: message, durationMs: Math.round(performance.now() - start) };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
