// Personal Finance Workbench: your own INR transactions, imported as CSV or
// JSON into DuckDB `ledger` as signed integer paise. The ledger is the only
// transaction owner; `context.state` keeps the month, budget, import draft and
// receipt. Each run reads the selected month from SQL and `view()` derives
// every surface from it. No sample records, bank login or network.

interface Database { run(sql: string, values?: (string | number | null)[]): Promise<void>; query(sql: string, values?: (string | number | null)[]): Promise<Record<string, unknown>[]> }
export interface State { month?: string; budget?: string; importText?: string; lastImport?: { at: string; count: number }; confirmClear?: boolean }
export interface Context { state: State; surfaces?: Record<string, unknown>; database: Database; now?: () => Date }
export interface Transaction { id: string; date: string; description: string; category: string; amount: string }
/** What one run reads from DuckDB for the selected month. */
export interface Ledger { total: number; months: string[]; rows: { id: string; date: string; description: string; category: string; paise: number }[]; categories: { label: string; amount: number }[]; daily: { date: string; net: number }[]; monthly: { label: string; moneyIn: number; moneyOut: number }[] }
interface Node { id: string; type: string; props?: Record<string, unknown>; children?: string[] | { each: string; template: string } }
interface Update { surface: string; nodes: Node[]; data: { op: 'replace'; path: '/'; value: Record<string, unknown> }[] }

const MAX_IMPORT = 200, MAX_LEDGER = 2000, MAX_TEXT = 50_000;
export const TITLES: Record<string, string> = { overview: 'Overview', ledger: 'Ledger', import: 'Import' };
export const EMPTY_LEDGER: Ledger = { total: 0, months: [], rows: [], categories: [], daily: [], monthly: [] };

// --- exact parsing -----------------------------------------------------------------

export function paise(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d{1,9}(?:\.\d{1,2})?$/.test(value)) throw new Error('Amounts must be decimals with at most two places, like -1250.50');
  const sign = value.startsWith('-') ? -1 : 1, [whole, decimal = ''] = value.replace(/^-/, '').split('.');
  const result = sign * (Number(whole) * 100 + Number(decimal.padEnd(2, '0')));
  if (!Number.isSafeInteger(result)) throw new Error('Amount exceeds the supported range');
  return result;
}
/** Minimal RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch; }
    else if (ch === '"' && !field) quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (quoted) throw new Error('A quoted CSV field is not closed');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
/** A JSON array or a CSV with an id,date,description,category,amount header, validated as one batch. */
export function records(text: string): Transaction[] {
  const trimmed = text.trim();
  let rows: Record<string, unknown>[];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON must be an array of transactions');
    rows = parsed;
  } else {
    const [header, ...body] = csv(trimmed);
    const keys = (header ?? []).map((h) => h.trim().toLowerCase());
    for (const k of ['id', 'date', 'description', 'category', 'amount']) if (!keys.includes(k)) throw new Error('CSV needs a header with id, date, description, category and amount');
    rows = body.map((cells) => Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()])));
  }
  if (!rows.length || rows.length > MAX_IMPORT) throw new Error(`Import 1–${MAX_IMPORT} transactions at a time`);
  const ids = new Set<string>();
  return rows.map((r, i) => {
    const at = `Row ${i + 1}: `;
    if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(r.id) || ids.has(r.id)) throw new Error(`${at}IDs must be unique letters, digits, _ or -`);
    ids.add(r.id);
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || new Date(r.date).toISOString().slice(0, 10) !== r.date) throw new Error(`${at}use a real YYYY-MM-DD date`);
    if (typeof r.description !== 'string' || !r.description.trim() || r.description.length > 200 || typeof r.category !== 'string' || !r.category.trim() || r.category.length > 60) throw new Error(`${at}needs a description and a category`);
    try { if (paise(r.amount) === 0) throw new Error('Zero amounts are not imported'); } catch (e) { throw new Error(`${at}${(e as Error).message}`); }
    return { id: r.id, date: r.date, description: r.description.trim(), category: r.category.trim(), amount: r.amount as string };
  });
}

// --- canonical state and the ledger read ---------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export function normalize(s: State, now = new Date()): State {
  const old = s as State & { lastCount?: unknown };
  const lastImport = s.lastImport && typeof s.lastImport === 'object' ? s.lastImport
    : typeof s.lastImport === 'string' && Number.isInteger(old.lastCount) ? { at: s.lastImport, count: old.lastCount as number } : undefined;
  return {
    month: typeof s.month === 'string' && MONTH.test(s.month) ? s.month : now.toISOString().slice(0, 7),
    budget: typeof s.budget === 'string' && s.budget !== '0' ? s.budget.slice(0, 20) : '',
    importText: typeof s.importText === 'string' ? s.importText.slice(0, MAX_TEXT) : '',
    ...(lastImport && typeof lastImport.at === 'string' && Number.isInteger(lastImport.count) ? { lastImport: { at: lastImport.at, count: lastImport.count } } : {}),
    confirmClear: s.confirmClear === true,
  };
}
async function initialize(db: Database) {
  await db.run('CREATE TABLE IF NOT EXISTS ledger(id VARCHAR PRIMARY KEY, date VARCHAR, description VARCHAR, category VARCHAR, paise BIGINT)');
}
export async function load(db: Database, month: string): Promise<Ledger> {
  await initialize(db);
  const total = Number((await db.query('SELECT count(*)::INTEGER AS n FROM ledger'))[0]!.n);
  if (!total) return EMPTY_LEDGER;
  const months = (await db.query('SELECT DISTINCT substr(date,1,7) AS m FROM ledger ORDER BY m DESC')).map((r) => String(r.m));
  const rows = (await db.query('SELECT id,date,description,category,paise::DOUBLE AS paise FROM ledger WHERE substr(date,1,7)=? ORDER BY date,id', [month])).map((r) => ({ id: String(r.id), date: String(r.date), description: String(r.description), category: String(r.category), paise: Number(r.paise) }));
  const categories = (await db.query('SELECT category AS label, sum(-paise)::DOUBLE/100 AS amount FROM ledger WHERE substr(date,1,7)=? AND paise<0 GROUP BY category ORDER BY amount DESC', [month])).map((r) => ({ label: String(r.label), amount: Number(r.amount) }));
  const daily = (await db.query('SELECT date, sum(paise)::DOUBLE/100 AS net FROM ledger WHERE substr(date,1,7)=? GROUP BY date ORDER BY date', [month])).map((r) => ({ date: String(r.date), net: Number(r.net) }));
  const monthly = (await db.query('SELECT substr(date,1,7) AS m, sum(CASE WHEN paise>0 THEN paise ELSE 0 END)::DOUBLE/100 AS i, sum(CASE WHEN paise<0 THEN -paise ELSE 0 END)::DOUBLE/100 AS o FROM ledger GROUP BY m ORDER BY m DESC LIMIT 12')).map((r) => ({ label: String(r.m), moneyIn: Number(r.i), moneyOut: Number(r.o) })).reverse();
  return { total, months, rows, categories, daily, monthly };
}

// --- actions ---------------------------------------------------------------------

export async function handleAction(controlId: string, value: unknown, c: Context, action?: string) {
  const now = c.now?.() ?? new Date();
  const s = (c.state = normalize(c.state, now));
  let focusSurface: string | undefined;
  if (!action) {
    if (controlId === '/month') { if (!MONTH.test(String(value))) throw new Error('Choose a month'); s.month = String(value); }
    else if (controlId === '/budget') s.budget = String(value ?? '').trim().slice(0, 20);
    else if (controlId === '/importText') { if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error('Paste at most 50,000 characters at a time'); s.importText = value; }
    else throw new Error(`Unknown Finance Workbench field: ${controlId}`);
  } else if (action === 'import_records') {
    const rows = records(s.importText ?? '');
    await initialize(c.database);
    const total = Number((await c.database.query('SELECT count(*)::INTEGER AS n FROM ledger'))[0]!.n);
    if (total + rows.length > MAX_LEDGER) throw new Error(`The ledger keeps up to ${MAX_LEDGER} records`);
    const clash = await c.database.query(`SELECT id FROM ledger WHERE id IN (${rows.map(() => '?').join(',')}) LIMIT 3`, rows.map((r) => r.id));
    if (clash.length) throw new Error(`Already imported: ${clash.map((r) => r.id).join(', ')}. Nothing was added; IDs are never overwritten.`);
    await c.database.run('BEGIN TRANSACTION');
    try {
      for (const r of rows) await c.database.run('INSERT INTO ledger VALUES(?,?,?,?,?)', [r.id, r.date, r.description, r.category, paise(r.amount)]);
      await c.database.run('COMMIT');
    } catch { await c.database.run('ROLLBACK'); throw new Error('Import rejected as a whole; check the IDs and values'); }
    s.lastImport = { at: now.toISOString(), count: rows.length };
    s.importText = '';
    // Show the month the import ends in, which is usually the one being reviewed.
    s.month = rows.map((r) => r.date.slice(0, 7)).sort().at(-1)!;
    focusSurface = 'overview';
  } else if (action === 'show_import') {
    focusSurface = 'import';
  } else if (action === 'ask_clear') {
    s.confirmClear = true;
  } else if (action === 'cancel_clear') {
    s.confirmClear = false;
  } else if (action === 'clear_ledger') {
    await initialize(c.database);
    await c.database.run('DELETE FROM ledger');
    s.confirmClear = false;
    delete s.lastImport;
  } else if (action !== 'recalculate') {
    throw new Error(`Unknown Finance Workbench action: ${action}`);
  }
  return { updates: view(s, await load(c.database, s.month!)), ...(focusSurface ? { focusSurface } : {}) };
}

// --- derived views -----------------------------------------------------------------

const money = (p: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const replaceAll = (value: Record<string, unknown>) => [{ op: 'replace' as const, path: '/' as const, value }];
const budgetOf = (s: State) => { try { const p = paise(s.budget); return p > 0 ? p : null; } catch { return null; } };
const monthOptions = (s: State, l: Ledger) => [...new Set([s.month!, ...l.months])].sort().reverse().map((m) => ({ label: monthName(m), value: m }));
const EXAMPLE = 'id,date,description,category,amount\nsalary-2026-10,2026-10-01,October salary,Income,85000.00\nrent-2026-10,2026-10-03,Rent,Housing,-25000.00';

export function view(input: State, l: Ledger = EMPTY_LEDGER): Update[] {
  const s = normalize(input);
  return [overviewSurface(s, l), ledgerSurface(s, l), importSurface(s, l)];
}

function overviewSurface(s: State, l: Ledger): Update {
  const signed = l.rows.map((r) => r.paise);
  const income = signed.filter((v) => v > 0).reduce((a, b) => a + b, 0), spent = -signed.filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const budget = budgetOf(s), badBudget = Boolean(s.budget) && budget === null, has = l.rows.length > 0;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: l.total ? ['fin-bar', ...(badBudget ? ['budget-hint'] : []), ...(has ? ['totals', budget ? 'budget-progress' : 'budget-none', 'charts'] : ['month-empty'])] : ['fin-empty'] },
    ...(l.total ? [
      { id: 'fin-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['month', 'budget', 'add-more'] },
      { id: 'month', type: 'select', props: { label: 'Month', bind: '/month', options: '{/monthOptions}' } },
      { id: 'budget', type: 'input', props: { label: 'Monthly spending budget · INR', bind: '/budget', placeholder: '40000' } },
      { id: 'add-more', type: 'button', props: { label: 'Import more', action: 'show_import', style: 'secondary' } },
      ...(badBudget ? [{ id: 'budget-hint', type: 'text', props: { content: 'The budget must be a number like 40000 or 40000.50.', variant: 'caption' } }] : []),
      ...(has ? [
        { id: 'totals', type: 'grid', props: { columns: 4, minItemWidth: 'sm', gap: 'sm' }, children: { each: '/totals', template: 'total' } },
        { id: 'total', type: 'stat', props: { label: '{label}', value: '{value}' } },
        budget
          ? { id: 'budget-progress', type: 'progress', props: { label: 'Spending against budget', value: '{/budgetUsed}', max: '{/budgetMax}', unit: '₹', tone: '{/budgetTone}' } }
          : { id: 'budget-none', type: 'text', props: { content: 'Set a monthly budget to track spending against it.', variant: 'caption' } },
        { id: 'charts', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'md' }, children: [...(l.categories.length ? ['spending-chart', 'share-chart'] : []), 'flow-chart', 'running-chart', ...(l.monthly.length > 1 ? ['trend-chart'] : [])] },
        ...(l.categories.length ? [{ id: 'share-chart', type: 'chart', props: { kind: 'pie', title: 'Share of spending', series: { records: '{/categories}', label: 'label', fields: ['amount'] }, height: 'md' } }] : []),
        { id: 'running-chart', type: 'chart', props: { kind: 'area', title: 'Cumulative net flow this month · INR', series: { records: '{/running}', label: 'date', fields: ['cumulative'] }, height: 'md' } },
        ...(l.monthly.length > 1 ? [{ id: 'trend-chart', type: 'chart', props: { kind: 'bar', title: 'Money in and out by month · INR', series: { records: '{/monthly}', label: 'label', fields: ['moneyIn', 'moneyOut'] }, height: 'md' } }] : []),
        ...(l.categories.length ? [{ id: 'spending-chart', type: 'chart', props: { kind: 'bar', orientation: 'horizontal', title: 'Spending by category · INR', series: { records: '{/categories}', label: 'label', fields: ['amount'] }, height: 'md' } }] : []),
        { id: 'flow-chart', type: 'chart', props: { kind: 'bar', colorBy: 'sign', title: 'Net flow by day · INR (not a balance)', series: { records: '{/daily}', label: 'date', fields: ['net'] }, height: 'md' } },
      ] : [{ id: 'month-empty', type: 'text', props: { content: '{/monthEmpty}', variant: 'caption' } }]),
    ] : [
      { id: 'fin-empty', type: 'card', props: { title: 'No transactions yet', body: 'Import your own records as CSV or JSON: positive amounts are money in, negative amounts are money out. Totals, a budget and charts appear here. Nothing leaves this computer.' }, children: ['start-import'] },
      { id: 'start-import', type: 'button', props: { label: 'Import transactions', action: 'show_import', style: 'primary' } },
    ]),
  ];
  const data = l.total ? {
    month: s.month, budget: s.budget, monthOptions: monthOptions(s, l),
    ...(has ? {
      totals: [{ label: 'Money in', value: money(income) }, { label: 'Money out', value: money(spent) }, { label: 'Net flow', value: money(income - spent) }, { label: 'Transactions', value: String(l.rows.length) }],
      ...(budget ? { budgetUsed: spent / 100, budgetMax: budget / 100, budgetTone: spent > budget ? 'danger' : spent > budget * 0.8 ? 'warning' : 'success' } : {}),
      categories: l.categories, daily: l.daily,
      running: l.daily.reduce<{ date: string; cumulative: number }[]>((acc, d) => [...acc, { date: d.date, cumulative: Math.round(((acc.at(-1)?.cumulative ?? 0) + d.net) * 100) / 100 }], []),
      ...(l.monthly.length > 1 ? { monthly: l.monthly } : {}),
    } : { monthEmpty: `No transactions in ${monthName(s.month!)}. Choose another month or import more.` }),
  } : {};
  return { surface: 'overview', nodes, data: replaceAll(data) };
}

function ledgerSurface(s: State, l: Ledger): Update {
  const has = l.rows.length > 0;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: l.total ? ['ledger-bar', has ? 'transactions' : 'ledger-month-empty'] : ['ledger-empty'] },
    ...(l.total ? [
      { id: 'ledger-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['ledger-month', 'ledger-add'] },
      { id: 'ledger-month', type: 'select', props: { label: 'Month', bind: '/month', options: '{/monthOptions}' } },
      { id: 'ledger-add', type: 'button', props: { label: 'Import more', action: 'show_import', style: 'secondary' } },
      has
        ? { id: 'transactions', type: 'table', props: { rows: '{/transactions}', columns: [{ key: 'date', label: 'Date' }, { key: 'description', label: 'Description' }, { key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount', align: 'end' }, { key: 'id', label: 'ID' }], sortable: true, searchable: true, pageSize: 15 } }
        : { id: 'ledger-month-empty', type: 'text', props: { content: 'No transactions in this month.', variant: 'caption' } },
    ] : [{ id: 'ledger-empty', type: 'text', props: { content: 'Imported transactions are listed here exactly as stored.', variant: 'caption' } }]),
  ];
  const data = l.total ? { month: s.month, monthOptions: monthOptions(s, l), ...(has ? { transactions: l.rows.map((r) => ({ ...r, amount: money(r.paise) })) } : {}) } : {};
  return { surface: 'ledger', nodes, data: replaceAll(data) };
}

function importSurface(s: State, l: Ledger): Update {
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['import-section', 'format-section', ...(l.total ? ['manage-section'] : [])] },
    { id: 'import-section', type: 'section', props: { title: 'Import transactions', description: '{/receipt}' }, children: ['import-text', 'import-bar'] },
    { id: 'import-text', type: 'textarea', props: { label: 'Paste CSV or JSON', bind: '/importText', placeholder: EXAMPLE, rows: 10 } },
    { id: 'import-bar', type: 'stack', props: { direction: 'horizontal', gap: 'sm' }, children: ['import'] },
    { id: 'import', type: 'button', props: { label: 'Import', action: 'import_records', style: 'primary' } },
    { id: 'format-section', type: 'section', props: { title: 'Format' }, children: ['format', 'format-example', 'privacy'] },
    { id: 'format', type: 'text', props: { content: 'One row per transaction with **id, date, description, category, amount**. Amounts are INR decimals with up to two places: positive for money in, negative for money out. IDs must be unique and stay fixed, so importing the same file twice adds nothing. Up to 200 rows per import and 2,000 in the ledger; a batch is added whole or not at all.' } },
    { id: 'format-example', type: 'text', props: { content: EXAMPLE, variant: 'code' } },
    { id: 'privacy', type: 'text', props: { content: 'Records stay in this app’s local database. No bank login, sync or network access. Net flow is not an account balance; classify transfers and refunds yourself.', variant: 'caption' } },
    ...(l.total ? [
      { id: 'manage-section', type: 'section', props: { title: 'Ledger', description: '{/ledgerSize}' }, children: [s.confirmClear ? 'confirm-clear' : 'ask-clear'] },
      ...(s.confirmClear ? [
        { id: 'confirm-clear', type: 'card', props: { title: 'Delete every transaction?', body: 'The whole ledger is removed from this app for good. Your original files are not touched.', tone: 'danger' }, children: ['confirm-bar'] },
        { id: 'confirm-bar', type: 'stack', props: { direction: 'horizontal', gap: 'sm' }, children: ['clear-yes', 'clear-no'] },
        { id: 'clear-yes', type: 'button', props: { label: 'Delete all', action: 'clear_ledger', style: 'danger' } },
        { id: 'clear-no', type: 'button', props: { label: 'Keep them', action: 'cancel_clear', style: 'secondary' } },
      ] : [{ id: 'ask-clear', type: 'button', props: { label: 'Delete all transactions', action: 'ask_clear', style: 'link' } }]),
    ] : []),
  ];
  const data = {
    importText: s.importText,
    receipt: s.lastImport ? `Last import: ${plural(s.lastImport.count, 'transaction')} on ${s.lastImport.at.slice(0, 10)} at ${s.lastImport.at.slice(11, 16)} UTC.` : 'Nothing imported yet. Use your own records; no sample data is supplied.',
    ...(l.total ? { ledgerSize: `${plural(l.total, 'transaction')} across ${plural(l.months.length, 'month')}.` } : {}),
  };
  return { surface: 'import', nodes, data: replaceAll(data) };
}

/** The shipped surface.json: every view of a new, empty app (dated by its month only through data). */
export const surfaceFile = (now = new Date()) => view(normalize({}, now)).map((u) => ({ id: u.surface, title: TITLES[u.surface], data: u.data[0]!.value, nodes: u.nodes }));
