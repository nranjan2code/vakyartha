// Command and Realm tools. Rust resolves the chat's folder, owns the Realm
// store and runs the pinned vak-sandbox helper; this adapter only validates
// tool arguments and builds the helper's Realm arguments. Desktop only.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { CatalogEntry } from "@vak/mcp/client";
import type { SandboxCall } from "./desktop-transport.ts";

/** The chat session a tool call belongs to; set around each tool execution. */
export const sandboxSession = new AsyncLocalStorage<string>();

type Args = Record<string, unknown>;
const REALM = "{realm}";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const relative = (value: unknown) => {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512 || value.startsWith("/") || value.split(/[\\/]/).includes("..") || value.includes("\0")) throw new Error("Paths must be relative to the project folder.");
  return value;
};
const offset = (value: unknown) => {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Offset must be a nonnegative integer.");
  return value;
};
const realmId = (args: Args) => {
  if (args.realmId === undefined || args.realmId === "") return REALM;
  if (typeof args.realmId !== "string" || !UUID.test(args.realmId)) throw new Error("Provide a valid Realm ID.");
  return args.realmId;
};
const paths = (value: unknown, required: boolean) => {
  if (!Array.isArray(value) || value.length > 200 || (required && !value.length)) throw new Error("Provide the affected paths (at most 200).");
  return value.map((p) => `--paths=${relative(p)}`);
};

function command(args: Args): { argv: string[]; cwd: string; timeoutSeconds?: number } {
  const name = String(args.command ?? "").trim();
  const argv = args.args;
  const cwd = String(args.workingDirectory ?? ".");
  if (!name || name.length > 256 || name.startsWith("-")) throw new Error("Provide a command name or absolute executable path.");
  if (!Array.isArray(argv) || argv.length > 64 || argv.some((x) => typeof x !== "string" || Buffer.byteLength(x) > 4096) || Buffer.byteLength(JSON.stringify(argv)) > 16 * 1024) {
    throw new Error("Arguments must be an array of at most 64 strings, no more than 16 KiB total, and no string longer than 4,096 bytes.");
  }
  if (cwd !== ".") relative(cwd);
  const t = args.timeout_seconds;
  if (t !== undefined && (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > 300)) throw new Error("timeout_seconds must be an integer between 1 and 300.");
  return { argv: [name, ...(argv as string[])], cwd, timeoutSeconds: t as number | undefined };
}

/** Helper arguments for one Realm tool; `{realm}` means this chat's Realm. */
export function realmRequest(name: string, args: Args): Parameters<SandboxCall>[0] {
  if (name === "list_realms") return { op: "realm", args: ["list"] };
  if (name === "create_realm") return { op: "realm_create", args: [] };
  const id = realmId(args);
  if (name === "realm_status") return { op: "realm", args: ["status", id] };
  if (name === "snapshot_realm") return { op: "realm", args: ["snapshot", id, `--offset=${offset(args.offset)}`] };
  if (name === "read_realm_file") return { op: "realm", args: ["read", `--offset=${offset(args.offset)}`, ...(args.original === true ? ["--original"] : []), "--", id, relative(args.path)] };
  if (name === "run_in_realm") {
    const { argv, cwd, timeoutSeconds } = command(args);
    return { op: "realm", args: ["exec", id, `--cwd=${cwd}`, "--", ...argv], timeoutSeconds };
  }
  if (name === "promote_realm") {
    if (typeof args.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(args.fingerprint)) throw new Error("Provide the current review fingerprint and all reviewed paths (at most 200 changes).");
    return { op: "realm", args: ["promote", id, `--fingerprint=${args.fingerprint}`, ...paths(args.paths, true)] };
  }
  if (name === "rollback_realm") {
    if (typeof args.transactionId !== "string" || !UUID.test(args.transactionId)) throw new Error("Provide the promotion receipt ID.");
    return { op: "realm", args: ["rollback", id, args.transactionId, ...paths(args.paths, false)] };
  }
  if (name === "recover_realm") return { op: "realm", args: ["recover", id, ...paths(args.paths, false)] };
  if (name === "destroy_realm") return { op: "realm", args: ["destroy", id] };
  throw new Error(`Unknown Realm operation: ${name}`);
}

/** Runs a command in a scratch folder the worker staged inside its own data (app runs, skill rehearsals). */
export async function runScratch(native: SandboxCall | undefined, workspace: string, argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!native) throw new Error("Sandboxed runs need the desktop app. No command was run.");
  const root = process.env.VAK_DATA_DIR ?? "";
  const rel = root ? path.relative(root, workspace) : "";
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Scratch runs must stay inside the worker's data folder.");
  return (await native({ op: "run_scratch", args: argv, cwd: rel, timeoutSeconds: Math.max(1, Math.min(300, Math.ceil(timeoutMs / 1000))) }, signal)) as { code: number; stdout: string; stderr: string };
}

function commandText(result: { code?: number; stdout?: string; stderr?: string }): { text: string; isError: boolean } {
  const parts = [result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`, `exit code: ${result.code}`].filter(Boolean);
  return { text: parts.join("\n\n") || `Command completed with exit code ${result.code} and no output.`, isError: result.code !== 0 };
}

const string = (description: string) => ({ type: "string", description });
const realm = { realmId: string("ID returned by create_realm or list_realms; omit to use this chat's Realm.") };
const schemas: [string, string, string, Record<string, unknown>, string[], boolean][] = [
  ["create_realm", "Create an isolated project workspace", "Copy the chat's project folder into a durable Realm. Commands can write there across calls; the original stays unchanged until reviewed promotion.", {}, [], true],
  ["list_realms", "List retained workspaces", "List durable Realms and their original project, status and last promotion receipt.", {}, [], true],
  ["realm_status", "Inspect a Realm", "Inspect a retained Realm before resuming work. Interrupted work requires explicit recovery; never replay a command automatically.", realm, [], true],
  ["run_in_realm", "Run in an isolated Realm", "Execute in the same durable copy across calls. Network denied. Writes persist in the copy, not the original.", { ...realm, command: string("Executable name or absolute path; no implicit shell."), args: { type: "array", items: { type: "string" }, maxItems: 64 }, workingDirectory: string("Relative directory, default root."), timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, ["command", "args"], false],
  ["snapshot_realm", "Review Realm changes", "Record a review fingerprint and return up to 20 changes per page. Read all pages and relevant file contents before requesting promotion. At most 200 changed paths can be promoted together.", { ...realm, offset: { type: "integer", minimum: 0 } }, [], true],
  ["read_realm_file", "Read a Realm file", "Read up to 16 KiB by byte offset. Set original=true to inspect its original-project version. Lossy text is marked; do not treat it as exact binary content.", { ...realm, path: string("Relative file path."), offset: { type: "integer", minimum: 0 }, original: { type: "boolean" } }, ["path"], true],
  ["promote_realm", "Apply reviewed Realm changes to the project", "Write exactly the reviewed candidate back to the original project. Supply the latest fingerprint and ALL paths in review order. Conflicts, stale reviews, protected files and path escapes are refused. Returns a rollback receipt.", { ...realm, fingerprint: string("Exact SHA-256 fingerprint returned by snapshot_realm."), paths: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["fingerprint", "paths"], false],
  ["rollback_realm", "Undo a Realm promotion", "Restore backups for this Realm's most recent promotion. Refuses to overwrite later project edits. Returns an operation receipt.", { ...realm, transactionId: string("Most recent committed promotion receipt ID."), paths: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["transactionId", "paths"], false],
  ["recover_realm", "Recover interrupted Realm work", "Roll back interrupted promotion from its journal and allow inspection/resumption. Never re-executes a command. Conflicting original-project edits require manual resolution.", { ...realm, paths: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["paths"], false],
  ["destroy_realm", "Discard a Realm workspace", "Delete this isolated copy after recovery checks. Does not undo promotion. Promotion receipts and backups remain retained.", realm, [], false],
];
export const realmTools = schemas.map(([name, title, description, properties, required, readOnly]) => ({ name, title, description, inputSchema: { type: "object", additionalProperties: false, properties, required }, annotations: { title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false as const } }));

export function sandboxExecutionEntry(native?: SandboxCall): CatalogEntry {
  const run = async (request: Parameters<SandboxCall>[0], signal?: AbortSignal) => {
    if (!native) throw new Error("Command execution needs the desktop app. No command was run.");
    return native({ ...request, session: sandboxSession.getStore() }, signal);
  };
  const server = {
    tools: [{
      name: "run_command",
      title: "Run a command in workspace",
      description: "Run a command and argument list in this chat's folder (or the Sandbox page folder). Network is denied. In direct mode, commands write to the project folder under OS containment. In copy mode, commands run in a durable Realm across turns until reviewed and applied. Without a chat folder, each run uses a fresh disposable copy. Up to 300 seconds and 256 KiB output.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          command: { type: "string", maxLength: 256, description: "Executable name or absolute executable path; no shell is added implicitly." },
          args: { type: "array", items: { type: "string" }, maxItems: 64, description: "Arguments passed directly to the executable." },
          workingDirectory: { type: "string", description: "Optional relative directory in the project folder; defaults to its root." },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Optional execution deadline in seconds (1 to 300; defaults to 30s)." },
        }, required: ["command", "args"],
      },
      annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false, title: "Run command in sandbox" },
    }, ...realmTools],
    async callTool(name: string, args: Args, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
      try {
        if (name === "run_command") {
          const { argv, cwd, timeoutSeconds } = command(args);
          return commandText((await run({ op: "run", args: argv, cwd, timeoutSeconds }, signal)) as { code?: number; stdout?: string; stderr?: string });
        }
        const result = await run(realmRequest(name, args), signal);
        const exit = (result as { result?: { exit_code?: number } })?.result?.exit_code;
        return { text: JSON.stringify(result), isError: exit !== undefined && exit !== 0 };
      } catch (error) {
        return { text: (error as Error).message, isError: true };
      }
    },
  };
  return {
    id: "sandbox-execution", name: "Sandboxed execution", publisher: "Vakyartha", trust: "built-in",
    summary: "Run isolated commands or retain a Realm for reviewed project changes.",
    description: "Run approved commands under the vak-sandbox helper in the chat's admitted mode: direct writes modify the original folder, retained Realm changes need reviewed promotion, and runs without a chat folder use disposable copies of the Sandbox page folder. Network is denied.",
    homepage: "https://github.com/nranjan2code/sandbox", icon: "shield",
    access: ["Commands run under OS containment in the chat's folder or the Sandbox page folder", "Direct mode writes to the project folder; copy mode stages in a durable Realm", "No network access; credentials and private directories protected", "Mutations ask by default; explicit per-tool policies remain in force", "Up to 300 seconds and 256 KiB output per run"],
    source: { kind: "builtin", server: () => server }, config: [],
  };
}
