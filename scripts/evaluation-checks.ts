import { getAt, resolveValue } from "@vak/core";
import type { SessionView } from "@vak/host";

/** Instructions are not result evidence, even when they contain the expected answer. */
export function resultText(view: SessionView): string {
  return JSON.stringify({ surfaces: view.surfaces, assistant: view.timeline.filter((entry) => entry.kind === "assistant") });
}
export function separateFormAndTable(view: SessionView): boolean {
  return view.surfaces.some((form) => form.nodes.some((node) => node.type === "form") && view.surfaces.some((table) => table.id !== form.id && table.nodes.some((node) => node.type === "table")));
}

/** Only visible table cells count; unused data and assistant prose cannot supply row labels. */
export function tableRows(view: SessionView): unknown[][] {
  return view.surfaces.flatMap((surface) => surface.nodes.filter((node) => node.type === "table").flatMap((node) => {
    const props = resolveValue(node.props ?? {}, { data: surface.data, base: "" }) as Record<string, unknown>;
    if (!Array.isArray(props.rows) || !Array.isArray(props.columns)) return [];
    const columns = props.columns;
    return props.rows.map((row: unknown) => Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((column: unknown) => {
      const key = typeof column === "string" ? column : column && typeof column === "object" && "key" in column ? String(column.key) : "";
      return (row as Record<string, unknown>)[key];
    }) : []);
  }));
}

export function tableOutputText(view: SessionView): string { return JSON.stringify(tableRows(view)); }

/** Read bound control values, rather than counting expected numbers in instructions or unused data. */
export function boundFieldValues(view: SessionView): { label: string; value: unknown }[] {
  return view.surfaces.flatMap((surface) => surface.nodes.filter((node) => ["input", "select", "checkbox", "textarea", "date"].includes(node.type) && typeof node.props?.bind === "string").map((node) => ({ label: String(node.props?.label ?? ""), value: getAt(surface.data, String(node.props!.bind)) })));
}
