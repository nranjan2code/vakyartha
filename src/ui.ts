// Building blocks for the Settings pages: rows, switches, segmented
// controls, pills, and key/value fields that save themselves.

import { api, ask, el } from "./core.ts";

export interface Setting { name: string; label: string; secret: boolean; placeholder?: string; group: "main" | "more" | "channel"; owner: string; set: boolean; value?: string }

export const title = (text: string, sub?: string) => [el("h1", { textContent: text }), sub ? el("p", { className: "lead", textContent: sub }) : null].filter(Boolean) as HTMLElement[];

export function group(heading: string | null, ...rows: (HTMLElement | null)[]): HTMLElement {
  return el("section", { className: "group" }, heading ? el("h2", { textContent: heading }) : null, el("div", { className: "rows" }, ...rows));
}

export function row(label: string, hint: string | null, control: HTMLElement): HTMLElement {
  return el("div", { className: "row" }, el("div", { className: "row-text" }, el("div", { className: "row-label", textContent: label }), hint ? el("div", { className: "row-hint", textContent: hint }) : null), el("div", { className: "row-control" }, control));
}

export function toggle(checked: boolean, onChange: (on: boolean) => void | Promise<void>): HTMLElement {
  const input = el("input", { type: "checkbox", className: "switch", checked });
  input.addEventListener("change", () => void onChange(input.checked));
  return input;
}

export function segmented<T extends string>(options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void): HTMLElement {
  const box = el("div", { className: "seg", role: "radiogroup" });
  for (const [id, label] of options) {
    const b = el("button", { type: "button", "aria-pressed": String(id === value), textContent: label });
    b.addEventListener("click", () => {
      for (const x of box.children) x.setAttribute("aria-pressed", String(x === b));
      onChange(id);
    });
    box.append(b);
  }
  return box;
}

export function select(options: (readonly [string, string])[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = el("select", {}, ...options.map(([v, t]) => el("option", { value: v, textContent: t })));
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

export function pill(text: string, tone: "" | "ok" | "bad" = ""): HTMLElement {
  return el("span", { className: `pill ${tone}`, textContent: text });
}

/** A key field: Save appears once something is typed; Remove when one is saved. Never shows a saved value. */
export function secretField(s: Setting, onSaved: () => void | Promise<void>): HTMLElement {
  const input = el("input", { type: "password", autocomplete: "off", spellcheck: false, placeholder: s.set ? "•••••••• saved" : "Paste a key", "aria-label": s.label });
  const save = el("button", { type: "button", className: "primary small", textContent: "Save", hidden: true });
  const remove = el("button", { type: "button", className: "ghost small", textContent: "Remove", hidden: !s.set });
  const note = el("span", { className: "field-note" });
  input.addEventListener("input", () => (save.hidden = !input.value.trim()));
  input.addEventListener("keydown", (e) => e.key === "Enter" && save.click());
  const put = async (value: string | null) => {
    note.textContent = "";
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { [s.name]: value } }) });
      await onSaved();
    } catch (err) {
      note.textContent = (err as Error).message;
    }
  };
  save.addEventListener("click", () => void put(input.value.trim()));
  remove.addEventListener("click", async () => {
    if (await ask(`Remove the saved ${s.label}?`, "Remove")) await put(null);
  });
  return el("div", { className: "field" }, el("label", { className: "field-label", textContent: s.label }), el("div", { className: "field-line" }, input, save, remove), note);
}

/** A plain value (host, URL): saved on Enter or when the field loses focus. */
export function plainField(s: Setting, onSaved: () => void | Promise<void>): HTMLElement {
  const input = el("input", { type: "text", autocomplete: "off", spellcheck: false, value: s.value ?? "", placeholder: s.placeholder ?? "", "aria-label": s.label });
  const note = el("span", { className: "field-note" });
  let saved = s.value ?? "";
  const commit = async () => {
    const v = input.value.trim();
    if (v === saved) return;
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { [s.name]: v || null } }) });
      saved = v;
      note.textContent = "Saved";
      await onSaved();
    } catch (err) {
      note.textContent = (err as Error).message;
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  input.addEventListener("blur", () => void commit());
  return el("div", { className: "field" }, el("label", { className: "field-label", textContent: s.label }), input, note);
}

