// Settings → Skills, laid out like MCP: installed skills as cards with search
// and filters, a page per skill (on/off, instructions, edit, remove), and
// publisher catalogs. A catalog skill is added only after its exact
// instructions are reviewed, and starts off.

import { api, ask, el } from "./core.ts";
import { skillPublisherIcon } from "./catalog-icons.ts";
import { icon, tile } from "./icons.ts";
import { group, pill, row, segmented, title, toggle } from "./ui.ts";
import { SKILL_SOURCES, type SkillListing, type SkillReview, type SkillView } from "../shared/skills.ts";
import { renderMarkdown } from "@vak/web";

const TEMPLATE = "---\nname: my-skill\ndescription: When to use this skill, in one sentence.\n---\n\nSteps the assistant follows when this skill applies.\n";
type Filter = "all" | "on" | "updates" | "builtin" | "catalog" | "yours";
let filter: Filter = "all", query = "";
let detailTab = "overview";
const size = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;
const statusLabel = (status: string) => status === "script" ? "Script · omitted in earlier import" : status === "too-large" ? "Too large" : status === "over-limit" ? "Over limit" : status === "not-text" ? "Not text" : "Type not supported";

const origin = (s: SkillView) => s.source ? "catalog" : s.builtin ? "builtin" : "yours";
const originLabel = (s: SkillView) => s.source ? s.source.repo : s.builtin ? "Built in" : "Yours";
const fileText = (s: SkillView) => s.text;
const isScript = (file: string) => /\.(?:py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|rb|go|rs|swift|php|pl|lua|java|kt|c|cc|cpp|h)$/i.test(file);

// Capability glyphs reuse the app's own integration tile system. Specific
// names get a recognizable symbol; unfamiliar catalog skills stay cohesive.
const SKILL_GLYPHS: Record<string, string> = {
  sandbox: "shield", assistant: "spark", "budget-helper": "chart", "code-review": "code",
  "commit-message": "edit", "compare-options": "split", "create-skill": "book",
  "daily-news": "globe", dashboard: "chart", "data-review": "table",
  "debug-error": "tool", "explain-simply": "book", "finance-dashboard": "chart",
  "interactive-ui": "form", "meeting-actions": "check", "periodic-report": "calendar",
  "market-dashboard": "chart", "meal-plan": "calendar", "operations-dashboard": "chart",
  "plan-my-day": "calendar", "research-brief": "search", "sales-dashboard": "chart",
  "shell-command": "code", "summarize": "page", "surface-design": "canvas",
  "task-tracker": "check", "trip-planner": "globe", "write-email": "send",
};

export async function skillsPage(initialSkill?: string, openSandbox?: () => void): Promise<HTMLElement[]> {
  const root = el("div", { className: "integrations-layout" });
  const feedback = el("p", { className: "settings-feedback", role: "status", "aria-live": "polite" });
  const showError = (error: unknown) => { feedback.textContent = (error as Error).message; feedback.classList.add("bad"); root.prepend(feedback); };
  const button = (label: string, action: () => void | Promise<void>, className = "ghost small") => {
    const b = el("button", { type: "button", className, textContent: label });
    b.addEventListener("click", async () => {
      b.disabled = true; feedback.textContent = "";
      try { await action(); } catch (error) { showError(error); }
      finally { b.disabled = false; }
    });
    return b;
  };
  let list: SkillView[] = [];
  let view: "installed" | "explore" = "installed";

  const grid = el("div", { className: "market skills-market" });
  const search = el("input", { type: "search", className: "market-search", placeholder: "Search skills", value: query, "aria-label": "Search skills" });
  search.addEventListener("input", () => { query = search.value; paint(); });
  const filters = segmented([["all", "All"], ["on", "On"], ["updates", "Updates"], ["builtin", "Built in"], ["catalog", "From catalogs"], ["yours", "Yours"]] as const, filter, v => { filter = v; paint(); });
  filters.classList.add("catalog-filters");
  const installed = el("div", {}, el("div", { className: "market-bar" }, search, button("New skill…", () => editor()), filters), grid);
  const summary = el("p", { className: "skills-summary", role: "status" });
  installed.prepend(summary);
  const catalog = el("div");
  const explore = el("section", { className: "external-catalogs", "aria-label": "Skill catalogs" });

  function paint(): void {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter(s => (filter === "all" || (filter === "on" ? s.enabled : filter === "updates" ? Boolean(s.update) : origin(s) === filter)) && words.every(w => `${s.name} ${s.description} ${s.files?.length ? "files" : ""} ${(s.files ?? []).map(f => f.path).join(" ")}`.toLowerCase().includes(w)));
    summary.textContent = `${list.filter(s => s.enabled).length} enabled · ${list.length} installed${list.some(s => s.update) ? ` · ${list.filter(s => s.update).length} updates available` : ""} · Showing ${shown.length}`;
    grid.replaceChildren(...shown.map(s => {
      const mark = s.source ? skillPublisherIcon(s.source.repo, 40) : tile(SKILL_GLYPHS[s.name] ?? "spark", 40);
      const card = el("button", { type: "button", className: "market-card" }, mark, el("div", { className: "market-text" }, el("h3", { className: "market-name", textContent: s.name }), el("div", { className: "market-sum", textContent: s.description })), el("div", { className: "market-foot" }, pill(originLabel(s)), pill(s.required ? "Always on" : s.enabled ? "On" : "Off", s.enabled ? "ok" : ""), s.files?.length ? pill(`${s.files.length} files`) : null, s.update ? pill("Update") : null, el("span", { className: "market-card-action" }, "Manage", icon("arrow", 14))));
      card.addEventListener("click", () => detail(s.name));
      return card;
    }));
    if (!shown.length) grid.append(el("p", { className: "row-hint", textContent: filter === "updates" && !query.trim() ? "No built-in updates available." : list.length ? "Nothing matches." : "No skills yet." }));
  }

  async function reload(): Promise<void> { list = await api<SkillView[]>("/api/skills"); paint(); }

  function home(): void {
    root.classList.remove("skill-detail-layout");
    const tabs = segmented([["installed", `Installed · ${list.length}`], ["explore", "Explore catalogs"]] as const, view, v => { view = v; installed.hidden = v !== "installed"; explore.hidden = v !== "explore"; });
    tabs.classList.add("catalog-tabs"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Skill views");
    installed.hidden = view !== "installed"; explore.hidden = view !== "explore";
    root.replaceChildren(...title("Skills", "Reusable instructions the assistant loads when a request matches. Skills chain to other skills and use your MCP tools, which keep their own access and approvals."), tabs, installed, explore);
  }
  const backHome = () => button("‹ Skills", async () => { await reload(); home(); });

  function description(text: string): HTMLElement[] {
    const body = el("p", { className: "lead skill-description", textContent: text });
    if (text.length <= 180) return [body];
    const more = button("Read full description", () => {
      const expanded = body.classList.toggle("expanded");
      more.textContent = expanded ? "Show less" : "Read full description";
      more.setAttribute("aria-expanded", String(expanded));
    });
    more.setAttribute("aria-expanded", "false");
    return [body, more];
  }

  function fileRows(files: NonNullable<SkillView["files"]>, load: (path: string) => Promise<string>): HTMLElement {
    const box = el("div", { className: "skill-files" });
    for (const file of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
      const content = el("div", { className: "skill-file-content" });
      const details = el("details", { className: "skill-file" }, el("summary", {}, el("code", { textContent: file.path }), el("span", { textContent: size(file.bytes) })), content);
      details.addEventListener("toggle", async () => {
        if (!details.open || content.dataset.loaded) return;
        content.dataset.loaded = "true"; content.textContent = "Loading…";
        try { const value = await load(file.path); content.replaceChildren(/\.md$/i.test(file.path) ? renderMarkdown(value) : el("pre", { className: "skill-body", textContent: value })); }
        catch (err) { delete content.dataset.loaded; content.replaceChildren(el("p", { role: "alert", textContent: `${(err as Error).message} Close and reopen to retry.` })); }
      });
      box.append(details);
    }
    return box;
  }

  function skillToggle(skill: SkillView): HTMLElement {
    const control = toggle(skill.enabled, async on => {
      const input = control as HTMLInputElement;
      input.disabled = true;
      try {
        list = await api<SkillView[]>(`/api/skills/${skill.name}`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
        paint(); detail(skill.name);
      } catch (error) { input.checked = !on; showError(error); }
      finally { input.disabled = false; }
    });
    control.setAttribute("aria-label", `Use ${skill.name}`);
    return control;
  }

  function detail(name: string): void {
    const s = list.find(x => x.name === name);
    if (!s) { home(); showError(new Error(`The skill “${name}” is not installed. Create or add it from Skills.`)); return; }
    root.classList.add("skill-detail-layout");
    const remove = s.required ? null : button("Remove", async () => { if (await ask(`Remove the skill ${s.name}${s.files?.length ? ` and its ${s.files.length} files` : ""}?`, "Remove")) { await api(`/api/skills/${s.name}`, { method: "DELETE" }); await reload(); home(); } });
    const note = el("p", { className: "row-hint", role: "status" });
    const update = s.update;
    const apply = button("Update skill", async () => {
      if (!update) return;
      apply.disabled = true;
      try { await api(`/api/skills/${s.name}`, { method: "PUT", body: JSON.stringify({ updateFingerprint: update.fingerprint, currentFingerprint: update.currentFingerprint }) }); await reload(); detail(s.name); }
      catch (err) { note.textContent = (err as Error).message; apply.disabled = false; }
    }, "primary small");
    const tabs = [["overview", "Overview"], ["instructions", "Instructions"], ...(s.files?.length ? [["files", `Files (${s.files.length})`]] : []), ...(s.source ? [["source", "Source"]] : [])] as [string, string][];
    if (!tabs.some(([id]) => id === detailTab)) detailTab = "overview";
    const section = el("div");
    const render = () => {
      section.replaceChildren();
      if (detailTab === "overview") section.append(group(null,
        s.required ? row("Availability", "Required for canvas and surface authoring. Always on and applied by the runtime.", pill("Always on", "ok")) : row("Use this skill", "When on, the assistant sees its name and description, loads instructions when a request matches, and reads files on demand.", skillToggle(s)),
        row("Package", `Instructions ${size(new TextEncoder().encode(s.body).length)} · ${s.files?.length ?? 0} files (${size((s.files ?? []).reduce((n, f) => n + f.bytes, 0))})`, pill(originLabel(s))),
        s.compatibility ? row("Compatibility stated by author", s.compatibility, pill("Check requirements")) : null,
        s.license ? row("License stated by author", s.license, pill("Author stated")) : null,
        s.metadata ? row("Author metadata", Object.entries(s.metadata).map(([key, value]) => `${key}: ${value}`).join(" · "), pill("Info")) : null,
        s.allowedTools ? row("Requested tools", `${s.allowedTools} · does not grant access`, pill("No authority")) : null),
        ...(s.omitted?.length ? [el("p", { className: "row-hint", textContent: `${s.omitted.length} bundled ${s.omitted.length === 1 ? "file was" : "files were"} not added. Instructions that use them may not work; see Source for the list.` })] : []),
        ...(update ? [group("Update available", el("p", { className: "row-hint", textContent: "Review the current and proposed instructions and files. Updating keeps the on/off choice." }), el("pre", { className: "skill-body", textContent: s.body }), el("pre", { className: "skill-body", textContent: update.body }), el("p", { className: "row-hint", textContent: `Current files: ${(s.files ?? []).map(f => f.path).join(", ") || "none"}. Proposed files: ${(update.files ?? []).map(f => f.path).join(", ") || "none"}.` }), ...(update.files?.length ? [fileRows(update.files, async file => (await api<{ text: string }>(`/api/skills/${s.name}/proposed-file?fingerprint=${encodeURIComponent(update.fingerprint)}&path=${encodeURIComponent(file)}`)).text)] : []), el("div", { className: "row-actions" }, apply), note)] : []),
        ...(s.name === "sandbox" && openSandbox ? [group("Execution setup", row("Project and protection", "This skill guides execution. The sandbox integration, folder and tool policy control whether commands can run.", button("Open Sandbox settings", openSandbox)))] : []),
        el("div", { className: "row-actions" }, button("Edit", () => editor(s)), remove));
      else if (detailTab === "instructions") {
        const body = el("div", { className: "skill-formatted" }, renderMarkdown(s.body));
        section.append(group("Current instructions", segmented([["formatted", "Formatted"], ["plain", "Plain text"]] as const, "formatted", mode => body.replaceChildren(mode === "plain" ? el("pre", { className: "skill-body", textContent: s.body }) : renderMarkdown(s.body))), body));
        body.addEventListener("click", event => { const link = (event.target as HTMLElement).closest("a"); const file = (s.files ?? []).find(f => link?.getAttribute("href")?.replace(/^\.\//, "") === f.path); if (file) { event.preventDefault(); detailTab = "files"; detail(name); const entry = [...root.querySelectorAll(".skill-file")].find(node => node.querySelector("code")?.textContent === file.path) as HTMLDetailsElement | undefined; if (entry) entry.open = true; } });
      } else if (detailTab === "files") section.append(group("Supporting files", el("p", { className: "row-hint", textContent: "Text and source files are read on demand. Scripts are never run by the skill loader." }), fileRows(s.files ?? [], async file => (await api<{ text: string }>(`/api/skills/${s.name}/file?path=${encodeURIComponent(file)}`)).text)));
      else if (s.source) section.append(group("Source", row("Repository", s.source.repo, el("a", { href: `https://github.com/${s.source.repo}/tree/${s.source.sha}/${s.source.path}`, target: "_blank", rel: "noopener noreferrer", textContent: "View source ↗" })), row("Path and commit", `${s.source.path || "/"} · ${s.source.sha}`, pill(new Date(s.source.addedAt).toLocaleDateString())), s.omitted?.length ? el("details", { className: "skill-file" }, el("summary", { textContent: `${s.omitted.length} bundled files not added` }), el("ul", {}, ...s.omitted.map(f => el("li", {}, el("code", { textContent: f.path }), ` · ${statusLabel(f.status)}`)))) : null));
    };
    const navigation = segmented(tabs, detailTab, tab => { detailTab = tab; render(); });
    root.replaceChildren(backHome(), ...title(s.name), ...description(s.description), el("div", { className: "badges" }, pill(originLabel(s)), pill(s.required ? "Always on" : s.enabled ? "On" : "Off", s.enabled ? "ok" : ""), s.files?.length ? pill(`${s.files.length} files`) : null, update ? pill("Update available") : null), navigation, section);
    render();
  }

  function editor(skill?: SkillView): void {
    root.classList.add("skill-detail-layout");
    const text = el("textarea", { className: "skill-editor", rows: 16, spellcheck: false, "aria-label": "Skill file", value: skill ? fileText(skill) : TEMPLATE });
    const note = el("p", { className: "row-hint", role: "status" });
    const save = button("Save", async () => {
      text.disabled = true;
      try {
        await api(skill ? `/api/skills/${skill.name}` : "/api/skills", { method: skill ? "PUT" : "POST", body: JSON.stringify({ text: text.value }) });
        await reload();
        detail(/^name:\s*(\S+)/m.exec(text.value)?.[1] ?? skill?.name ?? "");
      } catch (err) { note.textContent = (err as Error).message; }
      finally { text.disabled = false; }
    }, "primary small");
    const original = text.value;
    const cancel = button("Cancel", async () => {
      if (text.value !== original && !await ask("Discard your unsaved skill edits?", "Discard")) return;
      if (skill) detail(skill.name); else home();
    });
    root.replaceChildren(cancel, ...title(skill ? `Edit ${skill.name}` : "New skill", "A name, a description of when it applies, then the instructions. Only skills that are on reach the assistant."), ...(skill?.files?.length ? [el("p", { className: "row-hint", textContent: `${skill.files.length} supporting files are kept. Renaming the skill keeps them.` })] : []), text, el("div", { className: "row-actions" }, save), note);
    text.focus();
  }

  async function browse(repo: string): Promise<void> {
    catalog.replaceChildren(el("div", { className: "catalog-skeleton", "aria-hidden": "true" }), el("p", { className: "row-hint", role: "status", textContent: `Reading ${repo}…` }));
    try {
      const items = await api<SkillListing[]>(`/api/skills/catalog?repo=${encodeURIComponent(repo)}`);
      const descriptions = new Map<string, string | null>();
      const results = el("div", { className: "market skills-catalog-market" });
      const find = el("input", { type: "search", className: "market-search", placeholder: `Search ${items.length} skills`, "aria-label": "Search catalog skills" });
      const paintResults = () => {
        const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
        const visible = items.filter(i => words.every(w => `${i.name} ${i.path} ${descriptions.get(i.path) ?? ""}`.toLowerCase().includes(w))).slice(0, 24);
        results.replaceChildren(...visible.map(i => {
          const action = el("span", { className: "catalog-action" }, list.some(s => s.name === i.name) ? "Installed" : "Review", icon("arrow", 14));
          const b = el("button", { type: "button", className: "market-card external-card" }, skillPublisherIcon(repo, 40), el("div", { className: "market-text" }, el("h3", { className: "market-name", textContent: i.name }), el("div", { className: "market-pub", textContent: i.path || "/" }), el("div", { className: "market-sum", textContent: descriptions.has(i.path) ? descriptions.get(i.path) ?? i.path : "Loading description…" })), el("div", { className: "market-foot" }, el("span", { className: "catalog-origin", textContent: repo }), action));
          b.addEventListener("click", () => void review(i)); return b;
        }));
        if (!results.children.length) results.append(el("p", { className: "row-hint", textContent: "Nothing matches." }));
        const missing = visible.filter(i => !descriptions.has(i.path)).map(i => i.path);
        if (missing.length) void api<Record<string, string | null>>("/api/skills/describe", { method: "POST", body: JSON.stringify({ repo, paths: missing }) }).then(found => { for (const [key, value] of Object.entries(found)) descriptions.set(key, value); paintResults(); }).catch(() => { for (const key of missing) descriptions.set(key, null); paintResults(); });
      };
      find.addEventListener("input", paintResults); paintResults();
      catalog.replaceChildren(el("p", { className: "row-hint catalog-status", textContent: `${repo} at ${items[0]?.sha.slice(0, 7) ?? "—"}, the newest commit at least 14 days old · ${items.length} skills` }), find, results);
      find.focus();
    } catch (err) { catalog.replaceChildren(el("div", { className: "catalog-empty", role: "alert" }, el("h3", { textContent: "This catalog couldn't be read" }), el("p", { className: "row-hint", textContent: (err as Error).message }), button("Try again", () => void browse(repo)))); }
  }

  async function review(item: SkillListing): Promise<void> {
    const back = button("‹ Back to results", () => { home(); void browse(item.repo); });
    root.classList.add("skill-detail-layout");
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
      const added = r.files.filter(f => f.status === "added"), skipped = r.files.filter(f => f.status !== "added");
      const section = el("div");
      const tabs = segmented([["instructions", "Instructions"], ["files", `Files (${added.length})`], ["skipped", `Not added (${skipped.length})`]] as const, "instructions", tab => {
        if (tab === "instructions") section.replaceChildren(group("Instructions", el("pre", { className: "skill-body", textContent: r.body })));
        else if (tab === "files") section.replaceChildren(group("Files to add", fileRows(added, async file => (await api<{ text: string }>("/api/skills/review-file", { method: "POST", body: JSON.stringify({ fingerprint: r.fingerprint, path: file }) })).text)));
        else section.replaceChildren(group("Not added", ...skipped.map(f => row(f.path, size(f.bytes), pill(statusLabel(f.status))))));
      });
      section.append(group("Instructions", el("pre", { className: "skill-body", textContent: r.body })));
      root.replaceChildren(back, el("div", { className: "catalog-eyebrow", textContent: "REVIEW SKILL" }), ...title(r.name), ...description(r.description), el("div", { className: "badges" }, pill("Unverified"), pill("Starts off"), pill(added.length ? `Instructions + ${added.length} files` : "Instructions only")),
        el("p", { className: "row-hint", textContent: `${r.repo} · ${r.path || "/"} · commit ${r.sha.slice(0, 12)}. A skill cannot grant tools; MCP tools keep their own access and approvals.` }),
        ...(r.compatibility ? [el("p", { className: "row-hint", textContent: `Author's compatibility requirements: ${r.compatibility}` })] : []),
        ...(r.license ? [el("p", { className: "row-hint", textContent: `Author's license: ${r.license}` })] : []),
        ...(r.metadata ? [el("p", { className: "row-hint", textContent: `Author metadata: ${Object.entries(r.metadata).map(([key, value]) => `${key}: ${value}`).join(" · ")}` })] : []),
        ...(r.allowedTools ? [el("p", { className: "row-hint", textContent: `Requested tools: ${r.allowedTools}. This does not grant access.` })] : []),
        ...(added.some(f => isScript(f.path)) ? [el("p", { className: "row-hint", textContent: "Bundled scripts are stored as reviewable source text only; the skill loader never runs them." })] : []),
        ...(skipped.length ? [el("p", { className: "row-hint", textContent: `${skipped.length} bundled ${skipped.length === 1 ? "file" : "files"} will be omitted. Instructions that use them may not work.` })] : []), tabs, section,
        el("p", { className: "row-hint", textContent: `${added.length} files will be added (${size(added.reduce((n, f) => n + f.bytes, 0))}) · ${skipped.length} not added` }),
        blocked ? el("div", { className: "catalog-notice" }, el("strong", { textContent: "This skill can't be added" }), el("p", { textContent: blocked })) :
          el("div", { className: "catalog-next" }, el("label", { className: "catalog-ack" }, ack, el("span", { textContent: `I have reviewed the instructions${added.length ? ` and these ${added.length} supporting files: ${added.map(f => f.path).join(", ")}` : ""}. I want to add them.` })), add), note);
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
  if (initialSkill) detail(initialSkill); else home();
  return [root];
}
