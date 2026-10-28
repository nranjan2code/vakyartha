export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
export interface Database {
  run(sql: string, values?: (string | number | null)[]): Promise<void>;
  query(sql: string, values?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}
export async function initialize(db: Database) {
  await db.run('CREATE TABLE IF NOT EXISTS prices(symbol VARCHAR, date VARCHAR, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, PRIMARY KEY(symbol,date))');
}
export async function saveHistory(db: Database, symbol: string, bars: Bar[]) {
  await db.run('BEGIN TRANSACTION');
  try {
    await db.run('DELETE FROM prices WHERE symbol=?', [symbol]);
    for (const b of bars) await db.run('INSERT INTO prices VALUES(?,?,?,?,?,?,?)', [symbol,b.date,b.open,b.high,b.low,b.close,b.volume]);
    await db.run('COMMIT');
  } catch (e) { await db.run('ROLLBACK'); throw e; }
}
export async function analyze(db: Database, symbol: string) {
  const rows = await db.query(`WITH ordered AS (
    SELECT *, lag(close) OVER (ORDER BY date) AS prior_close,
    max(close) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) peak,
    count(*) OVER (ORDER BY date ROWS 19 PRECEDING) observations,
    avg(close) OVER (ORDER BY date ROWS 19 PRECEDING) mean20
    FROM prices WHERE symbol=?)
    SELECT date,open,high,low,close,volume,
    CASE WHEN prior_close>0 THEN (close/prior_close-1)*100 END AS returnPct,
    (close/peak-1)*100 AS drawdownPct,
    CASE WHEN observations=20 THEN mean20 END AS sma20 FROM ordered ORDER BY date`, [symbol]) as unknown as (Bar & { returnPct: number | null; drawdownPct: number; sma20: number | null })[];
  const stats = (await db.query(`WITH returns AS (
    SELECT *, close/lag(close) OVER (ORDER BY date)-1 AS r,
    max(close) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) AS peak
    FROM prices WHERE symbol=?)
    SELECT count(*)::INTEGER AS sessions, avg(volume) AS averageVolume,
    min(low) AS low, max(high) AS high,
    stddev_samp(r)*sqrt(252)*100 AS volatility,
    min((close/peak-1)*100) AS maxDrawdown FROM returns`, [symbol]))[0]!;
  return { rows, sessions: Number(stats.sessions), averageVolume: stats.averageVolume as number | null,
    low: stats.low as number | null, high: stats.high as number | null, volatility: stats.volatility as number | null,
    priceReturn: rows.length > 1 ? (rows.at(-1)!.close/rows[0]!.close-1)*100 : null,
    maxDrawdown: stats.maxDrawdown as number | null };
}
