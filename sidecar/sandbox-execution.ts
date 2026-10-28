import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CatalogEntry } from "@vak/mcp/client";
import { sandboxHelper, validateSandboxWorkspace } from "./sandbox-status.ts";
import { SandboxRealms, realmTools } from "./sandbox-realms.ts";

const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 50_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_RUNTIME_MS = 30_000;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const PATH_VALUE = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

interface ToolInfo {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { destructiveHint: boolean; readOnlyHint: boolean; openWorldHint: false; title: string };
}

interface SandboxToolServer {
  tools: ToolInfo[];
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: PATH_VALUE, HOME: cwd, TMPDIR: cwd }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, settled = false;
    let stopping: Error | undefined;
    const stop = (reason: Error) => {
      if (settled || stopping) return;
      stopping = reason;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop(new Error("Sandbox execution exceeded the 30 second limit.")), timeoutMs);
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new DOMException("Sandbox execution cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (part: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return stop(new Error("Sandbox output exceeded the 32 KiB limit."));
      if (part === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(stopping ?? error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (stopping) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* helper already exited */ }
        return reject(stopping);
      }
      if (code === 124 || code === 125) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* helper already exited */ }
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}

/** Shared execution primitive for approved project runs and explicit Studio rehearsals. */
export async function runSandboxCommand(binary: string, workspace: string, command: string, args: string[], cwd = workspace, timeoutMs = MAX_RUNTIME_MS, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  if (process.platform !== "darwin") throw new Error("OS-isolated command execution requires macOS. No command was run.");
  if (!(await sandboxHelper(binary)).compatible) throw new Error("A supervised sandbox helper is required. Rebuild or reinstall it; no command was run.");
  const checked = validateArgs({ command, args, workingDirectory: path.relative(workspace, cwd) || "." });
  if (!(timeoutMs > 0 && timeoutMs <= MAX_RUNTIME_MS)) throw new Error("Invalid sandbox command deadline.");
  signal?.throwIfAborted();
  return runProcess(binary, ["run", "--cwd", cwd, "--workspace", workspace, "--timeout-seconds", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "--max-output-bytes", String(MAX_OUTPUT_BYTES), "--", checked.command, ...checked.argv], cwd, timeoutMs, signal);
}

async function snapshot(source: string, target: string, started: number, signal?: AbortSignal): Promise<void> {
  const root = validateSandboxWorkspace(source);
  let total = 0, files = 0;
  const visit = async (from: string, to: string, ancestors: Set<string>): Promise<void> => {
    signal?.throwIfAborted();
    if (Date.now() - started >= MAX_RUNTIME_MS) throw new Error("Preparing the bounded workspace exceeded the 30 second run limit.");
    const canonical = await realpath(from);
    if (!canonical.startsWith(`${root}${path.sep}`) && canonical !== root) throw new Error("The workspace contains a link that escapes its configured folder.");
    if (ancestors.has(canonical)) throw new Error("The workspace contains a directory link cycle.");
    const info = await stat(canonical);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      const next = new Set(ancestors).add(canonical);
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if ([".git", ".vak", ".ssh", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".netrc"].includes(entry.name) || /^\.env(?:\.|$)/i.test(entry.name) || /(?:credential|secret|token|private.?key)/i.test(entry.name) || /^id_(?:rsa|ed25519|ecdsa)(?:$|\.)/i.test(entry.name) || /\.(?:pem|key)$/i.test(entry.name)) continue;
        await visit(path.join(canonical, entry.name), path.join(to, entry.name), next);
      }
      return;
    }
    if (!info.isFile()) throw new Error("The workspace contains a special file; remove it before running code.");
    total += info.size; files++;
    if (total > MAX_WORKSPACE_BYTES) throw new Error("Workspace snapshot exceeds the 512 MiB limit.");
    if (files > MAX_WORKSPACE_FILES) throw new Error("Workspace snapshot exceeds the 50,000 file limit.");
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(canonical, to);
    signal?.throwIfAborted();
    if (Date.now() - started >= MAX_RUNTIME_MS) throw new Error("Preparing the bounded workspace exceeded the 30 second run limit.");
  };
  await visit(root, target, new Set());
}

function validateArgs(args: Record<string, unknown>): { command: string; argv: string[]; cwd: string } {
  const command = String(args.command ?? "").trim();
  const argv = args.args;
  const cwd = String(args.workingDirectory ?? ".");
  if (!command || command.length > 256 || command.startsWith("-")) throw new Error("Provide a command name or absolute executable path.");
  const encodedArgs = JSON.stringify(argv) ?? "";
  if (!Array.isArray(argv) || argv.length > 64 || argv.some((x) => typeof x !== "string" || Buffer.byteLength(x, "utf8") > 4096) || Buffer.byteLength(encodedArgs, "utf8") > MAX_ARGUMENT_BYTES) throw new Error("Arguments must be an array of at most 64 strings, no more than 16 KiB total, and no string longer than 4,096 bytes.");
  if (cwd.length > 256 || cwd.startsWith("/") || cwd.split(/[\\/]/).includes("..")) throw new Error("workingDirectory must be a relative path inside the configured workspace.");
  return { command, argv: argv as string[], cwd };
}

export function sandboxExecutionEntry(opts: { binaryPath: string; enabled: () => boolean; workspace: () => string; dataDir: string }): CatalogEntry {
  const realms = new SandboxRealms(opts);
  const server: SandboxToolServer = {
    tools: [{
      name: "run_command",
      title: "Run a command in an isolated workspace",
      description: "Run a command and argument list in a disposable copy of the configured project folder. The copy is capped at 512 MiB and 50,000 files. Network is denied. The run stops after 30 seconds or 32 KiB of combined output. Changes are discarded after the call. Each call asks for approval by default.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          command: { type: "string", maxLength: 256, description: "Executable name or absolute executable path; no shell is added implicitly." },
          args: { type: "array", items: { type: "string" }, maxItems: 64, description: "Arguments passed directly to the executable." },
          workingDirectory: { type: "string", description: "Optional relative directory in the configured project folder; defaults to its root." },
        }, required: ["command", "args"],
      },
      annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false, title: "Run command in sandbox" },
    }, ...realmTools],
    async callTool(name, raw, signal) {
      if (name !== "run_command" && realmTools.some(tool => tool.name === name)) {
        try {
          const result = await realms.execute(name, raw, signal);
          const commandResult = (result as { result?: { exit_code?: number } })?.result;
          return { text: JSON.stringify(result), isError: commandResult?.exit_code !== undefined && commandResult.exit_code !== 0 };
        } catch (error) { return { text: (error as Error).message, isError: true }; }
      }
      if (name !== "run_command") return { text: `unknown tool ${name}`, isError: true };
      if (!opts.enabled()) return { text: "Sandbox execution is disabled in Settings → Sandbox. No command was run.", isError: true };
      if (process.platform !== "darwin") return { text: "OS-isolated command execution is currently available only on macOS. No command was run.", isError: true };
      const workspace = opts.workspace().trim();
      if (!workspace) return { text: "Set a project folder in Settings → Sandbox before running a command. No command was run.", isError: true };
      let temp: string | undefined;
      const started = Date.now();
      try {
        const { command, argv, cwd } = validateArgs(raw);
        temp = await mkdtemp(path.join(tmpdir(), "vakyartha-sandbox-"));
        const staged = path.join(temp, "workspace");
        await snapshot(workspace, staged, started, signal);
        const work = path.resolve(staged, cwd);
        if (!work.startsWith(`${staged}${path.sep}`) && work !== staged) throw new Error("workingDirectory must stay inside the sandbox workspace.");
        await stat(work).then((s) => { if (!s.isDirectory()) throw new Error("workingDirectory is not a directory."); });
        const remaining = MAX_RUNTIME_MS - (Date.now() - started);
        if (remaining <= 0) throw new Error("Preparing the bounded workspace exceeded the 30 second run limit.");
        const result = await runSandboxCommand(opts.binaryPath, staged, command, argv, work, remaining, signal);
        const parts = [result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`, `exit code: ${result.code}`].filter(Boolean);
        return { text: parts.join("\n\n") || `Command completed with exit code ${result.code} and no output.`, isError: result.code !== 0 };
      } catch (error) {
        return { text: (error as Error).message, isError: true };
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
  return {
    id: "sandbox-execution", name: "Sandboxed execution", publisher: "Vakyartha", trust: "built-in",
    summary: "Run isolated commands or retain a Realm for reviewed project changes.",
    description: "Run approved commands with macOS Seatbelt in a temporary copy or a durable Realm. Network is denied. Realm changes reach the original project only through fingerprint-bound, journaled promotion, with conflict checks and rollback receipts.",
    homepage: "https://github.com/nranjan2code/sandbox", icon: "shield",
    access: ["Reads a copy of the one project folder you configure", "Commands write only to isolated copies; explicit promotion can change the original project", "No network; common credential files are excluded", "Mutations ask by default; explicit per-tool policies remain in force", "30-second runtime, 32 KiB output, 512 MiB and 50,000 file snapshot limits"],
    source: { kind: "builtin", server: () => server }, config: [],
  };
}
