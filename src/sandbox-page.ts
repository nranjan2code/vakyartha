// Settings → Sandbox uses the app's actual helper, settings and integration state.
import { api, el } from "./core.ts";
import { icon } from "./icons.ts";
import { group, pill, row, title } from "./ui.ts";
import { realmSettings } from "./sandbox-realms-page.ts";
import { pickFolder, sandboxFolder, setSandboxFolder } from "./backend.ts";
import type { SandboxStatus } from "../shared/sandbox.ts";

export async function sandboxPage(openIntegration: () => void, openSkill: () => void): Promise<HTMLElement[]> {
  const root = el("div", { className: "sandbox-layout" });
  const load = async (): Promise<SandboxStatus> => {
    const [worker, folder] = await Promise.all([api<Omit<SandboxStatus, "workspace">>("/api/sandbox"), sandboxFolder().catch(() => null)]);
    return { ...worker, workspace: { path: folder ?? "", valid: Boolean(folder), error: worker.native ? undefined : "Command execution needs the desktop app." } };
  };
  let status = await load();
  let saved = status.workspace.path;
  const notice = el("p", { className: "settings-feedback", role: "status", "aria-live": "polite" });
  const report = (message: string, error = false) => { notice.textContent = message; notice.classList.toggle("bad", error); };
  const button = (label: string, action: () => void, primary = false) => el("button", { type: "button", className: `${primary ? "primary" : "ghost"} small`, textContent: label, onclick: action });
  const health = el("div", { className: "sandbox-health", role: "status" });
  const helperDetails = el("div");
  const workspace = el("input", { id: "sandbox-workspace", type: "text", value: saved, placeholder: "/Users/you/Projects/example", spellcheck: false, autocomplete: "off", "aria-describedby": "sandbox-workspace-hint", className: "flex-1" });
  const browseBtn = el("button", { type: "button", className: "ghost small workspace-browse-btn", title: "Choose folder in Finder" }, icon("folder", 14), el("span", { textContent: "Choose…" }));
  browseBtn.addEventListener("click", async () => {
    const chosen = await pickFolder();
    if (chosen) {
      workspace.value = chosen;
      workspace.removeAttribute("aria-invalid");
      updateDraft();
    }
  });
  const workspaceField = el("div", { className: "field-line" }, workspace, browseBtn);
  const save = el("button", { type: "submit", className: "primary small", textContent: "Save folder", disabled: true });
  const reset = button("Discard", () => { workspace.value = saved; workspace.removeAttribute("aria-invalid"); updateDraft(); });
  const updateDraft = () => { save.disabled = workspace.value.trim() === saved; reset.hidden = save.disabled; };
  workspace.addEventListener("input", updateDraft);
  updateDraft();
  const form = el("form", { className: "sandbox-workspace-form" },
    el("label", { htmlFor: "sandbox-workspace", className: "row-label", textContent: "Project folder" }),
    el("p", { id: "sandbox-workspace-hint", className: "row-hint", textContent: "Used when a chat has no folder of its own. Each run uses a fresh copy; Realms keep a separate copy across commands." }),
    workspaceField, el("div", { className: "row-actions" }, save, reset));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = workspace.value.trim();
    save.disabled = true; workspace.disabled = true; reset.disabled = true;
    try {
      const stored = (await setSandboxFolder(value || null)) ?? "";
      saved = stored; workspace.value = stored; workspace.removeAttribute("aria-invalid");
      report(value ? "Folder saved. The next command uses a fresh copy." : "Folder cleared. Command execution needs a project folder.");
      await refresh().catch(error => report(`Folder saved, but status could not refresh: ${error.message}`, true));
    } catch (error) { workspace.setAttribute("aria-invalid", "true"); report((error as Error).message, true); }
    finally { workspace.disabled = false; reset.disabled = false; updateDraft(); }
  });
  const execution = el("div");
  const testOutput = el("pre", { className: "skill-body sandbox-test-output", role: "status", hidden: true });
  const test = button("Run test command", () => {
    test.disabled = true; testOutput.hidden = false; testOutput.textContent = "Running in a disposable project copy…";
    void api<{ text: string; isError: boolean }>("/api/integrations/sandbox-execution/test", { method: "POST", body: JSON.stringify({ tool: "run_command", args: { command: "/usr/bin/printf", args: ["Sandbox command completed\n"] } }) })
      .then(result => { testOutput.textContent = result.text; testOutput.classList.toggle("bad", result.isError); })
      .catch(error => { testOutput.textContent = error.message; testOutput.classList.add("bad"); })
      .finally(() => { test.disabled = false; });
  });
  const check = button("Refresh status", () => {
    check.disabled = true;
    void refresh().then(() => report("Status refreshed. No project command was run.")).catch(error => report(error.message, true)).finally(() => { check.disabled = false; });
  });
  function paint(): void {
    const ready = status.native && status.platform === "darwin" && status.helper.available && status.helper.compatible && status.workspace.valid && status.execution.enabled && status.execution.status === "ready" && status.execution.policy !== "off";
    test.disabled = !ready;
    const headline = !status.native ? "Command execution needs the desktop app" : status.platform !== "darwin" ? "Command isolation needs macOS" : !status.helper.available ? "Sandbox helper unavailable" : !status.helper.compatible ? "Sandbox helper needs an update" : !status.workspace.valid ? "Choose a project to get started" : !status.execution.enabled ? "Enable sandboxed execution" : status.execution.policy === "off" ? "Command tool is off" : ready ? "Ready for isolated commands" : "Execution needs attention";
    const detail = status.helper.available && !status.helper.compatible ? status.helper.error! : !status.helper.available ? "Commands fail closed until the helper is rebuilt or reinstalled." : ready ? "Commands run in isolated copies with network denied. Use a Realm to keep changes across runs." : "Finish the setup below. Enabling a skill does not grant tool access.";
    health.replaceChildren(el("div", { className: "sandbox-health-icon" }, icon("shield", 24)), el("div", {}, el("h2", { textContent: headline }), el("p", { className: "row-hint", textContent: detail })), pill(ready ? "Ready" : "Needs attention", ready ? "ok" : ""));
    execution.replaceChildren(row("Sandboxed execution", `Integration ${status.execution.enabled ? "on" : "off"} · run_command policy: ${status.execution.policy === "ask" ? "Ask before running" : status.execution.policy === "allow" ? "Allowed without asking" : "Blocked"}.`, button("Manage tool & approvals", openIntegration)), row("Sandbox skill", "Guides command planning and error recovery. Instructions use the same governed execution tool.", button("Open skill", openSkill)));
    helperDetails.replaceChildren(row("Helper", status.helper.error ?? status.helper.version ?? "Unavailable", pill(status.helper.compatible ? "Compatible" : status.helper.available ? "Outdated" : "Missing", status.helper.compatible ? "ok" : "bad")), row("Helper location", status.helper.path), row("Project folder", status.workspace.error ?? status.workspace.path, pill(status.workspace.valid ? "Accessible" : "Not configured", status.workspace.valid ? "ok" : "")));
  }

  const realms = realmSettings(() => status);
  async function refresh(): Promise<void> { status = await load(); paint(); realms.dispatchEvent(new Event("sandbox:refresh")); }
  root.append(...title("Sandbox", "Control where local commands run and inspect the protection available on this computer."), health,
    group("Execution settings", form), notice,
    group("Connected capabilities", execution, el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: "Run a fixed printf command to check the full execution path. This copies the configured project and records the result in the integration log." }), el("div", { className: "row-actions" }, test), testOutput)),
    realms,
    group("Command boundaries", el("div", { className: "sandbox-boundaries" },
      ...[["globe", "Network denied", "Commands cannot connect to the internet."], ["folder", "Isolated files", "Commands write to copies. Only reviewed promotion changes the project. Check for sensitive files beyond the common credential exclusions."], ["key", "Minimal environment", "No provider keys or app environment are passed to commands."], ["clock", "Bounded runs", "30 seconds · 32 KiB output · 512 MiB / 50,000 files per snapshot."]].map(([glyph, label, hint]) => el("div", { className: "sandbox-boundary" }, icon(glyph!, 18), el("div", {}, el("strong", { textContent: label }), el("p", { className: "row-hint", textContent: hint })))))),
    el("details", { className: "sandbox-diagnostics" }, el("summary", { textContent: "Runtime details" }), helperDetails, el("div", { className: "row-actions" }, check, el("a", { href: "https://github.com/nranjan2code/sandbox", target: "_blank", rel: "noreferrer", textContent: "Sandbox documentation ↗" }))));
  paint();
  return [root];
}
