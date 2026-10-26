import { projectText, walk } from "@vak/core";
import type { CompletionCheck } from "@vak/providers";

export type TaskResultPolicy = ({ kind: "comparison"; labels?: string[] } | { kind: "research"; sources?: string[] }) & { notices?: string[] };
export function parseTaskResultPolicy(value: unknown): TaskResultPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || (value.kind !== "comparison" && value.kind !== "research")) throw new Error("Choose a supported result layout");
  const key = value.kind === "comparison" ? "labels" : "sources";
  if (Object.keys(value).some((field) => field !== "kind" && field !== key && field !== "notices")) throw new Error("Result layout contains unsupported fields");
  const notices = "notices" in value ? value.notices : undefined;
  if (notices !== undefined && (!Array.isArray(notices) || !notices.length || notices.length > 8 || notices.some((notice) => typeof notice !== "string" || !notice.trim() || notice.length > 120))) throw new Error("Provide up to 8 nonempty visible notices, each at most 120 characters");
  const common = notices === undefined ? {} : { notices: [...new Set((notices as string[]).map((notice) => notice.trim()))] };
  const raw = key in value ? (value as Record<string, unknown>)[key] : undefined;
  if (raw === undefined) return { kind: value.kind, ...common };
  if (!Array.isArray(raw) || !raw.length || raw.length > (key === "sources" ? 8 : 16) || raw.some((item) => typeof item !== "string" || !item.trim() || item.length > (key === "sources" ? 2000 : 120))) throw new Error("Provide a bounded, nonempty list of source URLs or option names");
  const items = raw.map((item: string) => {
    if (key === "labels") return item.trim();
    const url = new URL(item);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Sources must be public https URLs without credentials");
    return url.href;
  });
  return value.kind === "comparison" ? { kind: "comparison", labels: [...new Set(items)], ...common } : { kind: "research", sources: [...new Set(items)], ...common };
}
export function resultInstructions(policy?: TaskResultPolicy): string {
  if (!policy) return "";
  const named = policy.kind === "research" && policy.sources ? ` Required pages to read: ${policy.sources.join(", ")}.` : policy.kind === "comparison" && policy.labels ? ` Preserve these option labels exactly: ${policy.labels.join(", ")}.` : "";
  const notices = policy.notices?.length ? ` Required visible notices, supplied by the user: ${JSON.stringify(policy.notices)}. Copy each notice into a visible surface title or content; unused data does not display it.` : "";
  return named + notices + `Required result contract: exactly TWO separate surfaces. One surface must contain one form with bound editable controls and no comparison table. Initialize supplied criteria values, without inventing missing values. The other surface must contain one comparison table and no form. Layout/title wrappers are allowed on either independent surface. Remove surplus surfaces. Finish when the outputs are ready for user review; the app supplies a neutral acknowledgement. ${policy.kind === "research" ? 'The evidence table has ONLY columns source and quote, with keys source and quote. Each row has ONLY those two fields. source is a successfully fetched https URL; quote is a 24–800 character verbatim excerpt of that successful web tool result, preserving its wording. Include every source successfully read in this run. Do not paraphrase facts, add conclusions/statistics or claim verification of an inference. Put interpretation decisions in the editable criteria form.' : 'Every comparison row must visibly retain its option name in a displayed column. Every displayed cell needs its actual value or an explicit missing-data label; a column key must match its row field. Preserve all supplied options, values and units. Never replace row identity with a prose summary.'}`;
}
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export function checkTaskResult(policy: TaskResultPolicy, result: Parameters<CompletionCheck>[0], sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const visibleText = normalize(result.resolved.map((surface) => projectText(surface)).join("\n")).toLowerCase();
  for (const notice of policy.notices ?? []) {
    const escaped = normalize(notice).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(visibleText)) problems.push(`Display the user-supplied notice ${JSON.stringify(notice)} in a visible surface title or content. Preserve the existing outputs; a notice in unused data is not visible.`);
  }
  const tableId = policy.kind === "research" ? "evidence" : "comparison";
  const outputs = result.resolved.map((surface) => {
    const forms: NonNullable<typeof surface.root>[] = [], tables: NonNullable<typeof surface.root>[] = [];
    if (surface.root) walk(surface.root, (node) => { if (node.type === "form") forms.push(node); if (node.type === "table") tables.push(node); });
    return { surface, forms, tables };
  });
  const formOutput = outputs.find((output) => output.forms.length === 1 && !output.tables.length);
  const tableOutput = outputs.find((output) => output.tables.length === 1 && !output.forms.length);
  const formSurface = formOutput?.surface, tableSurface = tableOutput?.surface;
  if (result.surfaces.length !== 2 || !formSurface || !tableSurface || formSurface.id === tableSurface.id) problems.push("Produce exactly two separate surfaces: one containing a form and no table, the other containing a table and no form. Layout wrappers are allowed; sections inside one combined surface are not separate outputs.");
  if (formSurface && tableSurface && formSurface.id !== tableSurface.id && result.surfaces.length > 2) {
    const obsolete = result.surfaces.filter((surface) => surface.id !== formSurface.id && surface.id !== tableSurface.id);
    problems.push(`Keep the separate form ${JSON.stringify(formSurface.id)} and table ${JSON.stringify(tableSurface.id)}. Remove obsolete extra surfaces with vak_remove using only these surface arguments: ${JSON.stringify(obsolete.slice(0, 16).map((surface) => ({ surface: surface.id })))}. Do not rewrite the two kept surfaces just to remove extras.`);
  }
  const form = formOutput?.forms[0];
  let fields = 0;
  if (form) walk(form, (node) => { if (node.bindPath && ["input", "select", "checkbox", "textarea", "date"].includes(node.type)) fields++; });
  if (form?.type !== "form" || !fields) problems.push("The criteria surface needs one form and at least one editable bound field, separate from the comparison table.");
  const table = tableOutput?.tables[0];
  if (table?.type !== "table") problems.push(`Surface ${tableId} needs one table, separate from the criteria form.`);
  else {
    const rows = Array.isArray(table.props.rows) ? table.props.rows : [];
    const columns = Array.isArray(table.props.columns) ? table.props.columns.map((column) => typeof column === "string" ? column : column && typeof column === "object" && "key" in column ? String(column.key) : "") : [];
    if (!rows.length) problems.push(`Surface ${tableId} needs nonempty resolved rows.`);
    if (policy.kind === "comparison") {
      const visible = rows.map((row) => Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((key) => (row as Record<string, unknown>)[key]) : []);
      rows.forEach((row, index) => {
        const absent = columns.filter((_key, column) => { const value = visible[index]?.[column]; return value === undefined || value === null || typeof value === "string" && !value.trim(); });
        if (absent.length) problems.push(`Comparison row ${index + 1} has blank displayed cells for ${JSON.stringify(absent)}. Match column keys to the actual row fields ${JSON.stringify(row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : [])}; supply known values or explicit missing-data labels, never invent a value.`);
      });
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
  return [...new Set(problems)];
}


/** The app supplies review prose; wording alone must never start a repair run. */
export function reviewTaskResult(policy: TaskResultPolicy, result: Parameters<CompletionCheck>[0], sources: ReadonlyMap<string, string>) {
  return { issues: checkTaskResult(policy, result, sources), response: "Ready for review." };
}
