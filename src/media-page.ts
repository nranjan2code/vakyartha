import { basicCatalog, SurfaceStore, type SurfaceSnapshot } from "@vak/core";
import type { VakSurfaceElement } from "@vak/web";
import { MEDIA_OPERATIONS, mediaSelection, type MediaAsset, type MediaJob, type MediaKind, type MediaView } from "../shared/media.ts";
import { api, ask, el, engine } from "./core.ts";
import { group, row, select } from "./ui.ts";
import { resolveMedia } from "./media.ts";

let timer: ReturnType<typeof setTimeout> | undefined;
export function disposeMediaPage(): void { clearTimeout(timer); document.querySelectorAll<VakSurfaceElement>(".media-result-surface vak-surface").forEach((s) => s.pauseMedia()); }

async function fileLink(a: MediaAsset, button: HTMLButtonElement, note: HTMLElement): Promise<void> {
  button.disabled = true;
  try {
    const { url, token } = engine();
    const res = await fetch(`${url}/api/media/assets/${a.id}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("The file is no longer available");
    const blob = URL.createObjectURL(await res.blob());
    const link = el("a", { href: blob, download: a.name }); link.click();
    setTimeout(() => URL.revokeObjectURL(blob), 30_000);
  } catch (err) { note.textContent = (err as Error).message; }
  finally { button.disabled = false; }
}
export async function mediaSetup(kind: MediaKind, config: Record<string, unknown>, save: (config: Record<string, string>) => Promise<unknown>): Promise<HTMLElement[]> {
  const view = await api<MediaView>(`/api/media/${kind}`);
  const note = el("p", { className: "row-hint bad", role: "status" });
  const rows = Object.entries(MEDIA_OPERATIONS[kind]).map(([operation, label]) => {
    const choices = view.models.filter((m) => m.operations.includes(operation as never));
    const current = choices.find((m) => mediaSelection(m) === config[operation]);
    const modelBox = el("span", { className: "media-model-choice" });
    const hint = el("p", { className: "row-hint" });
    let model = current?.model ?? "";
    let provider = current?.provider ?? "";
    const paint = () => {
      const models = choices.filter((m) => m.provider === provider);
      if (!models.some((m) => m.model === model)) model = models[0]?.model ?? "";
      const updateHint = () => {
        const selected = models.find((m) => m.model === model);
        const p = view.providers.find((p) => p.id === provider);
        const setup = selected?.local ? "Runs on this Mac using the existing Voice setup." : provider && !p?.available ? "Add its shared key in Settings → Providers, then return here." : provider ? "Hosted work sends the approved inputs to this provider and is billed. Tool charges are separate from chat tokens." : "Off: this operation is not offered to the model.";
        hint.textContent = [selected?.note, setup].filter(Boolean).join(" ");
      };
      modelBox.replaceChildren(select(models.map((m) => [m.model, m.label]), model, (value) => { model = value; updateHint(); }));
      modelBox.querySelector("select")!.setAttribute("aria-label", `${label}: model`);
      if (provider === "") modelBox.replaceChildren();
      updateHint();
    };
    const providers = [...new Set(choices.map((m) => m.provider))];
    const providerSelect = select([["", "Off"], ...providers.map((id) => [id, view.providers.find((p) => p.id === id)?.label ?? id] as [string, string])], provider, (value) => { provider = value; paint(); });
    providerSelect.setAttribute("aria-label", `${label}: provider`);
    const use = el("button", { type: "button", className: "primary small", textContent: "Save selection" });
    use.addEventListener("click", async () => { use.disabled = true; note.textContent = ""; try { await save({ [operation]: provider ? mediaSelection({ provider, model }) : "" }); } catch (err) { note.textContent = (err as Error).message; use.disabled = false; } });
    paint();
    return el("div", { className: "row stack" }, el("div", { className: "row-label", textContent: label }), el("div", { className: "row-actions media-selection" }, providerSelect, modelBox, use), hint);
  });
  const keyLink = el("button", { className: "link", type: "button", textContent: "Manage shared provider keys →", onclick: () => window.dispatchEvent(new Event("vak:media-providers")) });
  return [group("Provider and model for each tool", ...rows, row("Shared credentials", "The same provider key is used for chat, Voice and media. No plugin-specific key copies.", keyLink)), note];
}

interface JobView { jobs: MediaJob[]; assets: MediaAsset[]; projections: Record<string, SurfaceSnapshot> }
export function mediaResults(kind: MediaKind): HTMLElement {
  const note = el("p", { className: "row-hint bad", role: "status" });
  const results = el("div");
  const imports = el("div");
  const pick = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/flac,audio/ogg,video/mp4,video/webm", "aria-label": "Import reference media" });
  const importButton = el("button", { className: "ghost small", type: "button", textContent: "Import reference" });
  importButton.addEventListener("click", async () => {
    const file = pick.files?.[0]; if (!file) return;
    if (file.size > 20_000_000) { note.textContent = "Reference files are limited to 20 MB."; return; }
    importButton.disabled = true;
    try {
      const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]!); r.onerror = () => reject(new Error("Could not read this file")); r.readAsDataURL(file); });
      await api("/api/media/import", { method: "POST", body: JSON.stringify({ name: file.name.slice(0, 160), data }) }); pick.value = ""; await refresh();
    } catch (err) { note.textContent = (err as Error).message; }
    finally { importButton.disabled = false; }
  });
  const action = async (job: MediaJob, command: string) => { try { await api(`/api/media/${kind}/jobs/${job.id}/${command}`, { method: "POST", body: "{}" }); await refresh(); } catch (err) { note.textContent = (err as Error).message; } };
  let signature = "";
  const rendered = new Map<string, { signature: string; element: HTMLElement }>();
  const refresh = async () => {
    const view = await api<JobView>(`/api/media/${kind}/jobs`);
    const next = JSON.stringify(view);
    if (next !== signature) {
      signature = next;
      const entries = view.jobs.slice(0, 20).map((j) => {
        const jobSignature = JSON.stringify([j, view.projections[j.id], j.assets.map((id) => view.assets.find((a) => a.id === id))]);
        const prior = rendered.get(j.id);
        if (prior?.signature === jobSignature) return prior.element;
        const controls = el("div", { className: "row-actions" });
        if (["submitting", "running"].includes(j.state)) controls.append(el("button", { type: "button", className: "ghost small", textContent: "Stop waiting", onclick: () => void action(j, "stop") }));
        if (j.remoteId && j.state === "interrupted") controls.append(el("button", { type: "button", className: "ghost small", textContent: "Resume status checks", onclick: () => void action(j, "resume") }));
        if (j.state === "succeeded" && !view.projections[j.id]) controls.append(el("button", { type: "button", className: "ghost small", textContent: "Show result", onclick: () => void action(j, "publish") }));
        if (j.session && j.surface) controls.append(el("button", { type: "button", className: "link", textContent: "Open in chat", onclick: () => window.dispatchEvent(new CustomEvent("vak:media-chat", { detail: j.session })) }));
        if (!["submitting", "running"].includes(j.state) && (!j.remoteId || ["succeeded", "failed"].includes(j.state))) controls.append(el("button", { type: "button", className: "link", textContent: "Remove record", onclick: async () => { if (await ask("Remove this local job record? Saved files remain. Removing a record does not cancel provider work or billing.", "Remove")) void action(j, "remove"); } }));
        for (const id of j.assets) { const a = view.assets.find((a) => a.id === id); if (a) { const download = el("button", { type: "button", className: "ghost small", textContent: `Download ${a.name}` }); download.addEventListener("click", () => void fileLink(a, download, note)); controls.append(download); } }
        const content = el("div", { className: "media-result-surface" });
        const snap = view.projections[j.id];
        if (snap) { const store = new SurfaceStore(basicCatalog); store.load(snap); const surface = document.createElement("vak-surface") as VakSurfaceElement; surface.mediaResolver = resolveMedia; surface.attach(store, snap.id); content.append(surface); }
        const element = el("div", { className: "row stack" }, el("div", { className: "row-label", textContent: `${Object.entries(MEDIA_OPERATIONS[kind]).find(([op]) => op === j.operation)?.[1] ?? j.operation} · ${j.state}` }), el("p", { className: "row-hint", textContent: `${j.selection.replace("|", " / ")} · ${new Date(j.created).toLocaleString()} · charge unknown` }), el("code", { textContent: j.id }), j.error || j.projectionError ? el("p", { className: "row-hint bad", textContent: j.error ?? j.projectionError }) : null, content, controls);
        rendered.set(j.id, { signature: jobSignature, element });
        return element;
      });
      // A different job's progress must not remount a playing result.
      for (let i = 0; i < entries.length; i++) if (results.children[i] !== entries[i]) results.insertBefore(entries[i]!, results.children[i] ?? null);
      for (const child of [...results.children]) if (!entries.includes(child as HTMLElement)) child.remove();
      for (const id of rendered.keys()) if (!view.jobs.slice(0, 20).some((j) => j.id === id)) rendered.delete(id);
      if (!view.jobs.length) results.append(el("p", { className: "row-hint", textContent: "No jobs yet. Enable a tool above, then ask in chat or use Try it below. Generated files stay in this library until you delete them." }));
      imports.replaceChildren(...view.assets.slice(-30).reverse().map((a) => {
        const download = el("button", { type: "button", className: "link", textContent: "Download" }); download.addEventListener("click", () => void fileLink(a, download, note));
        const remove = el("button", { type: "button", className: "link", textContent: "Delete file" });
        remove.addEventListener("click", async () => { if (!await ask("Delete this saved file? Surfaces using it will show it as unavailable.", "Delete")) return; try { await api(`/api/media/assets/${a.id}`, { method: "DELETE" }); await refresh(); } catch (err) { note.textContent = (err as Error).message; } });
        return el("div", { className: "row stack" }, el("div", { className: "row-label", textContent: `${a.name} · ${a.type} · ${(a.bytes / 1_000_000).toFixed(2)} MB` }), el("code", { textContent: a.id }), el("div", { className: "row-actions" }, download, remove));
      }));
    }
  };
  const tick = async () => { try { await refresh(); } catch (err) { note.textContent = (err as Error).message; } if (results.isConnected) timer = setTimeout(() => void tick(), 3000); };
  timer = setTimeout(() => void tick(), 100);
  return group("Results and reference files", el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: "Import a file to get its asset ID for editing. Job status checks do no model work. Stop waiting does not cancel provider generation or guarantee a refund." }), el("div", { className: "row-actions" }, pick, importButton)), note, results, el("details", {}, el("summary", { textContent: "Saved media library" }), imports));
}
