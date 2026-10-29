import { CollectionPage, pageControls } from './pagination.ts';
// A library of saved surfaces, independent of the chat sidebar's length. Cards
// show metadata only: a form's private values never become a library preview.
import type { SessionSummary, SurfaceSummary } from "@vak/host";
import { $, api, el } from "./core.ts";
import { icon } from "./icons.ts";

type Kind = "Form" | "Dashboard" | "Table" | "Code" | "Gallery" | "Interface";
interface Artifact { surface: SurfaceSummary; chat: SessionSummary; kind: Kind }
const GLYPHS: Record<Kind, string> = { Form: "form", Dashboard: "chart", Table: "table", Code: "code", Gallery: "image", Interface: "canvas" };
const FILTERS: [Kind | "All", string][] = [["All", "All"], ["Form", "Forms"], ["Dashboard", "Dashboards"], ["Table", "Tables"], ["Code", "Code"], ["Gallery", "Galleries"], ["Interface", "Interfaces"]];

function kindOf(types: string[]): Kind {
  if (types.includes("form")) return "Form";
  if (types.includes("chart")) return "Dashboard";
  if (types.includes("table")) return "Table";
  if (types.includes("code")) return "Code";
  if (types.includes("gallery")) return "Gallery";
  return "Interface";
}

export class ArtifactsPage {
  #page = $("artifacts-page");
  #sessions: SessionSummary[] = [];
  #query = "";
  #filter: Kind | "All" = "All";
  #sort = "recent";
  #paging = new CollectionPage();
  #request = 0;
  #opening = false;
  #openArtifact: (session: string, surface: string) => Promise<void>;
  #newChat: () => void;
  #toggleSidebar: () => void;

  constructor(openArtifact: (session: string, surface: string) => Promise<void>, newChat: () => void, toggleSidebar: () => void) {
    this.#openArtifact = openArtifact;
    this.#newChat = newChat;
    this.#toggleSidebar = toggleSidebar;
    $("open-artifacts").append(icon("canvas", 17), "Artifacts");
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.#page.hidden && $("settings").hidden && !document.querySelector("dialog[open]") && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        this.close(true);
      }
    });
  }

  async open(): Promise<void> {
    const studioEl = document.getElementById("skills-studio-page");
    if (studioEl) studioEl.hidden = true;
    document.body.classList.remove("in-skill-studio");
    this.#page.hidden = false;
    $("workspace").hidden = true;
    $("apps-page") && ($("apps-page").hidden = true);
    $("schedule-page") && ($("schedule-page").hidden = true);
    document.body.classList.add("in-artifacts");
    $("open-artifacts").setAttribute("aria-current", "page");
    window.dispatchEvent(new Event("vak:artifacts-opened"));
    this.#shell();
    const request = ++this.#request;
    $("artifacts-grid").replaceChildren(...Array.from({ length: 6 }, () => el("div", { className: "artifact-skeleton", "aria-hidden": "true" })));
    $("artifacts-results").textContent = "Loading artifacts…";
    this.#page.setAttribute("aria-busy", "true");
    try {
      const sessions = await api<SessionSummary[]>("/api/sessions");
      if (request === this.#request && !this.#page.hidden) this.update(sessions);
    } catch {
      if (request !== this.#request || this.#page.hidden) return;
      const retry = el("button", { type: "button", className: "ghost", textContent: "Try again" });
      retry.addEventListener("click", () => void this.open());
      $("artifacts-results").textContent = "Could not load artifacts";
      $("artifacts-grid").replaceChildren(el("div", { className: "artifact-empty" }, el("h2", { textContent: "Your library couldn’t load" }), el("p", { textContent: "Check the engine connection and try again." }), retry));
    } finally {
      if (request === this.#request) this.#page.removeAttribute("aria-busy");
    }
    if (request === this.#request && !this.#page.hidden) $("artifacts-title")?.focus();
  }

  close(focus = false, showWorkspace = true): void {
    ++this.#request;
    this.#page.hidden = true;
    if (showWorkspace) $("workspace").hidden = false;
    document.body.classList.remove("in-artifacts", "artifacts-show-sidebar");
    $("open-artifacts").setAttribute("aria-current", "false");
    window.dispatchEvent(new Event("vak:artifacts-closed"));
    if (focus) $("open-artifacts").focus();
  }

  update(sessions: SessionSummary[]): void {
    this.#sessions = sessions;
    if (!this.#page.hidden) this.#draw();
  }

  #shell(): void {
    const toggle = el("button", { type: "button", className: "icon-btn artifacts-sidebar", title: "Show sidebar", "aria-label": "Show sidebar" }, icon("sidebar"));
    toggle.addEventListener("click", this.#toggleSidebar);
    const back = el("button", { type: "button", className: "ghost small", textContent: "Back to chat" });
    back.addEventListener("click", () => this.close(true));
    const search = el("input", { id: "artifacts-search", type: "search", value: this.#query, placeholder: "Search artifacts or chats", "aria-label": "Search artifacts or chats" });
    search.addEventListener("input", () => { this.#query = search.value; this.#paging.index = 0; this.#draw(); });
    const sort = el("select", { id: "artifacts-sort", "aria-label": "Sort artifacts", value: this.#sort }, new Option("Most recent", "recent"), new Option("Oldest first", "oldest"), new Option("Name A–Z", "name"));
    sort.value = this.#sort;
    sort.addEventListener("change", () => { this.#sort = sort.value; this.#draw(); });
    const filters = el("div", { className: "artifact-filters", role: "group", "aria-label": "Filter by type" }, ...FILTERS.map(([kind, label]) => {
      const button = el("button", { type: "button", className: "artifact-filter", textContent: label, "aria-pressed": String(kind === this.#filter), "data-kind": kind });
      button.addEventListener("click", () => { this.#filter = kind; this.#paging.index = 0; this.#draw(); });
      return button;
    }));
    this.#page.replaceChildren(
      el("div", { className: "artifacts-top", "data-tauri-drag-region": "" }, toggle, back),
      el("div", { className: "artifacts-body" },
        el("header", { className: "artifacts-intro" }, el("div", { className: "artifacts-mark" }, icon("canvas", 24)), el("h1", { id: "artifacts-title", tabIndex: -1, textContent: "Artifacts" }), el("p", { textContent: "Saved interfaces from your chats." })),
        el("div", { className: "artifacts-search-row" }, el("div", { className: "artifact-search" }, icon("search", 18), search), sort),
        filters,
        el("div", { className: "artifacts-results", id: "artifacts-results", role: "status" }),
        el("p", { id: "artifacts-note", className: "error", role: "alert" }),
        el("div", { id: "artifacts-grid", className: "artifacts-grid" }),
        el("div", { id: "artifacts-more", className: "artifacts-more" }),
      ),
    );
  }

  #draw(): void {
    const all: Artifact[] = this.#sessions.flatMap(chat => (chat.surfaceSummaries ?? []).map(surface => ({ chat, surface, kind: kindOf(surface.types) })));
    const query = this.#query.trim().toLocaleLowerCase();
    const matches = all.filter(a => (this.#filter === "All" || a.kind === this.#filter) && `${a.surface.title ?? a.kind} ${a.chat.title} ${a.kind}`.toLocaleLowerCase().includes(query));
    matches.sort((a, b) => this.#sort === "name" ? (a.surface.title ?? a.kind).localeCompare(b.surface.title ?? b.kind) : this.#sort === "oldest" ? a.chat.updated.localeCompare(b.chat.updated) : b.chat.updated.localeCompare(a.chat.updated));
    for (const button of this.#page.querySelectorAll<HTMLButtonElement>(".artifact-filter")) button.setAttribute("aria-pressed", String(button.dataset.kind === this.#filter));
    $("artifacts-results").textContent = `${matches.length} ${matches.length === 1 ? "artifact" : "artifacts"}${matches.length !== all.length ? ` · ${all.length} total` : ""}`;
    const grid = $("artifacts-grid");
    grid.replaceChildren(...this.#paging.slice(matches, `${this.#filter}:${this.#query}:${this.#sort}`).map(a => this.#card(a)));
    if (!matches.length) {
      const clear = el("button", { type: "button", className: "ghost", textContent: all.length ? "Clear filters" : "Start a chat" });
      clear.addEventListener("click", () => {
        if (!all.length) return this.#newChat();
        this.#query = ""; this.#filter = "All";
        $<HTMLInputElement>("artifacts-search").value = "";
        this.#draw();
      });
      grid.append(el("div", { className: "artifact-empty" }, icon(all.length ? "search" : "canvas", 40), el("h2", { textContent: all.length ? "No matching artifacts" : "Your work will live here" }), el("p", { textContent: all.length ? "Try another search or clear the filters." : "Ask for a form, dashboard or table in any chat. Come back here whenever you need it." }), clear));
    }
    const more = $("artifacts-more");
    more.replaceChildren();
    more.append(pageControls(this.#paging, matches.length, 'Artifacts', () => this.#draw()));
  }

  #card(a: Artifact): HTMLElement {
    const title = a.surface.title || a.kind;
    const button = el("button", { type: "button", className: "artifact-card", "data-kind": a.kind, "data-surface": a.surface.id, "data-session": a.chat.id, "aria-label": `Open ${title} from ${a.chat.title}` },
      el("span", { className: "artifact-cover", "aria-hidden": "true" }, el("span", { className: "artifact-symbol" }, icon(GLYPHS[a.kind], 34)), el("span", { className: "artifact-kind", textContent: a.kind })),
      el("span", { className: "artifact-card-body" }, el("strong", { textContent: title }), el("span", { className: "artifact-chat", textContent: `From ${a.chat.title}` }), el("span", { className: "artifact-card-foot" }, el("time", { dateTime: a.chat.updated, title: "Chat last updated", textContent: new Date(a.chat.updated).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) }), el("span", { className: "artifact-open", textContent: "Open ↗" }))),
    );
    button.addEventListener("click", async () => {
      if (this.#opening) return;
      this.#opening = true;
      button.disabled = true;
      $("artifacts-note").textContent = "";
      try { await this.#openArtifact(a.chat.id, a.surface.id); }
      catch { $("artifacts-note").textContent = "Could not open this artifact. Refresh the library and try again."; }
      finally { this.#opening = false; button.disabled = false; }
    });
    return button;
  }
}
