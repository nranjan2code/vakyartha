// The app owns where an interface is shown. Move its live element rather than
// rendering a second form: validation, drafts and local table views stay intact.
// Small interfaces live in the conversation; large ones (placement.ts) leave a
// reference card there and open in the canvas. Any can be opened in the canvas.
import { projectMarkdown, projectText, type SurfaceSnapshot, type SurfaceStore } from "@vak/core";
import type { VakSurfaceElement } from "@vak/web";
import { $, prefs } from "./core.ts";
import { icon } from "./icons.ts";
import { downloadMarkdown } from "./backend.ts";
import { canvasReason } from "./placement.ts";

/** large: placed in the canvas; once large it stays so, and nothing jumps back into the chat. */
interface Entry { surface: VakSurfaceElement; home: HTMLElement; button: HTMLButtonElement; title: HTMLElement; option: HTMLOptionElement; large: boolean }

export class Canvas {
  #entries = new Map<string, Entry>();
  #active?: string;
  #session: () => string;
  #store: () => SurfaceStore;
  #text = false;
  #last?: string;
  #inTurn = false;
  #dismissed = false;
  #feedbackTimer?: ReturnType<typeof setTimeout>;
  #panel = $<HTMLElement>("canvas");
  #content = $<HTMLElement>("canvas-content");
  #workspace = $<HTMLElement>("workspace");
  #resize = $<HTMLElement>("canvas-resize");
  #expand = $<HTMLButtonElement>("canvas-expand");
  #picker = $<HTMLSelectElement>("canvas-pick");

  beginTurn(): void {
    this.#inTurn = true;
    this.#dismissed = false;
  }

  beginWork(): void {
    // A tool-start event has neither surface ID nor size yet: progress shows in
    // a canvas already open; otherwise the first snapshot decides where it goes.
    if (this.#dismissed || this.#panel.hidden) return;
    this.#panel.hidden = this.#resize.hidden = false;
    this.#workspace.classList.add("canvas-open");
    if (!this.#active) this.#view(false);
    this.#panel.setAttribute("aria-busy", "true");
    $("canvas-progress").hidden = false;
    this.#controls();
  }

  endTurn(): void {
    this.#inTurn = false;
    this.#dismissed = false;
    this.#panel.removeAttribute("aria-busy");
    $("canvas-progress").hidden = true;
    if (!this.#active) this.close(false, false);
  }

  #controls(): void {
    this.#picker.hidden = !this.#active;
    // A flow (a form, then its results, then a booking step) is several
    // interfaces: step through them in order instead of only the latest.
    const n = this.#picker.options.length;
    const i = this.#picker.selectedIndex;
    const many = Boolean(this.#active) && n > 1;
    $("canvas-label").textContent = many ? `Canvas · ${i + 1} of ${n}` : "Canvas";
    for (const [id, to] of [["canvas-prev", i - 1], ["canvas-next", i + 1]] as const) {
      const b = $<HTMLButtonElement>(id);
      b.hidden = !many;
      b.disabled = to < 0 || to >= n;
    }
    for (const id of ["canvas-copy", "canvas-download", "canvas-preview", "canvas-text"]) $<HTMLButtonElement>(id).disabled = !this.#active;
  }

  constructor(session: () => string, store: () => SurfaceStore) {
    this.#session = session;
    this.#store = store;
    for (const [id, name] of [["canvas-close", "close"], ["canvas-expand", "maximize"], ["canvas-copy", "copy"], ["canvas-download", "download"]] as const) $(id).append(icon(name, 16));
    this.#picker.addEventListener("change", () => this.open(this.#picker.value));
    for (const [id, by] of [["canvas-prev", -1], ["canvas-next", 1]] as const) {
      $(id).addEventListener("click", () => {
        const o = this.#picker.options[this.#picker.selectedIndex + by];
        if (o) this.open(o.value);
      });
    }
    $("canvas-preview").addEventListener("click", () => this.#view(false));
    $("canvas-text").addEventListener("click", () => this.#view(true));
    $("canvas-copy").addEventListener("click", () => void this.#copy());
    $("canvas-download").addEventListener("click", () => void this.#download());
    document.addEventListener("vak-change", () => this.#updateText());
    $("canvas-close").addEventListener("click", () => this.close(true));
    this.#expand.addEventListener("click", () => this.#setExpanded(!this.#workspace.classList.contains("canvas-expanded")));
    const saved = Number(prefs.get("canvas:width"));
    this.#width(saved || 56);
    this.#resize.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const width = Number(this.#resize.getAttribute("aria-valuenow"));
      this.#width(e.key === "Home" ? 35 : e.key === "End" ? 70 : width + (e.key === "ArrowLeft" ? 2 : -2));
    });
    this.#resize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.#resize.setPointerCapture(e.pointerId);
      this.#workspace.classList.add("resizing");
    });
    this.#resize.addEventListener("pointermove", (e) => {
      if (!this.#resize.hasPointerCapture(e.pointerId)) return;
      const r = this.#workspace.getBoundingClientRect();
      this.#width((r.right - e.clientX) / r.width * 100);
    });
    this.#resize.addEventListener("lostpointercapture", () => this.#workspace.classList.remove("resizing"));
    document.addEventListener("keydown", (e) => {
      if (this.#workspace.hidden || !$("settings").hidden || document.querySelector("dialog[open]")) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f" && this.#active) {
        e.preventDefault();
        this.#setExpanded(!this.#workspace.classList.contains("canvas-expanded"));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "b" && this.#entries.size) {
        e.preventDefault();
        if (this.#active) this.close(true);
        else this.open(this.#last ?? this.#entries.keys().next().value!, true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b" && this.#entries.size) {
        e.preventDefault();
        if (!this.#active) this.open(this.#last ?? this.#entries.keys().next().value!, true);
        else if (this.#workspace.classList.contains("canvas-expanded")) this.close(true);
        else this.#setExpanded(true);
        return;
      }
      if (e.key !== "Escape" || !this.#active || !$("settings").hidden) return;
      // Let an open dialog, native select, or an in-progress turn handle Escape.
      if (document.querySelector("dialog[open]") || document.querySelector("#send.stop") || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      this.close(true);
    });
  }

  #width(value: number): void {
    const width = Math.round(Math.max(35, Math.min(70, value)));
    this.#workspace.style.setProperty("--canvas-width", `${width}%`);
    this.#resize.setAttribute("aria-valuemin", "35");
    this.#resize.setAttribute("aria-valuemax", "70");
    this.#resize.setAttribute("aria-valuenow", String(width));
    prefs.set("canvas:width", String(width));
  }

  #setExpanded(value: boolean): void {
    this.#workspace.classList.toggle("canvas-expanded", value);
    this.#expand.replaceChildren(icon(value ? "split" : "maximize", 16));
    this.#expand.setAttribute("aria-label", value ? "Enter split view" : "Enter full view");
    this.#expand.title = `${value ? "Enter split view" : "Enter full view"} (⌘⇧F)`;
    this.#expand.setAttribute("aria-pressed", String(value));
  }

  #view(text: boolean): void {
    this.#text = text;
    this.#content.hidden = text;
    $("canvas-text-content").hidden = !text;
    $("canvas-preview").setAttribute("aria-pressed", String(!text));
    $("canvas-text").setAttribute("aria-pressed", String(text));
    this.#updateText();
  }

  #updateText(): void {
    if (!this.#text || !this.#active) return;
    const resolved = this.#store().resolve(this.#active);
    $("canvas-text-content").textContent = resolved ? projectText(resolved) : "";
  }

  #feedback(message: string): void {
    clearTimeout(this.#feedbackTimer);
    $("canvas-feedback").textContent = message;
    this.#feedbackTimer = setTimeout(() => { $("canvas-feedback").textContent = ""; }, 2500);
  }

  async #copy(): Promise<void> {
    const resolved = this.#active ? this.#store().resolve(this.#active) : undefined;
    if (!resolved) return;
    try {
      await navigator.clipboard.writeText(projectText(resolved));
      this.#feedback("Copied");
    } catch {
      this.#view(true);
      $("canvas-text-content").focus();
      this.#feedback("Select text to copy");
    }
  }

  async #download(): Promise<void> {
    const resolved = this.#active ? this.#store().resolve(this.#active) : undefined;
    if (!resolved) return;
    const filename = `${(resolved.title || "canvas").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "canvas"}.md`;
    try {
      await downloadMarkdown(filename, projectMarkdown(resolved));
      this.#feedback("Saved to Downloads");
    } catch {
      this.#feedback("Download failed. Try Copy.");
    }
  }

  register(surface: VakSurfaceElement, snap: SurfaceSnapshot, parent: HTMLElement, auto: boolean): void {
    let entry = this.#entries.get(snap.id);
    if (!entry) {
      const home = document.createElement("section");
      home.className = "surface-home";
      home.dataset.surface = snap.id;
      const head = document.createElement("div");
      head.className = "surface-head";
      const title = document.createElement("span");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost small";
      button.setAttribute("aria-controls", "canvas");
      button.addEventListener("click", () => this.open(snap.id, true));
      head.append(title, button);
      home.append(head, surface);
      parent.append(home);
      const option = new Option("", snap.id);
      this.#picker.add(option);
      if (this.#active) this.#controls();
      entry = { surface, home, button, title, option, large: false };
      this.#entries.set(snap.id, entry);
    }
    // Promote once a stream or update makes it large; never demote.
    entry.large ||= canvasReason(snap) !== undefined;
    entry.home.classList.toggle("inline", !entry.large);
    if (this.#active !== snap.id) surface.hidden = entry.large;
    entry.title.textContent = snap.title || "Interface";
    entry.option.textContent = entry.title.textContent;
    entry.button.textContent = this.#active === snap.id ? "Shown in canvas" : "Open in canvas";
    entry.button.setAttribute("aria-expanded", String(this.#active === snap.id));
    if (this.#active === snap.id) $("canvas-title").textContent = entry.title.textContent;
    if (this.#active === snap.id) this.#updateText();
    // Large new and updated surfaces open in the canvas. History redraws pass
    // auto=false; closing during this turn suppresses later stream ticks.
    if (auto && !this.#dismissed && entry.large) this.open(snap.id);
  }

  open(id: string, focus = false): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (this.#active !== id) {
      this.#returnHome();
      this.#active = id;
      this.#last = id;
      entry.surface.hidden = false;
      this.#content.append(entry.surface);
      this.#content.scrollTop = 0;
      this.#view(false);
    }
    entry.home.classList.add("in-canvas");
    entry.button.textContent = "Shown in canvas";
    entry.button.setAttribute("aria-expanded", "true");
    this.#picker.value = id;
    $("canvas-title").textContent = entry.title.textContent;
    this.#panel.hidden = this.#resize.hidden = false;
    this.#workspace.classList.add("canvas-open");
    this.#controls();
    prefs.set(`canvas:session:${this.#session()}`, id);
    if (focus) $("canvas-close").focus();
  }

  #returnHome(): void {
    const entry = this.#active ? this.#entries.get(this.#active) : undefined;
    if (!entry) return;
    entry.home.append(entry.surface);
    entry.surface.hidden = entry.large;
    entry.home.classList.remove("in-canvas");
    entry.button.textContent = "Open in canvas";
    entry.button.setAttribute("aria-expanded", "false");
  }

  close(focus = false, save = true): void {
    if (focus && this.#inTurn) this.#dismissed = true;
    const button = this.#active ? this.#entries.get(this.#active)?.button : undefined;
    this.#returnHome();
    this.#active = undefined;
    this.#panel.hidden = this.#resize.hidden = true;
    this.#workspace.classList.remove("canvas-open");
    $("canvas-progress").hidden = true;
    this.#setExpanded(false);
    clearTimeout(this.#feedbackTimer);
    $("canvas-feedback").textContent = "";
    if (save) prefs.set(`canvas:session:${this.#session()}`, "");
    if (focus) button?.focus();
  }

  restore(): void {
    const id = prefs.get(`canvas:session:${this.#session()}`);
    if (id) this.open(id);
  }

  /** Whether the surface sits in the conversation (small), not on a card. */
  isInline(id: string): boolean {
    const e = this.#entries.get(id);
    return Boolean(e && !e.large);
  }

  remove(id: string): void {
    if (id === this.#active) this.close();
    this.#entries.get(id)?.home.remove();
    this.#entries.get(id)?.option.remove();
    this.#entries.delete(id);
    if (this.#last === id) this.#last = undefined;
  }

  reset(): void {
    this.#inTurn = false;
    this.#dismissed = false;
    this.close(false, false);
    this.#panel.removeAttribute("aria-busy");
    this.#entries.clear();
    this.#last = undefined;
    this.#picker.replaceChildren();
  }
}
