import { initialize, saveHistory, analyze, type Database } from './analytics.ts';
import { decode, history, quote, indices, text } from './source.ts';

type Quote = ReturnType<typeof quote> & { fetchedAt: string };
type Index = ReturnType<typeof indices>[number];
interface Receipt { subject: string; tool: string; fetchedAt: string; sourceAt: string; rows: number; status: string }
interface State {
  symbol?: string; months?: string; watchlist?: string; query?: string;
  quotes?: Record<string, Quote>; broad?: Index[]; sectoral?: Index[]; derivatives?: Index[];
  receipts?: Receipt[]; message?: string; historyFor?: Record<string, string>;
}
export interface Context {
  state: State; surfaces: Record<string, unknown>; database: Database;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
const money = (n: number | null | undefined) => n == null ? 'Unavailable' : `₹${n.toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2})}`;
const pct = (n: number | null | undefined) => n == null ? 'Unavailable' : `${n>=0?'+':''}${n.toFixed(2)}%`;
const time = (value: string) => { const d=new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('en-GB',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false})+' IST' : value; };
const count = (n: number | null | undefined) => n == null ? 'Unavailable' : n.toLocaleString('en-IN',{maximumFractionDigits:0});
function symbol(value: unknown): string {
  const s=String(value).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9&.-]{0,24}$/.test(s)) throw new Error('Enter an exact NSE equity symbol');
  return s;
}
function settings(s: State) {
  s.symbol ??= 'RELIANCE'; s.months ??= '1'; s.watchlist ??= 'RELIANCE,TCS,INFY,HDFCBANK'; s.query ??= '';
  s.quotes ??= {}; s.receipts ??= []; s.historyFor ??= {};
}
async function read(ctx: Context, tool: string, args: Record<string, unknown>, parse: (raw: Record<string,unknown>) => { sourceAt: string; rows: number; commit(): Promise<void> | void }) {
  const fetchedAt=new Date().toISOString();
  try {
    const parsed=parse(decode(await ctx.callTool(tool,args)));
    await parsed.commit();
    ctx.state.receipts!.unshift({subject:String(args.symbol ?? args.group ?? ''),tool,fetchedAt,sourceAt:parsed.sourceAt,rows:parsed.rows,status:'Validated'});
  } catch (e) {
    const message=(e as Error).message.slice(0,250);
    ctx.state.receipts!.unshift({subject:String(args.symbol ?? args.group ?? ''),tool,fetchedAt,sourceAt:'Unavailable',rows:0,status:`Failed: ${message}`});
    ctx.state.message=`Refresh incomplete. Saved observations retained. ${message}`;
  }
  ctx.state.receipts=ctx.state.receipts!.slice(0,40);
}
async function refreshQuote(ctx: Context, selected: string) {
  await read(ctx,'nse-cmmkt__cm_get_stock_quote',{symbol:selected},raw=>{
    const q=quote(raw,selected);
    return {sourceAt:`${q.exchangeAt} IST; cache ${q.updatedAt}`,rows:1,commit(){ctx.state.quotes![selected]={...q,fetchedAt:new Date().toISOString()};}};
  });
}
export async function refreshMarket(ctx: Context) {
  settings(ctx.state); ctx.state.message='Market refresh completed. Each dataset retains its own source time.';
  await initialize(ctx.database);
  for (const group of ['broad','sectoral','derivatives'] as const) {
    await read(ctx,'nse-cmmkt__cm_get_live_indices',{group,nameFilter:''},raw=>{
      const rows=indices(raw,group), stamp=text(raw.nseTimestamp);
      return {sourceAt:`${stamp} IST; cache ${text(raw.updatedAt)}`,rows:rows.length,commit(){ctx.state[group]=rows;}};
    });
  }
  const watch=[...new Set(ctx.state.watchlist!.split(',').map(symbol))];
  if (watch.length>6) throw new Error('Watchlist supports at most six exact symbols per refresh');
  for (const selected of watch) await refreshQuote(ctx,selected);
  return project(ctx);
}
async function refreshInstrument(ctx: Context) {
  ctx.state.message='Instrument refresh completed. Daily history and delayed quote have separate source times.';
  const selected=symbol(ctx.state.symbol), months=Number(ctx.state.months);
  await refreshQuote(ctx,selected);
  await read(ctx,'nse__get_stock_history',{symbol:selected,months,endDate:'today'},raw=>{
    const bars=history(raw,selected);
    return {sourceAt:`${bars[0]!.date} – ${bars.at(-1)!.date} (daily NSE records)`,rows:bars.length,async commit(){
      await saveHistory(ctx.database,selected,bars); ctx.state.historyFor![selected]=`${months} month request · ${bars[0]!.date} – ${bars.at(-1)!.date}`;
    }};
  });
  return project(ctx);
}
export async function project(ctx: Context) {
  settings(ctx.state); await initialize(ctx.database);
  const s=ctx.state, selected=symbol(s.symbol), q=s.quotes![selected], a=await analyze(ctx.database,selected);
  const broad=[...new Map([...(s.derivatives??[]),...(s.broad??[])].map(r=>[r.label,r])).values()], sectors=s.sectoral??[];
  const watch=s.watchlist!.split(',').map(symbol).map(name=>s.quotes![name]).filter((r):r is Quote=>!!r);
  const index=(name:string)=>broad.find(i=>i.label===name);
  const nifty=index('NIFTY 50'), bank=index('NIFTY BANK');
  const last=a.rows.at(-1), first=a.rows[0];
  const times=s.receipts!.filter(r=>r.status==='Validated').map(r=>`${r.tool}: ${r.sourceAt}`).slice(0,3).join('\n');
  const data={
    symbol:selected,months:s.months,watchlist:s.watchlist,query:s.query,
    watchOptions:s.watchlist!.split(',').map(value=>({label:value,value})),ohlcTitle:`${selected} · daily OHLC (INR)`,
    message:s.message??'Ready to connect. Enable NSE and NSE Market Live in Settings → Integrations; set only this package’s declared read tools to Allow. Then refresh a view.',
    freshness:'NSE delayed snapshots · INR · refresh to recheck saved observations · informational use',
    sourceTimes:times||'No successful retrieval yet. Charts and tables stay empty until validated data arrives.',
    nifty:money(nifty?.last).replace('₹',''),niftyChange:pct(nifty?.changePct), bank:money(bank?.last).replace('₹',''),bankChange:pct(bank?.changePct),
    sectorCount:String(sectors.length),watchCount:`${watch.length} / ${s.watchlist!.split(',').length}`,
    quotePrice:money(q?.last),quoteChange:pct(q?.changePct),quoteTime:q?`Exchange ${q.exchangeAt} IST · cache ${time(q.updatedAt)} · retrieved ${time(q.fetchedAt)}`:'No quote fetched for selected symbol.',
    quoteRange:q?`${money(q.low)} – ${money(q.high)}`:'Unavailable',quoteVolume:count(q?.volume),previous:money(q?.previous),
    historyTitle:`${selected} · daily close (INR)`,historyWindow:s.historyFor![selected]??'No daily history retrieved.',
    historyInterpretation:first&&last?`${selected}: ${pct(a.priceReturn)} unadjusted close-to-close price return, ${first.date} to ${last.date}, across ${a.sessions} observations. This excludes dividends; corporate actions have not been verified.`:'Fetch instrument history to calculate observed price return. No synthetic price series is supplied.',
    history:a.rows, sma:a.rows.filter(r=>r.sma20!==null), priceReturn:pct(a.priceReturn),volatility:pct(a.volatility),maxDrawdown:pct(a.maxDrawdown),sessions:String(a.sessions),averageVolume:count(a.averageVolume),
    analysisNote:'DuckDB SQL uses dated observations only. Volatility = sample standard deviation of daily simple returns × √252; indicative with short histories. Drawdown uses running closing-price peaks. SMA requires 20 sessions. Trading sessions use equal chart spacing. Candles show observed OHLC intervals; no continuous time axis is implied.',
    sectors, indices:broad,watch:watch.map(r=>({...r,price:money(r.last),change:pct(r.changePct),source:time(r.exchangeAt.replace(' ','T')+'+05:30'),cache:time(r.updatedAt)})),
    receipts:s.receipts!, coverage:`${sectors.filter(r=>r.changePct>0).length} rising / ${sectors.filter(r=>r.changePct<0).length} falling / ${sectors.filter(r=>r.changePct===0).length} unchanged sector indices. This is index coverage, not stock market breadth.`,
    storage:'Canonical OHLCV rows live in the app’s DuckDB snapshot. Quotes, controls and source receipts share the same atomic app record. No model request is used for actions, SQL or refresh.',
  };
  return {updates:Object.keys(ctx.surfaces).map(surface=>({surface,data}))};
}
export async function handleAction(id: string, value: unknown, ctx: Context, action?: string) {
  settings(ctx.state);
  if (id.startsWith('/')) {
    if (id==='/symbol') ctx.state.symbol=symbol(value);
    else if (id==='/months') {if (!['1','2','3'].includes(String(value))) throw new Error('Choose 1, 2 or 3 months');ctx.state.months=String(value);}
    else if (id==='/watchlist') {const names=[...new Set(String(value).split(',').map(symbol))];if(!names.length||names.length>6)throw new Error('Enter 1–6 comma-separated symbols');ctx.state.watchlist=names.join(',');}
    else throw new Error('Unknown terminal setting');
    return project(ctx);
  }
  if (action==='refresh_market' || id==='refresh-market') return refreshMarket(ctx);
  if (action==='refresh_instrument' || id==='refresh-instrument') {await initialize(ctx.database);return refreshInstrument(ctx);}
  if (action==='focus_instrument') return {...await project(ctx),focusSurface:'instrument'};
  if (action==='recalculate' || id==='recalculate') return project(ctx);
  throw new Error('Unknown terminal action');
}
