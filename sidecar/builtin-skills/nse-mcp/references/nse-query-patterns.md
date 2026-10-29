# NSE Query Patterns & Workflow Blueprints

Step-by-step query workflows and canvas surface blueprints for common Indian stock market requests using the official NSE MCP servers.

---

## Pattern 1: Single Stock Performance & Trend Review

**User Request Example**: *"Give me a performance review of Reliance Industries (RELIANCE) over the last month and check its current price."*

### Step 1: Tool Execution
1. Query `nse__get_52_week_high_low` with `symbol: "RELIANCE"`.
2. Query `nse__moving_average` with `symbol: "RELIANCE", period: 50`.
3. If `nse-cmmkt` is enabled, query `nse_cmmkt__cm_get_stock_quote` with `symbol: "RELIANCE"` for the current trading day's snapshot.

### Step 2: Extract & Verify Numbers
- Identify First Close (e.g. ₹2,920.00 on 2026-09-28) and Last Close/LTP (e.g. ₹3,042.15 on 2026-10-28).
- Compute Window Price Return:
  `((3042.15 / 2920.00) - 1) × 100 = +4.18%`
- Calculate 50-day SMA position: compare ₹3,042.15 to the returned SMA.

### Step 3: Presenting the Result
- **Headline**: *"Reliance Industries Limited (RELIANCE) recorded a +4.18% price return over the past 30 days, closing at ₹3,042.15 on the National Stock Exchange."*
- **Canvas Payload** (if an interactive dashboard was requested):
  ```json
  {
    "data": {
      "summary": {
        "symbol": "RELIANCE",
        "lastPrice": "₹3,042.15",
        "windowReturn": "+4.18%",
        "sma50": "₹2,985.40",
        "high52": "₹3,217.90"
      },
      "history": [
        { "date": "2026-10-01", "close": 2930.50, "volume": 5120000 },
        { "date": "2026-10-15", "close": 2985.00, "volume": 6240000 },
        { "date": "2026-10-28", "close": 3042.15, "volume": 5890000 }
      ]
    },
    "surfaces": [
      {
        "id": "reliance-summary",
        "type": "grid",
        "props": { "columns": 2, "minItemWidth": "sm" },
        "children": ["m-price", "m-return"]
      },
      {
        "id": "m-price",
        "type": "metric",
        "props": { "label": "Latest Price (NSE)", "value": "{/summary/lastPrice}" }
      },
      {
        "id": "m-return",
        "type": "metric",
        "props": { "label": "30-Day Return", "value": "{/summary/windowReturn}", "tone": "success" }
      },
      {
        "id": "trend-chart",
        "type": "chart",
        "props": {
          "kind": "line",
          "title": "RELIANCE Closing Price Trend",
          "maxWidth": "lg",
          "series": [{ "label": "Close", "records": "{/history}", "x": "date", "y": "close" }]
        }
      }
    ]
  }
  ```

---

## Pattern 2: Market Breadth & Sentiment Analysis

**User Request Example**: *"What was the market breadth on the NSE yesterday and which stocks drove the session?"*

### Step 1: Tool Execution
1. Query `nse__get_market_breadth` with `date: "<yesterday's trading date>"`.
2. Query `nse_cmmkt__nse_get_market_movers` with `index: "NIFTY 50", count: 5` to inspect the major institutional drivers.

### Step 2: Establish the Evidence
- Verify Advances count, Declines count, Unchanged count, and the Advance/Decline (A/D) ratio.
- Check top 5 gainers and top 5 losers by percentage move.
- A/D ratio interpretation:
  - Ratio > 1.5: Broad-based bullish rally.
  - Ratio between 0.8 and 1.2: Mixed/neutral consolidation.
  - Ratio < 0.7: Broad-based selling pressure.

### Step 3: Presenting the Result
- Lead with the overall market breadth ratio and total securities traded.
- Pair the A/D ratio with the top gainer/loser leaders.
- State clearly that breadth covers all listed equity series on the Capital Market segment of the NSE.

---

## Pattern 3: Sectoral Peer Comparison

**User Request Example**: *"Compare Indian IT majors TCS, Infosys, and Wipro over the last quarter."*

### Step 1: Tool Execution
1. Query `nse__compare_stocks` with `symbols: ["TCS", "INFY", "WIPRO"], start_date: "2026-07-01", end_date: "2026-09-30"`.
2. For each symbol, query `nse__get_52_week_high_low` to inspect relative distance from peak levels.

### Step 2: Compare Metrics in a Table
- Never sum stock prices into a total row (`totals: false`).
- Build a structured comparison table with:
  - Symbol
  - Starting Price
  - Ending Price
  - Absolute Change (₹)
  - Period Price Return (%)
  - 52-Week Range Position

### Step 3: Synthesis
- Identify the strongest and weakest performers in the peer basket.
- Note any company-specific factors or quarterly earnings releases that occurred during the window.

