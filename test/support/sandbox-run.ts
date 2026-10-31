// Test stand-in for Rust's helper launch: the same `vaksb run` arguments,
// spawned directly because tests have no native host.
import { spawn } from "node:child_process";
import path from "node:path";
import type { PoolConfig } from "../../shared/sandbox-pool.ts";
import type { SandboxCall } from "../../sidecar/desktop-transport.ts";

export function helperRun(bin: string): NonNullable<PoolConfig["run"]> {
  return (workspace, argv, timeoutMs, signal) => new Promise((resolve, reject) => {
    const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const child = spawn(bin, ["run", "--cwd", workspace, "--workspace", workspace, "--timeout-seconds", seconds, "--max-output-bytes", "262144", "--", ...argv], { env: { PATH: "/usr/bin:/bin" }, signal });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.once("error", () => reject(new Error("Sandbox helper could not be started. Rebuild or reinstall the app.")));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function helperSandbox(bin: string): SandboxCall {
  return async (request, signal) => {
    if (request.op !== "run_scratch") throw new Error(`Unsupported test sandbox operation: ${request.op}`);
    return helperRun(bin)(path.join(process.env.VAK_DATA_DIR!, request.cwd!), request.args, (request.timeoutSeconds ?? 30) * 1000, signal ?? new AbortController().signal);
  };
}
