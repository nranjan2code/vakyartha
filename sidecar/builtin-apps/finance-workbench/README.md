# Personal Finance Workbench

Your own INR transactions, imported as CSV or JSON, with monthly totals, a spending budget and charts. Amounts are exact (integer paise); records stay in this app's local database. No bank login, sync, network access or sample data, and actions make no model request.

## Use it

1. Open **Apps → Personal Finance Workbench**. With no records, Overview offers **Import transactions**.
2. On **Import**, paste CSV with an `id,date,description,category,amount` header (quoted fields may contain commas) or a JSON array with those fields, and press **Import**. Positive amounts are money in, negative are money out. The app opens Overview on the month the import ends in.
3. On **Overview**, choose a month and type a monthly spending budget; both save as you change them.

## Views

| View | What it shows |
| --- | --- |
| **Overview** | Month, budget and **Import more**; money in, money out, net flow and transaction count; spending against budget (turns amber past 80 % and red past 100 %); spending by category (bars and share pie); net flow by day (coloured by sign); cumulative net flow through the month; money in and out by month (up to 12) once more than one month exists. |
| **Ledger** | Month and the exact searchable, sortable transactions. |
| **Import** | The import box, the format with an example, the last import receipt, and **Delete all transactions** (asks first). |

## Rules

Amounts are decimals with up to two places and nine whole digits; floats and exponents are refused. Dates are real `YYYY-MM-DD` days. IDs are unique letters, digits, `_` or `-` and are never overwritten: importing the same file twice adds nothing and names the IDs already present. A batch (1–200 rows) is added whole or not at all; the ledger keeps up to 2,000. Net flow is not an account balance; classify transfers and refunds yourself.

## Data

Transactions live in DuckDB `ledger`; the month, budget, import draft and receipt live in app state. Both are saved together only when a run succeeds. Version-1 state loads automatically.
