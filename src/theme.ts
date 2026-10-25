// Appearance: light/dark mode, a colour theme and text size. Colours are
// CSS light-dark() pairs keyed by data-theme, so a mode change needs no
// repaint logic; surfaces take the same tokens (app.css, vak-surface rule).

import { prefs } from "./core.ts";

export const MODES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

/** id, label, light accent, dark accent (the swatch shows both). */
export const THEMES = [
  ["indigo", "Indigo", "#4f46e5", "#8b85ff"],
  ["ocean", "Ocean", "#0e7490", "#22d3ee"],
  ["forest", "Forest", "#15803d", "#4ade80"],
  ["rose", "Rose", "#be185d", "#f472b6"],
  ["amber", "Amber", "#b45309", "#fbbf24"],
  ["graphite", "Graphite", "#3f3f46", "#d4d4d8"],
] as const;

export const SIZES = [
  ["small", "Small"],
  ["default", "Default"],
  ["large", "Large"],
] as const;

export interface Appearance {
  mode: (typeof MODES)[number][0];
  theme: (typeof THEMES)[number][0];
  size: (typeof SIZES)[number][0];
}

export function appearance(): Appearance {
  const pick = <T extends readonly (readonly [string, ...string[]])[]>(list: T, k: string, fallback: T[number][0]): T[number][0] =>
    (list.find(([id]) => id === prefs.get(k))?.[0] ?? fallback) as T[number][0];
  return { mode: pick(MODES, "appearance:mode", "system"), theme: pick(THEMES, "appearance:theme", "indigo"), size: pick(SIZES, "appearance:size", "default") };
}

export function applyAppearance(change: Partial<Appearance> = {}): void {
  for (const [k, v] of Object.entries(change)) prefs.set(`appearance:${k}`, v);
  const a = appearance();
  const root = document.documentElement;
  root.dataset.mode = a.mode;
  root.dataset.theme = a.theme;
  root.dataset.size = a.size;
  // Surfaces pick their status and chart colours by mode; follow a forced one.
  for (const s of document.querySelectorAll("vak-surface")) surfaceMode(s);
}

export function surfaceMode(surface: Element): void {
  const mode = document.documentElement.dataset.mode;
  if (mode === "light" || mode === "dark") surface.setAttribute("theme", mode);
  else surface.removeAttribute("theme");
}
