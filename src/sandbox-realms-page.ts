import { api, ask, el } from "./core.ts";
import { group, pill, row } from "./ui.ts";
import type { SandboxStatus } from "../shared/sandbox.ts";
import type { RealmReview, RealmSummary } from "../sidecar/sandbox-realms.ts";

type Receipt = { transaction_id: string; paths: string[]; phase: string };
type Status = { realm: RealmSummary; ready: boolean; change_count: number | null; recovery_paths: string[]; last_receipt?: Receipt | null };
export function realmSettings(getStatus: () => SandboxStatus): HTMLElement {
  const list = el("div", { className: "realm-list" });
  const feedback = el("p", { className: "settings-feedback", role: "status" });
  const detail = el("div");
  const button = (label: string, action: () => Promise<void>, primary = false) => {
    const b = el("button", { type: "button", className: `${primary ? "primary" : "ghost"} small`, textContent: label });
    b.addEventListener("click", async () => { b.disabled = true; feedback.textContent = ""; try { await action(); } catch (error) { feedback.textContent = (error as Error).message; feedback.classList.add("bad"); } finally { b.disabled = false; } });
    return b;
  };
  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await api<{ text: string; isError: boolean }>("/api/integrations/sandbox-execution/test", { method: "POST", body: JSON.stringify({ tool, args }) });
    if (result.isError) throw new Error(result.text);
    try { return JSON.parse(result.text) as T; } catch { throw new Error("The Realm receipt could not be read. Refresh its status before continuing."); }
  }
  const create = button("Create Realm", async () => {
    const realm = await call<RealmSummary>("create_realm");
    feedback.classList.remove("bad"); feedback.textContent = "Workspace created. Agent commands can keep changes in this copy across calls.";
    await refresh(); await inspect(realm.realm_id);
  }, true);
  const reload = button("Refresh workspaces", async () => { await refresh(); });
  async function refresh(): Promise<void> {
    const status = getStatus();
    create.disabled = !status.enabled || !status.helper.realms || !status.workspace.valid || !status.execution.enabled;
    if (!status.helper.realms) { list.replaceChildren(el("p", { className: "row-hint", textContent: "The sandbox helper needs the Realm lifecycle commands. Rebuild or reinstall it to use retained workspaces." })); return; }
    const realms = await call<RealmSummary[]>("list_realms");
    list.replaceChildren(...realms.map(realm => row(realm.realm_id, `${realm.status} · ${realm.base_path ?? "No original project"}`, button("Inspect workspace", () => inspect(realm.realm_id)))));
    if (!realms.length) list.append(el("p", { className: "row-hint realm-empty", textContent: "No retained workspaces. Create a Realm for work that needs several command runs and reviewed changes." }));
  }
  async function inspect(realmId: string): Promise<void> {
    const status = await call<Status>("realm_status", { realmId });
    const workspace = status.realm;
    const changes = el("div", { className: "realm-changes" });
    const result = el("p", { className: "settings-feedback", role: "status" });
    const actions = el("div", { className: "row-actions" });
    const review = button("Review changes", async () => {
      let snapshot = await call<RealmReview>("snapshot_realm", { realmId });
      const all = [...snapshot.changes];
      while (all.length < snapshot.total && snapshot.total <= 200) {
        const next = await call<RealmReview>("snapshot_realm", { realmId, offset: snapshot.next_offset });
        if (next.fingerprint !== snapshot.fingerprint || next.next_offset <= snapshot.next_offset) throw new Error("Workspace changed during review. Review again.");
        all.push(...next.changes); snapshot = next;
      }
      const fingerprint = snapshot.fingerprint, paths = all.map(change => change.path);
      changes.replaceChildren(el("p", { className: "row-hint", textContent: `${snapshot.total} changed paths · ${snapshot.can_promote ? "Ready for review" : "Promotion unavailable: check conflicts, blocked paths, interrupted state or the 200-path limit"}` }));
      for (const change of all) {
        const content = el("div");
        const file = el("details", { className: "skill-file" }, el("summary", {}, el("code", { textContent: change.path }), pill(change.conflict ? "Conflict" : change.blocked ? "Blocked" : !change.before ? "Added" : !change.after ? "Deleted" : "Changed", change.conflict || change.blocked ? "bad" : "")), content);
        file.addEventListener("toggle", async () => {
          if (!file.open || content.childNodes.length) return;
          content.className = "skill-file-content";
          try {
            for (const [label, version, original] of [["Original", change.before, true], ["Candidate", change.after, false]] as const) {
              content.append(el("h3", { textContent: label }));
              if (!version) { content.append(el("p", { className: "row-hint", textContent: "Not present" })); continue; }
              if (version.kind === "directory") { content.append(el("p", { className: "row-hint", textContent: "Directory" })); continue; }
              const data = await call<{ text: string; lossy: boolean; next_offset: number; version: { hash: string; mode: number } }>("read_realm_file", { realmId, path: change.path, original });
              if (data.version.hash !== version.hash || data.version.mode !== version.mode) throw new Error("File changed after review. Refresh the review before applying changes.");
              content.append(el("p", { className: "row-hint", textContent: `${version.bytes} bytes · SHA-256 ${version.hash}${data.lossy ? " · Lossy preview" : ""}${data.next_offset < version.bytes ? " · First 16 KiB only; use the file-read tool for the remaining bytes" : ""}` }), el("pre", { className: "skill-body", textContent: data.text }));
            }
          } catch (error) { content.replaceChildren(el("p", { className: "settings-feedback bad", role: "alert", textContent: (error as Error).message })); }
        });
        changes.append(file);
      }
      const apply = button("Apply reviewed changes", async () => {
        if (!await ask(`Apply these changes to ${workspace.base_path}?\n\n${paths.join("\n")}\n\nThe current review fingerprint must still match.`, "Apply changes")) return;
        const receipt = await call<Receipt>("promote_realm", { realmId, fingerprint, paths });
        await refresh(); await inspect(realmId); feedback.textContent = `Applied ${receipt.paths.length} paths. Receipt: ${receipt.transaction_id}`;
      }, true);
      apply.disabled = !snapshot.can_promote || all.length !== snapshot.total || !getStatus().enabled;
      changes.append(el("div", { className: "row-actions" }, apply));
    });
    const discard = button("Discard workspace", async () => {
      if (!await ask(`Delete Realm ${realmId} and its unpromoted changes? This does not undo earlier promotions.`, "Discard workspace")) return;
      await call("destroy_realm", { realmId }); detail.replaceChildren(); await refresh();
    });
    const recovery = button("Recover interrupted work", async () => {
      if (!await ask(`Recover this Realm from its durable journal? Interrupted promotions are rolled back. No command is replayed.\n\n${status.recovery_paths.join("\n")}`, "Recover")) return;
      await call("recover_realm", { realmId, paths: status.recovery_paths }); await refresh(); await inspect(realmId);
    });
    actions.append(review, ...(!status.ready ? [recovery] : []));
    if (workspace.last_transaction) actions.append(button("Undo last promotion", async () => {
      if (!await ask(`Undo promotion ${workspace.last_transaction} for ${workspace.base_path}? Later project edits cause refusal.\n\n${status.last_receipt?.paths.join("\n") ?? ""}`, "Undo promotion")) return;
      await call("rollback_realm", { realmId, transactionId: workspace.last_transaction, paths: status.last_receipt?.paths ?? [] }); await refresh(); await inspect(realmId);
    }));
    actions.append(discard);
    detail.replaceChildren(el("div", { className: "realm-detail" }, el("h3", { textContent: "Workspace details" }), el("code", { textContent: realmId }), el("p", { className: "row-hint", textContent: `${workspace.base_path} · ${status.change_count ?? "Unknown"} changed paths · ${status.ready ? "Ready" : "Needs recovery"}` }), el("p", { className: "row-hint", textContent: "Agents use run_in_realm with this ID to continue work. Changes stay in the copy until promotion is approved. Review file contents before applying them." }), actions, result, changes));
  }
  const root = group("Retained workspaces · Realms", el("div", { className: "realm-manager" }, el("p", { className: "row-hint", textContent: "Keep an isolated project copy across commands. Inspect changes, apply a reviewed version, undo a promotion, or discard the copy." }), el("div", { className: "row-actions" }, create, reload), feedback, list, detail));
  void refresh().catch(error => { feedback.textContent = error.message; feedback.classList.add("bad"); });
  root.addEventListener("sandbox:refresh", () => { void refresh().catch(error => { feedback.textContent = error.message; }); });
  return root;
}
