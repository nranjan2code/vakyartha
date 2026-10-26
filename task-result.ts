import { walk } from "@vak/core";
import type { CompletionCheck } from "@vak/providers";

export type TaskResultPolicy = { kind: "comparison"; labels?: string[] } | { kind: "research"; sources?: string[] };
export function parseTaskResultPolicy(value: unknown): TaskResultPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || (value.kind !== "comparison" && value.kind !== "research")) throw new Error("Choose a supported result layout");
  const key = value.kind === "comparison" ? "labels" : "sources";
  if (Object.keys(value).some((field) => field !== "kind" && field !== key)) throw new Error("Result layout contains unsupported fields");
  const raw = key in value ? (value as Record<string, unknown>)[key] : undefined;
  if (raw === undefined) return { kind: value.kind };
  if (!Array.isArray(raw) || !raw.length || raw.length > (key === "sources" ? 8 : 16) || raw.some((item) => typeof item !== "string" || !item.trim() || item.length > (key === "sources" ? 2000 : 120))) throw new Error("Provide a bounded, nonempty list of source URLs or option names");
  const items = raw.map((item: string) => {
    if (key === "labels") return item.trim();
    const url = new URL(item);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Sources must be public https URLs without credentials");
    return url.href;
  });
  return value.kind === "comparison" ? { kind: "comparison", labels: [...new Set(items)] } : { kind: "research", sources: [...new Set(items)] };
}
export function resultInstructions(policy?: TaskResultPolicy): string {
  if (!policy) return "";
  const named = policy.kind === "research" && policy.sources ? ` Required pages to read: ${policy.sources.join(", ")}.` : policy.kind === "comparison" && policy.labels ? ` Preserve these option labels exactly: ${policy.labels.join(", ")}.` : "";
  return named + `Required result contract: exactly TWO separate surfaces. One surface must have a root form with bound editable controls. Initialize supplied criteria values, without inventing missing values. The other surface must have a root table (not a layout containing a table). Remove surplus surfaces. End with exactly: Ready for review. ${policy.kind === "research" ? 'The evidence table has ONLY columns source and quote, with keys source and quote. Each row has ONLY those two fields. source is a successfully fetched https URL; quote is a 24–800 character verbatim excerpt of that successful web tool result, preserving its wording. Include every source successfully read in this run. Do not paraphrase facts, add conclusions/statistics or claim verification of an inference. Put interpretation decisions in the editable criteria form.' : 'Every comparison row must visibly retain its option name in a displayed name or label column. Preserve all supplied options, values and units. Never replace row identity with a prose summary.'}`;
}
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export function checkTaskResult(policy: TaskResultPolicy, result: Parameters<CompletionCheck>[0], sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const tableId = policy.kind === "research" ? "evidence" : "comparison";
  const formSurface = result.resolved.find((surface) => surface.root?.type === "form");
  const tableSurface = result.resolved.find((surface) => surface.root?.type === "table");
  if (result.surfaces.length !== 2 || !formSurface || !tableSurface || formSurface.id === tableSurface.id) problems.push("Produce exactly two separate surfaces: one root form and one root table; sections inside one surface are not separate outputs.");
  const form = formSurface?.root;
  let fields = 0;
  if (form) walk(form, (node) => { if (node.bindPath && ["input", "select", "checkbox", "textarea", "date"].includes(node.type)) fields++; });
  if (form?.type !== "form" || !fields) problems.push("The criteria surface needs a root form and at least one editable bound field.");
  const table = tableSurface?.root;
  if (table?.type !== "table") problems.push(`Surface ${tableId} needs a root table.`);
  else {
    const rows = Array.isArray(table.props.rows) ? table.props.rows : [];
    const columns = Array.isArray(table.props.columns) ? table.props.columns.map((column) => typeof column === "string" ? column : column && typeof column === "object" && "key" in column ? String(column.key) : "") : [];
    if (!rows.length) problems.push(`Surface ${tableId} needs nonempty resolved rows.`);
    if (policy.kind === "comparison") {
      const visible = rows.map((row) => Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((key) => (row as Record<string, unknown>)[key]) : []);
      if (policy.labels && (visible.length !== policy.labels.length || visible.some((cells) => policy.labels!.filter((label) => cells.includes(label)).length !== 1))) problems.push("Each declared option needs one distinct visible table row, with no extra options.");
      if (policy.labels?.some((label) => !visible.some((cells) => cells.includes(label)))) problems.push(`The comparison must visibly retain all requested option names: ${policy.labels.join(", ")}.`);
      if (visible.some((cells) => !cells.some((cell) => typeof cell === "string" && cell.trim()))) problems.push("Every comparison row needs a nonempty visible option name.");
    } else {
      if (columns.length !== 2 || !columns.includes("source") || !columns.includes("quote")) problems.push("Evidence columns must be exactly source and quote; do not add unsupported conclusions or statistics.");
      const covered = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some((key) => key !== "source" && key !== "quote") || !("source" in row) || !("quote" in row) || typeof row.source !== "string" || typeof row.quote !== "string") { problems.push("Each evidence row must contain only source and quote strings."); continue; }
        let url: string;
        try { const parsed = new URL(row.source); if (parsed.protocol !== "https:") throw new Error("https required"); url = parsed.href; } catch { problems.push("Use the full fetched https URL as source, not a data path or invented reference."); continue; }
        const text = sources.get(url), quote = normalize(row.quote);
        if (!text || quote.length < 24 || quote.length > 800 || !normalize(text).includes(quote)) problems.push(`Evidence for ${url} needs a 24–800 character verbatim excerpt from its successful web read, not a paraphrase or an unsupported inference.`);
        else covered.add(url);
      }
      if (policy.sources?.some((url) => !sources.has(url) || !covered.has(url))) problems.push(`Read and include valid excerpts from all required pages: ${policy.sources.join(", ")}.`);
      if (!sources.size || [...sources.keys()].some((url) => !covered.has(url))) problems.push("Include a valid source excerpt for every successfully read page; fetch missing sources before claiming a result.");
    }
  }
  if (result.response.trim() !== "Ready for review.") problems.push('After correcting the surfaces, end with exactly "Ready for review."; do not add an unverified prose summary.');
  return [...new Set(problems)];
}
