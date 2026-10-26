import { api, el } from "./core.ts";
import { brandTile, publisherIcon } from "./catalog-icons.ts";
import { icon, tile } from "./icons.ts";
import { group, pill } from "./ui.ts";
import { MARKETPLACES, type MarketplaceId, type MarketplaceListing, type MarketplacePage, type MarketplaceReview } from "../shared/marketplaces.ts";

/** Discovery never probes or starts a listed server. Adding opens normal setup. */
export function externalCatalogs(open: (id: string) => void): { node: HTMLElement; load: () => void } {
  let source: MarketplaceId = "mcp", query = "", page: MarketplacePage | undefined, request = 0;
  const content = el("div", { className: "external-content" });
  const sourceBox = el("div", { className: "catalog-sources", role: "group", "aria-label": "External catalog source" });
  const search = el("input", { type: "search", className: "market-search", placeholder: "Find a tool or service…", "aria-label": "Search external catalog", maxLength: 120 });
  const submit = el("button", { type: "submit", className: "primary small", textContent: "Search" });
  const searchForm = el("form", { className: "catalog-search" }, search, submit);
  const status = el("p", { className: "row-hint catalog-status", role: "status", "aria-live": "polite" });
  const heading = el("div", { className: "catalog-intro" }, el("div", {}, el("h2", { textContent: "Explore external tools" }), el("p", { className: "row-hint", textContent: "Search a directory, review a connection, then configure its access." })), pill("Optional"));
  const browser = el("div", {}, heading, sourceBox, searchForm, status, content);
  const node = el("section", { className: "external-catalogs", "aria-label": "External catalogs" }, browser);
  function button(label: string, action: () => void, className = "ghost small") {
    const b = el("button", { type: "button", className, textContent: label }); b.addEventListener("click", action); return b;
  }
  const currentSource = () => MARKETPLACES.find(x => x.id === source)!;
  function paintSources() {
    sourceBox.replaceChildren(...MARKETPLACES.map(s => {
      const b = el("button", { type: "button", className: "catalog-source", title: s.description, "aria-pressed": String(s.id === source) }, brandTile(s.id, "plug", 32), el("span", {}, el("strong", { textContent: s.name }), el("span", { textContent: s.description })));
      b.addEventListener("click", () => { source = s.id; paintSources(); void load(); }); return b;
    }));
  }
  function card(item: MarketplaceListing, originCursor: string): HTMLElement {
    const supported = item.options.some(o => !o.blocked && o.kind !== "unsupported");
    const action = button(supported ? "Review connection" : "View requirements", () => void review(item, originCursor), "catalog-action");
    action.setAttribute("aria-label", `${supported ? "Review connection" : "View requirements"} for ${item.title}`);
    action.append(icon("arrow", 14));
    return el("article", { className: "market-card external-card" }, publisherIcon(item, query, originCursor),
      el("div", { className: "market-text" }, el("h3", { className: "market-name", textContent: item.title }), el("div", { className: "market-pub", textContent: item.publisher }), el("div", { className: "market-sum", textContent: item.description })),
      el("div", { className: "market-foot" }, el("span", { className: "catalog-origin", textContent: currentSource().name }), action));
  }

  async function load(more = false): Promise<void> {
    const generation = ++request;
    const next = more ? page?.nextCursor ?? "" : "";
    if (!more) query = search.value.trim();
    status.textContent = more ? "Loading more…" : `Searching ${currentSource().name}…`;
    content.setAttribute("aria-busy", "true"); submit.disabled = true;
    if (!more) content.replaceChildren(...Array.from({ length: 3 }, () => el("div", { className: "catalog-skeleton", "aria-hidden": "true" })));
    try {
      const result = await api<MarketplacePage>(`/api/marketplaces/${source}?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(next)}`);
      if (generation !== request) return;
      page = result;
      let grid = content.querySelector<HTMLElement>(".market");
      if (!more || !grid) { grid = el("div", { className: "market" }); content.replaceChildren(grid); }
      grid.append(...result.items.map(i => card(i, next)));
      content.querySelector(".catalog-more")?.remove();
      if (!grid.children.length) grid.append(el("div", { className: "catalog-empty" }, icon("search", 28), el("h3", { textContent: "No matches yet" }), el("p", { className: "row-hint", textContent: "Try a service name, a shorter search, or another catalog. Catalogs may search names only." })));
      if (result.nextCursor) content.append(button("Load more", () => void load(true), "ghost catalog-more"));
      status.textContent = result.warning || `${currentSource().name} · ${grid.children.length} results shown · Retrieved ${new Date(result.fetchedAt).toLocaleString()} · Results cached for one hour`;
    } catch (err) {
      if (generation !== request) return;
      status.textContent = "";
      const problem = el("div", { className: "catalog-empty", role: "alert" }, el("h3", { textContent: "This catalog couldn't be reached" }), el("p", { className: "row-hint", textContent: (err as Error).message }), button("Try again", () => void load()), el("p", { className: "row-hint", textContent: "Your configured integrations remain available." }));
      if (!more) content.replaceChildren(problem); else content.append(problem);
    } finally { if (generation === request) { submit.disabled = false; content.removeAttribute("aria-busy"); } }
  }
  async function review(item: MarketplaceListing, originCursor: string, optionKey = item.options.find(o => !o.blocked)?.key ?? item.options[0]!.key): Promise<void> {
    const generation = ++request;
    const detail = el("div", { className: "catalog-review", tabIndex: -1 });
    const back = button("‹ Back to results", () => { ++request; node.replaceChildren(browser); submit.disabled = false; content.removeAttribute("aria-busy"); search.focus(); });
    detail.append(back, el("p", { role: "status", className: "row-hint", textContent: "Checking connection requirements…" }));
    node.replaceChildren(detail); detail.focus(); detail.scrollIntoView({ block: "start" });
    try {
      const r = await api<MarketplaceReview>(`/api/marketplaces/${source}/review`, { method: "POST", body: JSON.stringify({ query, cursor: originCursor, key: item.key, option: optionKey }) });
      if (generation !== request) return;
      const o = r.option;
      const selector = el("div", { className: "catalog-options", role: "group", "aria-label": "Connection options" }, ...item.options.map(opt => {
        const b = button(opt.label, () => void review(item, originCursor, opt.key)); b.setAttribute("aria-pressed", String(opt.key === o.key)); return b;
      }));
      const info = (label: string, value: string) => el("div", { className: "catalog-fact" }, el("span", { className: "row-hint", textContent: label }), el("span", { textContent: value }));
      const facts = el("div", { className: "catalog-facts" }, info("Catalog", currentSource().name), info("Publisher", item.publisher), info("Listing", item.name), info("Version", o.version || item.version), info("Connection", o.url || o.package || o.label), info("Service charges", "Unknown — check the publisher's terms"));
      const limits = o.kind === "http" ? "Tool inputs leave this computer for the displayed endpoint. A hosted service can change independently of its listing version. Browser sign-in and automatic token refresh are not available; a token or no-auth connection may work." : o.kind === "npm" ? "This package and its dependencies run locally. Installation pins the package, disables scripts and excludes dependencies newer than 14 days. Process isolation does not provide a full operating-system sandbox." : o.blocked || "Manual setup required.";
      const links = el("div", { className: "row-actions" }, el("a", { href: item.homepage, target: "_blank", rel: "noopener noreferrer", textContent: "Publisher details ↗" }), item.repository ? el("a", { href: item.repository, target: "_blank", rel: "noopener noreferrer", textContent: "Source repository ↗" }) : null);
      const requirements = o.fields.length ? group("What you'll need", ...o.fields.map(f => el("div", { className: "row stack" }, el("div", { className: "row-label", textContent: `${f.label}${f.required ? " · required" : " · optional"}` }), el("p", { className: "row-hint", textContent: f.help || "Set this credential on the integration's setup page. It stays in the app's secret store." })))) : el("p", { className: "row-hint", textContent: "No credentials are declared by this listing. The server may still require an account or browser sign-in." });
      const packageDetails = o.kind === "npm" && r.dependencies ? el("details", { className: "catalog-package" }, el("summary", { textContent: `Package review · ${Object.keys(r.dependencies).length} direct dependencies` }), el("p", { className: "row-hint", textContent: `Published ${r.publishedAt ?? "unknown"}. Entry point: ${r.bin}. Declared scripts (never run at install): ${r.scripts?.join(", ") || "none"}. Transitive dependencies have not been audited by Vakyartha.` }), el("pre", { textContent: JSON.stringify(r.dependencies, null, 2) })) : null;
      const ack = el("input", { type: "checkbox" });
      const acknowledgement = el("label", { className: "catalog-ack" }, ack, el("span", { textContent: o.kind === "npm" ? "I have reviewed the source and dependency requirements and approve adding this package. I understand its access and possible service costs." : "I understand where tool inputs go and that this service may charge me. I want to add this connection." }));
      const note = el("p", { className: "row-hint", role: "status", "aria-live": "polite" });
      const add = button(r.existingId ? "Open existing integration" : "Add and configure", () => {
        if (r.existingId) { open(r.existingId); return; }
        add.disabled = true; add.textContent = "Adding…"; note.textContent = "";
        void api<{ id: string }>(`/api/marketplaces/${source}/add`, { method: "POST", body: JSON.stringify({ fingerprint: r.fingerprint, acknowledged: ack.checked }) }).then(result => open(result.id)).catch(err => { note.textContent = err.message; add.textContent = "Add and configure"; add.disabled = !ack.checked; });
      }, "primary");
      add.disabled = !r.existingId;
      ack.addEventListener("change", () => { add.disabled = !ack.checked; });
      const blocked = r.blocked || o.blocked;
      detail.replaceChildren(back, el("div", { className: "catalog-review-heading" }, publisherIcon(item, query, originCursor, 48), el("div", {}, el("div", { className: "catalog-eyebrow", textContent: "REVIEW CONNECTION" }), el("h2", { textContent: item.title }))), el("p", { className: "lead", textContent: item.description }), el("div", { className: "badges" }, pill("Unverified"), pill("Starts off"), pill("Tools ask first")), selector, facts, el("p", { className: "row-hint", textContent: limits }), links, ...(packageDetails ? [packageDetails] : []), requirements,
        blocked && !r.existingId ? el("div", { className: "catalog-notice" }, el("strong", { textContent: "More setup is needed" }), el("p", { textContent: blocked })) : r.existingId ? el("div", { className: "catalog-notice" }, el("p", { textContent: "This connection is already in your catalog. Open its saved version and setup to manage tools and access." }), add) : el("div", { className: "catalog-next" }, acknowledgement, add, el("p", { className: "row-hint", textContent: "Next: save credentials if needed, install a local package, then turn it on to check the connection. You can disable or remove it at any time." })), note);
    } catch (err) { if (generation === request) detail.replaceChildren(back, el("p", { role: "alert", className: "row-hint bad", textContent: (err as Error).message }), button("Try again", () => void review(item, originCursor, optionKey))); }
  }
  searchForm.addEventListener("submit", e => { e.preventDefault(); void load(); });
  paintSources();
  return { node, load: () => { if (!page) void load(); } };
}
