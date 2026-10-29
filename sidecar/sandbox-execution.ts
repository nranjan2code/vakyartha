import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CatalogEntry } from "@vak/mcp/client";
import { sandboxHelper, validateSandboxWorkspace } from "./sandbox-status.ts";
import { SandboxRealms, realmTools } from "./sandbox-realms.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 50_000;
const MAX_OUTPUT_BYTES = 256 * 1024; // Bounded up to 256 KiB
const MAX_RUNTIME_MS = 300_000; // Bounded up to 300 seconds (5 minutes) for long builds
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
    const timer = setTimeout(() => stop(new Error(`Sandbox execution exceeded the ${Math.round(timeoutMs / 1000)} second limit.`)), timeoutMs);
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new DOMException("Sandbox execution cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (part: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return stop(new Error("Sandbox output exceeded the 256 KiB limit."));
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

function validateArgs(args: Record<string, unknown>): { command: string; argv: string[]; cwd: string; timeoutSeconds?: number } {
  const command = String(args.command ?? "").trim();
  const argv = args.args;
  const cwd = String(args.workingDirectory ?? ".");
  let timeoutSeconds: number | undefined;
  if (args.timeout_seconds !== undefined) {
    if (typeof args.timeout_seconds !== "number" || !Number.isSafeInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > 300) {
      throw new Error("timeout_seconds must be an integer between 1 and 300.");
    }
    timeoutSeconds = args.timeout_seconds;
  }
  if (!command || command.length > 256 || command.startsWith("-")) throw new Error("Provide a command name or absolute executable path.");
  const encodedArgs = JSON.stringify(argv) ?? "";
  if (!Array.isArray(argv) || argv.length > 64 || argv.some((x) => typeof x !== "string" || Buffer.byteLength(x, "utf8") > 4096) || Buffer.byteLength(encodedArgs, "utf8") > MAX_ARGUMENT_BYTES) throw new Error("Arguments must be an array of at most 64 strings, no more than 16 KiB total, and no string longer than 4,096 bytes.");
  if (cwd.length > 256 || cwd.startsWith("/") || cwd.split(/[\\/]/).includes("..")) throw new Error("workingDirectory must be a relative path inside the configured workspace.");
  return { command, argv: argv as string[], cwd, timeoutSeconds };
}

export function sandboxExecutionEntry(opts: {
  binaryPath: string;
  enabled: () => boolean;
  workspace: () => string;
  dataDir: string;
  workspaces?: WorkspaceRegistry;
}): CatalogEntry {
  const realms = new SandboxRealms(opts);
  const server: SandboxToolServer = {
    tools: [{
      name: "run_command",
      title: "Run a command in workspace",
      description: "Run a command and argument list inside the admitted workspace folder. Network is denied. In direct mode, commands write directly to the project folder with macOS Seatbelt protection. In isolated copy mode, commands run in a durable Realm across turns until reviewed and applied. Up to 300 seconds and 256 KiB output per run.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          command: { type: "string", maxLength: 256, description: "Executable name or absolute executable path; no shell is added implicitly." },
          args: { type: "array", items: { type: "string" }, maxItems: 64, description: "Arguments passed directly to the executable." },
          workingDirectory: { type: "string", description: "Optional relative directory in the configured project folder; defaults to its root." },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Optional execution deadline in seconds (1 to 300; defaults to 30s). Allows long builds and tests up to 5 minutes." },
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
      let workspace: string;
      try {
        workspace = opts.workspace().trim();
      } catch (err) {
        return { text: (err as Error).message, isError: true };
      }
      if (!workspace) return { text: "No folder workspace is admitted for this chat. Select 'Work in folder' to enable command execution.", isError: true };

      // In a folder-bound chat:
      const activeSession = opts.workspaces?.currentSession()?.session;
      if (activeSession && opts.workspaces) {
        const binding = opts.workspaces.getBinding(activeSession);
        if (binding && binding.accessState === "admitted") {
          try {
            const { command, argv, cwd, timeoutSeconds } = validateArgs(raw);
            const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : 30_000;

            if (binding.mode === "direct") {
              const work = path.resolve(binding.folder, cwd);
              if (!work.startsWith(`${binding.folder}${path.sep}`) && work !== binding.folder) {
                throw new Error("workingDirectory must stay inside the project folder.");
              }
              await stat(work).then((s) => {
                if (!s.isDirectory()) throw new Error("workingDirectory is not a directory.");
              });
              const result = await runSandboxCommand(
                opts.binaryPath,
                binding.folder,
                command,
                argv,
                work,
                timeoutMs,
                signal
              );
              const parts = [
                result.stdout && `stdout:\n${result.stdout}`,
                result.stderr && `stderr:\n${result.stderr}`,
                `exit code: ${result.code}`,
              ].filter(Boolean);
              return {
                text: parts.join("\n\n") || `Command completed with exit code ${result.code} and no output.`,
                isError: result.code !== 0,
              };
            }

            // Realm mode (isolated or shared copy)
            const res = (await realms.execute("run_in_realm", {
              command,
              args: argv,
              workingDirectory: cwd,
              timeout_seconds: timeoutSeconds,
            }, signal)) as { result?: { exit_code?: number; stdout?: string; stderr?: string } };
            const cmd = res?.result ?? { exit_code: 0, stdout: "", stderr: "" };
            const parts = [
              cmd.stdout && `stdout:\n${cmd.stdout}`,
              cmd.stderr && `stderr:\n${cmd.stderr}`,
              `exit code: ${cmd.exit_code}`,
            ].filter(Boolean);
            return {
              text: parts.join("\n\n") || `Command completed with exit code ${cmd.exit_code} and no output.`,
              isError: cmd.exit_code !== undefined && cmd.exit_code !== 0,
            };
          } catch (error) {
            return { text: (error as Error).message, isError: true };
          }
        }
      }

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
    access: ["Admitted folder workspace commands run with macOS Seatbelt protection", "Direct in-place editing writes directly to project folder; isolated mode stages in durable Realm", "No network access; credentials and private directories protected", "Mutations ask by default; explicit per-tool policies remain in force", "Up to 300-second runtime, 256 KiB output, long builds and Git worktrees supported"],
    source: { kind: "builtin", server: () => server }, config: [],
  };
}
