// Settings → Skills, laid out like MCP: installed skills as cards with search
// and filters, a page per skill (on/off, instructions, edit, remove), and
// publisher catalogs. A catalog skill is added only after its exact
// instructions are reviewed, and starts off.

import { api, ask, el } from "./core.ts";
import { skillPublisherIcon } from "./catalog-icons.ts";
import { icon, tile } from "./icons.ts";
import { group, pill, row, segmented, title, toggle } from "./ui.ts";
import { SKILL_SOURCES, type SkillListing, type SkillReview, type SkillView } from "../shared/skills.ts";

const TEMPLATE = "---\nname: my-skill\ndescription: When to use this skill, in one sentence.\n---\n\nSteps the assistant follows when this skill applies.\n";
type Filter = "all" | "on" | "updates" | "builtin" | "catalog" | "yours";
let filter: Filter = "all", query = "";

const origin = (s: SkillView) => s.source ? "catalog" : s.builtin ? "builtin" : "yours";
const originLabel = (s: SkillView) => s.source ? s.source.repo : s.builtin ? "Built in" : "Yours";
const fileText = (s: SkillView) => `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`;

// Capability glyphs reuse the app's own integration tile system. Specific
// names get a recognizable symbol; unfamiliar catalog skills stay cohesive.
const SKILL_GLYPHS: Record<string, string> = {
  assistant: "spark", "budget-helper": "chart", "code-review": "code",
  "commit-message": "edit", "compare-options": "split", "create-skill": "book",
  "daily-news": "globe", dashboard: "chart", "data-review": "table",
  "debug-error": "tool", "explain-simply": "book", "finance-dashboard": "chart",
  "interactive-ui": "form", "meeting-actions": "check", "periodic-report": "calendar",
  "market-dashboard": "chart", "meal-plan": "calendar", "operations-dashboard": "chart",
  "plan-my-day": "calendar", "research-brief": "search", "sales-dashboard": "chart",
  "shell-command": "code", "summarize": "page", "surface-design": "canvas",
  "task-tracker": "check", "trip-planner": "globe", "write-email": "send",
};

export async function skillsPage(): Promise<HTMLElement[]> {
  const root = el("div", { className: "integrations-layout" });
  const button = (label: string, action: () => void, className = "ghost small") => { const b = el("button", { type: "button", className, textContent: label }); b.addEventListener("click", action); return b; };
  let list: SkillView[] = [];
  let view: "installed" | "explore" = "installed";

  const grid = el("div", { className: "market skills-market" });
  const search = el("input", { type: "search", className: "market-search", placeholder: "Search skills", value: query, "aria-label": "Search skills" });
  search.addEventListener("input", () => { query = search.value; paint(); });
  const filters = segmented([["all", "All"], ["on", "On"], ["updates", "Updates"], ["builtin", "Built in"], ["catalog", "From catalogs"], ["yours", "Yours"]] as const, filter, v => { filter = v; paint(); });
  filters.classList.add("catalog-filters");
  const installed = el("div", {}, el("div", { className: "market-bar" }, search, button("New skill…", () => editor()), filters), grid);
  const catalog = el("div");
  const explore = el("section", { className: "external-catalogs", "aria-label": "Skill catalogs" });

  function paint(): void {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter(s => (filter === "all" || (filter === "on" ? s.enabled : filter === "updates" ? Boolean(s.update) : origin(s) === filter)) && words.every(w => `${s.name} ${s.description}`.toLowerCase().includes(w)));
    grid.replaceChildren(...shown.map(s => {
      const mark = s.source ? skillPublisherIcon(s.source.repo, 40) : tile(SKILL_GLYPHS[s.name] ?? "spark", 40);
      const card = el("button", { type: "button", className: "market-card" }, mark, el("div", { className: "market-text" }, el("h3", { className: "market-name", textContent: s.name }), el("div", { className: "market-pub", textContent: originLabel(s) }), el("div", { className: "market-sum", textContent: s.description })), el("div", { className: "market-foot" }, pill(originLabel(s)), pill(s.required ? "Always on" : s.enabled ? "On" : "Off", s.enabled ? "ok" : ""), s.update ? pill("Update", "bad") : null, el("span", { className: "market-card-action" }, "Manage", icon("arrow", 14))));
      card.addEventListener("click", () => detail(s.name));
      return card;
    }));
    if (!shown.length) grid.append(el("p", { className: "row-hint", textContent: filter === "updates" && !query.trim() ? "No built-in updates available." : list.length ? "Nothing matches." : "No skills yet." }));
  }

  async function reload(): Promise<void> { list = await api<SkillView[]>("/api/skills"); paint(); }

  function home(): void {
    const tabs = segmented([["installed", `Installed · ${list.length}`], ["explore", "Explore catalogs"]] as const, view, v => { view = v; installed.hidden = v !== "installed"; explore.hidden = v !== "explore"; });
    tabs.classList.add("catalog-tabs"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Skill views");
    installed.hidden = view !== "installed"; explore.hidden = view !== "explore";
    root.replaceChildren(...title("Skills", "Reusable instructions the assistant loads when a request matches. Skills chain to other skills and use your MCP tools, which keep their own access and approvals."), tabs, installed, explore);
  }
  const backHome = () => button("‹ Skills", () => { void reload().then(home); });

  function detail(name: string): void {
    const s = list.find(x => x.name === name);
    if (!s) { home(); return; }
    const remove = s.required ? null : button("Remove", async () => { if (await ask(`Remove the skill ${s.name}?`, "Remove")) { await api(`/api/skills/${s.name}`, { method: "DELETE" }); await reload(); home(); } });
    const note = el("p", { className: "row-hint", role: "status" });
    const update = s.update;
    const apply = button("Update skill", async () => {
      if (!update) return;
      apply.disabled = true;
      try { await api(`/api/skills/${s.name}`, { method: "PUT", body: JSON.stringify({ updateFingerprint: update.fingerprint, currentFingerprint: update.currentFingerprint }) }); await reload(); detail(s.name); }
      catch (err) { note.textContent = (err as Error).message; apply.disabled = false; }
    }, "primary small");
    root.replaceChildren(backHome(), ...title(s.name, s.description),
      el("div", { className: "badges" }, pill(originLabel(s)), pill(s.required ? "Always on" : s.enabled ? "On" : "Off", s.enabled ? "ok" : "")),
      group(null,
        s.required ? row("Availability", "Required for canvas and surface authoring. Always on and applied by the runtime.", pill("Always on", "ok")) : row("Use this skill", "When on, the assistant sees its name and description and loads the instructions when a request matches.", toggle(s.enabled, async on => { list = await api<SkillView[]>(`/api/skills/${s.name}`, { method: "PUT", body: JSON.stringify({ enabled: on }) }); paint(); detail(s.name); })),
        s.source ? row("Source", `${s.source.repo} · ${s.source.path || "/"} · commit ${s.source.sha.slice(0, 12)} · added ${new Date(s.source.addedAt).toLocaleDateString()}`, el("a", { href: `https://github.com/${s.source.repo}/tree/${s.source.sha}/${s.source.path}`, target: "_blank", rel: "noopener noreferrer", textContent: "View source ↗" })) : null),
      group("Current instructions", el("pre", { className: "skill-body", textContent: s.body })),
      ...(update ? [group("Update available", el("p", { className: "row-hint", textContent: s.required ? "Review the built-in update below. Updating replaces these instructions and preserves the required always-on status." : "Review the built-in update below. Updating replaces your current instructions and keeps your on/off choice." }), el("p", { textContent: update.description }), el("pre", { className: "skill-body", textContent: update.body }), el("div", { className: "row-actions" }, apply), note)] : []),
      el("div", { className: "row-actions" }, button("Edit", () => editor(s)), remove));
  }

  function editor(skill?: SkillView): void {
    const text = el("textarea", { className: "skill-editor", rows: 16, spellcheck: false, "aria-label": "Skill file", value: skill ? fileText(skill) : TEMPLATE });
    const note = el("p", { className: "row-hint", role: "status" });
    const save = button("Save", async () => {
      try {
        await api(skill ? `/api/skills/${skill.name}` : "/api/skills", { method: skill ? "PUT" : "POST", body: JSON.stringify({ text: text.value }) });
        await reload();
        detail(/^name:\s*(\S+)/m.exec(text.value)?.[1] ?? skill?.name ?? "");
      } catch (err) { note.textContent = (err as Error).message; }
    }, "primary small");
    root.replaceChildren(skill ? button("‹ Back", () => detail(skill.name)) : backHome(), ...title(skill ? `Edit ${skill.name}` : "New skill", "A name, a description of when it applies, then the instructions. Only skills that are on reach the assistant."), text, el("div", { className: "row-actions" }, save), note);
    text.focus();
  }

  async function browse(repo: string): Promise<void> {
    catalog.replaceChildren(el("div", { className: "catalog-skeleton", "aria-hidden": "true" }), el("p", { className: "row-hint", role: "status", textContent: `Reading ${repo}…` }));
    try {
      const items = await api<SkillListing[]>(`/api/skills/catalog?repo=${encodeURIComponent(repo)}`);
      const results = el("div", { className: "market skills-catalog-market" });
      const find = el("input", { type: "search", className: "market-search", placeholder: `Search ${items.length} skills`, "aria-label": "Search catalog skills" });
      const paintResults = () => {
        const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
        results.replaceChildren(...items.filter(i => words.every(w => i.path.toLowerCase().includes(w))).map(i => {
          const action = el("span", { className: "catalog-action" }, list.some(s => s.name === i.name) ? "Installed" : "Review", icon("arrow", 14));
          const b = el("button", { type: "button", className: "market-card external-card" }, skillPublisherIcon(repo, 40), el("div", { className: "market-text" }, el("h3", { className: "market-name", textContent: i.name }), el("div", { className: "market-pub", textContent: i.path || "/" })), el("div", { className: "market-foot" }, el("span", { className: "catalog-origin", textContent: repo }), action));
          b.addEventListener("click", () => void review(i)); return b;
        }));
        if (!results.children.length) results.append(el("p", { className: "row-hint", textContent: "Nothing matches." }));
      };
      find.addEventListener("input", paintResults); paintResults();
      catalog.replaceChildren(el("p", { className: "row-hint catalog-status", textContent: `${repo} at ${items[0]?.sha.slice(0, 7) ?? "—"}, the newest commit at least 14 days old · ${items.length} skills` }), find, results);
      find.focus();
    } catch (err) { catalog.replaceChildren(el("div", { className: "catalog-empty", role: "alert" }, el("h3", { textContent: "This catalog couldn't be read" }), el("p", { className: "row-hint", textContent: (err as Error).message }), button("Try again", () => void browse(repo)))); }
  }

  async function review(item: SkillListing): Promise<void> {
    const back = button("‹ Back to results", () => { home(); void browse(item.repo); });
    root.replaceChildren(back, el("p", { className: "row-hint", role: "status", textContent: "Fetching the instructions…" }));
    try {
      const r = await api<SkillReview>("/api/skills/review", { method: "POST", body: JSON.stringify({ repo: item.repo, path: item.path }) });
      const ack = el("input", { type: "checkbox" });
      const note = el("p", { className: "row-hint", role: "status" });
      const add = button("Add skill", async () => {
        try { const { name } = await api<{ name: string }>("/api/skills/add", { method: "POST", body: JSON.stringify({ fingerprint: r.fingerprint, acknowledged: ack.checked }) }); await reload(); detail(name); }
        catch (err) { note.textContent = (err as Error).message; }
      }, "primary");
      add.disabled = true; ack.addEventListener("change", () => { add.disabled = !ack.checked; });
      const blocked = r.blocked ?? (r.existing ? `A skill named ${r.name} is already installed.` : undefined);
      root.replaceChildren(back, el("div", { className: "catalog-eyebrow", textContent: "REVIEW SKILL" }), ...title(r.name, r.description), el("div", { className: "badges" }, pill("Unverified"), pill("Starts off"), pill("Instructions only")),
        el("p", { className: "row-hint", textContent: `${r.repo} · ${r.path || "/"} · commit ${r.sha.slice(0, 12)}. ${r.extraFiles.length ? `Bundled files are not imported or run: ${r.extraFiles.join(", ")}.` : "No bundled files."} A skill cannot grant tools; MCP tools keep their own access and approvals.` }),
        group("Instructions", el("pre", { className: "skill-body", textContent: r.body })),
        blocked ? el("div", { className: "catalog-notice" }, el("strong", { textContent: "This skill can't be added" }), el("p", { textContent: blocked })) :
          el("div", { className: "catalog-next" }, el("label", { className: "catalog-ack" }, ack, el("span", { textContent: "I have read these instructions and want the assistant to be able to follow them." })), add), note);
    } catch (err) { root.replaceChildren(back, el("p", { role: "alert", className: "row-hint bad", textContent: (err as Error).message })); }
  }

  const repoInput = el("input", { type: "search", className: "market-search", placeholder: "Any public owner/repository", "aria-label": "Skill repository", maxLength: 201 });
  const form = el("form", { className: "catalog-search" }, repoInput, el("button", { type: "submit", className: "primary small", textContent: "Open" }));
  form.addEventListener("submit", e => { e.preventDefault(); if (repoInput.value.trim()) void browse(repoInput.value.trim()); });
  const sources = el("div", { className: "catalog-sources", role: "group", "aria-label": "Skill catalogs" }, ...SKILL_SOURCES.map(s => {
    const b = el("button", { type: "button", className: "catalog-source", title: s.repo, "aria-pressed": "false" }, skillPublisherIcon(s.repo, 32), el("span", {}, el("strong", { textContent: s.name }), el("span", { textContent: s.description })));
    b.addEventListener("click", () => { for (const x of sources.children) x.setAttribute("aria-pressed", String(x === b)); repoInput.value = s.repo; void browse(s.repo); }); return b;
  }));
  explore.append(el("div", { className: "catalog-intro" }, el("div", {}, el("h2", { textContent: "Explore skills" }), el("p", { className: "row-hint", textContent: "Pick a publisher, search its skills, read the instructions, then add." })), pill("Optional")), sources, form, catalog);

  await reload();
  home();
  return [root];
}
