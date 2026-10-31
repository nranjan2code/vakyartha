// NSE Market Terminal: delayed NSE observations from the declared NSE read
// tools. Quotes, index snapshots, controls and receipts live in `context.state`;
// daily OHLCV lives in DuckDB `prices`. `view()` derives every surface from
// those two owners on each run, and a failed read is recorded, never filled in.
import { initialize, saveHistory, analyze, type Database } from './analytics.ts';
import { decode, history, quote, indices, text } from './source.ts';

type Quote = ReturnType<typeof quote> & { fetchedAt: string };
type Index = ReturnType<typeof indices>[number];
export type Analysis = Awaited<ReturnType<typeof analyze>>;
export interface Receipt { subject: string; tool: string; fetchedAt: string; sourceAt: string; rows: number; status: string }
export interface State {
  watchlist?: string[]; watchDraft?: string; symbol?: string; symbolDraft?: string; months?: string;
  quotes?: Record<string, Quote>; broad?: Index[]; sectoral?: Index[]; derivatives?: Index[];
  receipts?: Receipt[]; historyFor?: Record<string, string>; problem?: string; checkedAt?: string;
}
export interface Context {
  state: State; surfaces?: Record<string, unknown>; database: Database;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
interface Node { id: string; type: string; props?: Record<string, unknown>; children?: string[] | { each: string; template: string } }
interface Update { surface: string; nodes: Node[]; data: { op: 'replace'; path: '/'; value: Record<string, unknown> }[] }

const DEFAULT_WATCH = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
const MAX_WATCH = 6;
const HEADLINE = ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100'];
export const TITLES: Record<string, string> = { market: 'Market', instrument: 'Instrument', sources: 'Sources' };
export const EMPTY_ANALYSIS: Analysis = { rows: [], sessions: 0, averageVolume: null, low: null, high: null, volatility: null, priceReturn: null, maxDrawdown: null };

// --- canonical state ---------------------------------------------------------------

const SYMBOL = /^[A-Z0-9][A-Z0-9&.-]{0,24}$/;
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v : '').slice(0, max);
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Comma or space separated symbols to an exact, de-duplicated list; throws a sentence the person can act on. */
export function symbols(value: unknown): string[] {
  const list = [...new Set(String(value ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean))];
  const bad = list.find((s) => !SYMBOL.test(s));
  if (bad) throw new Error(`"${bad}" is not an NSE equity symbol`);
  if (!list.length || list.length > MAX_WATCH) throw new Error(`Enter 1–${MAX_WATCH} NSE symbols, separated by commas`);
  return list;
}
const validIndex = (r: Index) => r && typeof r.label === 'string' && finite(r.last) && finite(r.changePct) && typeof r.exchangeAt === 'string';
const validQuote = (q: Quote) => q && typeof q.symbol === 'string' && finite(q.last) && finite(q.previous) && finite(q.changePct) && finite(q.high) && finite(q.low) && finite(q.volume) && typeof q.exchangeAt === 'string';

/** State arrives as untrusted JSON, possibly from version 1 (watchlist as one string). */
export function normalize(s: State): State {
  let watchlist = DEFAULT_WATCH;
  try { watchlist = symbols(Array.isArray(s.watchlist) ? s.watchlist.join(',') : s.watchlist ?? DEFAULT_WATCH.join(',')); } catch { /* keep the default */ }
  const symbol = typeof s.symbol === 'string' && SYMBOL.test(s.symbol) ? s.symbol : watchlist[0]!;
  const quotes: Record<string, Quote> = {};
  for (const [k, q] of Object.entries(s.quotes && typeof s.quotes === 'object' ? s.quotes : {})) if (SYMBOL.test(k) && validQuote(q)) quotes[k] = q;
  const group = (v: unknown) => (Array.isArray(v) ? v.filter(validIndex).slice(0, 100) : []);
  const historyFor: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.historyFor && typeof s.historyFor === 'object' ? s.historyFor : {})) if (SYMBOL.test(k) && typeof v === 'string') historyFor[k] = v.slice(0, 200);
  return {
    watchlist, watchDraft: typeof s.watchDraft === 'string' ? str(s.watchDraft, 200) : watchlist.join(', '),
    symbol, symbolDraft: typeof s.symbolDraft === 'string' ? str(s.symbolDraft, 30) : symbol,
    months: ['1', '2', '3'].includes(String(s.months)) ? String(s.months) : '1',
    quotes, broad: group(s.broad), sectoral: group(s.sectoral), derivatives: group(s.derivatives),
    receipts: (Array.isArray(s.receipts) ? s.receipts : []).filter((r) => r && typeof r.tool === 'string').slice(0, 40),
    historyFor, problem: typeof s.problem === 'string' ? s.problem.slice(0, 400) : undefined, checkedAt: typeof s.checkedAt === 'string' ? s.checkedAt : undefined,
  };
}

// --- governed reads ----------------------------------------------------------------

/** One tool read: parse and commit on success, record a receipt either way. Returns the failure, if any. */
async function read(ctx: Context, tool: string, args: Record<string, unknown>, parse: (raw: Record<string, unknown>) => { sourceAt: string; rows: number; commit(): Promise<void> | void }) {
  const s = ctx.state, fetchedAt = new Date().toISOString(), subject = String(args.symbol ?? args.group ?? '');
  try {
    const parsed = parse(decode(await ctx.callTool(tool, args)));
    await parsed.commit();
    s.receipts!.unshift({ subject, tool, fetchedAt, sourceAt: parsed.sourceAt, rows: parsed.rows, status: 'Validated' });
    return undefined;
  } catch (e) {
    const message = (e as Error).message.slice(0, 250);
    s.receipts!.unshift({ subject, tool, fetchedAt, sourceAt: '', rows: 0, status: `Failed: ${message}` });
    return `${subject}: ${message}`;
  } finally { s.receipts = s.receipts!.slice(0, 40); }
}
function settle(s: State, failures: (string | undefined)[]) {
  const failed = failures.filter(Boolean) as string[];
  s.checkedAt = new Date().toISOString();
  s.problem = failed.length ? `${failed.length} of ${failures.length} reads failed; earlier observations are kept. First: ${failed[0]}${failed.length === failures.length ? ` ${SETUP}` : ''}` : undefined;
}
const readQuote = (ctx: Context, selected: string) => read(ctx, 'nse-cmmkt__cm_get_stock_quote', { symbol: selected }, (raw) => {
  const q = quote(raw, selected);
  return { sourceAt: `${q.exchangeAt} IST; cache ${q.updatedAt}`, rows: 1, commit() { ctx.state.quotes![selected] = { ...q, fetchedAt: new Date().toISOString() }; } };
});

/** Indices and every saved watchlist quote; also the scheduled refresh. */
export async function refreshMarket(ctx: Context) {
  const s = (ctx.state = normalize(ctx.state));
  const failures: (string | undefined)[] = [];
  for (const group of ['broad', 'sectoral', 'derivatives'] as const) {
    failures.push(await read(ctx, 'nse-cmmkt__cm_get_live_indices', { group, nameFilter: '' }, (raw) => {
      const rows = indices(raw, group);
      return { sourceAt: `${text(raw.nseTimestamp)} IST; cache ${text(raw.updatedAt)}`, rows: rows.length, commit() { s[group] = rows; } };
    }));
  }
  for (const selected of s.watchlist!) failures.push(await readQuote(ctx, selected));
  settle(s, failures);
  return render(ctx);
}
async function fetchInstrument(ctx: Context) {
  const s = ctx.state, selected = s.symbol!, months = Number(s.months);
  await initialize(ctx.database);
  const failures = [await readQuote(ctx, selected)];
  failures.push(await read(ctx, 'nse__get_stock_history', { symbol: selected, months, endDate: 'today' }, (raw) => {
    const bars = history(raw, selected);
    return { sourceAt: `${bars[0]!.date} – ${bars.at(-1)!.date} (daily NSE records)`, rows: bars.length, async commit() {
      await saveHistory(ctx.database, selected, bars);
      s.historyFor![selected] = `${months} month request · ${bars[0]!.date} – ${bars.at(-1)!.date}`;
    } };
  }));
  settle(s, failures);
}

// --- actions ---------------------------------------------------------------------

async function render(ctx: Context, focusSurface?: string) {
  await initialize(ctx.database);
  const analysis = await analyze(ctx.database, ctx.state.symbol!);
  return { updates: view(ctx.state, analysis), ...(focusSurface ? { focusSurface } : {}) };
}

export async function handleAction(controlId: string, value: unknown, ctx: Context, action?: string) {
  const s = (ctx.state = normalize(ctx.state));
  if (!action) {
    // Drafts save as they are typed; they are validated when a refresh uses them.
    if (controlId === '/watchDraft') s.watchDraft = str(value, 200);
    else if (controlId === '/symbolDraft') s.symbolDraft = str(value, 30).toUpperCase();
    else if (controlId === '/months') { if (!['1', '2', '3'].includes(String(value))) throw new Error('Choose 1, 2 or 3 months'); s.months = String(value); }
    else throw new Error(`Unknown terminal field: ${controlId}`);
    return render(ctx);
  }
  if (action === 'refresh_market') {
    // A scheduled refresh uses the saved watchlist; pressing Refresh applies the typed one first.
    s.watchlist = symbols(s.watchDraft);
    s.watchDraft = s.watchlist.join(', ');
    return refreshMarket(ctx);
  }
  if (action === 'fetch_instrument') {
    const list = symbols(s.symbolDraft);
    if (list.length !== 1) throw new Error('Enter one NSE symbol to fetch');
    const selected = list[0]!;
    s.symbol = s.symbolDraft = selected;
    await fetchInstrument(ctx);
    return render(ctx);
  }
  if (action === 'open_instrument') {
    const selected = String((value as { symbol?: unknown } | null)?.symbol ?? '');
    if (!s.watchlist!.includes(selected)) throw new Error('That symbol is no longer on the watchlist');
    s.symbol = s.symbolDraft = selected;
    await fetchInstrument(ctx);
    return render(ctx, 'instrument');
  }
  if (action === 'recalculate') return render(ctx);
  throw new Error(`Unknown terminal action: ${action}`);
}

// --- derived views -----------------------------------------------------------------

const num = (n: number, digits = 2) => n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const inr = (n: number) => `₹${num(n)}`;
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const count = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const tone = (n: number) => (n > 0 ? 'success' : n < 0 ? 'danger' : 'neutral');
const ist = (iso: string | undefined) => {
  const d = new Date(iso ?? '');
  return Number.isFinite(d.getTime()) ? `${d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST` : '';
};
const replaceAll = (value: Record<string, unknown>) => [{ op: 'replace' as const, path: '/' as const, value }];
const SETUP = 'In Settings → Integrations, enable NSE and NSE Market Live and set this app’s three NSE read tools to Allow.';
const problemNode = (id: string): Node => ({ id, type: 'alert', props: { title: 'Refresh incomplete', body: '{/problem}', tone: 'warning' } });
const METHODS = 'Volatility is the sample standard deviation of daily simple returns × √252; it is indicative with short histories. Drawdown is measured from the running closing peak. The 20-session average starts at the twentieth observation. Prices are unadjusted for dividends and corporate actions. Candles are spaced by trading session, not by calendar time.';

/** All three surfaces from the saved observations and the DuckDB analysis of the selected symbol. */
export function view(input: State, analysis: Analysis = EMPTY_ANALYSIS): Update[] {
  const s = normalize(input);
  return [marketSurface(s), instrumentSurface(s, analysis), sourcesSurface(s)];
}

function marketSurface(s: State): Update {
  const all = [...new Map([...s.derivatives!, ...s.broad!].map((r) => [r.label, r])).values()];
  const sectors = s.sectoral!;
  const quoted = s.watchlist!.filter((w) => s.quotes![w]);
  const any = all.length > 0 || sectors.length > 0 || quoted.length > 0;
  const headline = HEADLINE.map((name) => all.find((r) => r.label === name)).filter((r): r is Index => !!r);
  const stamp = [...all, ...sectors][0]?.exchangeAt;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['market-bar', ...(s.problem ? ['market-problem'] : []), ...(any ? ['market-line', ...(headline.length ? ['headline'] : []), 'watch-section', ...(sectors.length || all.length ? ['market-panels'] : [])] : ['market-empty'])] },
    { id: 'market-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['watch-input', 'refresh-market'] },
    { id: 'watch-input', type: 'input', props: { label: `Watchlist · up to ${MAX_WATCH} NSE symbols`, bind: '/watchDraft', placeholder: 'RELIANCE, TCS, INFY' } },
    { id: 'refresh-market', type: 'button', props: { label: 'Refresh', action: 'refresh_market', style: 'primary' } },
    ...(s.problem ? [problemNode('market-problem')] : []),
    ...(any ? [
      { id: 'market-line', type: 'text', props: { content: '{/line}', variant: 'caption' } },
      ...(headline.length ? [
        { id: 'headline', type: 'grid', props: { columns: 4, minItemWidth: 'sm', gap: 'sm' }, children: { each: '/headline', template: 'headline-stat' } },
        { id: 'headline-stat', type: 'stat', props: { label: '{label}', value: '{level}', delta: '{change}' } },
      ] : []),
      { id: 'watch-section', type: 'section', props: { title: 'Watchlist', description: 'Delayed quotes. Open one for its daily history and analytics.' }, children: quoted.length ? ['watch-split'] : ['watch-cards'] },
      ...(quoted.length ? [
        { id: 'watch-split', type: 'split', props: { ratio: '2:1', gap: 'md' }, children: ['watch-cards', 'watch-chart'] },
        { id: 'watch-chart', type: 'chart', props: { kind: 'bar', orientation: 'horizontal', colorBy: 'sign', title: 'Session change (%)', series: { records: '{/moves}', label: 'symbol', fields: ['changePct'] }, height: 'sm' } },
      ] : []),
      { id: 'watch-cards', type: 'grid', props: { columns: quoted.length ? 2 : 3, minItemWidth: 'sm', gap: 'sm' }, children: { each: '/watch', template: 'watch-card' } },
      { id: 'watch-card', type: 'card', props: { title: '{symbol}', subtitle: '{price}', badge: '{change}', body: '{detail}', tone: '{tone}' }, children: ['watch-open'] },
      { id: 'watch-open', type: 'button', props: { label: 'Open', action: 'open_instrument', payload: { symbol: '{symbol}' }, style: 'link' } },
      ...(sectors.length || all.length ? [
        { id: 'market-panels', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'md' }, children: [...(sectors.length ? ['sector-section'] : []), ...(all.length ? ['index-section'] : [])] },
        ...(sectors.length ? [
          { id: 'sector-section', type: 'section', props: { title: 'Sector rotation', description: '{/coverage}' }, children: ['sector-chart'] },
          { id: 'sector-chart', type: 'chart', props: { kind: 'bar', orientation: 'horizontal', colorBy: 'sign', title: 'Sector indices · session change (%)', series: { records: '{/sectors}', label: 'label', fields: ['changePct'] }, height: 'md' } },
        ] : []),
        ...(all.length ? [
          { id: 'index-section', type: 'section', props: { title: 'Index monitor' }, children: ['index-table'] },
          { id: 'index-table', type: 'table', props: { rows: '{/indices}', columns: [{ key: 'label', label: 'Index' }, { key: 'level', label: 'Level', align: 'end' }, { key: 'change', label: 'Session', align: 'end' }, { key: 'exchangeAt', label: 'Exchange time' }], sortable: true, searchable: true, pageSize: 10 } },
        ] : []),
      ] : []),
    ] : [{ id: 'market-empty', type: 'card', props: { title: 'No market data yet', body: `${SETUP} Then press Refresh: indices, sector moves and your watchlist quotes appear here with their exchange times.` } }]),
  ];
  const data = {
    watchDraft: s.watchDraft,
    ...(s.problem ? { problem: s.problem } : {}),
    ...(any ? {
      line: ['NSE delayed snapshot · INR · informational use', stamp ? `exchange ${stamp} IST` : '', s.checkedAt ? `checked ${ist(s.checkedAt)}` : ''].filter(Boolean).join(' · '),
      headline: headline.map((r) => ({ label: r.label, level: num(r.last), change: pct(r.changePct) })),
      watch: s.watchlist!.map((w) => {
        const q = s.quotes![w];
        return q
          ? { symbol: w, price: inr(q.last), change: pct(q.changePct), detail: `Range ${inr(q.low)} – ${inr(q.high)} · ${count(q.volume)} shares · ${q.exchangeAt} IST`, tone: tone(q.changePct) }
          : { symbol: w, price: 'No quote yet', change: '', detail: 'Refresh to load its delayed quote.', tone: 'neutral' };
      }),
      ...(quoted.length ? { moves: quoted.map((w) => ({ symbol: w, changePct: s.quotes![w]!.changePct })) } : {}),
      ...(sectors.length ? {
        sectors: sectors.map((r) => ({ label: r.label, changePct: r.changePct })),
        coverage: `${sectors.filter((r) => r.changePct > 0).length} rising, ${sectors.filter((r) => r.changePct < 0).length} falling, ${sectors.filter((r) => r.changePct === 0).length} unchanged sector indices. Index coverage, not market breadth.`,
      } : {}),
      ...(all.length ? { indices: all.map((r) => ({ label: r.label, level: num(r.last), change: pct(r.changePct), exchangeAt: `${r.exchangeAt} IST` })) } : {}),
    } : {}),
  };
  return { surface: 'market', nodes, data: replaceAll(data) };
}

function instrumentSurface(s: State, a: Analysis): Update {
  const selected = s.symbol!, q = s.quotes![selected], has = a.rows.length > 0;
  const sma = a.rows.filter((r) => r.sma20 !== null);
  const first = a.rows[0], last = a.rows.at(-1);
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['inst-bar', ...(s.problem ? ['inst-problem'] : []), ...(q ? ['quote-section'] : []), ...(has ? ['history-section', 'risk-section', 'ohlcv-section'] : []), ...(!q && !has ? ['inst-empty'] : [])] },
    { id: 'inst-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['symbol-input', 'months', 'fetch-instrument'] },
    { id: 'symbol-input', type: 'input', props: { label: 'NSE symbol', bind: '/symbolDraft', placeholder: 'RELIANCE' } },
    { id: 'months', type: 'select', props: { label: 'Daily history', bind: '/months', options: [{ label: '1 month', value: '1' }, { label: '2 months', value: '2' }, { label: '3 months', value: '3' }] } },
    { id: 'fetch-instrument', type: 'button', props: { label: 'Fetch quote & history', action: 'fetch_instrument', style: 'primary' } },
    ...(s.problem ? [problemNode('inst-problem')] : []),
    ...(q ? [
      { id: 'quote-section', type: 'section', props: { title: '{/quoteTitle}', description: '{/quoteTime}' }, children: ['quote-stats'] },
      { id: 'quote-stats', type: 'grid', props: { columns: 4, minItemWidth: 'sm', gap: 'sm' }, children: ['q-last', 'q-range', 'q-previous', 'q-volume'] },
      { id: 'q-last', type: 'stat', props: { label: 'Last · INR', value: '{/quote/last}', delta: '{/quote/change}' } },
      { id: 'q-range', type: 'stat', props: { label: 'Session low – high', value: '{/quote/range}' } },
      { id: 'q-previous', type: 'stat', props: { label: 'Previous close', value: '{/quote/previous}' } },
      { id: 'q-volume', type: 'stat', props: { label: 'Volume · shares', value: '{/quote/volume}' } },
    ] : []),
    ...(has ? [
      { id: 'history-section', type: 'section', props: { title: 'Daily price', description: '{/historyWindow}' }, children: ['price-split', 'interpretation'] },
      { id: 'price-split', type: 'split', props: { ratio: '2:1', gap: 'md' }, children: ['candles', 'risk-stats'] },
      { id: 'candles', type: 'chart', props: { kind: 'candlestick', title: '{/ohlcTitle}', series: { records: '{/history}', label: 'date', fields: ['open', 'high', 'low', 'close'] }, yScale: 'auto', height: 'md' } },
      { id: 'interpretation', type: 'text', props: { content: '{/interpretation}', variant: 'caption' } },
      { id: 'risk-section', type: 'section', props: { title: 'Analytics', description: 'Computed in DuckDB from the saved daily observations.' }, children: ['risk-charts'] },
      { id: 'risk-stats', type: 'grid', props: { columns: 2, minItemWidth: 'sm', gap: 'sm' }, children: ['r-return', 'r-vol', 'r-drawdown', 'r-sessions'] },
      { id: 'r-return', type: 'stat', props: { label: 'Price return', value: '{/stats/priceReturn}' } },
      { id: 'r-vol', type: 'stat', props: { label: 'Annualized volatility', value: '{/stats/volatility}' } },
      { id: 'r-drawdown', type: 'stat', props: { label: 'Max closing drawdown', value: '{/stats/maxDrawdown}' } },
      { id: 'r-sessions', type: 'stat', props: { label: 'Sessions · avg volume', value: '{/stats/sessions}' } },
      { id: 'risk-charts', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'md' }, children: [...(sma.length ? ['sma-chart'] : []), 'returns-chart', 'volume-chart', 'drawdown-chart'] },
      { id: 'returns-chart', type: 'chart', props: { kind: 'bar', colorBy: 'sign', title: 'Daily return (%)', series: { records: '{/returns}', label: 'date', fields: ['returnPct'] }, height: 'sm' } },
      { id: 'volume-chart', type: 'chart', props: { kind: 'bar', title: 'Daily volume · shares', series: { records: '{/history}', label: 'date', fields: ['volume'] }, height: 'sm' } },
      { id: 'drawdown-chart', type: 'chart', props: { kind: 'line', title: 'Drawdown from closing peak (%)', series: { records: '{/history}', label: 'date', fields: ['drawdownPct'] }, height: 'sm' } },
      ...(sma.length ? [{ id: 'sma-chart', type: 'chart', props: { kind: 'line', title: 'Close and 20-session average · INR', series: { records: '{/sma}', label: 'date', fields: ['close', 'sma20'] }, yScale: 'auto', height: 'sm' } }] : []),
      { id: 'ohlcv-section', type: 'section', props: { title: 'Exact observations' }, children: ['ohlcv'] },
      { id: 'ohlcv', type: 'table', props: { rows: '{/history}', columns: [{ key: 'date', label: 'Session' }, { key: 'open', label: 'Open', align: 'end' }, { key: 'high', label: 'High', align: 'end' }, { key: 'low', label: 'Low', align: 'end' }, { key: 'close', label: 'Close', align: 'end' }, { key: 'volume', label: 'Volume', align: 'end' }], sortable: true, pageSize: 10 } },
    ] : []),
    ...(!q && !has ? [{ id: 'inst-empty', type: 'text', props: { content: '{/emptyHint}', variant: 'caption' } }] : []),
  ];
  const data = {
    symbolDraft: s.symbolDraft, months: s.months,
    ...(s.problem ? { problem: s.problem } : {}),
    ...(q ? {
      quoteTitle: `${selected} · delayed quote`,
      quoteTime: `Exchange ${q.exchangeAt} IST · cache ${ist(q.updatedAt)} · retrieved ${ist(q.fetchedAt)}`,
      quote: { last: inr(q.last), change: pct(q.changePct), range: `${inr(q.low)} – ${inr(q.high)}`, previous: inr(q.previous), volume: count(q.volume) },
    } : {}),
    ...(has ? {
      ohlcTitle: `${selected} · daily OHLC (INR)`,
      historyWindow: s.historyFor![selected] ?? `${first!.date} – ${last!.date}`,
      history: a.rows, sma, returns: a.rows.filter((r) => r.returnPct !== null).map((r) => ({ date: r.date, returnPct: Number(r.returnPct!.toFixed(3)) })),
      interpretation: `${pct(a.priceReturn)} unadjusted close-to-close return from ${first!.date} to ${last!.date} over ${a.sessions} sessions. Dividends are excluded; corporate actions are not verified.`,
      stats: { priceReturn: pct(a.priceReturn), volatility: a.sessions >= 3 && a.volatility != null ? `${a.volatility.toFixed(2)}%` : 'Needs 3 sessions', maxDrawdown: pct(a.maxDrawdown), sessions: `${a.sessions} · ${count(a.averageVolume)}` },
    } : {}),
    ...(!q && !has ? { emptyHint: `Press Fetch to load ${selected}’s delayed quote and up to ${s.months === '1' ? '1 month' : `${s.months} months`} of daily history. ${SETUP}` } : {}),
  };
  return { surface: 'instrument', nodes, data: replaceAll(data) };
}

function sourcesSurface(s: State): Update {
  const receipts = s.receipts!;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['ledger-section', 'methods-section'] },
    { id: 'ledger-section', type: 'section', props: { title: 'Source ledger', description: 'The latest 40 reads. A failed read keeps earlier observations and never counts as fresh data.' }, children: [receipts.length ? 'receipts' : 'no-receipts'] },
    receipts.length
      ? { id: 'receipts', type: 'table', props: { rows: '{/receipts}', columns: [{ key: 'tool', label: 'Tool' }, { key: 'subject', label: 'Symbol / group' }, { key: 'sourceAt', label: 'Source time' }, { key: 'fetched', label: 'Retrieved' }, { key: 'rows', label: 'Rows', align: 'end' }, { key: 'status', label: 'Status' }], searchable: true, pageSize: 10 } }
      : { id: 'no-receipts', type: 'text', props: { content: `Nothing read yet. ${SETUP}`, variant: 'caption' } },
    { id: 'methods-section', type: 'section', props: { title: 'Methods' }, children: ['methods', 'storage'] },
    { id: 'methods', type: 'text', props: { content: METHODS } },
    { id: 'storage', type: 'text', props: { content: 'Daily OHLCV rows live in this app’s DuckDB database; quotes, index snapshots, settings and receipts are saved with the app. Actions run code only: no model request is made.', variant: 'caption' } },
  ];
  const data = receipts.length ? { receipts: receipts.map((r) => ({ ...r, sourceAt: r.sourceAt || '—', fetched: ist(r.fetchedAt) })) } : {};
  return { surface: 'sources', nodes, data: replaceAll(data) };
}

/** The shipped surface.json: every view of a new, empty app. */
export const surfaceFile = () => view({}).map((u) => ({ id: u.surface, title: TITLES[u.surface], data: u.data[0]!.value, nodes: u.nodes }));
