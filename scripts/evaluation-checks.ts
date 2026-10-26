import { basicCatalog, getAt, projectText, SurfaceStore, walk, type ResolvedNode } from "@vak/core";
import type { SessionView } from "@vak/host";

function resolvedSurfaces(view: SessionView) {
  const store = new SurfaceStore(basicCatalog);
  view.surfaces.forEach((surface) => store.load(surface));
  return store.list().map((surface) => store.resolve(surface.id)!);
}
function nodesOf(root: ResolvedNode | null): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  if (root) walk(root, (node) => nodes.push(node));
  return nodes;
}

/** Instructions and unused/hidden data are not displayed result evidence. */
export function resultText(view: SessionView): string {
  return JSON.stringify({ surfaces: resolvedSurfaces(view).map((surface) => projectText(surface)), assistant: view.timeline.filter((entry) => entry.kind === "assistant").map((entry) => entry.text) });
}
export function separateFormAndTable(view: SessionView): boolean {
  const outputs = resolvedSurfaces(view).map((surface) => ({ id: surface.id, types: nodesOf(surface.root).map((node) => node.type) }));
  return outputs.some((form) => form.types.includes("form") && !form.types.includes("table") && outputs.some((table) => table.id !== form.id && table.types.includes("table") && !table.types.includes("form")));
}

export function tablePayloads(view: SessionView): { columns: unknown; rows: unknown }[] {
  return resolvedSurfaces(view).flatMap((surface) => nodesOf(surface.root).filter((node) => node.type === "table").map((node) => ({ columns: node.props.columns, rows: node.props.rows })));
}

/** Use the canonical resolved tree, including column finalization and visibility. */
export function tableRows(view: SessionView): unknown[][] {
  return tablePayloads(view).flatMap((props) => {
    if (!Array.isArray(props.rows) || !Array.isArray(props.columns)) return [];
    const columns = props.columns;
    return props.rows.map((row: unknown) => Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((column: unknown) => {
      const key = typeof column === "string" ? column : column && typeof column === "object" && "key" in column ? String(column.key) : "";
      return (row as Record<string, unknown>)[key];
    }) : []);
  });
}

export function tableOutputText(view: SessionView): string { return JSON.stringify(tableRows(view)); }

/** Read reachable controls at their actual binding, including template instances. */
export function boundFieldValues(view: SessionView): { label: string; value: unknown }[] {
  return resolvedSurfaces(view).flatMap((surface) => nodesOf(surface.root).filter((node) => ["input", "select", "checkbox", "textarea", "date"].includes(node.type) && node.bindPath !== undefined).map((node) => ({ label: String(node.props.label ?? ""), value: getAt(surface.data, node.bindPath!) })));
}
