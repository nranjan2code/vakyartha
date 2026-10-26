// Original icons for integrations and the app's chrome: simple 24px stroke
// glyphs on a tinted tile, drawn for vak. Vendors' logos are not used (they
// are trademarks); the publisher's name is shown beside each instead.

const GLYPHS: Record<string, string> = {
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
  canvas: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M8 9v10.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  maximize: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  voice: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  tool: '<path d="M14.5 5.5a4 4 0 0 0-5.3 5l-5 5a1.8 1.8 0 0 0 2.5 2.5l5-5a4 4 0 0 0 5-5.3l-2.4 2.4-2.2-.6-.6-2.2z"/>',
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
