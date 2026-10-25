// Integrations: the tools the model may use beyond drawing UI, from a curated
// catalog (built-in, official MCP reference servers, vendors' own servers)
// or a server the user adds. Security decisions, in order of how much they
// matter:
// - Third-party code is pinned: an exact version, and `npm --before` keeps
//   every dependency to releases at least 14 days old (a compromised release
//   is usually caught within days). `--ignore-scripts`: nothing runs at install.
// - Each server runs in its own folder as HOME/TMPDIR/cwd, with only the
//   variables it declares: our API keys never reach it (McpClient.minimalEnv).
// - Files is limited to folders the user adds; nothing else is passed.
// - Every tool has a policy (allow / ask / off). Defaults: local reads are
//   allowed, writes and anything reaching the internet ask. "Allow for this
//   chat" lasts for one conversation only.
// - Keys go to the same secret store as provider keys (the Keychain on macOS).
// - Calls are logged (logs/tools.jsonl) and shown per integration.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@vak/core";
import { agentTools, type BuiltinServer, defaultDecision, McpClient, type McpToolInfo, timeServer, type ToolCallRecord, type ToolPolicy, webFetchServer } from "@vak/mcp/client";
import type { AgentTool } from "@vak/providers";
import type { SecretStore } from "./settings.ts";

const run = promisify(execFile);

export type Trust = "built-in" | "official" | "vendor" | "custom";

export interface ConfigField {
  key: string;
  label: string;
  kind: "secret" | "folders" | "text";
  required?: boolean;
  help?: string;
  /** Passed to the server as this environment variable. */
  env?: string;
  /** Sent as an HTTP header (remote servers): "Authorization: Bearer {value}". */
  header?: { name: string; format: string };
}

export interface CatalogEntry {
  id: string;
  name: string;
  publisher: string;
  trust: Trust;
  /** One line for the card. */
  summary: string;
  description: string;
  homepage: string;
  /** Icon id drawn by the UI (original artwork, not vendors' logos). */
  icon: string;
  /** What it can reach, in plain words, shown before install. */
  access: string[];
  source:
    | { kind: "builtin"; server: () => BuiltinServer }
    | { kind: "npm"; package: string; version: string; bin: string; args?: (config: Record<string, unknown>, dir: string) => string[]; env?: (dir: string) => Record<string, string> }
    | { kind: "http"; url: string }
    | { kind: "stdio"; command: string; args: string[] };
  config: ConfigField[];
}

/** Versions picked on 2026-10-25: each the newest published at least 14 days before. */
export const CATALOG: CatalogEntry[] = [
  {
    id: "web",
    name: "Web pages",
    publisher: "vak",
    trust: "built-in",
    summary: "Read public web pages for current facts.",
    description: "Fetches a public https page and gives the model its text and links. Private and local network addresses are refused, every redirect is checked, and pages are capped at 2 MB.",
    homepage: "https://github.com/nranjan2code/Projection",
    icon: "globe",
    access: ["Public https web pages", "Asks before each fetch unless you allow it for the chat"],
    source: { kind: "builtin", server: () => webFetchServer() },
    config: [],
  },
  {
    id: "time",
    name: "Time",
    publisher: "vak",
    trust: "built-in",
    summary: "Current time and time-zone conversion.",
    description: "Gives the model today's date and time in any time zone and converts between zones, so plans and schedules are anchored to now.",
    homepage: "https://github.com/nranjan2code/Projection",
    icon: "clock",
    access: ["Nothing outside this computer"],
    source: { kind: "builtin", server: () => timeServer() },
    config: [],
  },
  {
    id: "files",
    name: "Files",
    publisher: "Model Context Protocol",
    trust: "official",
    summary: "Read and edit files in folders you choose.",
    description: "The MCP reference filesystem server. It can list, search, read and (with your approval) write files, only inside the folders you add here.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    icon: "folder",
    access: ["Only the folders you add", "Asks before writing, moving or creating files"],
    source: { kind: "npm", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", bin: "dist/index.js", args: (c) => (Array.isArray(c.folders) ? (c.folders as string[]) : []) },
    config: [{ key: "folders", label: "Folders", kind: "folders", required: true, help: "Absolute paths, one per line. The server sees nothing outside them." }],
  },
  {
    id: "memory",
    name: "Memory",
    publisher: "Model Context Protocol",
    trust: "official",
    summary: "Remember facts across chats.",
    description: "The MCP reference memory server: a small knowledge graph of people, projects and preferences the model can add to and recall, stored in a file in this app's data folder.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    icon: "memory",
    access: ["One file in this app's data folder"],
    source: { kind: "npm", package: "@modelcontextprotocol/server-memory", version: "2026.8.31", bin: "dist/index.js", env: (dir) => ({ MEMORY_FILE_PATH: path.join(dir, "memory.jsonl") }) },
    config: [],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    publisher: "Brave",
    trust: "vendor",
    summary: "Web, news and local search.",
    description: "Brave's own MCP server for the Brave Search API: web, news, image and local results with snippets, so answers cite current sources.",
    homepage: "https://github.com/brave/brave-search-mcp-server",
    icon: "search",
    access: ["Sends your search queries to Brave", "Needs a Brave Search API key"],
    source: { kind: "npm", package: "@brave/brave-search-mcp-server", version: "2.1.4", bin: "dist/index.js" },
    config: [{ key: "apiKey", label: "Brave Search API key", kind: "secret", required: true, env: "BRAVE_API_KEY", help: "From api-dashboard.search.brave.com (a free plan exists)." }],
  },
  {
    id: "github",
    name: "GitHub",
    publisher: "GitHub",
    trust: "vendor",
    summary: "Issues, pull requests and code.",
    description: "GitHub's own remote MCP server: search code, read and file issues, review pull requests. What it can do is limited by the token you give it.",
    homepage: "https://github.com/github/github-mcp-server",
    icon: "branch",
    access: ["Your GitHub account, within the token's permissions", "Asks before anything that changes a repository"],
    source: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
    config: [{ key: "token", label: "GitHub token", kind: "secret", required: true, header: { name: "authorization", format: "Bearer {value}" }, help: "A fine-grained personal access token with only the repositories and permissions you want it to have." }],
  },
  {
    id: "notion",
    name: "Notion",
    publisher: "Notion",
    trust: "vendor",
    summary: "Search and edit your Notion pages.",
    description: "Notion's own MCP server. It sees only the pages and databases you share with the integration in Notion.",
    homepage: "https://github.com/makenotion/notion-mcp-server",
    icon: "page",
    access: ["Pages you share with the integration in Notion", "Asks before creating or editing pages"],
    source: { kind: "npm", package: "@notionhq/notion-mcp-server", version: "2.5.2", bin: "bin/cli.mjs" },
    config: [{ key: "token", label: "Notion integration token", kind: "secret", required: true, env: "NOTION_TOKEN", help: "Create an internal integration at notion.so/profile/integrations and share pages with it." }],
  },
  {
    id: "context7",
    name: "Library docs",
    publisher: "Upstash (Context7)",
    trust: "vendor",
    summary: "Current documentation for code libraries.",
    description: "Context7 looks up up-to-date documentation and examples for programming libraries, so code answers match the version you use.",
    homepage: "https://github.com/upstash/context7",
    icon: "book",
    access: ["Sends library names and questions to Context7"],
    source: { kind: "npm", package: "@upstash/context7-mcp", version: "4.3.0", bin: "dist/index.js" },
    config: [{ key: "apiKey", label: "Context7 API key (optional)", kind: "secret", env: "CONTEXT7_API_KEY", help: "Optional: higher rate limits." }],
  },
];

interface State {
  installed?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  policies: Record<string, ToolPolicy>;
  tools?: McpToolInfo[];
}

interface Saved {
  integrations: Record<string, State>;
  custom: CatalogEntry[];
}

export interface IntegrationView {
  entry: Omit<CatalogEntry, "source"> & { sourceKind: CatalogEntry["source"]["kind"]; version?: string; package?: string; url?: string; command?: string };
  installed: boolean;
  version?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  missing: string[];
  status: "off" | "ready" | "error" | "needs-setup" | "not-installed";
  error?: string;
  tools: (McpToolInfo & { policy: ToolPolicy; defaultPolicy: ToolPolicy })[];
  calls: ToolCallRecord[];
}

export interface IntegrationDeps {
  dataDir: string;
  secrets: SecretStore;
  log: (line: string) => void;
  approve: (req: { id: string; server: string; tool: string; title: string; args: unknown }, emit?: (e: AgentEvent) => void, signal?: AbortSignal) => Promise<"allow" | "allow-chat" | "deny">;
  /** npm to install with: a command, or a path to npm-cli.js run with this Node. */
  npm?: string;
}

export class Integrations {
  private file: string;
  private dir: string;
  private saved: Saved;
  private clients = new Map<string, McpClient>();
  private builtins = new Map<string, BuiltinServer>();
  private errors = new Map<string, string>();
  private calls = new Map<string, ToolCallRecord[]>();
  /** "Allow for this chat": session → server:tool. */
  private chatAllowed = new Map<string, Set<string>>();

  private deps: IntegrationDeps;

  constructor(deps: IntegrationDeps) {
    this.deps = deps;
    this.dir = path.join(deps.dataDir, "integrations");
    this.file = path.join(deps.dataDir, "integrations.json");
    mkdirSync(this.dir, { recursive: true });
    try {
      this.saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // First run: the in-process tools are on (they run no outside code).
      this.saved = { integrations: { time: { installed: "built-in", enabled: true, config: {}, policies: {} } }, custom: [] };
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2));
  }

  entries(): CatalogEntry[] {
    return [...CATALOG, ...this.saved.custom];
  }

  private entry(id: string): CatalogEntry {
    const e = this.entries().find((x) => x.id === id);
    if (!e) throw new Error(`unknown integration ${id}`);
    return e;
  }

  private state(id: string): State {
    return (this.saved.integrations[id] ??= { enabled: false, config: {}, policies: {} });
  }

  private secretName(id: string, key: string): string {
    return `INTEGRATION_${id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${key.toUpperCase()}`;
  }

  private missing(e: CatalogEntry, st: State): string[] {
    return e.config
      .filter((f) => f.required)
      .filter((f) => (f.kind === "secret" ? !this.deps.secrets.get(this.secretName(e.id, f.key)) : f.kind === "folders" ? !(Array.isArray(st.config[f.key]) && (st.config[f.key] as unknown[]).length) : !st.config[f.key]))
      .map((f) => f.label);
  }

  policyOf(id: string, tool: McpToolInfo): ToolPolicy {
    return this.state(id).policies[tool.name] ?? (defaultDecision(tool) === "allow" ? "allow" : "ask");
  }

  view(): IntegrationView[] {
    return this.entries().map((e) => {
      const st = this.saved.integrations[e.id] ?? { enabled: false, config: {}, policies: {} };
      const installed = e.source.kind === "builtin" || e.source.kind === "http" || e.source.kind === "stdio" ? true : Boolean(st.installed);
      const missing = this.missing(e, st);
      const error = this.errors.get(e.id);
      const { source, ...rest } = e;
      return {
        entry: { ...rest, sourceKind: source.kind, version: source.kind === "npm" ? source.version : undefined, package: source.kind === "npm" ? source.package : undefined, url: source.kind === "http" ? source.url : undefined, command: source.kind === "stdio" ? [source.command, ...source.args].join(" ") : undefined },
        installed,
        version: st.installed,
        enabled: st.enabled,
        config: st.config,
        secretsSet: Object.fromEntries(e.config.filter((f) => f.kind === "secret").map((f) => [f.key, Boolean(this.deps.secrets.get(this.secretName(e.id, f.key)))])),
        missing,
        status: !installed ? "not-installed" : missing.length ? "needs-setup" : !st.enabled ? "off" : error ? "error" : "ready",
        error,
        tools: (st.tools ?? []).map((t) => ({ ...t, policy: this.policyOf(e.id, t), defaultPolicy: defaultDecision(t) === "allow" ? "allow" : "ask" })),
        calls: (this.calls.get(e.id) ?? []).slice(-30).reverse(),
      };
    });
  }

  // --- install -------------------------------------------------------------------
  async install(id: string): Promise<void> {
    const e = this.entry(id);
    const st = this.state(id);
    if (e.source.kind !== "npm") {
      st.installed = e.source.kind === "builtin" ? "built-in" : "remote";
      this.persist();
      return;
    }
    const target = path.join(this.dir, id, "pkg");
    mkdirSync(target, { recursive: true });
    // Every package and dependency must have been public for two weeks.
    const before = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const npmArgs = ["install", `${e.source.package}@${e.source.version}`, "--prefix", target, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", `--before=${before}`];
    const npm = this.deps.npm ?? "npm";
    this.deps.log(`integrations: installing ${e.source.package}@${e.source.version} (before ${before})`);
    try {
      if (npm.endsWith(".js")) await run(process.execPath, [npm, ...npmArgs], { cwd: target, timeout: 300_000 });
      else await run(npm, npmArgs, { cwd: target, timeout: 300_000 });
    } catch (err) {
      const msg = (err as { stderr?: string }).stderr?.split("\n").find((l) => /ERR!/.test(l)) ?? (err as Error).message;
      throw new Error(`install failed: ${msg}`);
    }
    st.installed = e.source.version;
    this.errors.delete(id);
    this.persist();
  }

  async uninstall(id: string): Promise<void> {
    await this.stop(id);
    const e = this.entry(id);
    rmSync(path.join(this.dir, id), { recursive: true, force: true });
    for (const f of e.config) if (f.kind === "secret") this.deps.secrets.delete(this.secretName(id, f.key));
    delete this.saved.integrations[id];
    if (e.trust === "custom") this.saved.custom = this.saved.custom.filter((c) => c.id !== id);
    this.calls.delete(id);
    this.errors.delete(id);
    this.persist();
  }

  /** A server the user adds: always shown as unverified; every tool asks until changed. */
  addCustom(input: { name: string; command?: string; args?: string[]; url?: string; token?: string }): string {
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new Error("name required");
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 48);
    if (this.entries().some((e) => e.id === id)) throw new Error(`${name} already exists`);
    let source: CatalogEntry["source"];
    if (input.url) {
      const u = new URL(input.url);
      // A remote server gets your data and maybe a token: https only (or this machine).
      if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("remote servers must use https");
      source = { kind: "http", url: u.href };
    } else if (input.command?.trim()) source = { kind: "stdio", command: input.command.trim(), args: input.args ?? [] };
    else throw new Error("a command or a URL is required");
    const entry: CatalogEntry = {
      id,
      name,
      publisher: "Added by you",
      trust: "custom",
      summary: source.kind === "http" ? source.url : [source.command, ...source.args].join(" "),
      description: "A server you added. vak has not reviewed it: it runs with the same limits as the others (its own folder, no access to your keys), and every tool asks before it runs until you change that.",
      homepage: source.kind === "http" ? source.url : "",
      icon: "plug",
      access: [source.kind === "http" ? `Data you approve is sent to ${new URL(source.url).host}` : "Runs a program on this computer"],
      source,
      config: source.kind === "http" ? [{ key: "token", label: "Bearer token (optional)", kind: "secret", header: { name: "authorization", format: "Bearer {value}" } }] : [],
    };
    this.saved.custom.push(entry);
    this.state(id).installed = source.kind === "http" ? "remote" : "local";
    if (input.token) this.deps.secrets.set(this.secretName(id, "token"), input.token);
    this.persist();
    return id;
  }

  // --- configure -------------------------------------------------------------------
  async configure(id: string, change: { enabled?: boolean; config?: Record<string, unknown>; secrets?: Record<string, string | null>; policies?: Record<string, ToolPolicy> }): Promise<void> {
    const e = this.entry(id);
    const st = this.state(id);
    let restart = false;
    if (change.config) {
      for (const f of e.config) {
        if (!(f.key in change.config)) continue;
        const v = change.config[f.key];
        if (f.kind === "folders") st.config[f.key] = this.folders(v);
        else if (f.kind === "text") st.config[f.key] = String(v ?? "").trim();
      }
      restart = true;
    }
    for (const [key, value] of Object.entries(change.secrets ?? {})) {
      const f = e.config.find((x) => x.key === key && x.kind === "secret");
      if (!f) continue;
      if (value && /[\s"\\]/.test(value)) throw new Error(`${f.label} contains characters a key never has`);
      if (value) this.deps.secrets.set(this.secretName(id, key), value);
      else this.deps.secrets.delete(this.secretName(id, key));
      restart = true;
    }
    for (const [tool, p] of Object.entries(change.policies ?? {})) if (["allow", "ask", "off"].includes(p)) st.policies[tool] = p;
    if (typeof change.enabled === "boolean") {
      st.enabled = change.enabled;
      restart = true;
    }
    this.persist();
    if (restart) {
      await this.stop(id);
      if (st.enabled && !this.missing(e, st).length) await this.refresh(id);
    }
  }

  /** Folders for the Files server: absolute, existing, and never a whole system root. */
  private folders(v: unknown): string[] {
    const list = (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((x) => String(x).trim()).filter(Boolean);
    for (const f of list) {
      if (!path.isAbsolute(f)) throw new Error(`${f}: use a full path`);
      const n = path.resolve(f);
      if (["/", "/Users", "/System", "/Library", "/etc", "/var", "/private", process.env.HOME ?? ""].includes(n)) throw new Error(`${n}: too broad, choose a specific folder`);
      if (!existsSync(n)) throw new Error(`${n} doesn't exist`);
    }
    return [...new Set(list.map((f) => path.resolve(f)))];
  }

  // --- running ------------------------------------------------------------------------
  private source(id: string): BuiltinServer | McpClient {
    const e = this.entry(id);
    const st = this.state(id);
    if (e.source.kind === "builtin") {
      let b = this.builtins.get(id);
      if (!b) this.builtins.set(id, (b = e.source.server()));
      return b;
    }
    let c = this.clients.get(id);
    if (c) return c;
    const home = path.join(this.dir, id, "home");
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    for (const f of e.config) {
      if (f.kind !== "secret") continue;
      const v = this.deps.secrets.get(this.secretName(id, f.key));
      if (!v) continue;
      if (f.env) env[f.env] = v;
      if (f.header) headers[f.header.name] = f.header.format.replace("{value}", v);
    }
    const log = (line: string) => this.deps.log(line);
    if (e.source.kind === "npm") {
      const script = path.join(this.dir, id, "pkg", "node_modules", e.source.package, e.source.bin);
      if (!existsSync(script)) throw new Error("not installed");
      Object.assign(env, e.source.env?.(path.join(this.dir, id)) ?? {});
      c = new McpClient({ name: e.name, log, transport: { kind: "stdio", command: process.execPath, args: [script, ...(e.source.args?.(st.config, path.join(this.dir, id)) ?? [])], env, sandboxDir: home } });
    } else if (e.source.kind === "stdio") {
      c = new McpClient({ name: e.name, log, transport: { kind: "stdio", command: e.source.command, args: e.source.args, env, sandboxDir: home } });
    } else {
      c = new McpClient({ name: e.name, log, transport: { kind: "http", url: (e.source as { url: string }).url, headers } });
    }
    this.clients.set(id, c);
    return c;
  }

  /** Connect and read the tool list (kept, so Settings shows tools while a server is stopped). */
  async refresh(id: string): Promise<void> {
    try {
      const src = this.source(id);
      const tools = "tools" in src ? src.tools : await src.listTools();
      this.state(id).tools = tools;
      this.errors.delete(id);
      this.persist();
    } catch (err) {
      this.errors.set(id, (err as Error).message);
      await this.stop(id);
    }
  }

  async stop(id: string): Promise<void> {
    this.clients.get(id)?.close();
    this.clients.delete(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.clients.keys()]) await this.stop(id);
  }

  private record(id: string, r: ToolCallRecord): void {
    const list = this.calls.get(id) ?? [];
    list.push(r);
    if (list.length > 100) list.shift();
    this.calls.set(id, list);
    try {
      appendFileSync(path.join(this.deps.dataDir, "logs", "tools.jsonl"), `${JSON.stringify({ ...r, preview: undefined })}\n`);
    } catch {
      /* the log is a convenience */
    }
  }

  /** The tools a turn in `session` may use, with the policy and approvals wired in. */
  async toolsFor(session: string): Promise<AgentTool[]> {
    const out: AgentTool[] = [];
    for (const e of this.entries()) {
      const st = this.saved.integrations[e.id];
      if (!st?.enabled || this.missing(e, st).length || (e.source.kind === "npm" && !st.installed)) continue;
      if (!st.tools) await this.refresh(e.id);
      if (!this.state(e.id).tools?.length || this.errors.has(e.id)) continue;
      const allowed = (this.chatAllowed.get(session) ?? new Set<string>());
      out.push(
        ...agentTools(this.source(e.id), this.state(e.id).tools!, {
          server: e.id,
          label: e.name,
          policy: (t) => (allowed.has(`${e.id}:${t.name}`) && this.policyOf(e.id, t) === "ask" ? "allow" : this.policyOf(e.id, t)),
          approve: async (req, emit, signal) => {
            const d = await this.deps.approve(req, emit, signal);
            if (d === "allow-chat") {
              allowed.add(`${e.id}:${req.tool}`);
              this.chatAllowed.set(session, allowed);
            }
            return d === "deny" ? "deny" : "allow";
          },
          record: (r) => this.record(e.id, r),
        }),
      );
    }
    return out;
  }

  /** Run one tool from Settings with given input: the user asked for it, so no approval. */
  async test(id: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; ms: number }> {
    const started = Date.now();
    const res = await this.source(id).callTool(tool, args, AbortSignal.timeout(60_000));
    this.record(id, { at: new Date().toISOString(), server: id, tool, args, decision: "allowed", ok: !res.isError, ms: Date.now() - started, preview: res.text.slice(0, 300) });
    return { ...res, text: res.text.slice(0, 20_000), ms: Date.now() - started };
  }
}
