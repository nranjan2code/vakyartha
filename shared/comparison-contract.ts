/** Exact assertions supplied by the caller, never inferred from generated prose. */
type Scalar = string | number | boolean;
export type ComparisonExpression = number | boolean | { column: string } | { criterion: string } | { op: "divide" | "lte" | "gte" | "and"; args: [ComparisonExpression, ComparisonExpression] };
export type ComparisonContract = { identityColumn: string; rows: Record<string, Scalar>[]; criteria?: Record<string, number>; calculations?: Record<string, ComparisonExpression> };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const columnName = (value: string) => /^[A-Za-z_][\w-]{0,63}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function parseComparisonContract(value: unknown): ComparisonContract {
  if (!record(value) || Object.keys(value).some((key) => !["identityColumn", "rows", "criteria", "calculations"].includes(key)) || typeof value.identityColumn !== "string" || !columnName(value.identityColumn) || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 16) throw new Error("Exact comparison checks need an identityColumn and 1–16 rows");
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
  const contract: ComparisonContract = { identityColumn, rows };
  if (value.criteria !== undefined || value.calculations !== undefined) {
    if (!record(value.criteria) || !record(value.calculations)) throw new Error("Computed comparisons need criteria and calculations objects");
    const criteria = Object.entries(value.criteria), calculations = Object.entries(value.calculations);
    if (!criteria.length || criteria.length > 8 || criteria.some(([key, n]) => !columnName(key) || typeof n !== "number" || !Number.isFinite(n))) throw new Error("Provide 1–8 named finite numeric criteria");
    if (!calculations.length || calculations.length > 8 || calculations.some(([key]) => !columnName(key) || columns!.includes(key)) || columns!.length + calculations.length > 12 || rows.length * (columns!.length + calculations.length) > 128) throw new Error("Computed columns must be distinct from supplied facts and fit the comparison cell limit");
    let count = 0;
    const parse = (expr: unknown, depth = 0): ComparisonExpression => {
      if (++count > 64 || depth > 5) throw new Error("Comparison expressions exceed the size or depth limit");
      if (typeof expr === "boolean" || typeof expr === "number" && Number.isFinite(expr)) return expr;
      if (!record(expr)) throw new Error("Invalid comparison expression");
      if (Object.keys(expr).length === 1 && typeof expr.column === "string" && columns!.includes(expr.column)) return { column: expr.column };
      if (Object.keys(expr).length === 1 && typeof expr.criterion === "string" && Object.hasOwn(value.criteria as object, expr.criterion)) return { criterion: expr.criterion };
      if (Object.keys(expr).length !== 2 || !["divide", "lte", "gte", "and"].includes(String(expr.op)) || !Array.isArray(expr.args) || expr.args.length !== 2) throw new Error("Use column/criterion references or a supported binary operation");
      return { op: expr.op as "divide" | "lte" | "gte" | "and", args: [parse(expr.args[0], depth + 1), parse(expr.args[1], depth + 1)] };
    };
    contract.criteria = Object.fromEntries(criteria) as Record<string, number>;
    contract.calculations = Object.fromEntries(calculations.map(([key, expr]) => [key, parse(expr)]));
    comparisonExpectedRows(contract);
  }
  return contract;
}

/** A bounded expression tree supplied by the caller; never executable source or model inference. */
export function comparisonExpectedRows(contract: ComparisonContract): ComparisonContract["rows"] {
  const evaluate = (expr: ComparisonExpression, row: Record<string, Scalar>): Scalar => {
    if (typeof expr !== "object") return expr;
    if ("column" in expr) return row[expr.column]!;
    if ("criterion" in expr) return contract.criteria![expr.criterion]!;
    const a = evaluate(expr.args[0], row), b = evaluate(expr.args[1], row);
    if (expr.op === "and") {
      if (typeof a !== "boolean" || typeof b !== "boolean") throw new Error("and requires boolean operands");
      return a && b;
    }
    if (typeof a !== "number" || typeof b !== "number") throw new Error("Numeric comparison operations require numbers");
    if (expr.op === "lte") return a <= b;
    if (expr.op === "gte") return a >= b;
    const result = a / b;
    if (!Number.isFinite(result)) throw new Error("Comparison calculation is not finite");
    return result;
  };
  return contract.rows.map((row) => ({ ...row, ...Object.fromEntries(Object.entries(contract.calculations ?? {}).map(([key, expr]) => [key, evaluate(expr, row)])) }));
}

export function reviseComparisonCriteria(contract: ComparisonContract, criteria: unknown): ComparisonContract {
  if (!contract.criteria || !record(criteria) || Object.keys(criteria).length !== Object.keys(contract.criteria).length || Object.entries(criteria).some(([key, value]) => !Object.hasOwn(contract.criteria!, key) || typeof value !== "number" || !Number.isFinite(value))) throw new Error("Submit every declared numeric criterion, with no extra criteria");
  return parseComparisonContract({ ...contract, criteria });
}

/** Check resolved displayed columns/rows; hidden fields in data cannot satisfy an assertion. */
export function checkComparisonContract(contract: ComparisonContract, table: { columns: unknown; rows: unknown }): string[] {
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return ["Exact comparison checks require resolved table columns and rows."];
  const columns = table.columns.map((column) => typeof column === "string" ? column : record(column) && typeof column.key === "string" ? column.key : "");
  const expectedRows = comparisonExpectedRows(contract), expectedColumns = Object.keys(expectedRows[0]!);
  if (columns.length !== expectedColumns.length || new Set(columns).size !== columns.length || expectedColumns.some((key) => !columns.includes(key))) return [`Display exactly the declared comparison columns ${JSON.stringify(expectedColumns)}; order may vary.`];
  const identityIndex = columns.indexOf(contract.identityColumn), issues: string[] = [];
  const visible = table.rows.map((row) => Array.isArray(row) ? row : record(row) ? columns.map((key) => row[key]) : []);
  if (visible.length !== expectedRows.length || visible.some((row) => !expectedRows.some((expected) => expected[contract.identityColumn] === row[identityIndex]))) issues.push("Exact comparison rows must contain each declared identity once, with no extra rows.");
  for (const expected of expectedRows) {
    const name = expected[contract.identityColumn], matches = visible.filter((row) => row[identityIndex] === name);
    if (matches.length !== 1) { issues.push(`Display exactly one comparison row for ${JSON.stringify(name)}.`); continue; }
    for (const [key, value] of Object.entries(expected)) {
      if (matches[0]![columns.indexOf(key)] !== value) issues.push(`Comparison ${JSON.stringify(name)} column ${JSON.stringify(key)} must equal caller-supplied ${JSON.stringify(value)} (${typeof value}); keep its scalar type.`);
    }
  }
  return issues.slice(0, 16);
}
