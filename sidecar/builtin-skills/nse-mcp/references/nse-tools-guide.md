# Official NSE MCP Tools & Schema Guide

Reference guide for tools exposed by the National Stock Exchange of India (NSE) official Model Context Protocol servers.

## Server Namespace Overview

In Vakyartha, MCP tool names follow the pattern `${server}__${clean(tool)}`. Depending on which vendor integration is enabled in **Settings → Integrations**, tools will appear with one of two prefixes:

| Integration ID | Server Name | Transport & Endpoint | Tool Prefix |
| --- | --- | --- | --- |
| `nse` | NSE Bhavcopy (Historical EOD) | Streamable HTTP (`https://mcp.nseindia.in/bhavcopy/cm/mcp`) | `nse__` |
| `nse-cmmkt` | NSE Market Live (Current Session) | Streamable HTTP (`https://mcp.nseindia.in/cmmkt/mcp`) | `nse_cmmkt__` |

---

## 1. NSE Bhavcopy Server Tools (`nse__*`)

The Bhavcopy server provides authoritative historical end-of-day data covering up to 5 years of cash market (CM) trading sessions.

### `nse__get_market_breadth`
Retrieves market-wide advance, decline, and unchanged counts for an exact trading date.
- **Arguments**:
  - `date` (string, required): Trading date in `YYYY-MM-DD` (or `DD-MM-YYYY`) format.
- **Returns**:
  ```json
  {
    "date": "2026-10-27",
    "advances": 1420,
    "declines": 890,
    "unchanged": 115,
    "total_traded": 2425,
    "advance_decline_ratio": 1.595
  }
  ```
- **Usage Notes**:
  - Use to evaluate broader market sentiment and market participation for any specific session over the last 5 years.
  - An advance-decline ratio > 1.0 indicates bullish participation; < 1.0 indicates bearish breadth.

### `nse__moving_average`
Calculates Simple Moving Average (SMA) of closing prices over a specified lookback period.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol (e.g. `"RELIANCE"`, `"TCS"`, `"INFY"`).
  - `period` or `days` (number, required): Lookback period in trading days (e.g. `20`, `50`, `200`).
  - `series` (string, optional): Security series, defaults to `"EQ"`.
- **Returns**:
  ```json
  {
    "symbol": "RELIANCE",
    "period": 50,
    "sma": 2985.40,
    "latest_close": 3042.15,
    "as_of_date": "2026-10-27"
  }
  ```
- **Usage Notes**:
  - Useful for determining if an instrument is trading above or below key technical benchmarks (e.g., 20-day, 50-day, 200-day SMA).

### `nse__get_52_week_high_low`
Fetches the 52-week high and low figures for a specified equity.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol (e.g. `"TATAMOTORS"`).
  - `series` (string, optional): Security series, defaults to `"EQ"`.
- **Returns**:
  ```json
  {
    "symbol": "TATAMOTORS",
    "high_52_week": 1179.05,
    "high_date": "2026-07-30",
    "low_52_week": 650.20,
    "low_date": "2025-11-04",
    "latest_close": 985.30,
    "distance_from_high_pct": -16.43,
    "distance_from_low_pct": 51.54
  }
  ```

### `nse__compare_stocks`
Compares historical price trends, returns, and volatility across multiple NSE securities over an identical historical timeframe.
- **Arguments**:
  - `symbols` (array of strings, required): List of equity tickers (e.g. `["INFY", "TCS", "WIPRO"]`).
  - `start_date` (string, optional): Start date (`YYYY-MM-DD`).
  - `end_date` (string, optional): End date (`YYYY-MM-DD`).
- **Returns**: Comparative returns matrix with period price changes and relative metrics.

### `nse__search_symbols`
Fuzzy lookups and resolves valid NSE equity symbols matching a company name or partial keyword.
- **Arguments**:
  - `query` (string, required): Search query (e.g. `"HDFC"`, `"Tata Motors"`, `"State Bank"`).
- **Returns**: List of matching symbols with company names, industry sectors, and series.

---

## 2. NSE Market Live Server Tools (`nse_cmmkt__*`)

The CM Market Live server provides snapshots of the ongoing or most recent trading session, running with a 1–3 minute exchange delay.

### `nse_cmmkt__cm_get_stock_quote`
Retrieves the latest quote snapshot for a single NSE equity.
- **Arguments**:
  - `symbol` (string, required): NSE equity symbol (e.g. `"HDFCBANK"`).
  - `series` (string, optional): Security series (defaults to `"EQ"`).
- **Returns**:
  ```json
  {
    "symbol": "HDFCBANK",
    "series": "EQ",
    "last_price": 1724.80,
    "change": 14.30,
    "p_change": 0.84,
    "open": 1715.00,
    "day_high": 1732.50,
    "day_low": 1712.10,
    "previous_close": 1710.50,
    "volume": 8452100,
    "total_turnover": 1457892000,
    "timestamp": "2026-10-28 10:45:00"
  }
  ```

### `nse_cmmkt__nse_get_market_movers`
Fetches top gainers and losers for the current trading day across the entire market or filtered by index.
- **Arguments**:
  - `index` (string, optional): Index filter, such as `"NIFTY 50"`, `"NIFTY BANK"`, `"NIFTY IT"`, or `"ALL"`.
  - `count` (number, optional): Number of top gainers/losers to retrieve (defaults to `5` or `10`).
- **Returns**:
  ```json
  {
    "gainers": [
      { "symbol": "BHARTIARTL", "ltp": 1650.00, "change": 45.20, "p_change": 2.82 },
      { "symbol": "ICICIBANK", "ltp": 1285.50, "change": 24.10, "p_change": 1.91 }
    ],
    "losers": [
      { "symbol": "BAJFINANCE", "ltp": 6890.00, "change": -112.00, "p_change": -1.60 }
    ],
    "as_of": "2026-10-28 10:45:00"
  }
  ```

### `nse_cmmkt__cm_get_data_status`
Checks data feed freshness, timestamp, and cache health for live market data.
- **Returns**: Cache status, last exchange sync timestamp, and market operational status (`Open`, `Closed`, `Pre-Open`).

---

## 3. Error Handling & Edge Cases

1. **Weekend & Holiday Inquiries**:
   - The exchange is closed on Saturdays, Sundays, and declared Indian market holidays (e.g. Diwali, Republic Day, Independence Day).
   - If a tool returns `No data found` or an empty array for a date query, check if the requested date falls on a weekend or holiday. Fall back to the most recent previous trading session and state the substitution clearly.
2. **Invalid or Delisted Symbols**:
   - Symbols undergo periodic changes (mergers, ticker renames). Use `nse__search_symbols` to verify the active symbol if a symbol lookup fails.
3. **Delayed Feed Attribution**:
   - Quotes from `nse-cmmkt` are delayed by 1–3 minutes as required by NSE public feed guidelines. Always note this delay in time-sensitive intraday reviews.

