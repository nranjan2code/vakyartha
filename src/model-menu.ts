// A compact popover over the composer's model <select>. The select stays the
// source of truth (filled by models.ts, read on "change"), so this only mirrors
// its options and writes the choice back.

import { el } from "./core.ts";

/** `host` receives the trigger; the menu opens above it, right-aligned. */
export function modelMenu(select: HTMLSelectElement, host: HTMLElement): void {
  const label = el("span", { className: "model-label" });
  const provider = el("span", { className: "model-provider" });
  const trigger = el("button", { type: "button", className: "model-trigger", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Choose a model" }, label, provider);
  const menu = el("div", { className: "model-menu", role: "listbox", "aria-label": "Models", hidden: true });
  const wrap = el("div", { className: "model-wrap" }, trigger, menu);
  select.hidden = true;
  host.append(wrap);

  const sync = () => {
    const [name, from] = (select.selectedOptions[0]?.textContent ?? "Choose a model").split(" · ");
    label.textContent = name ?? ""; provider.textContent = (from ?? "").replace(/\s*\(.*\)$/, "");
  };
  new MutationObserver(sync).observe(select, { childList: true, subtree: true });
  select.addEventListener("change", sync);
  sync();

  const close = () => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  function choose(value: string): void {
    close();
    select.value = value;
    select.dispatchEvent(new Event("change"));
    sync();
    trigger.focus();
  }
  function item(o: HTMLOptionElement, n: number): HTMLElement {
    if (o.value === "__settings") {
      const more = el("button", { type: "button", role: "option", className: "model-item model-more" }, el("span", { textContent: "More models" }), el("span", { className: "model-hint", textContent: "›" }));
      more.addEventListener("click", () => choose(o.value));
      return more;
    }
    const [name, from] = (o.textContent ?? "").split(" · ");
    const selected = o.value === select.value;
    const b = el("button", { type: "button", role: "option", className: "model-item", "aria-selected": String(selected), disabled: o.disabled },
      el("span", { className: "model-name" }, el("span", { textContent: name ?? "" }), from ? el("span", { className: "model-from", textContent: from }) : null),
      el("span", { className: selected ? "model-check" : "model-hint", textContent: selected ? "✓" : n <= 9 ? String(n) : "" }));
    b.addEventListener("click", () => choose(o.value));
    return b;
  }
  function open(): void {
    let n = 0;
    menu.replaceChildren(...[...select.children].flatMap(c => {
      if (c instanceof HTMLOptGroupElement) return [el("div", { className: "model-group", textContent: c.label }), ...[...c.children].map(o => item(o as HTMLOptionElement, ++n))];
      const o = c as HTMLOptionElement;
      return o.value === "__settings" ? [el("hr", { className: "model-sep" }), item(o, 0)] : [item(o, ++n)];
    }));
    menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
    (menu.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.querySelector<HTMLElement>(".model-item"))?.focus();
  }
  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll<HTMLElement>(".model-item:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); items.filter(x => !x.classList.contains("model-more"))[Number(e.key) - 1]?.click(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !wrap.contains(e.target as Node)) close(); });
}
