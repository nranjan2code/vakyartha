# Official NSE MCP Tools & Schema Guide

Reference guide for all tools exposed by the National Stock Exchange of India (NSE) official Model Context Protocol servers.

## Server Namespace Overview

In Vakyartha, MCP tool names follow the pattern `${server}__${clean(tool)}`. Depending on which vendor integration is enabled in **Settings → Integrations**, tools appear under these prefixes:

| Integration ID | Server Name | Transport & Endpoint | Tool Prefix | Tools Count |
| --- | --- | --- | --- | --- |
| `nse` | NSE Bhavcopy (Historical EOD) | Streamable HTTP (`https://mcp.nseindia.in/bhavcopy/cm/mcp`) | `nse__` | 21 tools |
| `nse-cmmkt` | NSE Market Live (Current Session) | Streamable HTTP (`https://mcp.nseindia.in/cmmkt/mcp`) | `nse_cmmkt__` | 15 tools |

---

## 1. NSE Bhavcopy Server Tools (`nse__*`)

The Bhavcopy server provides authoritative historical end-of-day cash market data covering up to 5 years of daily trading sessions, final closing figures, OHLCV records, market breadth, and corporate action checks.

### Symbol & Price Queries

#### `nse__get_ltp_by_date`
Returns the official last traded price (close price) for a given NSE symbol on a specific date.
- **Arguments**:
  - `symbol` (string, required): Official NSE equity ticker (e.g. `"TCS"`, `"RELIANCE"`).
  - `date` (string, required): Trading date in `YYYY-MM-DD` format (or `"today"`).

#### `nse__get_bulk_quote`
Retrieves the latest available price snapshot for multiple NSE stocks in a single round-trip.
- **Arguments**:
  - `symbols` (array of strings, required): List of tickers (e.g. `["TCS", "INFY", "WIPRO", "HCLTECH"]`).

#### `nse__get_stock_history`
Fetches daily OHLCV (Open, High, Low, Close, Volume) price history for an equity over a multi-month window.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol.
  - `months` (integer, required): Number of months of history (e.g. `1`, `3`, `6`, `12`).
  - `endDate` (string, required): End date in `YYYY-MM-DD` format or `"today"`.

#### `nse__get_52_week_high_low`
Fetches the 52-week high and low figures for a specified equity, including dates and percentage distances from the extremes.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol (e.g. `"TATAMOTORS"`).
- **Corporate Action Warning**:
  - If a stock underwent a stock split or bonus issue in the past 52 weeks, raw unadjusted prices may show an artificial low. Call `get_corporate_actions(symbol)` to verify whether an ex-date distorted the 52-week range.

#### `nse__moving_average`
Calculates Simple Moving Average (SMA) of closing prices over N trading days.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol.
  - `days` (integer, required): Lookback period in trading days (e.g. `20`, `50`, `200`).

#### `nse__get_volume_analysis`
Analyzes trading volume trends, averages, and spikes for an equity over N trading days.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol.
  - `days` (integer, required): Number of days to analyze (e.g. `10`, `30`).

### Search & Symbol Resolution

#### `nse__nse_lookup_symbol`
Fast, lightweight ticker lookup by partial keyword. Returns matching symbols only — no price data.
- **Arguments**:
  - `query` (string, required): Keyword (e.g. `"TATA"`, `"HDFC"`, `"BANK"`).

#### `nse__search_symbols`
Comprehensive symbol search returning company names, series, and industry sectors.
- **Arguments**:
  - `query` (string, required): Search query (e.g. `"State Bank"`, `"Motors"`).

### Market Breadth & Sentiment

#### `nse__get_market_mood`
Provides a holistic, factual read of NSE market mood for a trading day: India VIX level, 1-day/1-week/1-month VIX changes, benchmark index performances, advance-decline ratios, and market breadth classification (`broad advance`, `mixed`, or `broad decline`).
- **Arguments**:
  - `date` (string, required): Trading date in `YYYY-MM-DD` format or `"today"`.

#### `nse__get_market_breadth`
Retrieves market-wide advance, decline, and unchanged counts for mainboard equities.
- **Arguments**:
  - `date` (string, required): Trading date in `YYYY-MM-DD` format.

#### `nse__get_top_movers`
Gets the top N gaining or losing NSE equities on a specific date with OHLCV metrics.
- **Arguments**:
  - `date` (string, required): Trading date in `YYYY-MM-DD` format.
  - `n` (integer, required): Number of stocks (default: 10, max: 50).
  - `direction` (string, required): `"gain"` for top gainers, `"loss"` for top losers.

#### `nse__get_top_by_volume`
Lists the top N most actively traded NSE stocks on a date.
- **Arguments**:
  - `date` (string, required): Trading date in `YYYY-MM-DD` format.
  - `n` (integer, required): Count (default: 10, max: 50).
  - `sortBy` (string, required): `"volume"` (traded quantity) or `"value"` (turnover in ₹).

### Index & Valuation Analytics

#### `nse__get_index_snapshot`
Fetches end-of-day snapshot of NSE indices: open, high, low, close, point change, % change, volume, turnover, P/E, P/B, and dividend yield.
- **Arguments**:
  - `date` (string, required): Date in `YYYY-MM-DD` format.
  - `filter` (string, required): Index filter category (e.g. `"all"`, `"broad"`, `"sectoral"`).

#### `nse__get_index_history`
Retrieves daily time-series history for an NSE index.
- **Arguments**:
  - `indexName` (string, required): Official index name (e.g. `"Nifty 50"`, `"Nifty Bank"`, `"NIFTY IT"`).
  - `months` (integer, required): History length (max 12 months per chunk).
  - `endDate` (string, required): End date (`YYYY-MM-DD` or `"today"`).

#### `nse__get_index_performance`
Calculates returns across standard horizons: 1-day, 1-week, 1-month, 3-months, 6-months, 1-year, and 2-years, alongside 52-week high/low metrics.
- **Arguments**:
  - `indexName` (string, required): Official index name.
  - `date` (string, required): As-of date (`YYYY-MM-DD` or `"today"`).

#### `nse__get_index_valuation`
Returns P/E, P/B, and dividend yield for an index, placing current levels in their historical percentile range.
- **Arguments**:
  - `indexName` (string, required): Index name.
  - `months` (integer, required): Historical lookback in months.
  - `date` (string, required): As-of date.

#### `nse__get_index_movers`
Identifies top gaining and losing indices for a day or period — essential for sector and theme rotation analysis.
- **Arguments**:
  - `date` (string, required): Trading date.
  - `period` (string, required): Evaluation period (e.g. `"1D"`, `"1W"`, `"1M"`).
  - `n` (integer, required): Number of indices.
  - `scope` (string, required): Scope category (e.g. `"sectoral"`, `"broad"`, `"all"`).

### Stock & Index Comparisons

#### `nse__compare_stocks`
Compares multiple NSE stocks side-by-side over an identical time window.
- **Arguments**:
  - `symbols` (array of strings, required): Tickers (e.g. `["TCS", "INFY", "WIPRO"]`).
  - `months` (integer, required): Comparison window in months.

#### `nse__compare_indices`
Compares 2 to 10 NSE indices side-by-side: returns, annualized volatility, maximum drawdown, and valuation multiples.
- **Arguments**:
  - `indexNames` (array of strings, required): List of index names (e.g. `["Nifty 50", "Nifty Midcap 100", "NIFTY Smallcap 100"]`).
  - `months` (integer, required): Duration in months.
  - `date` (string, required): As-of date.

#### `nse__get_stock_vs_index`
Compares an equity against a benchmark index over a time window: computes alpha, beta, correlation, and relative outperformance.
- **Arguments**:
  - `symbol` (string, required): Stock ticker.
  - `indexName` (string, required): Benchmark index (e.g. `"Nifty 50"`).
  - `months` (integer, required): Evaluation horizon in months.
  - `date` (string, required): As-of date.

#### `nse__get_corporate_actions`
Fetches corporate action records (dividends, splits, bonuses, rights issues) directly from NSE India.
- **Arguments**:
  - `symbol` (string, required): Stock ticker.
  - `fromDate` (string, required): Start date (`YYYY-MM-DD`).
  - `toDate` (string, required): End date (`YYYY-MM-DD`).

---

## 2. NSE Market Live Server Tools (`nse_cmmkt__*`)

The CM Market Live server provides intraday snapshots and near-real-time data for the current trading session (exchange delay: 1–3 minutes).

### Live Quotes & Market Movers

#### `nse_cmmkt__nse_get_market_movers`
**Primary tool** for answering queries such as *"What are today's top gainers and losers?"*, *"Market movers"*, or *"Best and worst performing stocks"*.
- **Arguments**:
  - `indexName` (string, required): Index segment (e.g. `"NIFTY 50"`, `"NIFTY 500"`, `"allSec"`).
  - `limit` (integer, required): Number of items to return.

#### `nse_cmmkt__cm_get_stock_quote`
Retrieves the latest intraday quote snapshot for an equity by exact ticker.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol (e.g. `"RELIANCE"`, `"INFY"`).
- **Returns**: Last traded price, day's open, high, low, previous close, point change, % change, total volume, and timestamp.

#### `nse_cmmkt__cm_get_index_quote`
Retrieves live quote data for an index: last level, day's range, % change, 52-week range, and 1-week/1-month/1-year performance comparisons.
- **Arguments**:
  - `indexName` (string, required): Exact index name (e.g. `"NIFTY 50"`, `"NIFTY BANK"`, `"INDIA VIX"`).

#### `nse_cmmkt__cm_get_live_indices`
Lists live values across multiple indices or a specific group.
- **Arguments**:
  - `group` (string, required): Index group (`"all"`, `"derivatives"`, `"broad"`, `"sectoral"`, `"strategy"`, `"thematic"`, `"fixed_income"`).
  - `nameFilter` (string, optional): Substring filter.

#### `nse_cmmkt__nse_get_gainers`
Retrieves top N gainers flattened across all indices sorted descending by % gain.
- **Arguments**:
  - `limit` (integer, required): Maximum count.

#### `nse_cmmkt__nse_get_losers`
Retrieves top N losers flattened across all indices sorted ascending by % loss.
- **Arguments**:
  - `limit` (integer, required): Maximum count.

#### `nse_cmmkt__cm_get_live_gainers` / `nse_cmmkt__cm_get_live_losers`
Returns raw gainers and losers grouped by index segments (`NIFTY`, `BANKNIFTY`, `NIFTYNEXT50`, `allSec`).

#### `nse_cmmkt__cm_get_live_market_data`
Fetches live variation data for a specific index segment.
- **Arguments**:
  - `index` (string, required): Segment identifier.

### Segment Watch & Instrument Scans

#### `nse_cmmkt__cm_get_equity_stocks`
Scans live quotes across mainboard equity series (`EQ`, `BE`, `BL`, `BT`, `IL`, `IQ`).
- **Arguments**:
  - `limit` (integer, required): Result limit.
  - `symbolFilter` (string, optional): Symbol prefix/filter.

#### `nse_cmmkt__cm_get_sme_stocks`
Scans live quotes for Small & Medium Enterprises (SME) equities (`SM`, `ST` series).
- **Arguments**:
  - `limit` (integer, required): Count.
  - `symbolFilter` (string, optional): Ticker filter.

#### `nse_cmmkt__cm_get_call_auction_stocks`
Scans quotes for call auction session stocks (`CA`, `CB` series).
- **Arguments**:
  - `limit` (integer, required): Count.
  - `symbolFilter` (string, optional): Ticker filter.

#### `nse_cmmkt__cm_get_bond_stocks`
Scans quotes for listed bonds, debentures, and government securities.
- **Arguments**:
  - `limit` (integer, required): Count.
  - `symbolFilter` (string, optional): Filter string.

### Feed & Cache Health

#### `nse_cmmkt__cm_get_data_status`
Checks live market feed freshness, exchange timestamps, and operational status (`Open`, `Closed`, `Pre-Open`).

#### `nse_cmmkt__cm_get_allstocks_status`
Checks freshness of the exchange all-stocks data cache.

---

## 3. Operational Rules & Best Practices

1. **Exchange Trading Hours**:
   - Trading occurs Monday through Friday, 09:15 to 15:30 IST (UTC+05:30).
   - Near-real-time quotes reflect the last session outside of market hours. Always state the as-of timestamp returned by the feed.
2. **Weekend & Holiday Handling**:
   - If a historical query returns empty or holiday warning, use the immediately preceding trading session's close and note the date clearly.
3. **Price & Corporate Action Verification**:
   - Never present an intraday snapshot as an official settlement price before final EOD Bhavcopy release.
   - For sudden price drops exceeding 20%, always verify whether a stock split or bonus issue took place using `get_corporate_actions`.
