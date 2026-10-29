// Original icons for integrations and the app's chrome: simple 24px stroke
// glyphs on a tinted tile, drawn for vak. Publisher identity assets are
// handled separately by catalog-icons.ts; these glyphs represent capabilities.

const GLYPHS: Record<string, string> = {
  'chevron-left': '<path d="m14 6-6 6 6 6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.3 8a7 7 0 0 1 11.6-3L20 8M4 16l3.1 3A7 7 0 0 0 18.7 16"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M7.5 3.5v4M16.5 3.5v4M3.5 10h17M8 14h2M14 14h2M8 17h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5M12 3.5C9.4 5.9 8.1 8.7 8.1 12s1.3 6.1 3.9 8.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 10.5h17"/>',
  memory: '<circle cx="6.5" cy="7" r="2.3"/><circle cx="17.5" cy="7" r="2.3"/><circle cx="12" cy="17" r="2.3"/><path d="M8.6 8.1 10.8 15M15.4 8.1 13.2 15M8.8 7h6.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  branch: '<circle cx="7" cy="5.8" r="2.2"/><circle cx="7" cy="18.2" r="2.2"/><circle cx="17" cy="8.5" r="2.2"/><path d="M7 8v8M17 10.7c0 4-5.5 3.2-9.2 6"/>',
  page: '<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5"/>',
  book: '<path d="M5 5.5a2 2 0 0 1 2-2h11v15H7a2 2 0 0 0-2 2z"/><path d="M5 20.5a2 2 0 0 1 2-2h11v2H7M9 7.5h5"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M7 7.5h10v3a5 5 0 0 1-10 0z"/><path d="M12 15.5v5"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  form: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h4M8 18h6"/>',
  chart: '<path d="M3 3v18h18M7 16v-5M12 16V7M17 16v-8"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 4v16"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  canvas: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M8 9v10.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  maximize: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  voice: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  talk: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  tool: '<path d="M14.5 5.5a4 4 0 0 0-5.3 5l-5 5a1.8 1.8 0 0 0 2.5 2.5l5-5a4 4 0 0 0 5-5.3l-2.4 2.4-2.2-.6-.6-2.2z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  spark: '<path d="M12 3.5 13.8 10 20.5 12l-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2z"/>',
  send: '<path d="M20.5 3.5 3.5 10.5l7 3 3 7z"/><path d="m10.5 13.5 10-10"/>',
  bubble: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5h0a2 2 0 0 1-1.5-2z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.5 1.7-1.5h2.2a3.8 3.8 0 0 0 3.8-3.8c0-4.2-3.8-7.4-8.5-7.4z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.3" r="1"/><circle cx="15" cy="7.8" r="1"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6.05 11a22.35 22.35 0 0 1-3.95 2zM9 9l3 3M15 9l-3-3"/>',
};

/** Tile colours: light and dark pairs (CSS light-dark), one hue per icon. */
const TINT: Record<string, [string, string]> = {
  globe: ["#0e7490", "#22d3ee"],
  clock: ["#6d28d9", "#a78bfa"],
  folder: ["#b45309", "#fbbf24"],
  memory: ["#be185d", "#f472b6"],
  search: ["#c2410c", "#fb923c"],
  branch: ["#374151", "#d1d5db"],
  page: ["#1f2937", "#e5e7eb"],
  book: ["#15803d", "#4ade80"],
  plug: ["#4b5563", "#9ca3af"],
  voice: ["#c2410c", "#fdba74"],
  rocket: ["#6366f1", "#818cf8"],
};

export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // Fixed markup from this file only; nothing here comes from a server.
  svg.innerHTML = GLYPHS[name] ?? GLYPHS.plug!;
  return svg;
}

/** An icon on its tinted tile, for integration cards and the chat. */
export function tile(name: string, size = 40): HTMLElement {
  const [light, dark] = TINT[name] ?? TINT.plug!;
  const box = document.createElement("span");
  box.className = "tile";
  box.style.setProperty("--tint", `light-dark(${light}, ${dark})`);
  box.style.width = box.style.height = `${size}px`;
  box.append(icon(name, Math.round(size * 0.55)));
  return box;
}
