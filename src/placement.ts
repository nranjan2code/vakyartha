// Where an interface belongs: small ones read best in the conversation, next
// to the words around them; big or wide ones need the canvas. Decided from the
// snapshot alone, so streaming, history and updates all agree.

/** Components that need width or room to be useful. */
const WIDE = new Set(["table", "chart", "tabs", "map", "graph", "gallery", "calendar", "board", "gantt", "diff", "compare"]);
const INPUTS = new Set(["input", "textarea", "select", "checkbox", "date"]);

/** More than this many fields makes a form a canvas form. */
export const MAX_INLINE_FIELDS = 5;
/** Nodes in a tree before it is a large interface. */
export const MAX_INLINE_NODES = 24;
/** Characters of visible text before it is a long read. */
export const MAX_INLINE_TEXT = 1500;
const LONG_CODE_LINES = 12;

interface Node { type: string; props?: Record<string, unknown>; children?: unknown }
export interface Shape { nodes: Node[]; data?: Record<string, unknown> }

function textLength(v: unknown, depth = 0): number {
  if (typeof v === "string") return v.length;
  if (depth > 6 || !v || typeof v !== "object") return 0;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += textLength(x, depth + 1);
  return n;
}

/** Nodes written inline in children count too (inline authoring). */
function walk(nodes: unknown[], visit: (n: Node) => void, depth = 0): void {
  if (depth > 20) return;
  for (const n of nodes) {
    if (!n || typeof n !== "object" || typeof (n as Node).type !== "string") continue;
    visit(n as Node);
    const c = (n as Node).children;
    if (Array.isArray(c)) walk(c, visit, depth + 1);
  }
}

/** Why an interface goes to the canvas, or undefined when it stays inline. */
export function canvasReason(s: Shape): string | undefined {
  let nodes = 0, fields = 0, text = textLength(s.data);
  let reason: string | undefined;
  walk(s.nodes, (n) => {
    nodes++;
    text += textLength(n.props);
    if (INPUTS.has(n.type)) fields++;
    if (!reason && WIDE.has(n.type)) reason = n.type;
    if (!reason && n.type === "media" && n.props?.kind !== "audio") reason = "media";
    if (!reason && n.type === "code" && String(n.props?.code ?? n.props?.content ?? "").split("\n").length > LONG_CODE_LINES) reason = "long code";
  });
  if (reason) return reason;
  if (fields > MAX_INLINE_FIELDS) return "form";
  if (nodes > MAX_INLINE_NODES) return "size";
  if (text > MAX_INLINE_TEXT) return "length";
  return undefined;
}
