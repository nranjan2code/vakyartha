// The app owns where an interface is shown. Move its live element rather than
// rendering a second form: validation, drafts and local table views stay intact.
// Small interfaces live in the conversation; large ones (placement.ts) leave a
// reference card there and open in the canvas. Any can be opened in the canvas.
import { basicCatalog, projectMarkdown, projectText, type SurfaceSnapshot, SurfaceStore } from "@vak/core";
import type { VakSurfaceElement } from "@vak/web";
import { $, api, ask, prefs } from "./core.ts";
import { icon } from "./icons.ts";
import { downloadMarkdown } from "./backend.ts";
import { canvasReason } from "./placement.ts";
import { surfaceMode } from "./theme.ts";
import { resolveMedia } from "./media.ts";

/** large: placed in the canvas; once large it stays so, and nothing jumps back into the chat. */
interface Entry { surface: VakSurfaceElement; home: HTMLElement; button: HTMLButtonElement; title: HTMLElement; option: HTMLOptionElement; large: boolean }

interface DeployedAppRef {
  appId: string;
  appName: string;
  version: string;
  deployedSurfaceVersion?: number;
  snapshotFingerprint: string;
  deployedAt: string;
}

export class Canvas {
  #entries = new Map<string, Entry>();
  #active?: string;
  #session: () => string;
  #store: () => SurfaceStore;
  #text = false;
  #last?: string;
  #inTurn = false;
  #dismissed = false;
  #feedbackTimer?: ReturnType<typeof setTimeout>;
  #panel = $<HTMLElement>("canvas");
  #content = $<HTMLElement>("canvas-content");
  #workspace = $<HTMLElement>("workspace");
  #resize = $<HTMLElement>("canvas-resize");
  #expand = $<HTMLButtonElement>("canvas-expand");
  #picker = $<HTMLSelectElement>("canvas-pick");
  /** Each surface as earlier replies left it (oldest first); the live one is always the latest. */
  #versions = new Map<string, SurfaceSnapshot[]>();
  /** An earlier version on show: its own store and a read-only element, the live one stays untouched. */
  #old?: { id: string; version: number; store: SurfaceStore; el: HTMLElement };

  beginTurn(): void {
    this.#inTurn = true;
    this.#dismissed = false;
  }

  beginWork(): void {
    // A tool-start event has neither surface ID nor size yet: progress shows in
    // a canvas already open; otherwise the first snapshot decides where it goes.
    if (this.#dismissed || this.#panel.hidden) return;
    this.#panel.hidden = this.#resize.hidden = false;
    this.#workspace.classList.add("canvas-open");
    if (!this.#active) this.#view(false);
    this.#panel.setAttribute("aria-busy", "true");
    $("canvas-progress").hidden = false;
    this.#controls();
  }

  endTurn(): void {
    this.#inTurn = false;
    this.#dismissed = false;
    this.#panel.removeAttribute("aria-busy");
    $("canvas-progress").hidden = true;
    if (!this.#active) this.close(false, false);
  }

  #controls(): void {
    this.#picker.hidden = !this.#active;
    // A flow (a form, then its results, then a booking step) is several
    // interfaces: step through them in order instead of only the latest.
    const n = this.#picker.options.length;
    const i = this.#picker.selectedIndex;
    const many = Boolean(this.#active) && n > 1;
    $("canvas-label").textContent = many ? `Canvas · ${i + 1} of ${n}` : "Canvas";
    for (const [id, to] of [["canvas-prev", i - 1], ["canvas-next", i + 1]] as const) {
      const b = $<HTMLButtonElement>(id);
      b.hidden = !many;
      b.disabled = to < 0 || to >= n;
    }
    // Versions of the one on show: earlier replies' copies, then the live one.
    const older = this.#active ? this.#older(this.#active) : [];
    const at = this.#old?.id === this.#active ? older.findIndex((v) => v.version === this.#old!.version) : older.length;
    $("canvas-versions").hidden = !older.length;
    $("canvas-version-label").textContent = at === older.length ? `Latest · ${older.length + 1} versions` : `Version ${at + 1} of ${older.length + 1}`;
    $<HTMLButtonElement>("canvas-older").disabled = at <= 0;
    $<HTMLButtonElement>("canvas-newer").disabled = at >= older.length;
    for (const id of ["canvas-copy", "canvas-download", "canvas-preview", "canvas-text"]) {
      const btn = document.getElementById(id);
      if (btn instanceof HTMLButtonElement) btn.disabled = !this.#active;
    }

    const deployBtn = document.getElementById("canvas-deploy") as HTMLButtonElement | null;
    if (deployBtn) {
      deployBtn.disabled = !this.#active;
      if (this.#active) {
        const snap = this.#old?.id === this.#active ? this.#old.store.snapshot(this.#active) : this.#store().snapshot(this.#active);
        const ref = snap ? this.#getDeployedApp(snap.id) : null;
        if (ref && snap) {
          const currentFingerprint = this.#fingerprint(snap);
          const currentVersion = snap.version ?? 1;
          const isChanged = ref.snapshotFingerprint !== currentFingerprint || (ref.deployedSurfaceVersion !== undefined && currentVersion > ref.deployedSurfaceVersion);
          if (isChanged) {
            deployBtn.className = "icon-btn deployed needs-update";
            deployBtn.setAttribute("aria-label", `Update hosted application “${ref.appName}” (New version available)`);
            deployBtn.title = `Update hosted application “${ref.appName}” (New version available)`;
            deployBtn.replaceChildren(icon("spark", 16));
          } else {
            deployBtn.className = "icon-btn deployed";
            deployBtn.setAttribute("aria-label", `Application “${ref.appName}” deployed · Click to open in Apps`);
            deployBtn.title = `Application “${ref.appName}” deployed · Click to open in Apps`;
            deployBtn.replaceChildren(icon("cpu", 16));
          }
        } else {
          deployBtn.className = "icon-btn";
          deployBtn.setAttribute("aria-label", "Deploy as hosted application");
          deployBtn.title = "Deploy as hosted application";
          deployBtn.replaceChildren(icon("rocket", 16));
        }
      }
    }
  }

  #fingerprint(snap: SurfaceSnapshot): string {
    return `${JSON.stringify(snap.nodes)}:${snap.version ?? 1}`;
  }

  #getDeployedApp(surfaceId: string): DeployedAppRef | null {
    try {
      const raw = prefs.get(`app:surface:${surfaceId}`);
      if (!raw) return null;
      return JSON.parse(raw) as DeployedAppRef;
    } catch {
      return null;
    }
  }

  #setDeployedApp(surfaceId: string, ref: DeployedAppRef | null): void {
    if (ref) prefs.set(`app:surface:${surfaceId}`, JSON.stringify(ref));
    else {
      try {
        localStorage.removeItem(`vak:app:surface:${surfaceId}`);
      } catch {}
    }
  }

  constructor(session: () => string, store: () => SurfaceStore) {
    this.#session = session;
    this.#store = store;
    for (const [id, name] of [["canvas-close", "close"], ["canvas-expand", "maximize"], ["canvas-copy", "copy"], ["canvas-download", "download"], ["canvas-deploy", "rocket"]] as const) $(id)?.append(icon(name, 16));
    this.#picker.addEventListener("change", () => this.open(this.#picker.value));
    for (const [id, by] of [["canvas-older", -1], ["canvas-newer", 1]] as const) {
      $(id).addEventListener("click", () => {
        if (!this.#active) return;
        const older = this.#older(this.#active);
        const at = this.#old?.id === this.#active ? older.findIndex((v) => v.version === this.#old!.version) : older.length;
        this.showVersion(this.#active, older[at + by]?.version);
      });
    }
    for (const [id, by] of [["canvas-prev", -1], ["canvas-next", 1]] as const) {
      $(id).addEventListener("click", () => {
        const o = this.#picker.options[this.#picker.selectedIndex + by];
        if (o) this.open(o.value);
      });
    }
    $("canvas-preview").addEventListener("click", () => this.#view(false));
    $("canvas-text").addEventListener("click", () => this.#view(true));
    $("canvas-copy").addEventListener("click", () => void this.#copy());
    $("canvas-download").addEventListener("click", () => void this.#download());
    $("canvas-deploy")?.addEventListener("click", () => void this.#deployAsApp());
    window.addEventListener("vak:app-deleted", (e) => {
      const deletedId = (e as CustomEvent<string>).detail;
      if (typeof deletedId === "string") {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith("vak:app:surface:")) {
              const raw = localStorage.getItem(key);
              if (raw && raw.includes(`"appId":"${deletedId}"`)) {
                localStorage.removeItem(key);
              }
            }
          }
        } catch {}
        this.#controls();
      }
    });
    document.addEventListener("vak-change", () => this.#updateText());
    $("canvas-close").addEventListener("click", () => this.close(true));
    this.#expand.addEventListener("click", () => this.#setExpanded(!this.#workspace.classList.contains("canvas-expanded")));
    const saved = Number(prefs.get("canvas:width"));
    this.#width(saved || 56);
    this.#resize.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const width = Number(this.#resize.getAttribute("aria-valuenow"));
      this.#width(e.key === "Home" ? 35 : e.key === "End" ? 70 : width + (e.key === "ArrowLeft" ? 2 : -2));
    });
    this.#resize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.#resize.setPointerCapture(e.pointerId);
      this.#workspace.classList.add("resizing");
    });
    this.#resize.addEventListener("pointermove", (e) => {
      if (!this.#resize.hasPointerCapture(e.pointerId)) return;
      const r = this.#workspace.getBoundingClientRect();
      this.#width((r.right - e.clientX) / r.width * 100);
    });
    this.#resize.addEventListener("lostpointercapture", () => this.#workspace.classList.remove("resizing"));
    document.addEventListener("keydown", (e) => {
      if (this.#workspace.hidden || !$("settings").hidden || document.querySelector("dialog[open]")) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f" && this.#active) {
        e.preventDefault();
        this.#setExpanded(!this.#workspace.classList.contains("canvas-expanded"));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "b" && this.#entries.size) {
        e.preventDefault();
        if (this.#active) this.close(true);
        else this.open(this.#last ?? this.#entries.keys().next().value!, true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b" && this.#entries.size) {
        e.preventDefault();
        if (!this.#active) this.open(this.#last ?? this.#entries.keys().next().value!, true);
        else if (this.#workspace.classList.contains("canvas-expanded")) this.close(true);
        else this.#setExpanded(true);
        return;
      }
      if (e.key !== "Escape" || !this.#active || !$("settings").hidden) return;
      // Let an open dialog, native select, or an in-progress turn handle Escape.
      if (document.querySelector("dialog[open]") || document.querySelector("#send.stop") || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      this.close(true);
    });
  }

  #width(value: number): void {
    const width = Math.round(Math.max(35, Math.min(70, value)));
    this.#workspace.style.setProperty("--canvas-width", `${width}%`);
    this.#resize.setAttribute("aria-valuemin", "35");
    this.#resize.setAttribute("aria-valuemax", "70");
    this.#resize.setAttribute("aria-valuenow", String(width));
    prefs.set("canvas:width", String(width));
  }

  #setExpanded(value: boolean): void {
    this.#workspace.classList.toggle("canvas-expanded", value);
    this.#expand.replaceChildren(icon(value ? "split" : "maximize", 16));
    this.#expand.setAttribute("aria-label", value ? "Enter split view" : "Enter full view");
    this.#expand.title = `${value ? "Enter split view" : "Enter full view"} (⌘⇧F)`;
    this.#expand.setAttribute("aria-pressed", String(value));
  }

  #view(text: boolean): void {
    this.#text = text;
    this.#content.hidden = text;
    $("canvas-text-content").hidden = !text;
    $("canvas-preview").setAttribute("aria-pressed", String(!text));
    $("canvas-text").setAttribute("aria-pressed", String(text));
    this.#updateText();
  }

  #updateText(): void {
    if (!this.#text || !this.#active) return;
    const resolved = this.#resolved();
    $("canvas-text-content").textContent = resolved ? projectText(resolved) : "";
  }

  #resolved() {
    if (!this.#active) return undefined;
    return this.#old?.id === this.#active ? this.#old.store.resolve(this.#active) : this.#store().resolve(this.#active);
  }

  /**
   * Fold an inline interface the conversation has moved past to its title line
   * (or open it again). The element stays in place, so its drafts and state do.
   */
  fold(id: string, folded: boolean): void {
    const entry = this.#entries.get(id);
    if (!entry || entry.large) return;
    entry.home.classList.toggle("folded", folded);
    entry.title.tabIndex = folded ? 0 : -1;
    entry.title.setAttribute("role", folded ? "button" : "presentation");
    entry.title.setAttribute("aria-expanded", String(!folded));
    entry.title.title = folded ? "Show this interface" : "";
  }

  /** Remember a surface as a reply left it; the same version twice is kept once. */
  addVersion(snap: SurfaceSnapshot): void {
    const list = this.#versions.get(snap.id) ?? [];
    if (list.at(-1)?.version === snap.version) return;
    list.push(structuredClone(snap));
    this.#versions.set(snap.id, list.slice(-10));
    if (this.#active === snap.id) this.#controls();
  }

  /** Versions older than the live surface, oldest first. */
  #older(id: string): SurfaceSnapshot[] {
    const live = this.#store().snapshot(id)?.version ?? Infinity;
    return (this.#versions.get(id) ?? []).filter((v) => v.version < live);
  }

  /** Show a surface as it was at `version` (read-only), or the live one when that is the latest. */
  showVersion(id: string, version?: number): void {
    if (this.#active !== id) this.open(id);
    const snap = version === undefined ? undefined : this.#older(id).find((v) => v.version === version);
    this.#old?.el.remove();
    this.#old = undefined;
    const live = this.#entries.get(id)?.surface;
    if (live) live.hidden = Boolean(snap);
    if (snap) {
      const store = new SurfaceStore(basicCatalog);
      store.load(structuredClone(snap));
      const el = document.createElement("div");
      el.className = "canvas-old";
      const note = document.createElement("div");
      note.className = "canvas-old-note";
      const back = document.createElement("button");
      back.type = "button";
      back.className = "link";
      back.textContent = "Back to latest";
      back.addEventListener("click", () => this.showVersion(id));
      note.append(document.createTextNode("Earlier version · "), back);
      const surface = document.createElement("vak-surface") as VakSurfaceElement;
      surface.mediaResolver = resolveMedia;
      surfaceMode(surface);
      surface.attach(store, id);
      // What it showed, not something to act on: its controls belong to a past state.
      surface.inert = true;
      el.append(note, surface);
      this.#content.prepend(el);
      this.#old = { id, version: snap.version, store, el };
    }
    this.#controls();
    this.#updateText();
  }

  #feedback(message: string): void {
    clearTimeout(this.#feedbackTimer);
    $("canvas-feedback").textContent = message;
    this.#feedbackTimer = setTimeout(() => { $("canvas-feedback").textContent = ""; }, 2500);
  }

  async #copy(): Promise<void> {
    const resolved = this.#resolved();
    if (!resolved) return;
    try {
      await navigator.clipboard.writeText(projectText(resolved));
      this.#feedback("Copied");
    } catch {
      this.#view(true);
      $("canvas-text-content").focus();
      this.#feedback("Select text to copy");
    }
  }

  async #download(): Promise<void> {
    const resolved = this.#resolved();
    if (!resolved) return;
    const filename = `${(resolved.title || "canvas").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "canvas"}.md`;
    try {
      await downloadMarkdown(filename, projectMarkdown(resolved));
      this.#feedback("Saved to Downloads");
    } catch {
      this.#feedback("Download failed. Try Copy.");
    }
  }

  async #deployAsApp(): Promise<void> {
    if (!this.#active) return;
    const snap = this.#old?.id === this.#active ? this.#old.store.snapshot(this.#active) : this.#store().snapshot(this.#active);
    if (!snap) return;

    const existingRef = this.#getDeployedApp(snap.id);
    if (existingRef) {
      const currentFingerprint = this.#fingerprint(snap);
      const currentVersion = snap.version ?? 1;
      const isChanged = existingRef.snapshotFingerprint !== currentFingerprint || (existingRef.deployedSurfaceVersion !== undefined && currentVersion > existingRef.deployedSurfaceVersion);

      if (!isChanged) {
        // App is already deployed and up to date
        const openNow = await ask(
          `“${existingRef.appName}” is already deployed as a hosted application and is up to date.\n\nOpen it now in the Apps workbench?`,
          "Open in Apps"
        );
        if (openNow) {
          window.dispatchEvent(new CustomEvent("vak:run-app", { detail: existingRef.appId }));
        }
        return;
      }

      // App has newer changes in Canvas: ask user to confirm update
      const doUpdate = await ask(
        `Update hosted application “${existingRef.appName}”?\n\nA newer version of this interface is available in Canvas. Updating will refresh the app's visual surface and state with your latest canvas changes while preserving its isolated storage volume and background triggers.`,
        "Update App"
      );
      if (!doUpdate) return;

      try {
        this.#feedback("Updating app…");
        const parts = (existingRef.version || "1.0.0").split(".").map(Number);
        const nextVersion = `${parts[0] || 1}.${parts[1] || 0}.${(parts[2] ?? 0) + 1}`;

        const manifestUpdate = {
          name: snap.title || existingRef.appName,
          version: nextVersion,
        };

        const files: Record<string, string> = {
          "surface.json": JSON.stringify(snap, null, 2),
          "AGENTS.md": `# AGENTS.md — ${snap.title || existingRef.appId}

Self-documenting architectural contract for agents and humans operating this application.

## Identity & Purpose
- **Application ID:** \`${existingRef.appId}\`
- **Name:** ${snap.title || existingRef.appName}
- **Version:** ${nextVersion}
- **Category:** finance
- **Runtime:** Node.js 24 airgapped worker runtime with local persistent volume.

## Interactive Surfaces
Declared in \`surface.json\` (version ${snap.version ?? 1}):
- **Surface ID:** \`${snap.id || existingRef.appId}\`
- **Nodes Count:** ${Array.isArray(snap.nodes) ? snap.nodes.length : 0}

## Action Dispatch
UI events and form changes call \`handleAction(controlId, value)\` in \`server.ts\`.
Background polls invoke \`refreshData()\`.

## Guidelines for Agents
1. All changes must be self-contained in this directory.
2. Read \`surface.json\` before modifying actions to ensure control IDs align.
3. No external network requests without declaring explicit allowed domains in \`app.json\`.
`,
          "SKILL.md": `---
name: ${existingRef.appId}
description: Operational instructions for managing and updating ${snap.title || existingRef.appName}.
---

# Operating ${snap.title || existingRef.appName}

- App Version: ${nextVersion}
- To run background actions: call \`POST /api/apps/${existingRef.appId}/triggers/refresh-poll/run\`.
- To dispatch UI changes: call \`POST /api/apps/${existingRef.appId}/action\`.
- To update visual layout: edit \`surface.json\` and restart the app runner.
`
        };

        await api(`/api/apps/${encodeURIComponent(existingRef.appId)}`, {
          method: "PUT",
          body: JSON.stringify({ manifest: manifestUpdate, files }),
        });

        existingRef.version = nextVersion;
        existingRef.appName = snap.title || existingRef.appName;
        existingRef.deployedSurfaceVersion = snap.version ?? 1;
        existingRef.snapshotFingerprint = currentFingerprint;
        existingRef.deployedAt = new Date().toISOString();
        this.#setDeployedApp(snap.id, existingRef);

        this.#feedback(`Updated to v${nextVersion}!`);
        window.dispatchEvent(new CustomEvent("vak:app-updated", { detail: existingRef.appId }));
        this.#controls();
      } catch (err) {
        this.#feedback("Update failed");
      }
      return;
    }

    // Initial deployment
    const baseTitle = (snap.title || "custom-app").trim();
    const slug = baseTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 36) || `app-${Date.now().toString(36)}`;
    const appId = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      this.#feedback("Deploying to Apps…");
      const manifest = {
        id: appId,
        version: "1.0.0",
        name: snap.title || "Hosted Application",
        description: `Dynamic hosted application deployed from Canvas surface`,
        author: "User",
        icon: "chart",
        category: "finance",
        entrypoints: {
          surface: "surface.json",
          backend: "server.ts",
        },
        runtime: {
          engine: "node24",
          memoryLimitMb: 256,
          cpuTimeLimitSec: 60,
          maxStorageMb: 512,
        },
        entitlements: {
          network: { mode: "airgap", allowedDomains: [] },
          mcpTools: [],
          storage: { sqlite: true, duckdb: false },
        },
        triggers: [
          {
            id: "refresh-poll",
            kind: "cron",
            expression: "*/5 * * * *",
            action: "refreshData",
            maxDurationSec: 30,
          },
        ],
      };

      const files: Record<string, string> = {
        "surface.json": JSON.stringify(snap, null, 2),
        "server.ts": `// Sandboxed app daemon for ${snap.title || appId}
export function handleAction(controlId: string, value: unknown): Record<string, unknown> {
  console.log("[${appId}] handleAction:", controlId, value);
  return {
    op: "batch_update",
    controlId,
    value,
    patches: []
  };
}

export function refreshData(): Record<string, unknown> {
  console.log("[${appId}] background poll executed");
  return { ok: true, timestamp: new Date().toISOString() };
}
`,
        "AGENTS.md": `# AGENTS.md — ${snap.title || appId}

Self-documenting architectural contract for agents and humans operating this application.

## Identity & Purpose
- **Application ID:** \`${appId}\`
- **Name:** ${snap.title || "Hosted Application"}
- **Version:** 1.0.0
- **Category:** finance
- **Runtime:** Node.js 24 airgapped worker runtime with local persistent volume.

## Interactive Surfaces
Declared in \`surface.json\` (version ${snap.version ?? 1}):
- **Surface ID:** \`${snap.id || appId}\`
- **Nodes Count:** ${Array.isArray(snap.nodes) ? snap.nodes.length : 0}

## Action Dispatch
UI events and form changes call \`handleAction(controlId, value)\` in \`server.ts\`.
Background polls invoke \`refreshData()\`.

## Guidelines for Agents
1. All changes must be self-contained in this directory.
2. Read \`surface.json\` before modifying actions to ensure control IDs align.
3. No external network requests without declaring explicit allowed domains in \`app.json\`.
`,
        "SKILL.md": `---
name: ${appId}
description: Operational instructions for managing and updating ${snap.title || appId}.
---

# Operating ${snap.title || appId}

- App Version: 1.0.0
- To run background actions: call \`POST /api/apps/${appId}/triggers/refresh-poll/run\`.
- To dispatch UI changes: call \`POST /api/apps/${appId}/action\`.
- To update visual layout: edit \`surface.json\` and restart the app runner.
`
      };

      await api("/api/apps", {
        method: "POST",
        body: JSON.stringify({ manifest, files }),
      });

      const ref: DeployedAppRef = {
        appId,
        appName: snap.title || "Hosted Application",
        version: "1.0.0",
        deployedSurfaceVersion: snap.version ?? 1,
        snapshotFingerprint: this.#fingerprint(snap),
        deployedAt: new Date().toISOString(),
      };
      this.#setDeployedApp(snap.id, ref);

      this.#feedback("Deployed to Apps!");
      window.dispatchEvent(new CustomEvent("vak:app-installed", { detail: appId }));
      this.#controls();
    } catch (err) {
      this.#feedback("Deploy failed");
    }
  }

  openStandalone(snap: SurfaceSnapshot, focus = true): void {
    this.#store().load(structuredClone(snap));
    let entry = this.#entries.get(snap.id);
    if (!entry) {
      const surface = document.createElement("vak-surface") as VakSurfaceElement;
      surface.mediaResolver = resolveMedia;
      surfaceMode(surface);
      surface.attach(this.#store(), snap.id);

      const home = document.createElement("section");
      home.className = "surface-home";
      home.dataset.surface = snap.id;
      const head = document.createElement("div");
      head.className = "surface-head";
      const title = document.createElement("span");
      title.textContent = snap.title || "Interface";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost small";
      button.textContent = "Open in canvas";
      button.addEventListener("click", () => this.open(snap.id, true));
      head.append(title, button);
      home.append(head, surface);

      const option = new Option(snap.title || "App", snap.id);
      this.#picker.add(option);
      entry = { surface, home, button, title, option, large: true };
      this.#entries.set(snap.id, entry);
    }
    this.open(snap.id, focus);
  }

  register(surface: VakSurfaceElement, snap: SurfaceSnapshot, parent: HTMLElement, auto: boolean): void {
    let entry = this.#entries.get(snap.id);
    if (!entry) {
      const home = document.createElement("section");
      home.className = "surface-home";
      home.dataset.surface = snap.id;
      const head = document.createElement("div");
      head.className = "surface-head";
      const title = document.createElement("span");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost small";
      button.setAttribute("aria-controls", "canvas");
      button.addEventListener("click", () => this.open(snap.id, true));
      head.append(title, button);
      home.append(head, surface);
      parent.append(home);
      const option = new Option("", snap.id);
      this.#picker.add(option);
      if (this.#active) this.#controls();
      entry = { surface, home, button, title, option, large: false };
      this.#entries.set(snap.id, entry);
      // Folded, the title is the way back in.
      title.addEventListener("click", () => this.fold(snap.id, false));
      title.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.fold(snap.id, false); } });
    }
    // Promote once a stream or update makes it large; never demote.
    entry.large ||= canvasReason(snap) !== undefined;
    entry.home.classList.toggle("inline", !entry.large);
    if (this.#active !== snap.id) surface.hidden = entry.large;
    entry.title.textContent = snap.title || "Interface";
    entry.option.textContent = entry.title.textContent;
    entry.button.textContent = this.#active === snap.id ? "Shown in canvas" : "Open in canvas";
    entry.button.setAttribute("aria-expanded", String(this.#active === snap.id));
    if (this.#active === snap.id) $("canvas-title").textContent = entry.title.textContent;
    if (this.#active === snap.id) this.#updateText();
    // Large new and updated surfaces open in the canvas. History redraws pass
    // auto=false; closing during this turn suppresses later stream ticks.
    if (auto && !this.#dismissed && entry.large) this.open(snap.id);
  }

  open(id: string, focus = false): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (this.#active !== id) {
      this.#returnHome();
      this.#active = id;
      this.#last = id;
      entry.surface.hidden = false;
      this.#content.append(entry.surface);
      this.#content.scrollTop = 0;
      this.#view(false);
    }
    entry.home.classList.add("in-canvas");
    entry.button.textContent = "Shown in canvas";
    entry.button.setAttribute("aria-expanded", "true");
    this.#picker.value = id;
    $("canvas-title").textContent = entry.title.textContent;
    this.#panel.hidden = this.#resize.hidden = false;
    this.#workspace.classList.add("canvas-open");
    this.#controls();
    prefs.set(`canvas:session:${this.#session()}`, id);
    if (focus) $("canvas-close").focus();
  }

  #returnHome(): void {
    if (this.#old) this.showVersion(this.#old.id);
    const entry = this.#active ? this.#entries.get(this.#active) : undefined;
    if (!entry) return;
    entry.home.append(entry.surface);
    entry.surface.hidden = entry.large;
    entry.home.classList.remove("in-canvas");
    entry.button.textContent = "Open in canvas";
    entry.button.setAttribute("aria-expanded", "false");
  }

  close(focus = false, save = true): void {
    if (focus && this.#inTurn) this.#dismissed = true;
    const button = this.#active ? this.#entries.get(this.#active)?.button : undefined;
    this.#returnHome();
    this.#active = undefined;
    this.#panel.hidden = this.#resize.hidden = true;
    this.#workspace.classList.remove("canvas-open");
    $("canvas-progress").hidden = true;
    this.#setExpanded(false);
    clearTimeout(this.#feedbackTimer);
    $("canvas-feedback").textContent = "";
    if (save) prefs.set(`canvas:session:${this.#session()}`, "");
    if (focus) button?.focus();
  }

  restore(): void {
    const id = prefs.get(`canvas:session:${this.#session()}`);
    if (id) this.open(id);
  }

  /** Whether the surface sits in the conversation (small), not on a card. */
  isInline(id: string): boolean {
    const e = this.#entries.get(id);
    return Boolean(e && !e.large);
  }

  remove(id: string): void {
    if (id === this.#active) this.close();
    this.#entries.get(id)?.home.remove();
    this.#entries.get(id)?.option.remove();
    this.#entries.delete(id);
    if (this.#last === id) this.#last = undefined;
  }

  reset(): void {
    this.#inTurn = false;
    this.#dismissed = false;
    this.close(false, false);
    this.#panel.removeAttribute("aria-busy");
    this.#entries.clear();
    this.#last = undefined;
    this.#versions.clear();
    this.#picker.replaceChildren();
  }
}
