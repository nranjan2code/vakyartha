import { TASK_LABELS, parseTaskSummaries, parseTaskView, type TaskSummary, type TaskView } from "../task-contract.ts";
import { $, api, ask, el } from "./core.ts";
import { SchedulePage } from "./schedule-page.ts";

type Command = { kind: "cancel" } | { kind: "approve"; approval: string; decision: "allow" | "deny" };

/** Task controls use the existing conversation and canvas; no surface copies live here. */
export class TasksPanel {
  private summaries: TaskSummary[] = [];
  private selected?: TaskView;
  private session: () => string;
  private open: (session: string) => Promise<void>;
  private loading = false;
  private drawn = "";
  readonly page: SchedulePage;

  constructor(session: () => string, open: (session: string) => Promise<void>, beforeOpen: () => void, toggleSidebar: () => void) {
    this.session = session; this.open = open;
    this.page = new SchedulePage({ navigate: open, refresh: () => this.refresh(), remove: (t) => this.remove(t), beforeOpen, toggleSidebar });
    setInterval(() => {
      if (this.page.visible() || this.owns(this.session())) void this.refresh();
    }, 2000);
  }

  owns(session: string): boolean { return this.summaries.some((t) => t.session === session); }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.summaries = parseTaskSummaries(await api<unknown>("/api/tasks"));
      this.page.update(this.summaries);
      const summary = this.summaries.find((t) => t.session === this.session());
      if (!summary) this.selected = undefined;
      else if (this.selected?.id !== summary.id || this.selected.revision !== summary.revision) {
        const selected = parseTaskView(await api<unknown>(`/api/tasks/${encodeURIComponent(summary.id)}`));
        if (selected.session !== this.session()) return;
        this.selected = selected;
      }
      this.draw();
    } catch (err) { this.error((err as Error).message); }
    finally { this.loading = false; }
  }

  selectionChanged(): void {
    if (this.selected?.session !== this.session()) {
      this.selected = undefined; this.drawn = ""; $("task-bar").hidden = true;
      $("task-error").hidden = true;
    }
    void this.refresh();
  }

  private draw(): void {
    const bar = $("task-bar"), t = this.selected;
    bar.hidden = !t;
    if (!t) { this.drawn = ""; return; }
    const key = `${t.id}:${t.revision}`;
    if (this.drawn === key) return;
    // Do not replace an approval button or details panel while the person is reading it.
    const expanded = bar.querySelector("details")?.open;
    this.drawn = key;
    const status = el("span", { className: `task-state ${t.state}`, role: "status", textContent: TASK_LABELS[t.state] });
    const details = el("details", { open: Boolean(expanded) }, el("summary", { textContent: "Task details and activity" }), el("p", { textContent: t.goal }), el("p", {}, el("strong", { textContent: "Complete when: " }), t.criteria), el("p", { className: "hint", textContent: `${t.model} · ${t.runs} runs · ${t.pending.length} queued inputs` }), el("ol", {}, ...t.activity.slice(-8).map((a) => el("li", { textContent: a.text }))));
    const controls = el("div", { className: "task-controls" });
    if (t.state === "needs_input") {
      const complete = el("button", { type: "button", className: "primary small", textContent: "Review result" });
      complete.addEventListener("click", () => void this.page.reviewResult(t.id));
      controls.append(complete);
    }
    if (["queued", "running", "needs_approval"].includes(t.state)) {
      const cancel = el("button", { type: "button", className: "ghost small", textContent: "Cancel task" });
      cancel.addEventListener("click", () => void this.command({ kind: "cancel" })); controls.append(cancel);
    }
    const remove = el("button", { type: "button", className: "ghost small", textContent: "Delete…", disabled: ["queued", "running", "needs_approval"].includes(t.state), title: "Stop active work before deleting its record" });
    remove.addEventListener("click", () => void this.remove(t));
    controls.append(remove);
    bar.replaceChildren(el("div", { className: "task-heading" }, status, controls), el("p", { className: "task-note", textContent: t.note }), details);
    if (t.approval) {
      const approval = t.approval;
      const buttons = el("div", { className: "task-controls" });
      for (const [label, decision] of [["Deny", "deny"], ["Allow once", "allow"]] as const) {
        const b = el("button", { type: "button", className: decision === "allow" ? "primary small" : "ghost small", textContent: label });
        b.addEventListener("click", () => void this.command({ kind: "approve", approval: approval.id, decision })); buttons.append(b);
      }
      bar.append(el("section", { className: "approval", "aria-label": "Task permission request" }, el("strong", { textContent: `${approval.server}: ${approval.title}` }), el("p", { textContent: "Only this exact request will be allowed. All arguments are shown below." }), el("pre", { className: "approval-args", textContent: JSON.stringify(approval.args, null, 2) }), buttons));
    }
  }

  error(message: string): void {
    this.page.error(message);
    $("task-error").textContent = message;
    $("task-error").hidden = false;
  }

  private async command(command: Command): Promise<void> {
    if (!this.selected) return;
    try {
      $("task-error").hidden = true;
      await api(`/api/tasks/${encodeURIComponent(this.selected.id)}/${command.kind}`, { method: "POST", body: JSON.stringify(command) });
      await this.refresh();
    } catch (err) { this.error((err as Error).message); }
  }

  async input(message?: string, action?: { surface: string; source: string; data: Record<string, unknown> }, revision?: number): Promise<void> {
    const id = this.session();
    if (!this.owns(id)) throw new Error("No selected task");
    const detail = parseTaskView(await api<unknown>(`/api/tasks/${encodeURIComponent(id)}`));
    const uncertain = detail.operations.filter((op) => op.state === "uncertain");
    let reconciliation: { revision: number; operationIds: string[]; note: string } | undefined;
    if (uncertain.length) {
      const note = el("textarea", { required: true, minLength: 12, maxLength: 1000, rows: 4, "aria-label": "What did you check?" });
      const dialog = el("dialog", { className: "schedule-reconcile", "aria-label": "Review uncertain operations" });
      const form = el("form", { method: "dialog" }, el("h2", { textContent: "Review uncertain operations" }), el("p", { textContent: "Check the affected service or files. Record what happened before continuing. This records your review; it does not repeat an operation or verify its meaning automatically." }), ...uncertain.map((op) => el("label", {}, el("input", { type: "checkbox", required: true }), `${op.tool} · ${op.id}`)), el("label", {}, "What did you check?", note), el("div", { className: "task-controls" }, el("button", { value: "cancel", formNoValidate: true, textContent: "Cancel" }), el("button", { value: "reviewed", textContent: "Record review and continue" })));
      dialog.append(form); document.body.append(dialog); dialog.showModal();
      const confirmed = await new Promise<boolean>((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "reviewed"), { once: true }));
      const checked = note.value.trim(); dialog.remove();
      if (!confirmed) throw new Error("Review uncertain operations before continuing");
      reconciliation = { revision: detail.revision, operationIds: uncertain.map((op) => op.id), note: checked };
    }
    await api(`/api/tasks/${encodeURIComponent(id)}/input`, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), message, action, revision, ...(reconciliation ? { reconciliation } : {}) }) });
    await this.refresh();
  }

  private async remove(t: TaskView): Promise<void> {
    if (!(await ask(`Delete “${t.goal.slice(0, 120)}”? This removes its conversation, drafts, input snapshots, local task output files and raw diagnostic transcript. Downloaded copies, external changes, shared memory, integrations, credentials, integration logs and numeric usage records are kept.`, "Delete"))) return;
    let confirmUncertain = false;
    if (t.operations.some((op) => op.state === "uncertain" || op.state === "started")) {
      confirmUncertain = await ask("Some external effects are uncertain. Deleting removes the recovery record, but cannot undo those effects. Review the affected service or files first.", "Delete recovery record");
      if (!confirmUncertain) return;
    }
    try {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: "DELETE", body: JSON.stringify({ revision: t.revision, confirmUncertain }) });
      window.dispatchEvent(new CustomEvent("vak:task-deleted", { detail: t.id }));
      await this.refresh();
    } catch (err) { this.error((err as Error).message); }
  }
}
