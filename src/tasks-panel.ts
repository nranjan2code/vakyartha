import { TASK_LABELS, TASK_LIMITS, parseTaskSummaries, parseTaskView, taskObject, taskString, type TaskSummary, type TaskView } from "../task-contract.ts";
import { $, api, ask, el } from "./core.ts";
import { current } from "./models.ts";
import { openSettings } from "./settings.ts";

interface Capability { id: string; name: string; summary: string; ready: boolean; free: boolean; access: string[] }
type Command = { kind: "cancel" } | { kind: "complete" } | { kind: "approve"; approval: string; decision: "allow" | "deny" };
function parseCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid capability list");
  return value.map((item: unknown) => {
    const raw = taskObject(item);
    if (!Array.isArray(raw.access) || raw.access.length > 32) throw new Error("Invalid capability access");
    return { id: taskString(raw.id, 120), name: taskString(raw.name, 240), summary: taskString(raw.summary, 2000), ready: raw.ready === true, free: raw.free === true, access: raw.access.map((v: unknown) => taskString(v, 2000)) };
  });
}

/** Task controls use the existing conversation and canvas; no surface copies live here. */
export class TasksPanel {
  private summaries: TaskSummary[] = [];
  private selected?: TaskView;
  private session: () => string;
  private open: (session: string) => Promise<void>;
  private loading = false;
  private drawn = "";
  private listDrawn = "";

  constructor(session: () => string, open: (session: string) => Promise<void>) {
    this.session = session; this.open = open;
    $("open-tasks").addEventListener("click", () => {
      $("task-list").hidden = !$("task-list").hidden;
      $("open-tasks").setAttribute("aria-expanded", String(!$("task-list").hidden));
      void this.refresh();
    });
    $("new-task").addEventListener("click", () => void this.create());
    $("task-create-cancel").addEventListener("click", () => $<HTMLDialogElement>("task-create").close());
    setInterval(() => {
      if (!$("task-list").hidden || this.owns(this.session())) void this.refresh();
    }, 2000);
  }

  owns(session: string): boolean { return this.summaries.some((t) => t.session === session); }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.summaries = parseTaskSummaries(await api<unknown>("/api/tasks"));
      const list = $("task-items");
      const listKey = `${this.session()}:${JSON.stringify(this.summaries)}`;
      if (listKey !== this.listDrawn) {
        this.listDrawn = listKey;
        list.replaceChildren(...this.summaries.map((t) => {
          const button = el("button", { type: "button", className: "task-link", "data-task": t.id, "aria-current": String(t.session === this.session()) }, el("span", { textContent: t.goal }), el("small", { textContent: TASK_LABELS[t.state] }));
          button.addEventListener("click", () => void this.open(t.session).catch((err) => this.error((err as Error).message)));
          return button;
        }));
        if (!this.summaries.length) list.append(el("p", { className: "hint", textContent: "Give a task a goal and a clear finish line. Its interfaces stay interactive as work progresses." }));
      }
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
      const complete = el("button", { type: "button", className: "primary small", textContent: "Mark complete" });
      complete.addEventListener("click", async () => {
        if (await ask(`Does the saved result meet these criteria?\n\n${t.criteria}`, "Mark complete")) await this.command({ kind: "complete" });
      });
      controls.append(complete);
    }
    if (["queued", "running", "needs_approval"].includes(t.state)) {
      const cancel = el("button", { type: "button", className: "ghost small", textContent: "Cancel task" });
      cancel.addEventListener("click", () => void this.command({ kind: "cancel" })); controls.append(cancel);
    }
    const remove = el("button", { type: "button", className: "ghost small", textContent: "Delete task", disabled: ["queued", "running", "needs_approval"].includes(t.state), title: "Stop active work before deleting its record" });
    remove.addEventListener("click", async () => {
      if (!(await ask(`Delete “${t.goal.slice(0, 120)}”? This removes its conversation, drafts and raw diagnostic transcript. External changes, shared memory, integrations, credentials, integration logs and numeric usage records are kept.`, "Delete task"))) return;
      let confirmUncertain = false;
      if (t.operations.some((op) => op.state === "uncertain" || op.state === "started")) {
        confirmUncertain = await ask("Some external effects are uncertain. Deleting this task removes the recovery record, but cannot undo those effects. Review the affected service or files before proceeding.", "Delete recovery record");
        if (!confirmUncertain) return;
      }
      try {
        await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: "DELETE", body: JSON.stringify({ revision: t.revision, confirmUncertain }) });
        window.dispatchEvent(new CustomEvent("vak:task-deleted", { detail: t.id }));
        await this.refresh();
      } catch (err) { this.error((err as Error).message); }
    });
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
    let reconciled = false;
    if (detail.operations.some((op) => op.state === "uncertain")) {
      reconciled = await ask("Some operations may already have happened. Check the connected service or files first. Continue only after reviewing their effects.", "I checked; continue");
      if (!reconciled) throw new Error("Review uncertain operations before continuing");
    }
    await api(`/api/tasks/${encodeURIComponent(id)}/input`, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), message, action, revision, reconciled }) });
    await this.refresh();
  }

  private async create(): Promise<void> {
    if (!current.model) return void openSettings("models");
    const dialog = $<HTMLDialogElement>("task-create"), form = $<HTMLFormElement>("task-create-form");
    const error = $("task-create-error"); error.textContent = "";
    $("task-create-model").textContent = `Model: ${current.model}. Task work runs while this app and computer remain running.`;
    const capabilities = $("task-capabilities"); capabilities.replaceChildren();
    try {
      const list = parseCapabilities(await api<unknown>("/api/task-capabilities"));
      for (const c of list) {
        const checkbox = el("input", { type: "checkbox", value: c.id, name: "capability", disabled: !c.ready, checked: c.id === "time" && c.ready, "data-free": String(c.free) });
        capabilities.append(el("label", { className: "task-capability" }, checkbox, el("span", {}, el("strong", { textContent: c.name }), el("small", { textContent: c.ready ? `${c.summary}${c.free ? " · No service fee" : " · Your server: trust and cost not verified"}` : "Set up in Integrations before selecting" }), el("small", { textContent: c.access.join(" · ") }))));
      }
    } catch (err) { error.textContent = (err as Error).message; }
    const goSettings = (section: "integrations" | "models") => () => { dialog.close(); void openSettings(section); };
    $("task-manage-integrations").onclick = goSettings("integrations");
    $("task-change-model").onclick = goSettings("models");
    $("task-create-limits").textContent = `Per run: ${TASK_LIMITS.rounds} model rounds, ${TASK_LIMITS.tools} tool calls, ${TASK_LIMITS.activeMs / 60000} active minutes. Results require your review. Tool access is limited to your selection and integration policies.`;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = $<HTMLButtonElement>("task-create-start"); button.disabled = true;
      try {
        const chosen = [...capabilities.querySelectorAll<HTMLInputElement>("input:checked")];
        const confirmedFree = chosen.filter((c) => c.dataset.free !== "true").map((c) => c.value);
        if (confirmedFree.length && !(await ask("You selected a server you configured. Its publisher, execution permissions and service costs have not been verified by the app. Continue only after checking that it is trusted and has no service fees for this task.", "I checked; continue"))) return;
        const t = parseTaskView(await api<unknown>("/api/tasks", { method: "POST", body: JSON.stringify({ goal: $<HTMLTextAreaElement>("task-goal").value, criteria: $<HTMLTextAreaElement>("task-criteria").value, provider: current.provider, model: current.model, integrations: chosen.map((c) => c.value), confirmedFree }) }));
        dialog.close(); form.reset(); $("task-list").hidden = false;
        await this.refresh(); await this.open(t.session);
      } catch (err) { error.textContent = (err as Error).message; }
      finally { button.disabled = false; }
    };
    dialog.showModal(); $<HTMLTextAreaElement>("task-goal").focus();
  }
}
