// Recorded-shape tool responses for the built-in apps' tests. Values are
// synthetic but follow each source's documented output exactly, so the apps'
// real parsers, validation and receipts run unchanged.
import { DuckDBInstance } from "@duckdb/node-api";

const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
export const nseHistory = (symbol: string, sessions = 22) => ({
  symbol,
  data: Array.from({ length: sessions }, (_, i) => {
    const close = 1000 + i * 5 - (i % 4 === 3 ? 20 : 0);
    return { symbol, series: "EQ", date: day(i), open: close - 3, high: close + 8, low: close - 9, close, volume: 100000 + i * 1000 };
  }),
});
export const nseQuote = (symbol: string) => ({
  stock: { symbol, series: "EQ", lastTradedPrice: 1101, preClosePrice: 1090, perChange: 1.01, openPrice: 1092, highPrice: 1105, lowPrice: 1088, volume: 250000, latestTimestamp: "30-Oct-2026 15:30:00" },
  updatedAt: "2026-10-30T10:05:00.000Z",
});
const index = (indexName: string, last: number, previousClose: number) => ({ indexName, last, previousClose, percChange: Number(((last / previousClose - 1) * 100).toFixed(2)), timeVal: "30-Oct-2026 15:30" });
export const nseIndices = (group: string) => ({
  indices: { [group]: group === "sectoral" ? [index("NIFTY IT", 41000, 40500), index("NIFTY AUTO", 23000, 23200)] : group === "broad" ? [index("NIFTY 50", 25000, 24900), index("NIFTY BANK", 52000, 52100)] : [index("NIFTY 50 FUTURES", 25050, 24950)] },
  nseTimestamp: "30-Oct-2026 15:30", updatedAt: "2026-10-30T10:05:00.000Z",
});
/** The NSE tools as the host returns them (MCP text content). */
export async function nseTool(name: string, args: Record<string, unknown>) {
  const body = name === "nse-cmmkt__cm_get_live_indices" ? nseIndices(String(args.group)) : name === "nse-cmmkt__cm_get_stock_quote" ? nseQuote(String(args.symbol)) : name === "nse__get_stock_history" ? nseHistory(String(args.symbol)) : null;
  if (!body) throw new Error(`Unexpected tool ${name}`);
  return { text: JSON.stringify(body) };
}

export const rss = (title: string, url: string) => `<rss version="2.0"><channel><item><title><![CDATA[${title}]]></title><link>${url}?utm_source=feed</link><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Source excerpt for ${title}</p>]]></description></item></channel></rss>`;
/** web__fetch_page for feeds: the original response body after its URL line. */
export async function feedTool(_name: string, args: Record<string, unknown>) {
  const url = String(args.url);
  return `URL: ${url}\n\n${rss(`Story from ${new URL(url).pathname}`, url.replace(/\.xml$/, "/story"))}`;
}

const issue = (repo: string, n: number, state = "open", pull = false) => ({ number: n, title: `Item ${n}`, state, html_url: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${n}`, updated_at: `2026-10-2${n % 9}T10:00:00Z`, labels: [{ name: "bug" }], user: { login: "author" }, ...(pull ? { pull_request: {} } : {}) });
/** web__fetch_page for the repository API: issues, pulls and commits pages. */
export async function repoTool(_name: string, args: Record<string, unknown>) {
  const url = String(args.url);
  const repo = /repos\/([^/]+\/[^/]+)\//.exec(url)![1]!;
  const body = url.includes("/issues?") ? [issue(repo, 1), issue(repo, 2, "closed"), issue(repo, 3, "open", true)]
    : url.includes("/pulls?") ? [issue(repo, 3, "open", true)]
    : [{ sha: "a".repeat(40), html_url: `https://github.com/${repo}/commit/${"a".repeat(40)}`, commit: { message: "Fix the thing\n\nBody", author: { name: "Dev", date: "2026-10-29T09:00:00Z" } } }];
  return `URL: ${url}\n\n${JSON.stringify(body)}`;
}

/** An in-memory DuckDB with the runtime's `context.database` shape. */
export async function memoryDatabase() {
  const instance = await DuckDBInstance.create(":memory:", { enable_external_access: "false" }), conn = await instance.connect();
  return {
    database: {
      async run(sql: string, args?: (string | number | null)[]) { await conn.run(sql, args as never); },
      async query(sql: string, args?: (string | number | null)[]) { return (await conn.runAndReadAll(sql, args as never)).getRowObjectsJson() as Record<string, unknown>[]; },
    },
    close() { conn.closeSync(); instance.closeSync(); },
  };
}
