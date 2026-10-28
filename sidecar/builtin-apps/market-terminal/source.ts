import type { Bar } from './analytics.ts';
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an NSE object');
  return value as ObjectValue;
}
export function decode(value: unknown): ObjectValue {
  if (typeof value === 'string') return object(JSON.parse(value));
  const result = object(value);
  if (result.isError) throw new Error('NSE returned an error');
  return typeof result.text === 'string' ? object(JSON.parse(result.text)) : result;
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Missing or invalid NSE numeric field');
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Missing or invalid NSE text field');
  return value;
}
export function history(raw: ObjectValue, symbol: string): Bar[] {
  if (raw.symbol !== symbol || !Array.isArray(raw.data) || !raw.data.length || raw.data.length > 80) throw new Error('Empty, oversized or mismatched NSE history');
  const dates = new Set<string>();
  const bars = raw.data.map(value => {
    const r = object(value), date = text(r.date);
    if (r.symbol !== symbol || r.series !== 'EQ' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0,10) !== date || dates.has(date)) throw new Error('Invalid or duplicate NSE history identity');
    dates.add(date);
    const b = { date, open: number(r.open), high: number(r.high), low: number(r.low), close: number(r.close), volume: number(r.volume) };
    if (b.low <= 0 || b.low > Math.min(b.open,b.close) || b.high < Math.max(b.open,b.close) || b.low > b.high || b.volume < 0 || !Number.isSafeInteger(b.volume)) throw new Error('Invalid NSE OHLCV observation');
    return b;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  return bars;
}
// NSE publishes rounded two-decimal levels; low-priced indices magnify the
// implied return uncertainty. Preserve the published percentage and test its
// overlap with the price-rounding interval, rather than silently replacing it.
function sessionChange(last: number, previous: number, reported: unknown): number {
  const change = number(reported);
  const lower = ((last - 0.005) / (previous + 0.005) - 1) * 100;
  const upper = ((last + 0.005) / (previous - 0.005) - 1) * 100;
  if (previous <= 0.005 || change + 0.005 < lower - 1e-9 || change - 0.005 > upper + 1e-9) throw new Error('Inconsistent NSE session return');
  return change;
}
export function quote(raw: ObjectValue, symbol: string) {
  const s = object(raw.stock);
  if (s.symbol !== symbol || s.series !== 'EQ') throw new Error('NSE quote identity mismatch');
  const last = number(s.lastTradedPrice), previous = number(s.preClosePrice);
  if (last <= 0 || previous <= 0) throw new Error('Invalid NSE quote price');
  const changePct = sessionChange(last, previous, s.perChange);
  return { symbol, last, previous, changePct, open: number(s.openPrice), high: number(s.highPrice), low: number(s.lowPrice), volume: number(s.volume), exchangeAt: text(s.latestTimestamp), updatedAt: text(raw.updatedAt) };
}
export function indices(raw: ObjectValue, group: string) {
  const rows = object(raw.indices)[group];
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('NSE index group unavailable');
  const names = new Set<string>();
  return rows.map(v=>{
    const r=object(v), label=text(r.indexName), last=number(r.last), previous=number(r.previousClose);
    if (names.has(label) || last<=0 || previous<=0) throw new Error('Invalid NSE index identity or price');
    names.add(label);
    const changePct=sessionChange(last, previous, r.percChange);
    return { label, last, changePct, exchangeAt: text(r.timeVal) };
  }).sort((a,b)=>b.changePct-a.changePct);
}
