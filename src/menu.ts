// Right-click, desktop style. The webview's own menu (Reload, Inspect,
// Back) never shows: it would reload the app or navigate it away. What stays
// native is what a person expects anywhere on a Mac: Cut/Copy/Paste in a text
// field, and Copy on selected text. Parts of the window that have something to
// offer register their own items; everywhere else a right-click does nothing.
// Option-right-click in a dev build keeps the inspector for debugging.

import { el } from "./core.ts";

export interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
  danger?: boolean;
}
export type MenuEntry = MenuItem | "-";

/** Items for the element right-clicked, found by walking out from it (through shadow roots). */
type Provider = (target: Element, path: EventTarget[]) => MenuEntry[] | undefined;
const providers: Provider[] = [];

export function onContextMenu(provider: Provider): void {
  providers.push(provider);
}

let open: HTMLElement | undefined;

function close(): void {
  open?.remove();
  open = undefined;
}

function show(x: number, y: number, entries: MenuEntry[]): void {
  close();
  const menu = el("div", { className: "context-menu", role: "menu" });
  for (const e of entries) {
    if (e === "-") {
      menu.append(el("div", { className: "sep", role: "separator" }));
      continue;
    }
    const b = el("button", { type: "button", role: "menuitem", className: e.danger ? "danger-item" : "", textContent: e.label });
    b.addEventListener("click", () => {
      close();
      void e.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  open = menu;
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
}

const editable = (n: EventTarget) =>
  n instanceof HTMLTextAreaElement || (n instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color"].includes(n.type)) || (n instanceof HTMLElement && n.isContentEditable);

document.addEventListener("contextmenu", (e) => {
  const path = e.composedPath();
  if (import.meta.env.DEV && e.altKey) return;
  // Native menus where they mean something: editing text, or copying a selection.
  if (path.some(editable)) return;
  const selected = getSelection()?.toString() ?? "";
  e.preventDefault();
  const target = path.find((n): n is Element => n instanceof Element);
  if (!target) return;
  const entries: MenuEntry[] = [];
  if (selected.trim()) entries.push({ label: "Copy", run: () => navigator.clipboard.writeText(selected) });
  for (const p of providers) {
    const items = p(target, path);
    if (!items?.length) continue;
    if (entries.length) entries.push("-");
    entries.push(...items);
  }
  if (entries.length) show(e.clientX, e.clientY, entries);
  else close();
});

document.addEventListener("pointerdown", (e) => {
  if (open && !e.composedPath().includes(open)) close();
});
document.addEventListener("keydown", (e) => {
  if (!open) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...open.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }
}, true);
window.addEventListener("blur", close);
document.addEventListener("scroll", close, true);

/** The nearest element matching `selector` on the event path, inside shadow roots too. */
export function closest<T extends Element>(path: EventTarget[], selector: string): T | undefined {
  return path.find((n): n is T => n instanceof Element && n.matches(selector));
}
