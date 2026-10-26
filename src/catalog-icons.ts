// Local marks identify catalog sources and curated publishers. External listing
// icons arrive through authenticated, bounded public-image fetching, never HTML.
import { el, engine } from "./core.ts";
import { tile } from "./icons.ts";
import type { MarketplaceId, MarketplaceListing } from "../shared/marketplaces.ts";

const BRANDS: Record<string, string> = { mcp: "mcp.svg", files: "mcp.svg", memory: "mcp.svg", github: "github.png", docker: "docker.png", "brave-search": "brave-search.png", tavily: "tavily.png", databricks: "databricks.png", notion: "notion.png", context7: "context7.png" };
export function brandTile(id: string, fallback = "plug", size = 40): HTMLElement {
  if (!BRANDS[id]) return tile(fallback, size);
  const box = el("span", { className: "brand-tile" }, el("img", { src: `/brand/integrations/${BRANDS[id]}`, alt: "", width: size - 12, height: size - 12 }));
  box.style.cssText = `width:${size}px;height:${size}px`;
  return box;
}

/** Rebuild a passive SVG geometry subset instead of inserting publisher XML. */
export function passiveSvg(text: string): string {
  if (text.length > 262_144 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsupported icon SVG");
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Unsupported icon SVG");
  const tags = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc"]);
  const attrs = new Set(["viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity", "transform", "id", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "clip-path", "clip-rule", "mask", "maskUnits"]);
  let count = 0;
  function copy(node: Element): Element {
    if (++count > 1500 || !tags.has(node.localName)) throw new Error("Unsupported icon SVG element");
    const target = document.createElementNS("http://www.w3.org/2000/svg", node.localName);
    for (const a of node.attributes) {
      if (!attrs.has(a.name)) continue;
      if (/url\s*\(/i.test(a.value) && !/^url\(#[\w.-]+\)$/.test(a.value)) throw new Error("External SVG reference");
      target.setAttribute(a.name, a.value);
    }
    for (const child of node.children) target.append(copy(child));
    return target;
  }
  const root = copy(parsed.documentElement);
  if (!root.hasAttribute("viewBox")) {
    const w = Number.parseFloat(root.getAttribute("width") ?? "96"), h = Number.parseFloat(root.getAttribute("height") ?? "96");
    root.setAttribute("viewBox", `0 0 ${Number.isFinite(w) && w > 0 ? w : 96} ${Number.isFinite(h) && h > 0 ? h : 96}`);
  }
  root.setAttribute("width", "96"); root.setAttribute("height", "96");
  return new XMLSerializer().serializeToString(root);
}
let active = 0;
const queue: (() => Promise<void>)[] = [];
function pump(): void {
  while (active < 4 && queue.length) {
    active++;
    void queue.shift()!().finally(() => { active--; pump(); });
  }
}
function imageTile(label: string, route: string | undefined, size = 40): HTMLElement {
  const box = el("span", { className: "publisher-icon", "aria-hidden": "true" }, label.trim().slice(0, 2).toUpperCase());
  box.style.cssText = `width:${size}px;height:${size}px`;
  if (!route) return box;
  queue.push(async () => {
    if (!box.isConnected) return;
    let blobUrl: string | undefined;
    try {
      const b = engine();
      const response = await fetch(`${b.url}${route}`, { headers: { authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !box.isConnected) return;
      let blob = await response.blob();
      if (blob.type === "image/svg+xml") blob = new Blob([passiveSvg(await blob.text())], { type: "image/svg+xml" });
      if (!box.isConnected) return;
      blobUrl = URL.createObjectURL(blob);
      const img = el("img", { src: blobUrl, alt: "", width: size - 12, height: size - 12 });
      await img.decode();
      if (box.isConnected && img.naturalWidth <= 4096 && img.naturalHeight <= 4096) box.replaceChildren(img);
    } catch { /* Keep the publisher initials when no usable icon is available. */ }
    finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
  });
  // Async settings builders return their nodes before the caller mounts them.
  setTimeout(pump, 0);
  return box;
}

export function publisherIcon(item: MarketplaceListing, query: string, cursor: string, size = 40): HTMLElement {
  const source: MarketplaceId = item.source;
  const route = item.iconUrl ? `/api/marketplaces/${source}/icon?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}&key=${encodeURIComponent(item.key)}` : undefined;
  return imageTile(item.title, route, size);
}
export function importedIcon(id: string, title: string, size = 40, available = true): HTMLElement {
  return imageTile(title, available ? `/api/integrations/${id}/icon` : undefined, size);
}
