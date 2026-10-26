/** Exact assertions supplied by the caller, never inferred from generated prose. */
export type ComparisonContract = { identityColumn: string; rows: Record<string, string | number | boolean>[] };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const columnName = (value: string) => /^[A-Za-z_][\w-]{0,63}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function parseComparisonContract(value: unknown): ComparisonContract {
  if (!record(value) || Object.keys(value).some((key) => key !== "identityColumn" && key !== "rows") || typeof value.identityColumn !== "string" || !columnName(value.identityColumn) || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 16) throw new Error("Exact comparison checks need an identityColumn and 1–16 rows");
  const identityColumn = value.identityColumn, rows: ComparisonContract["rows"] = [], identities = new Set<string>();
  let columns: string[] | undefined;
  for (const row of value.rows) {
    if (!record(row)) throw new Error("Each expected comparison row must be an object");
    const keys = Object.keys(row);
    if (!keys.length || keys.length > 12 || keys.some((key) => !columnName(key)) || columns && (keys.length !== columns.length || keys.some((key) => !columns!.includes(key)))) throw new Error("Expected rows need the same 1–12 named columns");
    columns ??= keys;
    const name = row[identityColumn];
    if (typeof name !== "string" || !name.trim() || name.length > 120 || identities.has(name)) throw new Error("Each expected row needs a unique nonempty text identity");
    identities.add(name);
    const copy: ComparisonContract["rows"][number] = {};
    for (const [key, cell] of Object.entries(row)) {
      if (!(typeof cell === "boolean" || typeof cell === "number" && Number.isFinite(cell) || typeof cell === "string" && cell.trim() && cell.length <= 500)) throw new Error("Expected cells must be finite numbers, booleans or nonempty text up to 500 characters");
      copy[key] = cell as string | number | boolean;
    }
    rows.push(copy);
  }
  if (rows.length * columns!.length > 128 || JSON.stringify(rows).length > 12000) throw new Error("Exact comparison checks exceed 128 cells or 12,000 characters");
  return { identityColumn, rows };
}

/** Check resolved displayed columns/rows; hidden fields in data cannot satisfy an assertion. */
export function checkComparisonContract(contract: ComparisonContract, table: { columns: unknown; rows: unknown }): string[] {
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return ["Exact comparison checks require resolved table columns and rows."];
  const columns = table.columns.map((column) => typeof column === "string" ? column : record(column) && typeof column.key === "string" ? column.key : "");
  const expectedColumns = Object.keys(contract.rows[0]!);
  if (columns.length !== expectedColumns.length || new Set(columns).size !== columns.length || expectedColumns.some((key) => !columns.includes(key))) return [`Display exactly the declared comparison columns ${JSON.stringify(expectedColumns)}; order may vary.`];
  const identityIndex = columns.indexOf(contract.identityColumn), issues: string[] = [];
  const visible = table.rows.map((row) => Array.isArray(row) ? row : record(row) ? columns.map((key) => row[key]) : []);
  if (visible.length !== contract.rows.length || visible.some((row) => !contract.rows.some((expected) => expected[contract.identityColumn] === row[identityIndex]))) issues.push("Exact comparison rows must contain each declared identity once, with no extra rows.");
  for (const expected of contract.rows) {
    const name = expected[contract.identityColumn], matches = visible.filter((row) => row[identityIndex] === name);
    if (matches.length !== 1) { issues.push(`Display exactly one comparison row for ${JSON.stringify(name)}.`); continue; }
    for (const [key, value] of Object.entries(expected)) {
      if (matches[0]![columns.indexOf(key)] !== value) issues.push(`Comparison ${JSON.stringify(name)} column ${JSON.stringify(key)} must equal caller-supplied ${JSON.stringify(value)} (${typeof value}); keep its scalar type.`);
    }
  }
  return issues.slice(0, 16);
}
