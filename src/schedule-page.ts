import { parseTaskResultPolicy } from "../task-result.ts";
import { parseRunUsage } from "../finops.ts";
import { TASK_LABELS, TASK_RUN_LABELS, TASK_LIMITS, TASK_BUDGET_DEFAULTS, TASK_BUDGET_MAX, parseTaskLimits, parseReviewSnapshot, parseTaskView, taskObject, taskString, type TaskSummary, type TaskView } from "../task-contract.ts";
import { scheduleLabel } from "../schedule.ts";
import { $, api, ask, el } from "./core.ts";
import { icon } from "./icons.ts";
import { current } from "./models.ts";
import { openSettings } from "./settings.ts";

interface Capability { id: string; name: string; summary: string; ready: boolean; free: boolean; access: string[] }
type Filter = "all" | "upcoming" | "attention" | "active" | "history";
type View = { kind: "list" } | { kind: "create" } | { kind: "detail"; id: string } | { kind: "review"; id: string };
const ATTENTION = new Set(["needs_input", "needs_approval", "interrupted", "failed"]);
const TEMPLATES = [
  { title: "Research brief", glyph: "book", description: "Compare sources and turn a question into a clear, cited brief.", goal: "Research this topic using the public sources I provide. Compare the evidence and prepare an interactive brief with source links and missing information clearly labelled.", criteria: "A cited brief with a comparison, source dates and any gaps clearly shown." },
  { title: "Workspace review", glyph: "folder", description: "Review files in a folder you choose and surface what needs attention.", goal: "Review the readable files in the folder I authorize. Summarize the important changes and show an interactive table of items needing attention. Ask before changing files.", criteria: "A traceable summary and a usable table, with unsupported files and uncertainties listed." },
  { title: "Plan the next step", glyph: "form", description: "Turn a goal into a plan you can review and refine.", goal: "Help me plan this goal. Collect missing information with an interactive form, then create a practical checklist and a separate plan I can refine.", criteria: "A usable input form and an actionable plan. No external action without approval." },
] as const;

function capabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid capability list");
  return value.map((item: unknown) => {
    const raw = taskObject(item);
    if (!Array.isArray(raw.access) || raw.access.length > 32) throw new Error("Invalid capability access");
    return { id: taskString(raw.id, 120), name: taskString(raw.name, 240), summary: taskString(raw.summary, 2000), ready: raw.ready === true, free: raw.free === true, access: raw.access.map((v: unknown) => taskString(v, 2000)) };
  });
}
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const button = (label: string, action: () => void, primary = false) => {
  const b = el("button", { type: "button", className: primary ? "primary" : "ghost", textContent: label });
  b.addEventListener("click", action); return b;
};

/** Schedule chrome references live workspaces; it never mounts or copies their surfaces. */
export class SchedulePage {
  private page = $("schedule-page");
  private view: View = { kind: "list" };
  private summaries: TaskSummary[] = [];
  private filter: Filter = "all";
  private query = "";
  private tab: "yours" | "templates" = "yours";
  private sort: "recent" | "next" = "recent";
  private key = "";
  private request = 0;
  private detail?: TaskView;
  private busy = false;
  private creationBusy = false;
  private formReady = false;
  private formShown = false;
  private formGeneration = 0;
  private navigate: (id: string) => Promise<void>;
  private refresh: () => Promise<void>;
  private remove: (task: TaskView) => Promise<void>;
  private beforeOpen: () => void;
  private toggleSidebar: () => void;

  constructor(options: { navigate(id: string): Promise<void>; refresh(): Promise<void>; remove(task: TaskView): Promise<void>; beforeOpen(): void; toggleSidebar(): void }) {
    this.navigate = options.navigate; this.refresh = options.refresh; this.remove = options.remove; this.beforeOpen = options.beforeOpen; this.toggleSidebar = options.toggleSidebar;
    window.addEventListener("vak:settings-closed", () => {
      if (this.visible() && this.view.kind === "create") void this.create();
    });
    window.addEventListener("vak:model", () => {
      $<HTMLInputElement>("task-spending-ack").checked = false;
      if (this.visible() && this.view.kind === "create") $("task-create-model").textContent = current.model || "Choose a model before saving";
    });
    $("open-schedule").append(icon("calendar", 18), "Schedule");
    $("open-schedule").addEventListener("click", () => void this.openPage());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.page.hidden || !$("settings").hidden || document.querySelector("dialog[open]") || event.defaultPrevented || this.creationBusy) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      event.preventDefault();
      if (this.view.kind === "list") this.close(true); else this.list();
    });
  }

  visible(): boolean { return !this.page.hidden; }
  async openPage(): Promise<void> {
    this.beforeOpen(); this.page.hidden = false; $("workspace").hidden = true;
    document.body.classList.add("in-schedule"); $("open-schedule").setAttribute("aria-current", "page");
    this.list(); await this.refresh();
  }
  close(focus = false): void {
    if (this.page.hidden) return;
    this.request++; this.page.hidden = true; $("workspace").hidden = false;
    document.body.classList.remove("in-schedule", "schedule-show-sidebar");
    $("open-schedule").setAttribute("aria-current", "false");
    if (focus) $("open-schedule").focus();
  }
  update(summaries: TaskSummary[]): void {
    this.summaries = summaries;
    if (this.page.hidden || this.view.kind === "create") return;
    if (this.view.kind === "list") this.drawList();
    else if (this.view.kind === "detail" && this.detail?.revision !== summaries.find((t) => t.id === this.detail?.id)?.revision) void this.showDetail(this.view.id, false);
  }
  error(message: string): void {
    if (!this.visible()) return;
    let notice = this.page.querySelector<HTMLElement>(".schedule-error");
    if (!notice) { notice = el("p", { className: "schedule-error", role: "alert" }); this.page.prepend(notice); }
    notice.textContent = message;
  }
  private shell(title: string, subtitle: string, back: () => void): HTMLElement {
    this.parkComposer();
    const sidebar = button("", this.toggleSidebar); sidebar.className = "icon-btn schedule-sidebar"; sidebar.setAttribute("aria-label", "Show sidebar"); sidebar.append(icon("sidebar"));
    const top = el("div", { className: "schedule-top", "data-tauri-drag-region": "" }, sidebar, button(this.view.kind === "list" ? "Back to conversation" : "Back to Schedule", back));
    const body = el("div", { className: "schedule-body" }, el("header", { className: "schedule-intro" }, el("div", { className: "schedule-eyebrow" }, icon("calendar", 16), "WORKSPACE"), el("h1", { id: "schedule-title", tabIndex: -1, textContent: title }), el("p", { textContent: subtitle })));
    this.page.replaceChildren(top, body); return body;
  }
  private list(): void {
    this.request++; this.view = { kind: "list" }; this.key = "";
    const body = this.shell("Schedule", "Your upcoming work, progress, and results in one place.", () => this.close(true));
    const tabs = el("div", { className: "schedule-tabs", role: "group", "aria-label": "Schedule views" });
    for (const [id, label] of [["yours", "Yours"], ["templates", "Ideas to start"]] as const) {
      const b = button(label, () => { this.tab = id; this.key = ""; this.drawList(); }); b.dataset.tab = id; tabs.append(b);
    }
    const create = button("Create schedule", () => void this.create(), true); create.id = "create-schedule"; create.prepend(icon("plus", 16));
    body.append(el("div", { className: "schedule-toolbar" }, tabs, create));
    const search = el("input", { type: "search", placeholder: "Search your work", value: this.query, "aria-label": "Search schedules" });
    search.addEventListener("input", () => { this.query = search.value; this.key = ""; this.drawList(); });
    const sort = el("select", { "aria-label": "Sort schedules" }, new Option("Recently updated", "recent"), new Option("Next scheduled", "next")); sort.value = this.sort;
    sort.addEventListener("change", () => { this.sort = sort.value === "next" ? "next" : "recent"; this.key = ""; this.drawList(); });
    body.append(el("div", { id: "schedule-search-row", className: "schedule-search-row" }, el("div", { className: "artifact-search" }, icon("search", 17), search), sort));
    const filters = el("div", { id: "schedule-filters", className: "schedule-filters", role: "group", "aria-label": "Filter by lifecycle" });
    for (const [id, label] of [["all", "All work"], ["upcoming", "Upcoming"], ["attention", "Needs attention"], ["active", "In progress"], ["history", "History"]] as const) {
      const b = button(label, () => { this.filter = id; this.key = ""; this.drawList(); }); b.dataset.filter = id; filters.append(b);
    }
    body.append(filters, el("div", { id: "schedule-count", className: "schedule-count", role: "status" }), el("div", { id: "schedule-results" }), el("p", { className: "schedule-availability" }, icon("shield", 15), "Runs on this computer. Keep the app running and your computer awake. Missed times are held for review."));
    this.drawList(); $("schedule-title").focus();
  }
  private drawList(): void {
    if (this.view.kind !== "list") return;
    const key = JSON.stringify([this.summaries, this.filter, this.query, this.tab, this.sort]); if (key === this.key) return; this.key = key;
    for (const b of this.page.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.setAttribute("aria-pressed", String(b.dataset.tab === this.tab));
    for (const b of this.page.querySelectorAll<HTMLButtonElement>("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === this.filter));
    $("schedule-search-row").hidden = $("schedule-filters").hidden = this.tab === "templates" || !this.summaries.length;
    const results = $("schedule-results"); results.replaceChildren();
    if (this.tab === "templates") { $("schedule-count").textContent = "Start with an idea, then choose the inputs, access and time."; results.append(this.templates()); return; }
    const shown = this.summaries.filter((t) => (!this.query.trim() || `${t.goal} ${t.note}`.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())) && (this.filter === "all" || this.filter === "upcoming" && ["scheduled", "paused"].includes(t.state) || this.filter === "attention" && ATTENTION.has(t.state) || this.filter === "active" && ["queued", "running"].includes(t.state) || this.filter === "history" && ["completed", "cancelled"].includes(t.state)));
    shown.sort((a, b) => this.sort === "next" ? (a.state === "scheduled" ? Date.parse(a.schedule!.at) : Infinity) - (b.state === "scheduled" ? Date.parse(b.schedule!.at) : Infinity) || b.updated.localeCompare(a.updated) : b.updated.localeCompare(a.updated));
    $("schedule-count").textContent = shown.length ? `${shown.length} ${shown.length === 1 ? "item" : "items"}` : "";
    if (shown.length) results.append(el("div", { className: "schedule-grid" }, ...shown.map((t) => this.card(t))));
    else if (this.summaries.length) results.append(el("div", { className: "schedule-empty" }, icon("search", 34), el("h2", { textContent: "Nothing matches just yet" }), el("p", { textContent: "Try another search or lifecycle filter." }), button("Clear filters", () => { this.query = ""; this.filter = "all"; this.list(); })));
    else results.append(el("div", { className: "schedule-empty" }, el("div", { className: "schedule-empty-icon" }, icon("calendar", 44)), el("h2", { textContent: "Nothing scheduled yet" }), el("p", { textContent: "Start now or choose a time. Follow the work here, then open the result when it is ready." }), button("Create your first schedule", () => void this.create(), true)), el("section", { className: "schedule-inspiration" }, el("h2", { textContent: "What would you like to make time for?" }), this.templates()));
  }
  private card(t: TaskSummary): HTMLElement {
    const b = button("", () => void this.showDetail(t.id)); b.className = "schedule-card"; b.dataset.task = t.id;
    b.append(el("div", { className: "schedule-card-top" }, el("span", { className: "schedule-card-icon" }, icon(t.schedule ? "calendar" : "form", 21)), this.badge(t.state)), el("h2", { textContent: t.goal }), el("p", { textContent: t.note }), el("div", { className: "schedule-card-footer" }, icon("clock", 15), el("span", { textContent: t.schedule ? scheduleLabel(t.schedule) : `Updated ${date(t.updated)}` }), icon("arrow", 16)));
    return b;
  }
  private badge(state: TaskView["state"]): HTMLElement { return el("span", { className: `schedule-badge ${state}` }, el("span", { className: "schedule-dot" }), TASK_LABELS[state]); }
  private templates(): HTMLElement {
    return el("div", { className: "schedule-templates" }, ...TEMPLATES.map((t) => {
      const b = button("", () => void this.create(t)); b.className = "schedule-template";
      b.append(el("span", { className: "schedule-card-icon" }, icon(t.glyph, 21)), el("span", {}, el("strong", { textContent: t.title }), el("span", { textContent: t.description }), el("small", {}, "Make it yours ", icon("arrow", 13)))); return b;
    }));
  }

  async reviewResult(id: string): Promise<void> {
    this.beforeOpen(); this.page.hidden = false; $("workspace").hidden = true;
    document.body.classList.add("in-schedule"); $("open-schedule").setAttribute("aria-current", "page");
    const request = ++this.request; this.view = { kind: "review", id };
    try {
      const task = parseTaskView(await api<unknown>(`/api/tasks/${encodeURIComponent(id)}`));
      const snapshot = parseReviewSnapshot(await api<unknown>(`/api/tasks/${encodeURIComponent(id)}/review`));
      if (request !== this.request || this.page.hidden) return;
      if (task.revision !== snapshot.revision) throw new Error("Task changed. Open a fresh review.");
      const body = this.shell("Review the result", "Accept what you checked, with a record of the evidence.", () => void this.showDetail(id));
      const layout = el("div", { className: "schedule-detail-grid" });
      const result = this.section("Saved result", el("p", { textContent: `Run ${task.runs} · ${date(snapshot.assistantAt)}` }), button("Open workspace", () => { this.close(); void this.navigate(id).catch((err: unknown) => this.error(String(err))); }));
      result.append(el("p", { className: "hint", textContent: "Review the saved workspace and source receipts. Unsubmitted form edits are not part of this result. A returned tool call alone does not prove an external change." }));
      for (const surface of snapshot.surfaces) result.append(el("p", { textContent: `${surface.title} · version ${surface.version}` }));
      if (!snapshot.surfaces.length) result.append(el("p", { className: "hint", textContent: "Text result only; no saved surfaces." }));
      const operations = task.operations.filter((operation) => operation.runId === snapshot.runId);
      if (operations.length) {
        result.append(el("h3", { textContent: "Tool call records" }), el("p", { className: "hint", textContent: "Returned means a response was received. Verify the external outcome separately." }));
        for (const operation of operations) result.append(el("p", { textContent: `${operation.tool} · ${operation.state} · ${operation.id}` }));
      }
      const note = el("textarea", { id: "review-evidence", required: true, maxLength: 4000, rows: 5, placeholder: "What did you check? Reference the sources, values, output or operation receipts that support the criteria." });
      const confirm = el("input", { id: "review-confirm", type: "checkbox", required: true });
      const save = el("button", { type: "submit", className: "primary", textContent: "Accept reviewed result" });
      const error = el("p", { className: "error", role: "alert" });
      const form = el("form", { className: "schedule-review-form" }, el("label", { htmlFor: "review-evidence", textContent: "Evidence you checked" }), note, el("label", { className: "schedule-review-confirm" }, confirm, el("span", { textContent: "I checked the saved result against the completion criteria, including any external effects." })), error, save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); if (!form.reportValidity() || save.disabled) return;
        save.disabled = true; error.textContent = "";
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify({ ...snapshot, note: note.value, confirmed: confirm.checked }) });
          await this.refresh(); await this.showDetail(id);
        } catch (err) { error.textContent = String(err); save.disabled = false; }
      });
      layout.append(el("div", {}, this.section("Completion criteria", el("p", { textContent: task.criteria })), result, this.section("Your review", form)), el("aside", {}, this.section("A clear acceptance record", el("p", { textContent: "Acceptance records your review, the run identity and the saved surface versions. It is not automatic verification. If the task or result changes, review it again." }), button("Refresh review", () => void this.reviewResult(id)))));
      body.append(layout); $("schedule-title").focus();
    } catch (err) { this.error(String(err)); }
  }

  private async showDetail(id: string, focus = true): Promise<void> {
    if (this.busy || this.page.hidden) return;
    if (!focus && this.page.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const request = ++this.request;
    try {
      const task = parseTaskView(await api<unknown>(`/api/tasks/${encodeURIComponent(id)}`));
      if (request !== this.request || this.page.hidden) return;
      this.detail = task; this.view = { kind: "detail", id };
      const body = this.shell(task.goal.length > 160 ? task.goal.slice(0, 157) + "…" : task.goal, "The full picture, from the first instruction to the result.", () => this.list());
      body.querySelector(".schedule-eyebrow")!.textContent = "SCHEDULE / OVERVIEW";
      const actions = el("div", { className: "schedule-detail-actions" }, this.badge(task.state), button("Open workspace", () => { this.close(); void this.navigate(id).catch((err: unknown) => this.error(String(err))); }, true));
      const change = (operation: "pause" | "resume" | "run") => void this.mutate(task, "schedule", { operation, revision: task.revision });
      if (task.state === "scheduled" || task.state === "paused") {
        actions.append(button("Run now", () => change("run")), button(task.state === "paused" ? "Resume" : "Pause", () => change(task.state === "paused" ? "resume" : "pause")));
      }
      if (["queued", "running", "needs_approval"].includes(task.state)) actions.append(button("Cancel run", () => void this.mutate(task, "cancel", {})));
      if (task.state === "needs_input") actions.append(button("Review result", () => void this.reviewResult(task.id)));
      body.append(actions, el("p", { className: "schedule-status-note", role: "status", textContent: task.note }));
      const layout = el("div", { className: "schedule-detail-grid" });
      const main = el("div", {}, this.section("Instructions", el("p", { className: "schedule-instructions", textContent: task.goal })), this.section("The finish line", el("p", { textContent: task.criteria })), this.section("Activity", task.activity.length ? el("ol", { className: "schedule-timeline" }, ...task.activity.slice(-24).reverse().map((a) => el("li", {}, el("time", { dateTime: a.at, textContent: date(a.at) }), el("span", { textContent: a.text })))) : el("p", { className: "hint", textContent: "Your first run will appear here. No model work happens while waiting for a scheduled time." })));
      const history = el("div", { className: "schedule-run-history" });
      for (const run of [...task.runHistory].reverse()) {
        const timing = run.ended ? `Finished ${date(run.ended)}` : run.recovered ? `Recovery recorded ${date(run.recovered)} · end time unknown` : "In progress";
        const item = el("details", { className: "schedule-run" }, el("summary", {}, el("span", { className: "schedule-run-sequence", textContent: String(run.sequence).padStart(2, "0") }), el("span", {}, el("strong", { textContent: run.inputKind === "action" ? "Surface interaction" : run.sequence === 1 ? "Initial run" : "Continuation" }), el("small", { textContent: date(run.started) })), el("span", { className: `schedule-badge ${run.state === "review" ? "needs_input" : run.state === "accepted" ? "completed" : run.state}`, textContent: TASK_RUN_LABELS[run.state] })));
        item.append(el("p", { textContent: run.note }), el("p", { className: "hint", textContent: `${run.modelRequests} model requests reserved · ${(run.chargedMs / 1000).toFixed(1)}s charged to the task budget` }), el("p", { className: "hint", textContent: `${timing} · ${run.state === "running" || run.recovered ? "Active time incomplete" : `${(run.activeMs / 1000).toFixed(1)}s active`} · ${run.toolCalls} tool ${run.toolCalls === 1 ? "call" : "calls"}${run.stop ? ` · Stop: ${run.stop}` : ""}` }), el("code", { className: "schedule-run-id", textContent: `Run ${run.id} · Input ${run.inputId}` }));
        if (run.review) item.append(el("p", { className: "hint", textContent: `Reviewed by you ${date(run.review.at)} · ${run.review.surfaces.length} saved surfaces · versions recorded` }), el("blockquote", { textContent: run.review.note }));
        if (run.retrievals?.length) item.append(el("details", {}, el("summary", { textContent: "Source retrieval receipts" }), ...run.retrievals.map((read) => el("p", { className: "hint", textContent: `${read.url} · Retrieved ${read.retrievedAt}` }))));
        const usage = el("p", { className: "hint", role: "status" });
        const loadUsage = button("Show usage", async () => {
          loadUsage.disabled = true;
          try {
            const measured = parseRunUsage(await api<unknown>(`/api/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}/usage`));
            usage.textContent = `${measured.requests} recorded model requests · Input ${measured.input ?? "unknown"} tokens · Output ${measured.output ?? "unknown"} tokens · Model API estimate ${measured.estimatedModelUsd === undefined ? "unknown" : `$${measured.estimatedModelUsd.toFixed(6)}`}. Tool/server charges, compute and hosting excluded. Not a spending ceiling.`;
            loadUsage.textContent = "Refresh usage";
          } catch (err) { usage.textContent = `Usage unavailable: ${String(err)}`; }
          finally { loadUsage.disabled = false; }
        });
        loadUsage.classList.add("schedule-run-usage");
        item.append(el("div", { className: "task-controls" }, loadUsage, button("Open FinOps", () => void openSettings("finops"))), usage);
        history.append(item);
      }
      if (!task.runs) history.append(el("p", { className: "hint", textContent: "No runs yet. Waiting for a scheduled time uses no model work." }));
      history.append(el("p", { className: "hint", textContent: "Runs share the live workspace. This history records execution; earlier surface versions are not snapshotted." }));
      main.append(this.section("Run history", history));
      const facts = el("dl", { className: "schedule-facts" });
      for (const [label, value] of [["Result layout", task.resultPolicy?.kind === "research" ? "Criteria + checked source excerpts" : task.resultPolicy?.kind === "comparison" ? "Criteria + named comparison" : "Flexible workspace"], ["Task budget", `${task.runs} / ${task.limits.runs} runs · ${task.budget.modelRequests} / ${task.limits.modelRequests} model requests · ${task.budget.toolCalls} / ${task.limits.toolCalls} tool attempts`], ["Time charged", `${(task.budget.activeMs / 60000).toFixed(2)} / ${task.limits.activeMs / 60000} active minutes (includes unfinished reservations)`], ["Spending", task.spending.kind === "local_only" ? "Local provider only" : task.spending.kind === "api_allowed" ? "Model API charges allowed · no monetary ceiling" : `Required ceiling $${task.spending.usd}`], ["When", scheduleLabel(task.schedule)], ["Timing", task.schedule ? `Once · ${task.schedule.status === "dispatched" ? "Dispatched" : task.schedule.status === "paused" ? "Paused" : "Upcoming"}` : "Started manually"], ["Model", task.model], ["Capabilities", task.integrations.join(", ") || "None selected"], ["Runs", String(task.runs)], ["Created", date(task.created)]]) facts.append(el("dt", { textContent: label }), el("dd", { textContent: value }));
      if (task.resultPolicy?.kind === "comparison" && task.resultPolicy.table) {
        const contract = task.resultPolicy.table;
        facts.append(el("dt", { textContent: "Exact comparison checks" }), el("dd", {}, el("details", {}, el("summary", { textContent: `${contract.rows.length} expected rows · ${contract.criteria ? "submitted criteria with checked calculations" : "fixed declared cells"}` }), el("pre", { textContent: JSON.stringify(contract, null, 2), className: "schedule-contract" }))));
      }
      if (task.resultPolicy?.notices?.length) facts.append(el("dt", { textContent: "Required visible notices" }), el("dd", { textContent: task.resultPolicy.notices.join(" · ") }));
      const aside = el("aside", {}, this.section("At a glance", facts), this.section("Your control", el("p", { textContent: "Each run is bounded. Changes follow your integration permissions, and results wait for your review." }), button("Manage integrations", () => void openSettings("integrations"))));
      if (task.state === "scheduled" || task.state === "paused") {
        const value = new Date(task.schedule!.at); const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        const when = el("input", { type: "datetime-local", value: local, required: true, "aria-label": "New schedule time" });
        const form = el("form", { className: "schedule-reschedule" }, el("label", {}, "New time on this computer", when), el("small", { textContent: Intl.DateTimeFormat().resolvedOptions().timeZone }), el("button", { type: "submit", className: "ghost", textContent: "Save time" }));
        form.addEventListener("submit", (event) => { event.preventDefault(); if (!when.value || !Number.isFinite(new Date(when.value).getTime())) return; void this.mutate(task, "schedule", { operation: "reschedule", revision: task.revision, schedule: { kind: "once", at: new Date(when.value).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, status: "armed", missed: "review" } }); });
        aside.append(this.section("Change the time", form));
      }
      if (task.approval) {
        const approval = task.approval;
        main.prepend(this.section("Your approval is needed", el("strong", { textContent: `${approval.server}: ${approval.title}` }), el("pre", { className: "approval-args", textContent: JSON.stringify(approval.args, null, 2) }), el("div", { className: "task-controls" }, button("Deny", () => void this.mutate(task, "approve", { approval: approval.id, decision: "deny" })), button("Allow once", () => void this.mutate(task, "approve", { approval: approval.id, decision: "allow" }), true))));
      }
      const remove = button("Delete…", async () => {
        this.busy = true;
        try { await this.remove(task); if (!this.summaries.some((s) => s.id === task.id)) this.list(); }
        finally { this.busy = false; }
      }); remove.className = "schedule-delete"; remove.disabled = ["queued", "running", "needs_approval"].includes(task.state);
      aside.append(el("div", { className: "schedule-danger" }, remove, el("small", { textContent: remove.disabled ? "Cancel active work and let it stop before deleting." : "Deletion is scoped and requires confirmation. External changes are kept." })));
      layout.append(main, aside); body.append(layout);
      if (focus) $("schedule-title").focus();
    } catch (err) { if (request === this.request) this.error((err as Error).message); }
  }
  private section(title: string, ...children: HTMLElement[]): HTMLElement { return el("section", { className: "schedule-section" }, el("h2", { textContent: title }), ...children); }
  private async mutate(task: TaskView, operation: "schedule" | "cancel" | "complete" | "approve", body: object): Promise<void> {
    if (this.busy) return; this.busy = true;
    try { await api(`/api/tasks/${encodeURIComponent(task.id)}/${operation}`, { method: "POST", body: JSON.stringify(body) }); }
    catch (err) { this.error((err as Error).message); return; }
    finally { this.busy = false; }
    await this.refresh(); await this.showDetail(task.id, false);
  }

  private async create(template?: typeof TEMPLATES[number]): Promise<void> {
    this.request++; this.view = { kind: "create" };
    const form = $("schedule-compose"); this.formShown = true;
    const body = this.shell("Create a schedule", "Choose what to do, when to begin, and which tools it can use.", () => this.list());
    form.hidden = false; body.append(form);
    $("task-create-cancel").onclick = () => this.list();
    $("task-create-model").textContent = current.model || "Choose a model before saving";
    $("task-manage-integrations").onclick = () => void openSettings("integrations");
    $("task-change-model").onclick = () => void openSettings("models");
    if (template) { $<HTMLTextAreaElement>("task-goal").value = template.goal; $<HTMLTextAreaElement>("task-criteria").value = template.criteria; }
    this.updateTiming();
    this.updateResultLayout();
    $("task-result-layout").onchange = () => this.updateResultLayout();
    this.updateSpending();
    for (const [id, field, divisor] of [["task-budget-runs", "runs", 1], ["task-budget-model", "modelRequests", 1], ["task-budget-tools", "toolCalls", 1], ["task-budget-minutes", "activeMs", 60000]] as const) {
      const input = $<HTMLInputElement>(id); input.max = String(TASK_BUDGET_MAX[field] / divisor);
      if (!input.value) input.value = String(TASK_BUDGET_DEFAULTS[field] / divisor);
    }
    $("task-spending").onchange = () => { $<HTMLInputElement>("task-spending-ack").checked = false; this.updateSpending(); };
    $("schedule-timing").onchange = () => this.updateTiming();
    $("schedule-at").oninput = () => this.updateTiming();
    const generation = ++this.formGeneration;
    $<HTMLFormElement>("task-create-form").onsubmit = (event) => { event.preventDefault(); void this.save(); };
    $<HTMLButtonElement>("task-create-start").disabled = true;
    const choices = $("task-capabilities");
    // Retain explicit choices when returning from settings; newly available tools start unchecked.
    const selected = new Set([...choices.querySelectorAll<HTMLInputElement>("input:checked")].map((c) => c.value));
    try {
      const list = capabilities(await api<unknown>("/api/task-capabilities"));
      if (generation !== this.formGeneration) return;
      choices.replaceChildren(...list.map((c) => {
        const checkbox = el("input", { type: "checkbox", name: "capability", value: c.id, disabled: !c.ready, checked: c.ready && (selected.has(c.id) || !this.formReady && c.id === "time"), "data-free": String(c.free) });
        return el("label", { className: `schedule-capability${c.ready ? "" : " unavailable"}` }, checkbox, el("span", {}, el("strong", { textContent: c.name }), el("small", { textContent: c.ready ? c.summary : "Set up in Integrations" }), el("small", { textContent: c.free ? "No service fee" : "Your server · cost and trust require review" })));
      })); this.formReady = true;
    } catch (err) { $("task-create-error").textContent = (err as Error).message; }
    finally { if (generation === this.formGeneration) $<HTMLButtonElement>("task-create-start").disabled = false; }
    $("task-goal").focus();
  }
  private updateResultLayout(): void {
    const kind = $<HTMLSelectElement>("task-result-layout").value;
    $("task-result-inputs-row").hidden = !kind;
    $("task-result-notices-row").hidden = !kind;
    $("task-comparison-checks-row").hidden = kind !== "comparison";
    $("task-result-inputs-label").textContent = kind === "research" ? "Public source URLs, one per line (up to 8)" : "Option names, one per line (up to 16)";
    $<HTMLTextAreaElement>("task-result-inputs").required = Boolean(kind);
    $("task-result-help").textContent = kind === "research" ? "Select Web pages below. Requires a visible answer, limitations, checked excerpts and retrieval dates. Interpretation needs your review." : kind === "comparison" ? "Requires an editable criteria form and a separate comparison. Optional supplied facts and calculations check values when criteria are submitted." : "Flexible work still needs your evidence review.";
  }

  private updateSpending(): void {
    const allowed = $<HTMLSelectElement>("task-spending").value === "api_allowed";
    $("task-spending-ack-row").hidden = !allowed;
    $<HTMLInputElement>("task-spending-ack").required = allowed;
  }

  private updateTiming(): void {
    const later = $<HTMLSelectElement>("schedule-timing").value === "once";
    $("schedule-date-field").hidden = !later;
    $<HTMLInputElement>("schedule-at").required = later;
    $("schedule-timezone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = new Date($<HTMLInputElement>("schedule-at").value);
    $("schedule-time-preview").textContent = later && Number.isFinite(at.getTime()) ? `Will run once: ${date(at.toISOString())} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : later ? "Choose a future date and time." : "Starts as soon as the execution slot is free.";
    $("task-create-start").textContent = later ? "Save schedule" : "Start now";
    $("task-create-limits").textContent = `${TASK_LIMITS.rounds} model requests · ${TASK_LIMITS.tools} tool calls · ${TASK_LIMITS.activeMs / 60000} active minutes per run`;
  }
  private async save(): Promise<void> {
    if (this.creationBusy || !$<HTMLFormElement>("task-create-form").reportValidity()) return;
    const error = $("task-create-error"); error.textContent = "";
    if (!current.model) { error.textContent = "Choose a model to run this work."; return; }
    const later = $<HTMLSelectElement>("schedule-timing").value === "once";
    const at = new Date($<HTMLInputElement>("schedule-at").value);
    if (later && (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())) { error.textContent = "Choose a future date and time."; return; }
    this.creationBusy = true; $<HTMLButtonElement>("task-create-start").disabled = true;
    try {
      const layout = $<HTMLSelectElement>("task-result-layout").value;
      const entries = $<HTMLTextAreaElement>("task-result-inputs").value.split("\n").map((value) => value.trim()).filter(Boolean);
      const notices = $<HTMLTextAreaElement>("task-result-notices").value.split("\n").map((value) => value.trim()).filter(Boolean);
      const exact = $<HTMLTextAreaElement>("task-comparison-checks").value.trim();
      const resultPolicy = layout ? parseTaskResultPolicy({ kind: layout, ...(layout === "comparison" && exact ? { table: JSON.parse(exact) } : {}), ...(layout === "research" ? { sources: entries } : { labels: entries }), ...(notices.length ? { notices } : {}) }) : undefined;
      const limits = parseTaskLimits({ runs: Number($<HTMLInputElement>("task-budget-runs").value), modelRequests: Number($<HTMLInputElement>("task-budget-model").value), toolCalls: Number($<HTMLInputElement>("task-budget-tools").value), activeMs: Number($<HTMLInputElement>("task-budget-minutes").value) * 60000 });
      const chosen = [...$("task-capabilities").querySelectorAll<HTMLInputElement>("input:checked")];
      const confirmedFree = chosen.filter((c) => c.dataset.free !== "true").map((c) => c.value);
      if (confirmedFree.length && !(await ask("You selected a server you configured. Continue only after checking its source, permissions and that there are no service fees for this work.", "I checked; continue"))) return;
      const task = parseTaskView(await api<unknown>("/api/tasks", { method: "POST", body: JSON.stringify({ goal: $<HTMLTextAreaElement>("task-goal").value, criteria: $<HTMLTextAreaElement>("task-criteria").value, provider: current.provider, model: current.model, ...(resultPolicy ? { resultPolicy } : {}), limits, spending: $<HTMLSelectElement>("task-spending").value === "api_allowed" ? { kind: "api_allowed", acknowledged: $<HTMLInputElement>("task-spending-ack").checked } : { kind: "local_only" }, integrations: chosen.map((c) => c.value), confirmedFree, ...(later ? { schedule: { kind: "once", at: at.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, status: "armed", missed: "review" } } : {}) }) }));
      $<HTMLFormElement>("task-create-form").reset(); this.formReady = false;
      await this.refresh(); await this.showDetail(task.id);
    } catch (err) { error.textContent = (err as Error).message; }
    finally { this.creationBusy = false; $<HTMLButtonElement>("task-create-start").disabled = false; }
  }

  /** Park the composer before changing page content so its unsaved inputs survive navigation. */
  parkComposer(): void {
    if (!this.formShown) return;
    const composer = $("schedule-compose"); composer.hidden = true; $("schedule-parking").append(composer);
  }
}
