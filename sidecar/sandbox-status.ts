import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface SandboxCapabilities {
  contract?: number;
  supervised_processes?: boolean;
  detachment_denied?: boolean;
}

export function compatibleSandboxHelper(capabilities: SandboxCapabilities, runHelp: string): boolean {
  return capabilities.contract === 3 && capabilities.supervised_processes === true && capabilities.detachment_denied === true
    && ["--workspace", "--cwd", "--timeout-seconds", "--max-output-bytes"].every(flag => runHelp.includes(flag));
}

/** Settings and execution use the same scope check; saving never copies or runs a project. */
export function validateSandboxWorkspace(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Enter an absolute path to a project folder.");
  let root: string;
  try {
    root = realpathSync(value);
    if (!statSync(root).isDirectory()) throw new Error();
    accessSync(root, constants.R_OK | constants.X_OK);
  } catch { throw new Error("This folder does not exist or cannot be read. Choose an accessible project folder."); }
  if (["/", "/Users", "/home", "/System", "/Library", "/private", "/var", homedir()].includes(root)) {
    throw new Error("Choose a specific project folder, rather than your home or a system folder.");
  }
  return root;
}

/** Probe the command contract without executing project code. */
export async function sandboxHelper(binary: string): Promise<{ available: boolean; compatible: boolean; realms: boolean; path: string; version?: string; error?: string }> {
  const probe = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(binary, args, { timeout: 2000, maxBuffer: 8192, env: { PATH: process.env.PATH } }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  try {
    const version = (await probe(["--version"])).trim().slice(0, 120);
    const help = await probe(["run", "--help"]);
    const capabilities = JSON.parse(await probe(["capabilities"])) as SandboxCapabilities;
    const compatible = compatibleSandboxHelper(capabilities, help);
    const realmHelp = await probe(["realm", "--help"]);
    const realms = ["create", "exec", "snapshot", "read", "promote", "rollback", "recover", "destroy"].every(command => realmHelp.includes(command));
    return { available: true, compatible, realms, path: binary, version, ...(!compatible ? { error: "This helper is outdated. Rebuild or reinstall it before running commands." } : {}) };
  } catch {
    return { available: false, compatible: false, realms: false, path: binary, error: "Sandbox helper could not be started. Rebuild or reinstall the app with its sandbox helper." };
  }
}
