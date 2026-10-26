// A compact popover over the composer's model <select>. The select stays the
// source of truth (filled by models.ts, read on "change"), so this only mirrors
// its options and writes the choice back.

import { el } from "./core.ts";

export function modelMenu(select: HTMLSelectElement): void {
  const label = el("span", { className: "model-label" });
  const trigger = el("button", { type: "button", className: "model-trigger", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Choose a model" }, label, el("span", { className: "model-caret", "aria-hidden": "true", textContent: "▾" }));
  const menu = el("div", { className: "model-menu", role: "listbox", "aria-label": "Models", hidden: true });
  const wrap = el("div", { className: "model-wrap" }, trigger, menu);
  select.hidden = true;
  select.before(wrap);

  const sync = () => { label.textContent = select.selectedOptions[0]?.textContent ?? "Choose a model"; };
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
  function item(o: HTMLOptionElement): HTMLElement {
    const [name, provider] = (o.textContent ?? "").split(" · ");
    const b = el("button", { type: "button", role: "option", className: "model-item", "aria-selected": String(o.value === select.value), disabled: o.disabled }, el("span", { textContent: name ?? "" }), provider ? el("span", { className: "model-provider", textContent: provider }) : null);
    b.addEventListener("click", () => choose(o.value));
    return b;
  }
  function open(): void {
    menu.replaceChildren(...[...select.children].flatMap(c => c instanceof HTMLOptGroupElement
      ? [el("div", { className: "model-group", textContent: c.label }), ...[...c.children].map(o => item(o as HTMLOptionElement))]
      : [item(c as HTMLOptionElement)]));
    menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
    (menu.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.querySelector<HTMLElement>(".model-item"))?.focus();
  }
  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll<HTMLElement>(".model-item:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !wrap.contains(e.target as Node)) close(); });
}
