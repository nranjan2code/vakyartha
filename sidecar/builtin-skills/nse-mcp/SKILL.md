---
name: nse-mcp
description: Query official National Stock Exchange of India (NSE) market data via MCP, including 5-year historical bhavcopy, delivery volume, market breadth, and near-real-time capital market quotes.
license: MIT
compatibility: Requires enabled 'nse' (Bhavcopy) or 'nse-cmmkt' (Market Live) vendor integrations.
metadata:
  author: nranjan2code
  version: "1.0"
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
  - Questions covering past dates, weekly/monthly returns, moving averages, 52-week ranges, or market-wide breadth require the **`nse`** (Bhavcopy) integration.
  - Primary tools: `nse__get_market_breadth`, `nse__moving_average`, `nse__get_52_week_high_low`, `nse__compare_stocks`, `nse__search_symbols`.
- **Intraday Quotes & Current Session Activity**:
  - Questions covering current stock price, today's trading action, top gainers/losers, or immediate index levels require the **`nse-cmmkt`** (Market Live) integration.
  - Primary tools: `nse_cmmkt__cm_get_stock_quote`, `nse_cmmkt__nse_get_market_movers`, `nse_cmmkt__cm_get_data_status`.
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
  - Indian national holidays and exchange settlement holidays have no trading sessions. If a query returns no data for a weekend or holiday, use the immediately preceding trading session's final close.

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

## Composing Visual & Spoken Projections

When requested to review NSE instruments or compose an interactive review, follow Vakyartha's liquid canvas architecture:

1. **Tier 1: Natural-Language Headline & Metric Strip**:
   - Provide a concise headline stating the symbol, evaluation window, recorded move, and data source (NSE Bhavcopy or NSE Market Live).
   - Build a 2-column metric strip (`grid` with `columns: 2, minItemWidth: "xs"`) showing:
     - **Latest Price / Close**: Value formatted with currency (`₹` or `INR`).
     - **Window Price Return**: Percentage with semantic tone (`positive` for gain, `critical` for drop, `neutral` for flat).
2. **Tier 2: Clamped Time-Series Line Visual**:
   - For multi-session history, plot dated closing prices using a `line` chart.
   - Always clamp single charts to `maxWidth: "lg"` or pair them with volume/breadth in a 2-column grid (`columns: 2`). Never let a single chart stretch across 100% of a wide screen.
3. **Tier 3: Granular Historical Table**:
   - Map `{/history}` records containing date, open, high, low, close, and volume.
   - Disable table totals (`totals: false`) on price and return columns.

---

## Regulatory & Usage Disclaimer

All data provided through the official NSE MCP servers is intended exclusively for educational, informational, and research purposes. It does not constitute investment advice, a financial recommendation, or an order execution facility. Always remind the user that historical market performance does not guarantee future results.

