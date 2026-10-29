// Integrations: the tools the model may use beyond drawing UI. This file is
// the app's choice of WHAT to offer: a curated catalog of built-in tools,
// official MCP reference servers and vendors' own servers, each pinned to a
// version. HOW they are installed and run (pinned, script-free installs, a
// folder of their own, only their declared keys, per-tool policies,
// approvals, the call log) is the framework's `Integrations`
// (@vak/mcp/client), so its safety rules apply unchanged. Keys go to the
// app's secret store (the Keychain on macOS).

import path from "node:path";
import { type CatalogEntry, Integrations, type IntegrationsOptions, timeServer, webFetchServer } from "@vak/mcp/client";
import { ollamaOcrServer } from "./ocr.ts";
import { sandboxExecutionEntry } from "./sandbox-execution.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import type { Media } from "./media/index.ts";

/** Only documented workspace MCP endpoints may receive this integration's bearer token. */
export function databricksEndpoint(config: Record<string, unknown>): string {
  const value = String(config.endpoint ?? "").trim();
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Enter the full HTTPS MCP server URL from your Databricks workspace."); }
  const hosts = [".cloud.databricks.com", ".azuredatabricks.net", ".gcp.databricks.com"];
  if (url.protocol !== "https:" || !hosts.some((suffix) => url.hostname.endsWith(suffix) && url.hostname.length > suffix.length) ||
      url.username || url.password || url.port || url.search || url.hash ||
      !(/^\/ai-gateway\/mcp-services\/[^/]+\/?$/.test(url.pathname) || /^\/api\/2\.0\/mcp\/[^/]+(?:\/[^/]+)*\/?$/.test(url.pathname))) {
    throw new Error("Use a Databricks workspace HTTPS MCP URL (/ai-gateway/mcp-services/… or /api/2.0/mcp/…), without credentials, a port, query or fragment. Databricks Apps require OAuth and are not supported here.");
  }
  return url.href;
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
    id: "ocr",
    name: "OCR (local)",
    publisher: "vak",
    trust: "built-in",
    summary: "Read the text in images with a local OCR model.",
    description: "Reads text, tables and formulas from image files using an OCR model in your local Ollama (GLM-OCR: ollama pull glm-ocr). Images never leave this computer for recognition.",
    homepage: "https://ollama.com/library/glm-ocr",
    icon: "image",
    access: ["Image files you point it at", "Your local Ollama only"],
    source: { kind: "builtin", server: () => ollamaOcrServer() },
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
    id: "tavily",
    name: "Tavily",
    publisher: "Tavily",
    trust: "vendor",
    summary: "Search, read and research the web.",
    description: "Tavily's own remote MCP server: web search tuned for AI answers, clean text from pages, site maps and crawls, and multi-source research reports, so answers cite current sources.",
    homepage: "https://github.com/tavily-ai/tavily-mcp",
    icon: "search",
    access: ["Sends your searches and the pages to read to Tavily", "Needs a Tavily API key; each call uses your Tavily credits", "Asks before each call unless you allow it for the chat"],
    // The hosted server rather than the npm package: nothing third-party runs here, and the key travels in a header, never the URL.
    source: { kind: "http", url: "https://mcp.tavily.com/mcp/" },
    config: [{ key: "apiKey", label: "Tavily API key", kind: "secret", required: true, header: { name: "authorization", format: "Bearer {value}" }, help: "From app.tavily.com (a free plan exists)." }],
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
    id: "databricks",
    name: "Databricks",
    publisher: "Databricks",
    trust: "vendor",
    summary: "Query governed data and use workspace tools.",
    description: "Connects to a Databricks-provided or registered remote MCP in your workspace, or a legacy workspace MCP endpoint. Available tools and data depend on the server URL and your permissions. Uses a personal access token for local testing; browser sign-in, automatic token refresh and servers hosted on Databricks Apps are not supported.",
    homepage: "https://docs.databricks.com/aws/en/agents/mcp-tools/built-in-mcp-services",
    icon: "table",
    access: ["Sends tool inputs to the workspace MCP URL you configure", "Can query data, run code or change resources within your account permissions", "Calls may incur workspace compute or service charges", "Tools use the existing per-tool approval policies"],
    source: { kind: "http", url: databricksEndpoint },
    config: [
      { key: "endpoint", label: "Databricks MCP server URL", kind: "text", required: true, help: "Copy the full MCP URL from your workspace. Example: https://<workspace-hostname>/ai-gateway/mcp-services/system.ai.dbsql. Choose only the service you want to expose; workspace features and grants must be enabled." },
      { key: "token", label: "Databricks personal access token", kind: "secret", required: true, header: { name: "authorization", format: "Bearer {value}" }, help: "Create a short-lived token in your workspace with only the access you need. Saved in the app's secret store and sent only as an Authorization header. Replace it here when it expires. Databricks recommends OAuth for production/team use." },
    ],
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
  {
    id: "zerodha",
    name: "Zerodha",
    publisher: "Zerodha",
    trust: "vendor",
    summary: "Live quotes, portfolio holdings, orders and trades with Kite.",
    description: "Zerodha's hosted Kite MCP server: market data quotes, historical candles, portfolio holdings, positions, and order management. Login is handled securely in your browser via Zerodha; no API credentials need to be stored in the app.",
    homepage: "https://github.com/zerodha/kite-mcp-server",
    icon: "chart",
    access: [
      "Your Zerodha account, after signing in through your browser",
      "Live quotes, holdings, positions, and order history",
      "Asks before placing, modifying, or cancelling any order",
    ],
    source: { kind: "http", url: "https://mcp.kite.trade/mcp" },
    config: [],
  },
  {
    id: "nse",
    name: "NSE",
    publisher: "NSE",
    trust: "vendor",
    summary: "Historical bhavcopy, stock prices and market breadth from the National Stock Exchange of India.",
    description: "National Stock Exchange of India's official hosted Bhavcopy MCP server: up to 5 years of historical end-of-day cash market data, daily bhavcopy, advances/declines, delivery volumes and 52-week highs/lows. Public and authentication-free.",
    homepage: "https://www.nseindia.com/nse-mcp",
    icon: "chart",
    access: [
      "Public market data from the National Stock Exchange of India",
      "Historical cash market data and daily bhavcopy records for the last 5 years",
      "No credentials or API keys required",
    ],
    source: { kind: "http", url: "https://mcp.nseindia.in/bhavcopy/cm/mcp" },
    config: [],
  },
  {
    id: "nse-cmmkt",
    name: "NSE Market Live",
    publisher: "NSE",
    trust: "vendor",
    summary: "Near-real-time equity quotes, indices and market snapshots from the National Stock Exchange of India.",
    description: "National Stock Exchange of India's official hosted CM Market Live MCP server: near-real-time snapshots of the current trading day, stock quotes, top gainers/losers, indices and active securities. Public and authentication-free.",
    homepage: "https://www.nseindia.com/nse-mcp",
    icon: "chart",
    access: [
      "Public market data from the National Stock Exchange of India",
      "Near-real-time trading day snapshots, live quotes and index performance",
      "No credentials or API keys required",
    ],
    source: { kind: "http", url: "https://mcp.nseindia.in/cmmkt/mcp" },
    config: [],
  },
];

/** Enforce the indestructible engine pin and safety policy on integration catalog entries. */
export function validateCatalogEntry(entry: CatalogEntry): void {
  if (entry.source.kind === "npm") {
    const v = entry.source.version;
    if (!v || v === "latest" || /[\^~*><]/.test(v)) {
      throw new Error(`Integration ${entry.id} specifies an invalid version: ${v}. Exact pinned version required.`);
    }
  } else if (entry.source.kind === "http") {
    if (typeof entry.source.url === "string") {
      const u = new URL(entry.source.url);
      if (u.protocol !== "https:") {
        throw new Error(`Integration ${entry.id} uses insecure protocol: ${u.protocol}. Only HTTPS allowed.`);
      }
    }
  }
}

/** Keep one live catalog array so reviewed imports reach the existing lifecycle. */
export function integrationCatalog(media?: Media, binaryPath = "vaksb", dataDir = ".", getWorkspace?: () => string, workspaces?: WorkspaceRegistry): CatalogEntry[] {
  const catalog = [...CATALOG, ...(media?.entries() ?? []), sandboxExecutionEntry({
    binaryPath, dataDir,
    enabled: () => process.env.VAK_SANDBOX_ENABLED !== "false",
    workspace: getWorkspace ?? (() => process.env.VAK_SANDBOX_WORKSPACE ?? ""),
    workspaces,
  })];
  for (const entry of catalog) {
    validateCatalogEntry(entry);
  }
  return catalog;
}

/** App-owned catalog entries run through the framework's common integration lifecycle. */
export function createIntegrations(
  deps: Omit<IntegrationsOptions, "catalog" | "enabledAtFirstRun">,
  media?: Media,
  catalog?: CatalogEntry[],
  getWorkspace?: () => string,
  workspaces?: WorkspaceRegistry,
): Integrations {
  return new Integrations({
    ...deps,
    catalog: catalog ?? integrationCatalog(media, deps.vakSandbox?.binaryPath, deps.dataDir, getWorkspace, workspaces),
    enabledAtFirstRun: ["time", "sandbox-execution"],
  });
}
