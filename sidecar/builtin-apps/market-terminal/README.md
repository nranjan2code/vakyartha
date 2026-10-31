# NSE Market Terminal

Delayed NSE market observations for India: index levels, sector moves, a watchlist of up to six stocks, and daily price history with analytics computed in DuckDB. Every value comes from a successful read of the NSE integrations; nothing is invented, and actions make no model request.

## Connect

1. In **Settings → Integrations**, enable **NSE** and **NSE Market Live** (official HTTPS endpoints, no credentials). Set this app's three read tools to **Allow**: `nse-cmmkt__cm_get_live_indices`, `nse-cmmkt__cm_get_stock_quote`, `nse__get_stock_history`. Ask and Off stay enforced; the app never changes your policies.
2. Open **Apps → NSE Market Terminal** and press **Refresh**.

Until a read succeeds the Market view says exactly this instead of showing empty numbers. A refresh in which some reads fail shows a warning with the first failure and keeps every earlier observation with its own source time.

## Views

| View | What it shows |
| --- | --- |
| **Market** | Watchlist field and **Refresh**; headline index stats (NIFTY 50, NIFTY BANK and others when present); watchlist cards with price, change, range and volume beside a signed session-change chart; each card's **Open** fetches that stock and opens Instrument; a sector rotation chart (horizontal bars coloured by sign) and a searchable, sortable index table. |
| **Instrument** | Symbol, history window (1–3 months) and **Fetch quote & history**; delayed quote stats; daily OHLC candles; analytics stats (price return, annualized volatility, maximum closing drawdown, sessions and average volume); charts for the 20-session average, daily returns, volume and drawdown; the exact OHLCV table. |
| **Sources** | The latest 40 reads with tool, subject, source time, retrieval time, rows and status; the calculation methods. |

The watchlist and symbol fields save as you type and are applied when you press Refresh or Fetch, so a half-typed symbol never fails a run. Layouts use adaptive grids and splits: two to four columns when wide, one column on a phone.

## Calculations

- Price return: last close / first close − 1, unadjusted for dividends and corporate actions.
- Daily return: close / previous close − 1; the first session has none.
- Annualized volatility: sample standard deviation of daily returns × √252; shown from three sessions.
- Drawdown: close / running maximum close − 1; the maximum drawdown is its minimum.
- 20-session average: shown from the twentieth observed session, never zero-filled.

Charts space sessions evenly; they are trading days, not a continuous calendar. Sector up/down counts describe index coverage, not market breadth. The feed is a delayed snapshot (roughly 1–3 minutes), not streaming ticks.

## Refresh and schedule

**Refresh** reads three index groups and every watchlist quote (at most nine reads). **Fetch** and **Open** read one quote and one history. A five-minute market refresh is declared but off until you enable it under **Manage**; it runs only while the app and computer are awake and uses the saved watchlist.

## Data

Daily OHLCV lives in the app's DuckDB table `prices`; quotes, index snapshots, settings and receipts live in app state. Both are saved together only when a run succeeds. State from version 1 (a comma-separated watchlist string) loads automatically.
