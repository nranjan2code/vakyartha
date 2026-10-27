// A bounded parser for selected UTF-8 CSV snapshots. Facts are parsed once by
// their input owner; presentation generation receives a source reference.
import type { TableSources, SourceCell } from "@vak/core";
import type { TaskFileInput } from "../shared/task-files.ts";
import { digest } from "./task-files.ts";

export function selectedTableSources(inputs: readonly Pick<TaskFileInput, "name" | "content">[], notices: readonly string[] = [], labels: readonly string[] = []): TableSources {
  const sources: Record<string, TableSources[string]> = {};
  inputs.forEach((input, index) => {
    if (!input.name.toLowerCase().endsWith(".csv")) return;
    const records: string[][] = [];
    let record: string[] = [], value = "", quoted = false, closed = false, started = false;
    const field = () => { record.push(value); value = ""; closed = false; started = false; if (record.length > 32) throw new Error("Selected CSV exceeds 32 columns"); };
    const row = () => { field(); if (record.some((cell) => cell !== "")) records.push(record); record = []; if (records.length > 501) throw new Error("Selected CSV exceeds 500 rows"); };
    const text = input.content.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (quoted) {
        if (char === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
        else value += char;
      } else if (char === ",") field();
      else if (char === "\r" || char === "\n") { if (char === "\r" && text[i + 1] === "\n") i++; row(); }
      else if (char === '"' && !started && !value && !closed) { quoted = true; started = true; }
      else { if (closed || char === '"') throw new Error("Selected CSV contains text outside a quoted field"); value += char; started = true; }
    }
    if (quoted) throw new Error("Selected CSV has an unclosed quoted field");
    if (value || record.length || started || closed) row();
    const columns = records.shift();
    if (!columns?.length || columns.some((column) => !column.trim() || column.length > 120) || new Set(columns).size !== columns.length || !records.length || records.some((row) => row.length !== columns.length)) throw new Error("Selected CSV needs unique nonempty headers and equally sized data rows");
    const scalar = (cell: string): SourceCell => {
      try { const parsed: unknown = JSON.parse(cell); if (typeof parsed === "number" && Number.isFinite(parsed) && (!Number.isInteger(parsed) || Number.isSafeInteger(parsed))) return parsed; } catch { /* source strings and identifiers remain verbatim */ }
      return cell;
    };
    const identities = new Set(records.map((record) => record[0]));
    const extraLabels = labels.filter((label) => !identities.has(label));
    const totalLabel = labels.length && records.every((record) => labels.includes(record[0]!)) && extraLabels.length === 1 ? extraLabels[0] : undefined;
    sources[`file_${index + 1}`] = { columns, ...(totalLabel ? { totalLabel } : {}), rows: records.map((row) => row.map(scalar)), filename: input.name, sha256: digest(input.content), notices: [...notices], context: inputs.filter((context) => !context.name.toLowerCase().endsWith(".csv")).map((context) => ({ filename: context.name, sha256: digest(context.content), content: context.content })) };
  });
  return sources;
}
