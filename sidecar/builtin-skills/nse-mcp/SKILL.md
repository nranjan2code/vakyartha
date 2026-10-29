---
name: nse-mcp
description: Query official National Stock Exchange of India (NSE) market data via MCP, including 5-year historical bhavcopy, delivery volume, market breadth, and near-real-time capital market quotes.
license: MIT
compatibility: Requires enabled 'nse' (Bhavcopy) or 'nse-cmmkt' (Market Live) vendor integrations.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# National Stock Exchange of India (NSE) Market Data & MCP

Analytical and operational procedure for querying official National Stock Exchange of India (NSE) market data using vendor Model Context Protocol (MCP) servers and composing verified financial analyses on Vakyartha canvas surfaces.

## Overview & Architecture

The National Stock Exchange of India operates two official hosted MCP endpoints on `mcp.nseindia.in` using Streamable HTTP transport. Neither endpoint requires API keys, credentials, or browser authentication:

1. **`nse` (NSE Bhavcopy — Historical EOD)**:
   - Hosted endpoint: `https://mcp.nseindia.in/bhavcopy/cm/mcp`
   - Tool namespace in Vakyartha: `nse__<tool_name>`
   - Scope: Daily end-of-day equity data covering up to 5 years of trading history, final closing figures, OHLCV records, delivery volumes, 52-week highs/lows, and market breadth (advances/declines).
2. **`nse-cmmkt` (NSE Market Live — Current Session Snapshots)**:
   - Hosted endpoint: `https://mcp.nseindia.in/cmmkt/mcp`
   - Tool namespace in Vakyartha: `nse_cmmkt__<tool_name>`
   - Scope: Near-real-time intraday snapshots (running on a 1–3 minute exchange delay), live stock quotes, day high/low, top gainers and losers, and index performance.

### Skill Chaining
- Load enabled `market-dashboard` and `interactive-ui` when creating an interactive canvas review.
- The required `surface-design` skill governs layout structure, metric strips, clamped charts, and spoken clarity automatically.
- Read supporting reference files via `read_skill_file`:
  - `references/nse-tools-guide.md`: Detailed tool catalog, schemas, arguments, and return types.
  - `references/nse-query-patterns.md`: Step-by-step query workflows for single equity reviews, market breadth, and index scans.

---

## Tool Selection & Dispatch Procedure

### 1. Identify the Query Scope

- **Historical Performance or Multi-Day Windows**:
  - Questions covering past dates, weekly/monthly returns, moving averages, 52-week ranges, market breadth, corporate actions, or index history require the **`nse`** (Bhavcopy) integration.
  - Primary tools:
    - *Equities*: `nse__get_stock_history`, `nse__get_ltp_by_date`, `nse__get_bulk_quote`, `nse__get_52_week_high_low`, `nse__moving_average`, `nse__get_volume_analysis`, `nse__get_corporate_actions`.
    - *Market & Breadth*: `nse__get_market_mood`, `nse__get_market_breadth`, `nse__get_top_movers`, `nse__get_top_by_volume`.
    - *Indices & Comparisons*: `nse__get_index_snapshot`, `nse__get_index_history`, `nse__get_index_performance`, `nse__get_index_valuation`, `nse__get_index_movers`, `nse__compare_indices`, `nse__compare_stocks`, `nse__get_stock_vs_index`.
    - *Symbol Resolution*: `nse__nse_lookup_symbol`, `nse__search_symbols`.
- **Intraday Quotes & Current Session Activity**:
  - Questions covering current stock price, today's trading action, live gainers/losers, or immediate index levels require the **`nse-cmmkt`** (Market Live) integration.
  - Primary tools:
    - *Market Movers*: `nse_cmmkt__nse_get_market_movers` (primary tool for gainers/losers today), `nse_cmmkt__nse_get_gainers`, `nse_cmmkt__nse_get_losers`.
    - *Spot Quotes*: `nse_cmmkt__cm_get_stock_quote` (single equity), `nse_cmmkt__cm_get_index_quote` (single index), `nse_cmmkt__cm_get_live_indices` (grouped index levels).
    - *Segment Watches*: `nse_cmmkt__cm_get_equity_stocks`, `nse_cmmkt__cm_get_sme_stocks`, `nse_cmmkt__cm_get_bond_stocks`, `nse_cmmkt__cm_get_call_auction_stocks`.
    - *Feed Health*: `nse_cmmkt__cm_get_data_status`, `nse_cmmkt__cm_get_allstocks_status`.
- **Comprehensive Reviews (History + Spot Quote)**:
  - When both integrations are enabled, query `nse` for historical baseline figures and `nse-cmmkt` for the current trading day's snapshot.

### 2. Parameter & Symbol Conventions

- **Symbol Formatting**: Use official uppercase NSE equity tickers:
  - Standard equities: `RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `TATAMOTORS`, `ITC`, `ICICIBANK`, `SBIN`, `BHARTIARTL`.
  - Major indices: `NIFTY 50`, `NIFTY BANK`, `NIFTY IT`.
  - Series: defaults to `"EQ"` (Standard Equity).
- **Date Formatting**: Follow standard ISO format (`YYYY-MM-DD`) or exchange format (`DD-MM-YYYY`) as documented in `references/nse-tools-guide.md`.
- **Trading Calendar Awareness**:
  - NSE trades Monday through Friday, 09:15 to 15:30 IST (UTC+05:30).
  - Verify the exchange calendar and requested session. Empty data does not establish a holiday. Use a preceding session only when that basis matches the request, and disclose the substitution.

---

## Establishing Verified Evidence

1. **Verify Instrument & Session Freshness**:
   - Resolve symbol, series, trading date, and segment (`cm` for Capital Market).
   - Distinguish a completed historical trading session (final Bhavcopy) from an intraday snapshot (delayed 1–3 minutes). Never present an intraday spot price as an official session closing price before exchange settlement.
   - Never fabricate or guess market prices, traded quantities, 52-week extremes, or corporate action dates. If a tool call fails or returns empty, state the missing data explicitly.

2. **Deterministic Return Calculations**:
   - Compute price return strictly as:
     `Price Return (%) = ((Last Close / First Close) - 1) × 100`
   - Compute point change as:
     `Point Change = Last Close - First Close`
   - Keep price return distinct from total return (which includes cash dividends).
   - Never sum prices, price levels, or percentages across multiple instruments into a table total.

---

## Compose the requested result

Follow required surface-design and enabled interactive-ui. Map related views from the same verified history, retain exact records, use totals:false for price/return columns and show the session, units, freshness and return basis. Keep independent requested outputs separate. A quote cannot supply a candle or a multi-session return. Follow the currently offered integration schemas over reference examples when they differ.

## Regulatory & Usage Disclaimer

All data provided through the official NSE MCP servers is intended exclusively for educational, informational, and research purposes. It does not constitute investment advice, a financial recommendation, or an order execution facility. Always remind the user that historical market performance does not guarantee future results.
