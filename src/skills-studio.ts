// Studio: Unified Authoring, Rehearsal, Flow DAG, and Canvas Staging
// Workbench for Agent Skills and Sandboxed Dynamic Applications.
// Supports multi-tab multitasking, instant background auto-saves, and seamless session restoration.

import { api, ask, el } from "./core.ts";
import { icon } from "./icons.ts";
import { pill, segmented } from "./ui.ts";
import { type VakSurfaceElement } from "@vak/web";
import { basicCatalog, lowerSurface, projectText, SurfaceStore, type SurfaceSnapshot, type VpsNode } from "@vak/core";
import { surfaceMode } from "./theme.ts";
import type {
  SkillDraftResponse,
  SkillDraftSaveResponse,
  SkillEvalResult,
  SkillPackageView,
  SkillSandboxRunResponse,
  SkillView,
} from "../shared/skills.ts";
import type { AppSummary, AppDetails } from "../sidecar/sandbox-pool/app-registry.ts";
import { createAppScaffold } from "../shared/app-scaffold.ts";
import { parseAppManifest, type AppManifest } from "../shared/app-manifest.ts";

let activeStudioBackAction: (() => Promise<void>) | null = null;

// Persistent session state across tab switches
let sessionActiveItemName: string | undefined = undefined;
let sessionActiveKind: "skill" | "app" = "skill";
let sessionActiveStudioTab: "spec" | "dag" | "preview" | "sandbox" = "spec";
let sessionActiveFileName = "SKILL.md";
let sessionActiveBreakpoint: "sm" | "md" | "lg" | "full" = "md";
let sessionSelectedDagNodeId: string | null = null;

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let flushPendingAutoSave: (() => Promise<void>) | null = null;

export function isSkillStudioOpen(): boolean {
  return document.body.classList.contains("in-skill-studio");
}

export async function closeSkillStudio(): Promise<void> {
  const root = document.getElementById("skills-studio-page");
  if (root) {
    root.hidden = true;
  }
  document.body.classList.remove("in-skill-studio");
  if (flushPendingAutoSave) {
    try {
      await flushPendingAutoSave();
    } catch {
      // flush error is non-blocking
    }
  }
  window.dispatchEvent(new Event("vak:studio-closed"));
}

export async function openSkillStudio(
  initialItemName: string | undefined,
  onBack: () => void | Promise<void>,
  reloadParentList: () => Promise<void>,
  initialType: "skill" | "app" = "skill"
): Promise<HTMLElement> {
  const root = (document.getElementById("skills-studio-page") ?? el("div", { id: "skills-studio-page", className: "skills-studio-page" })) as HTMLElement;
  if (!root.parentElement) {
    const appEl = document.querySelector(".app") ?? document.body;
    appEl.append(root);
  }

  root.hidden = false;
  document.body.classList.add("in-skill-studio");

  // Ensure all sibling views in the app grid are hidden
  const workspaceEl = document.getElementById("workspace");
  if (workspaceEl) workspaceEl.hidden = true;
  const artifactsEl = document.getElementById("artifacts-page");
  if (artifactsEl) artifactsEl.hidden = true;
  const appsEl = document.getElementById("apps-page");
  if (appsEl) appsEl.hidden = true;
  const scheduleEl = document.getElementById("schedule-page");
  if (scheduleEl) scheduleEl.hidden = true;

  window.dispatchEvent(new Event("vak:studio-opened"));

  const settingsEl = document.getElementById("settings");
  const wasSettingsOpen = settingsEl ? !settingsEl.hidden : false;
  if (settingsEl) settingsEl.hidden = true;

  // Active view model
  let activeItemName: string | undefined = initialItemName ?? sessionActiveItemName;
  let activeKind: "skill" | "app" = initialItemName ? initialType : sessionActiveKind;

  // Hub collections
  let installedSkills: SkillView[] = [];
  let installedApps: AppSummary[] = [];
  let hubFilter: "all" | "skills" | "apps" | "drafts" = "all";
  let hubQuery = "";

  // Editor states
  let currentSkillPkg: SkillPackageView | null = null;
  let currentAppDetails: AppDetails | null = null;
  let hasDraft = false;
  let appDraftFingerprint: string | undefined;
  let appBaseFingerprint: string | undefined;
  let appManifestText: string | undefined;
  let draftSavedAt: string | undefined = undefined;
  let isDirty = false;
  let isAutoSaving = false;
  let isSavingDraft = false;
  let isPublishing = false;

  let activeFileName = sessionActiveFileName;
  let activeStudioTab: "spec" | "dag" | "preview" | "sandbox" = sessionActiveStudioTab;
  let activeBreakpoint: "sm" | "md" | "lg" | "full" = sessionActiveBreakpoint;
  let selectedDagNodeId: string | null = sessionSelectedDagNodeId;

  let evalResults: SkillEvalResult[] = [];
  let sandboxLog: SkillSandboxRunResponse | null = null;
  let isRunningTests = false;
  let isRunningSandbox = false;
  let activeTools: { id: string; name: string }[] = [];

  // Tab key handler for code textareas
  function enableTabIndent(textarea: HTMLTextAreaElement): void {
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event("input"));
      }
    });
  }

  // Feedback notifications
  const feedback = el("p", { className: "settings-feedback", role: "status", "aria-live": "polite" });
  const showError = (err: unknown) => {
    feedback.textContent = (err as Error).message;
    feedback.className = "settings-feedback bad";
    render();
  };
  const showNotice = (msg: string) => {
    feedback.textContent = msg;
    feedback.className = "settings-feedback ok";
    render();
  };

  async function loadHubData(): Promise<void> {
    try {
      const [skills, apps, integrations] = await Promise.all([
        api<SkillView[]>("/api/skills").catch(() => []),
        Promise.all([api<AppSummary[]>("/api/apps"), api<AppSummary[]>("/api/apps/drafts")]).then(([live, drafts]) => [...new Map([...live, ...drafts].map(a => [a.id, a])).values()]).catch(() => []),
        api<{ entry: { id: string; name: string }; enabled: boolean }[]>("/api/integrations").catch(() => []),
      ]);
      installedSkills = skills;
      installedApps = apps;
      const sysTools = [
        { id: "read_skill_file", name: "read_skill_file" },
        { id: "vak_render", name: "vak_render" },
        { id: "vak_update", name: "vak_update" },
        { id: "vak_submit", name: "vak_submit" },
        { id: "use_skill", name: "use_skill" },
        { id: "run_command", name: "run_command" },
      ];
      activeTools = [
        ...sysTools,
        ...integrations.filter(i => i.enabled).map(i => ({ id: i.entry.id, name: i.entry.name }))
      ];
    } catch (err) {
      showError(err);
    }
  }

  async function loadItemData(name: string, kind: "skill" | "app"): Promise<void> {
    isDirty = false;
    hasDraft = false;
    appDraftFingerprint = undefined; appBaseFingerprint = undefined; appManifestText = undefined;
    draftSavedAt = undefined;
    evalResults = [];
    sandboxLog = null;
    activeItemName = name;
    activeKind = kind;
    sessionActiveItemName = name;
    sessionActiveKind = kind;

    if (kind === "skill") {
      activeFileName = "SKILL.md";
      sessionActiveFileName = "SKILL.md";
      try {
        const draftResp = await api<SkillDraftResponse>(`/api/skills/${encodeURIComponent(name)}/draft`);
        currentSkillPkg = draftResp.package;
        hasDraft = draftResp.hasDraft;
        draftSavedAt = draftResp.draftSavedAt;
        if (hasDraft) {
          showNotice(`Loaded working draft${draftSavedAt ? ` from ${new Date(draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. Live assistant uses published version until you publish.`);
        }
      } catch {
        const published = installedSkills.find(s => s.name === name);
        if (published) {
          const pkg = await api<SkillPackageView>(`/api/skills/${encodeURIComponent(name)}/package`).catch(() => ({
            skill: published,
            files: (published.files ?? []).map(f => ({ path: f.path, text: "", bytes: f.bytes, status: f.status }))
          }));
          currentSkillPkg = pkg;
        } else {
          initNewSkill(name);
        }
      }
    } else {
      activeFileName = "app.json";
      sessionActiveFileName = "app.json";
      try {
        const draft = await api<any>(`/api/apps/${encodeURIComponent(name)}/draft`);
        const published = await api<AppDetails>(`/api/apps/${encodeURIComponent(name)}`).catch(() => null);
        currentAppDetails = { ...(published ?? { workspaceDir: "", isRunning: false, storageBytes: 0, state: {}, lastExecutedAt: null }), manifest: draft.manifest, _supportingFiles: Object.entries(draft.files).map(([path, text]) => ({ path, text: String(text) })) };
        appManifestText = draft.manifestText ?? JSON.stringify(draft.manifest, null, 2);
        try { if (draft.manifest.entrypoints.surface) currentAppDetails.surface = JSON.parse(draft.files[draft.manifest.entrypoints.surface]); } catch { /* Preserve incomplete source; preview waits for valid JSON. */ }
        appDraftFingerprint = draft.fingerprint ?? undefined; appBaseFingerprint = draft.base ?? undefined;
        hasDraft = Boolean(draft.fingerprint); draftSavedAt = draft.savedAt;
      } catch {
        initNewApp(name);
      }
    }
  }

  function initNewSkill(name = "custom-analysis"): void {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    const template = `---
name: ${slug}
description: Analyze domain records and project structured 3-tier findings across interactive canvas surfaces.
allowed-tools: read_skill_file
license: MIT
compatibility: Compliant with Agent Skills specification.
metadata:
  version: "1.0.0"
---

# ${slug}

## Objective
Analyze domain records from verified sources and project structured findings onto the interactive Canvas.

## Procedure
1. Resolve the analysis window, source records, and currency/units.
2. Load \`interactive-ui\` when binding canonical data collections or receiving form criteria.
3. The shared, required \`surface-design\` guidance applies automatically:
   - Tier 1: Executive summary headline and 3 to 4 metric aggregate cards.
   - Tier 2: Analytical core using a 2-column grid pairing a trend chart with distribution.
   - Tier 3: Dense detail inspection table with sorting and filtering.
4. Keep one canonical collection under \`/records\` rather than duplicating numbers across separate surfaces.
5. Formulate the visible narrative so the first sentence carries the primary finding and key caveat for Voice TTS.
`;
    currentSkillPkg = {
      skill: {
        name: slug,
        description: "Analyze domain records and project structured 3-tier findings across interactive canvas surfaces.",
        enabled: false,
        body: template.split(/^---\s*$/m).slice(2).join("---").trim(),
        text: template,
        allowedTools: "read_skill_file",
      },
      files: [
        {
          path: "schemas/records.json",
          text: JSON.stringify({
            records: [
              { id: "1", deliverable: "Verify core interface contracts", priority: "High", status: "Active", estimate_days: 3 },
              { id: "2", deliverable: "Test sandbox isolation boundary", priority: "Critical", status: "In Progress", estimate_days: 2 },
              { id: "3", deliverable: "Audit responsive layout reflow", priority: "Medium", status: "Pending", estimate_days: 4 }
            ]
          }, null, 2),
          bytes: 350,
          status: "added",
        },
        {
          path: "tests/test_scenarios.json",
          text: JSON.stringify({
            positive_prompts: [
              `Execute ${slug.replace(/-/g, " ")} to analyze domain records and show the canvas`,
              `Inspect active deliverables and show the breakdown table`
            ],
            distractor_prompts: [
              "What is the weather in Tokyo?",
              "Draft an email to schedule a meeting"
            ]
          }, null, 2),
          bytes: 260,
          status: "added",
        }
      ]
    };
    isDirty = true;
    scheduleAutoSave();
  }

  function initNewApp(name = "custom-app"): void {
    appDraftFingerprint = undefined; appBaseFingerprint = undefined; appManifestText = undefined; hasDraft = false;
    const { manifest, files } = createAppScaffold(name);
    currentAppDetails = {
      manifest, workspaceDir: "", isRunning: false, storageBytes: 0, state: {},
      surface: JSON.parse(files["surface.json"]!), lastExecutedAt: null,
      _supportingFiles: Object.entries(files).map(([path, text]) => ({ path, text })),
    };
    isDirty = true;
    scheduleAutoSave();
  }

  // Automatic Background Draft Saving
  function scheduleAutoSave(): void {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      void saveDraftAction(true);
    }, 800);
  }

  flushPendingAutoSave = async () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (isDirty) {
      await saveDraftAction(true);
    }
  };

  function getActiveText(): string {
    if (activeKind === "skill" && currentSkillPkg) {
      if (activeFileName === "SKILL.md") return currentSkillPkg.skill.text;
      const f = currentSkillPkg.files.find(item => item.path === activeFileName);
      return f ? f.text : "";
    } else if (activeKind === "app" && currentAppDetails) {
      if (activeFileName === "app.json") return appManifestText ?? JSON.stringify(currentAppDetails.manifest, null, 2);
      const supporting = (currentAppDetails as any)._supportingFiles as { path: string; text: string }[] | undefined;
      const f = supporting?.find(item => item.path === activeFileName);
      return f ? f.text : "";
    }
    return "";
  }

  function setActiveText(content: string): void {
    isDirty = true;
    if (activeKind === "skill" && currentSkillPkg) {
      if (activeFileName === "SKILL.md") {
        currentSkillPkg.skill.text = content;
        const mName = /^name:\s*([a-z0-9-]+)/m.exec(content);
        if (mName?.[1]) currentSkillPkg.skill.name = mName[1];
        const mDesc = /^description:\s*(.+)$/m.exec(content);
        if (mDesc?.[1]) currentSkillPkg.skill.description = mDesc[1].trim();
        const mTools = /^allowed-tools:\s*(.+)$/m.exec(content);
        if (mTools?.[1]) currentSkillPkg.skill.allowedTools = mTools[1].trim();
        const parts = content.split(/^---\s*$/m);
        if (parts.length >= 3) currentSkillPkg.skill.body = parts.slice(2).join("---").trim();
      } else {
        let f = currentSkillPkg.files.find(item => item.path === activeFileName);
        if (!f) {
          f = { path: activeFileName, text: content, bytes: new TextEncoder().encode(content).length, status: "added" };
          currentSkillPkg.files.push(f);
        } else {
          f.text = content;
          f.bytes = new TextEncoder().encode(content).length;
        }
      }
    } else if (activeKind === "app" && currentAppDetails) {
      if (activeFileName === "app.json") {
        appManifestText = content;
        try { currentAppDetails.manifest = parseAppManifest(JSON.parse(content)); } catch { /* Raw manifest text stays in the inert draft. */ }
      } else {
        let supporting = (currentAppDetails as any)._supportingFiles as { path: string; text: string }[] | undefined;
        if (!supporting) {
          supporting = [];
          (currentAppDetails as any)._supportingFiles = supporting;
        }
        let f = supporting.find(item => item.path === activeFileName);
        if (!f) {
          f = { path: activeFileName, text: content };
          supporting.push(f);
        } else {
          f.text = content;
        }
        if (activeFileName === "surface.json") {
          try { currentAppDetails.surface = JSON.parse(content); } catch {}
        }
      }
    }
    scheduleAutoSave();
  }

  function rebuildSkillMdFromVisual(name: string, desc: string, tools: string, bodyText: string): void {
    if (!currentSkillPkg) return;
    isDirty = true;
    const header = [
      "---",
      `name: ${name.trim()}`,
      `description: ${desc.trim()}`,
      tools.trim() ? `allowed-tools: ${tools.trim()}` : null,
      `license: ${currentSkillPkg.skill.license ?? "MIT"}`,
      `compatibility: ${currentSkillPkg.skill.compatibility ?? "Compliant with Agent Skills specification."}`,
      "metadata:",
      "  author: Studio Author",
      `  updated: "${new Date().toISOString()}"`,
      "---",
      "",
      bodyText.trim()
    ].filter(Boolean).join("\n");
    currentSkillPkg.skill.name = name.trim();
    currentSkillPkg.skill.description = desc.trim();
    currentSkillPkg.skill.allowedTools = tools.trim();
    currentSkillPkg.skill.body = bodyText.trim();
    currentSkillPkg.skill.text = header;
    scheduleAutoSave();
  }

  // Draft operations
  async function saveDraftAction(silent = false): Promise<void> {
    if (isSavingDraft || isAutoSaving) return;
    if (activeKind === "skill" && currentSkillPkg) {
      if (silent) isAutoSaving = true;
      else { isSavingDraft = true; feedback.textContent = "Saving draft…"; feedback.className = "settings-feedback"; }
      try {
        const payload = {
          text: currentSkillPkg.skill.text,
          files: currentSkillPkg.files.map(f => ({ path: f.path, text: f.text }))
        };
        const res = await api<SkillDraftSaveResponse>(`/api/skills/${encodeURIComponent(currentSkillPkg.skill.name)}/draft`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        hasDraft = true;
        draftSavedAt = res.draftSavedAt;
        isDirty = false;
        if (!silent) showNotice(`Draft saved at ${new Date(res.draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
        await loadHubData();
      } catch (err) {
        if (!silent) showError(err);
      } finally {
        isSavingDraft = false;
        isAutoSaving = false;
        updateHeaderPills();
      }
    } else if (activeKind === "app" && currentAppDetails) {
      if (silent) isAutoSaving = true;
      else isSavingDraft = true;
      try {
        const supporting = ((currentAppDetails as any)._supportingFiles as { path: string; text: string }[] | undefined) ?? [];
        const filesMap: Record<string, string> = {};
        for (const f of supporting) filesMap[f.path] = f.text;
        const draft = await api<any>(`/api/apps/${encodeURIComponent(currentAppDetails.manifest.id)}/draft`, {
          method: "PUT",
          body: JSON.stringify({ manifest: currentAppDetails.manifest, files: filesMap, manifestText: appManifestText, previous: appDraftFingerprint, base: appBaseFingerprint })
        });
        appDraftFingerprint = draft.fingerprint; appBaseFingerprint = draft.base ?? undefined; hasDraft = true; draftSavedAt = draft.savedAt;
        isDirty = false;
        if (!silent) showNotice(`Saved application “${currentAppDetails.manifest.name}”.`);
        await loadHubData();
      } catch (err) {
        if (!silent) showError(err);
      } finally {
        isSavingDraft = false;
        isAutoSaving = false;
        updateHeaderPills();
      }
    }
  }

  async function discardDraftAction(): Promise<void> {
    if (activeKind === "app" && currentAppDetails) {
      if (!await ask("Discard this unpublished app draft?", "Discard")) return;
      await api(`/api/apps/${encodeURIComponent(currentAppDetails.manifest.id)}/draft`, { method: "DELETE" });
      await loadItemData(currentAppDetails.manifest.id, "app"); render(); return;
    }
    if (activeKind === "skill" && currentSkillPkg && hasDraft) {
      const ok = await ask(`Discard working draft for “${currentSkillPkg.skill.name}”? Workspace will revert to published package.`, "Discard Draft");
      if (!ok) return;
      feedback.textContent = "Discarding draft…";
      feedback.className = "settings-feedback";
      try {
        await api(`/api/skills/${encodeURIComponent(currentSkillPkg.skill.name)}/draft`, { method: "DELETE" });
        hasDraft = false;
        draftSavedAt = undefined;
        isDirty = false;
        currentSkillPkg = await api<SkillPackageView>(`/api/skills/${encodeURIComponent(currentSkillPkg.skill.name)}/package`);
        showNotice("Draft discarded. Workspace reverted to published package.");
        await loadHubData();
        render();
      } catch (err) {
        showError(err);
      }
    }
  }

  async function publishAction(): Promise<void> {
    if (isPublishing) return;
    if (activeKind === "skill" && currentSkillPkg) {
      isPublishing = true;
      feedback.textContent = "Publishing skill to assistant…";
      feedback.className = "settings-feedback";
      try {
        const payload = {
          text: currentSkillPkg.skill.text,
          files: currentSkillPkg.files.map(f => ({ path: f.path, text: f.text }))
        };
        const saved = await api<SkillView>(`/api/skills/${encodeURIComponent(currentSkillPkg.skill.name)}/publish`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        currentSkillPkg.skill = saved;
        hasDraft = false;
        draftSavedAt = undefined;
        isDirty = false;
        showNotice(`Successfully published “${saved.name}”! The live assistant can now use this skill.`);
        await loadHubData();
        render();
      } catch (err) {
        showError(err);
      } finally {
        isPublishing = false;
        render();
      }
    } else if (activeKind === "app" && currentAppDetails) {
      if (isDirty || !appDraftFingerprint) await saveDraftAction(false);
      if (isDirty || !appDraftFingerprint) return;
      const tools = currentAppDetails.manifest.entitlements.mcpTools.join(", ") || "None";
      if (!await ask(`Publish reviewed application “${currentAppDetails.manifest.name}”? Declared tools: ${tools}. Scheduled work stays off until enabled in Apps.`, "Publish App")) return;
      try {
        currentAppDetails = await api<AppDetails>(`/api/apps/${encodeURIComponent(currentAppDetails.manifest.id)}/publish`, { method: "POST", body: JSON.stringify({ fingerprint: appDraftFingerprint }) });
        hasDraft = false; appDraftFingerprint = undefined; showNotice("App published. Open it in Apps; its actions run directly without a model.");
        await loadHubData();
      } catch (error) { showError(error); }
    }
  }

  function updateHeaderPills(): void {
    const pillBox = root.querySelector(".studio-status-pills");
    if (!pillBox) return;
    const pills: HTMLElement[] = [
      pill(activeKind === "skill" ? "Skill" : "App", "info"),
      hasDraft
        ? pill(isAutoSaving ? "Saving draft…" : `Draft${draftSavedAt ? ` (${new Date(draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""}`, "caution")
        : pill("Published", "ok"),
    ];
    if (isDirty && !isAutoSaving) {
      pills.push(pill("Unsaved edits", "caution"));
    }
    pillBox.replaceChildren(...pills);
  }

  async function backAction(): Promise<void> {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (isDirty) {
      await saveDraftAction(true);
    }

    if (activeItemName) {
      // Return to Hub view
      activeItemName = undefined;
      sessionActiveItemName = undefined;
      currentSkillPkg = null;
      currentAppDetails = null;
      isDirty = false;
      await loadHubData();
      render();
      return;
    }

    activeStudioBackAction = null;
    window.removeEventListener("keydown", onKeyDown, true);
    root.hidden = true;
    document.body.classList.remove("in-skill-studio");
    window.dispatchEvent(new Event("vak:studio-closed"));
    if (wasSettingsOpen && settingsEl) {
      settingsEl.hidden = false;
    }
    await onBack();
  }

  activeStudioBackAction = backAction;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      e.stopPropagation();
      void backAction();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  interface DagNodeDef {
    id: string;
    title: string;
    glyph: string;
    detail: string;
    badge: string;
    x: number;
    y: number;
    width: number;
    height: number;
    inspectorText: string;
    removableType?: "tool" | "chain" | "stage";
    removableValue?: string;
  }

  interface DagEdgeDef {
    from: string;
    to: string;
  }

  function getDomainTestPrompts(skill: SkillView): { positive: string[]; distractor: string[] } {
    const name = skill.name;
    if (name === "meeting-actions") {
      return {
        positive: [
          "Extract action items and decisions from today's sprint sync",
          "Turn this meeting transcript into assigned deliverables with owners and due dates",
          "Prepare minutes recording agreed architecture choices and open questions"
        ],
        distractor: [
          "What is the weather outside in Seattle right now?",
          "Help me debug a Rust borrow checker lifetime compiler error"
        ]
      };
    }
    if (name === "market-dashboard") {
      return {
        positive: [
          "How did Indian markets close today?",
          "Show me live Nifty 50 and Sensex breadth with top gainers",
          "Analyze top active equities by turnover on NSE"
        ],
        distractor: [
          "Write a poem about autumn leaves",
          "Plan a 3-day itinerary for a trip to Tokyo"
        ]
      };
    }
    if (name === "task-tracker") {
      return {
        positive: [
          "Show active sprint deliverables and what is currently blocked",
          "Track milestones and assignees for milestone 0.2.0",
          "Update the status of task VAK-102 to Done"
        ],
        distractor: [
          "What are the top headlines in world news?",
          "Translate this paragraph into French"
        ]
      };
    }
    if (name === "code-review") {
      return {
        positive: [
          "Review src/skills-studio.ts for architectural and type safety",
          "Analyze git diff against main and flag any security regressions",
          "Audit TypeScript strictness and modular component boundaries"
        ],
        distractor: [
          "Recommend a good Italian pasta recipe for dinner",
          "What is the capital of Australia?"
        ]
      };
    }
    if (name === "interactive-ui") {
      return {
        positive: [
          "Create an interactive dashboard with form controls and filters",
          "Bind user input to canvas state using reactive widgets",
          "Show a multi-component interactive surface with action buttons"
        ],
        distractor: [
          "What is the capital of Peru?",
          "How do I make chocolate chip cookies?"
        ]
      };
    }
    if (name === "surface-design") {
      return {
        positive: [
          "Format this analytical report with 3-tier liquid layout",
          "Ensure canvas surface reflows properly across 320px, 720px, and 960px",
          "Construct dual spoken voice readout for this dashboard"
        ],
        distractor: [
          "What is Newton's third law of motion?",
          "Help me fix my bike chain"
        ]
      };
    }

    const title = name.replace(/-/g, " ");
    return {
      positive: [
        `Execute ${title} to ${skill.description.charAt(0).toLowerCase() + skill.description.slice(1).replace(/\.$/, "")}`,
        `Show me the ${title} procedure and projected outcomes`,
        `Apply ${title} guidelines to my current workspace task`
      ],
      distractor: [
        "What is the forecast temperature in London tomorrow?",
        "Can you write a haiku about computers?"
      ]
    };
  }

  function buildRealisticSkillSurface(skill: SkillView, pkg: SkillPackageView | null): SurfaceSnapshot {
    const name = skill.name;
    const snapId = `studio-${name}`;

    // 1. Check if user provided an explicit custom schema file in package
    if (pkg?.files) {
      const schemaFile = pkg.files.find(f => f.path.includes("records.json") || f.path.includes("schemas/"));
      if (schemaFile) {
        try {
          const parsed = JSON.parse(schemaFile.text);
          if (Array.isArray(parsed.records) && parsed.records.length > 0) {
            const sample = parsed.records[0];
            const cols = Object.keys(sample);
            const numCols = cols.filter(c => typeof sample[c] === "number");
            const valCol = numCols[0];

            const nodes: VpsNode[] = [
              {
                id: "root-section",
                type: "section",
                props: {
                  title: name.replace(/-/g, " "),
                  description: skill.description
                },
                children: ["metric-grid", "records-table"]
              },
              {
                id: "metric-grid",
                type: "grid",
                props: { columns: Math.min(parsed.records.length, 4), minItemWidth: "sm" },
                children: ["m1", "m2", "m3", "m4"].slice(0, Math.min(numCols.length + 1, 4))
              },
              { id: "m1", type: "stat", props: { label: "Total Entities", value: { records: "{/records}", field: cols[0], aggregate: "count" } } }
            ];
            if (valCol) {
              nodes.push({ id: "m2", type: "stat", props: { label: `Total ${valCol}`, value: { records: "{/records}", field: valCol, aggregate: "sum" } } });
              nodes.push({ id: "m3", type: "stat", props: { label: `Average ${valCol}`, value: { records: "{/records}", field: valCol, aggregate: "mean" } } });
              nodes.push({ id: "m4", type: "stat", props: { label: `Peak ${valCol}`, value: { records: "{/records}", field: valCol, aggregate: "max" } } });
            }
            nodes.push({
              id: "records-table",
              type: "table",
              props: {
                title: "Source Records",
                columns: cols,
                rows: { records: "{/records}", fields: cols },
                maxWidth: "full",
                searchable: true,
                sortable: true
              }
            });
            return { id: snapId, version: 1, title: name.replace(/-/g, " "), data: { records: parsed.records }, nodes };
          }
        } catch {}
      }
    }

    // 2. Domain-specific surface blueprints
    if (name === "meeting-actions") {
      const actions = [
        { id: "1", deliverable: "Verify vak-sandbox exit codes and execution telemetry", owner: "Nisheeth Ranjan", due_date: "29 Oct 2026", priority: "High", status: "In Progress" },
        { id: "2", deliverable: "Dynamically construct Flow DAG from skill taxonomy and tools", owner: "Nisheeth Ranjan", due_date: "28 Oct 2026", priority: "Critical", status: "Done" },
        { id: "3", deliverable: "Validate multi-surface lowerSurface text-to-speech spoken projection", owner: "Audio Lead", due_date: "30 Oct 2026", priority: "Medium", status: "Ready" },
        { id: "4", deliverable: "Assert container query reflow on 320px mobile viewport", owner: "QA Engineer", due_date: "31 Oct 2026", priority: "Medium", status: "Pending" },
        { id: "5", deliverable: "Ship verified v0.2.0 desktop release bundle to /Applications", owner: "Release Eng", due_date: "01 Nov 2026", priority: "High", status: "Scheduled" }
      ];
      const nodes: VpsNode[] = [
        {
          id: "root-section",
          type: "section",
          props: {
            title: "Sprint Architecture & Planning Sync — 28 Oct 2026",
            description: "Distilled decisions, action items, and open questions extracted from engineering discussion."
          },
          children: ["summary-grid", "decisions-section", "actions-section", "questions-section"]
        },
        {
          id: "summary-grid",
          type: "grid",
          props: { columns: 4, minItemWidth: "sm" },
          children: ["stat-decisions", "stat-actions", "stat-questions", "stat-blockers"]
        },
        { id: "stat-decisions", type: "stat", props: { label: "Decisions Ratified", value: 4, tone: "positive", subtext: "unanimous consent" } },
        { id: "stat-actions", type: "stat", props: { label: "Action Items Assigned", value: { records: "{/actions}", field: "id", aggregate: "count" }, tone: "info", subtext: "2 high priority" } },
        { id: "stat-questions", type: "stat", props: { label: "Open Questions", value: 2, tone: "caution", subtext: "assigned investigation leads" } },
        { id: "stat-blockers", type: "stat", props: { label: "Blocked Items", value: 0, tone: "neutral", subtext: "clear path to release" } },
        {
          id: "decisions-section",
          type: "section",
          props: { title: "Agreed Decisions & Architectural Direction" },
          children: ["decisions-grid"]
        },
        {
          id: "decisions-grid",
          type: "grid",
          props: { columns: 2, minItemWidth: "md" },
          children: ["decision-1", "decision-2"]
        },
        {
          id: "decision-1",
          type: "card",
          props: {
            title: "Seatbelt Sandbox Isolation",
            subtitle: "Security & Entitlements Boundary",
            tone: "positive"
          },
          children: ["decision-1-text"]
        },
        {
          id: "decision-1-text",
          type: "text",
          props: { value: "All external tool executions and script rehearsals must run inside isolated Seatbelt containers with SHA-256 integrity receipts before result emission." }
        },
        {
          id: "decision-2",
          type: "card",
          props: {
            title: "Dynamic Flow DAG & Taxonomy",
            subtitle: "Visual & Architectural Contract",
            tone: "info"
          },
          children: ["decision-2-text"]
        },
        {
          id: "decision-2-text",
          type: "text",
          props: { value: "Studio must construct execution DAGs dynamically from frontmatter tools and markdown sections rather than static placeholders." }
        },
        {
          id: "actions-section",
          type: "section",
          props: { title: "Assigned Action Items Register" },
          children: ["actions-table"]
        },
        {
          id: "actions-table",
          type: "table",
          props: {
            title: "Active Action Register",
            columns: ["deliverable", "owner", "due_date", "priority", "status"],
            rows: { records: "{/actions}", fields: ["deliverable", "owner", "due_date", "priority", "status"] },
            maxWidth: "full",
            searchable: true,
            sortable: true
          }
        },
        {
          id: "questions-section",
          type: "section",
          props: { title: "Open Questions & Deferred Topics" },
          children: ["question-card"]
        },
        {
          id: "question-card",
          type: "card",
          props: {
            title: "Ephemeral Sandbox Worker Warmup",
            subtitle: "Performance Investigation",
            tone: "caution"
          },
          children: ["question-text"]
        },
        {
          id: "question-text",
          type: "text",
          props: { value: "Investigate whether warming disposable Seatbelt workers reduces cold-start latency for prompt evaluations without violating process isolation boundaries. Assigned to Infra Team; reconvene on 31 Oct." }
        }
      ];
      return {
        id: snapId,
        version: 1,
        title: "Sprint Architecture & Planning Sync — 28 Oct 2026",
        data: { actions },
        nodes
      };
    }

    if (name === "market-dashboard") {
      const sectors = [
        { sector: "Nifty IT", return_pct: 1.82 },
        { sector: "Nifty Metal", return_pct: 1.45 },
        { sector: "Nifty Energy", return_pct: 0.84 },
        { sector: "Nifty FMCG", return_pct: 0.32 },
        { sector: "Nifty Auto", return_pct: -0.54 }
      ];
      const breadth = [
        { status: "Advances", count: 34 },
        { status: "Declines", count: 16 }
      ];
      const equities = [
        { symbol: "RELIANCE", ltp: 2745.20, change_pct: "+1.20%", volume: "4.8M", trend: "Bullish" },
        { symbol: "TCS", ltp: 3980.50, change_pct: "+2.10%", volume: "3.2M", trend: "Bullish" },
        { symbol: "HDFCBANK", ltp: 1680.00, change_pct: "+0.40%", volume: "6.1M", trend: "Consolidating" },
        { symbol: "INFY", ltp: 1840.10, change_pct: "+1.90%", volume: "5.4M", trend: "Bullish" },
        { symbol: "ICICIBANK", ltp: 1240.30, change_pct: "+0.60%", volume: "4.1M", trend: "Positive" }
      ];
      const nodes: VpsNode[] = [
        {
          id: "root-section",
          type: "section",
          props: {
            title: "Indian Markets Close — NSE / BSE Session 28 Oct 2026",
            description: "Benchmark indices, sectoral rotation, market breadth, and top active equities."
          },
          children: ["indices-grid", "analytics-split", "equities-section"]
        },
        {
          id: "indices-grid",
          type: "grid",
          props: { columns: 4, minItemWidth: "sm" },
          children: ["idx-nifty", "idx-sensex", "idx-bank", "idx-vix"]
        },
        { id: "idx-nifty", type: "stat", props: { label: "NIFTY 50", value: "24,399.40", change: "+0.68%", tone: "positive", subtext: "+164.25 pts" } },
        { id: "idx-sensex", type: "stat", props: { label: "SENSEX", value: "80,220.72", change: "+0.75%", tone: "positive", subtext: "+600.40 pts" } },
        { id: "idx-bank", type: "stat", props: { label: "BANK NIFTY", value: "51,280.15", change: "+0.42%", tone: "positive", subtext: "+215.10 pts" } },
        { id: "idx-vix", type: "stat", props: { label: "INDIA VIX", value: "14.18", change: "-3.20%", tone: "neutral", subtext: "Volatility subsiding" } },
        {
          id: "analytics-split",
          type: "split",
          props: { ratio: "2:1", maxWidth: "lg" },
          children: ["sector-chart", "breadth-chart"]
        },
        {
          id: "sector-chart",
          type: "chart",
          props: {
            title: "Top Sector Returns (%)",
            kind: "bar",
            series: { records: "{/sectors}", label: "sector", fields: ["return_pct"] }
          }
        },
        {
          id: "breadth-chart",
          type: "chart",
          props: {
            title: "Nifty 50 Advance / Decline",
            kind: "pie",
            series: { records: "{/breadth}", label: "status", fields: ["count"] }
          }
        },
        {
          id: "equities-section",
          type: "section",
          props: { title: "Top Active Equities by Turnover" },
          children: ["equities-table"]
        },
        {
          id: "equities-table",
          type: "table",
          props: {
            title: "NSE Most Active",
            columns: ["symbol", "ltp", "change_pct", "volume", "trend"],
            rows: { records: "{/equities}", fields: ["symbol", "ltp", "change_pct", "volume", "trend"] },
            maxWidth: "full",
            searchable: true,
            sortable: true
          }
        }
      ];
      return {
        id: snapId,
        version: 1,
        title: "Indian Markets Close — NSE / BSE Session 28 Oct 2026",
        data: { sectors, breadth, equities },
        nodes
      };
    }

    if (name === "task-tracker") {
      const tasks = [
        { task_id: "VAK-101", title: "Dynamic Flow DAG taxonomy parser", assignee: "Nisheeth", priority: "Critical", status: "Done", deadline: "28 Oct" },
        { task_id: "VAK-102", title: "Domain-specific canvas preview synthesizers", assignee: "Nisheeth", priority: "Critical", status: "In Progress", deadline: "28 Oct" },
        { task_id: "VAK-103", title: "Verify Seatbelt sandbox exit codes in runner", assignee: "Infra", priority: "High", status: "In Progress", deadline: "29 Oct" },
        { task_id: "VAK-104", title: "WebKit 320px container query responsiveness check", assignee: "QA", priority: "Medium", status: "Review", deadline: "30 Oct" },
        { task_id: "VAK-105", title: "Dual spoken audio lowerSurface narration check", assignee: "Audio", priority: "Medium", status: "Open", deadline: "31 Oct" }
      ];
      const priorities = [
        { priority: "Critical", count: 2 },
        { priority: "High", count: 1 },
        { priority: "Medium", count: 2 }
      ];
      const nodes: VpsNode[] = [
        {
          id: "root-section",
          type: "section",
          props: { title: "Engineering Sprint Backlog — Milestone 0.2.0", description: "Active deliverables, task states, assignees, and release countdown." },
          children: ["summary-grid", "analytics-split", "tasks-table"]
        },
        {
          id: "summary-grid",
          type: "grid",
          props: { columns: 4, minItemWidth: "sm" },
          children: ["t-total", "t-done", "t-prog", "t-review"]
        },
        { id: "t-total", type: "stat", props: { label: "Total Tasks", value: 5, tone: "info" } },
        { id: "t-done", type: "stat", props: { label: "Completed", value: 1, tone: "positive" } },
        { id: "t-prog", type: "stat", props: { label: "In Progress", value: 2, tone: "caution" } },
        { id: "t-review", type: "stat", props: { label: "Under Review", value: 1, tone: "info" } },
        {
          id: "analytics-split",
          type: "split",
          props: { ratio: "2:1", maxWidth: "lg" },
          children: ["priority-chart", "workflow-card"]
        },
        {
          id: "priority-chart",
          type: "chart",
          props: { title: "Priority Breakdown", kind: "bar", series: { records: "{/priorities}", label: "priority", fields: ["count"] } }
        },
        {
          id: "workflow-card",
          type: "card",
          props: { title: "Milestone Velocity", subtitle: "Sprint 4", tone: "positive" },
          children: ["workflow-text"]
        },
        {
          id: "workflow-text",
          type: "text",
          props: { value: "On track for Milestone 0.2.0 delivery. Zero critical blockers detected across current sprint cycle." }
        },
        {
          id: "tasks-table",
          type: "table",
          props: {
            title: "Sprint Tasks",
            columns: ["task_id", "title", "assignee", "priority", "status", "deadline"],
            rows: { records: "{/tasks}", fields: ["task_id", "title", "assignee", "priority", "status", "deadline"] },
            maxWidth: "full",
            searchable: true,
            sortable: true
          }
        }
      ];
      return {
        id: snapId,
        version: 1,
        title: "Engineering Sprint Backlog — Milestone 0.2.0",
        data: { tasks, priorities },
        nodes
      };
    }

    if (name === "code-review") {
      const findings = [
        { file: "src/skills-studio.ts", line: "1080", severity: "Medium", finding: "Flow DAG nodes were previously static templates", recommendation: "Generate DAG dynamically from skill frontmatter and headings" },
        { file: "src/skills-studio.ts", line: "1356", severity: "Medium", finding: "Surface preview fell back to generic Alpha Segment data", recommendation: "Construct authentic domain-specific surfaces per skill category" },
        { file: "src/skills-studio.ts", line: "649", severity: "Low", finding: "Test prompts used generic template questions", recommendation: "Extract domain-specific positive and distractor prompts" }
      ];
      const nodes: VpsNode[] = [
        {
          id: "root-section",
          type: "section",
          props: { title: "Code Review & Quality Audit — src/skills-studio.ts", description: "Automated static analysis, architectural boundary enforcement, and refactor items." },
          children: ["audit-grid", "findings-table", "boundary-grid"]
        },
        {
          id: "audit-grid",
          type: "grid",
          props: { columns: 4, minItemWidth: "sm" },
          children: ["a-files", "a-findings", "a-blockers", "a-gate"]
        },
        { id: "a-files", type: "stat", props: { label: "Files Audited", value: 14, tone: "info" } },
        { id: "a-findings", type: "stat", props: { label: "Findings", value: 3, tone: "caution" } },
        { id: "a-blockers", type: "stat", props: { label: "Critical Blockers", value: 0, tone: "positive" } },
        { id: "a-gate", type: "stat", props: { label: "Quality Gate", value: "PASSED", tone: "positive" } },
        {
          id: "findings-table",
          type: "table",
          props: {
            title: "Audit Findings & Recommendations",
            columns: ["file", "line", "severity", "finding", "recommendation"],
            rows: { records: "{/findings}", fields: ["file", "line", "severity", "finding", "recommendation"] },
            maxWidth: "full",
            searchable: true,
            sortable: true
          }
        },
        {
          id: "boundary-grid",
          type: "grid",
          props: { columns: 2, minItemWidth: "md" },
          children: ["b-sandbox", "b-types"]
        },
        {
          id: "b-sandbox",
          type: "card",
          props: { title: "Seatbelt Sandbox Isolation", subtitle: "Process Boundaries", tone: "positive" },
          children: ["b-sandbox-text"]
        },
        { id: "b-sandbox-text", type: "text", props: { value: "All script rehearsals strictly constrained to disposable sandbox processes with zero ambient host access." } },
        {
          id: "b-types",
          type: "card",
          props: { title: "Strict TypeScript Strictness", subtitle: "Type Safety", tone: "positive" },
          children: ["b-types-text"]
        },
        { id: "b-types-text", type: "text", props: { value: "Full strict mode enabled with zero implicit any or unchecked index accesses." } }
      ];
      return {
        id: snapId,
        version: 1,
        title: "Code Review & Quality Audit — src/skills-studio.ts",
        data: { findings },
        nodes
      };
    }

    // 3. General domain synthesis from skill description and body headings
    const title = name.replace(/-/g, " ");
    const headings = (skill.body || skill.text || "")
      .split(/\r?\n/)
      .filter(l => /^##\s+/.test(l))
      .map(l => l.replace(/^##\s+/, "").trim())
      .filter(h => !/overview|boundaries|chaining|theming|style/i.test(h))
      .slice(0, 4);

    const records = [
      { id: "1", item: `${title} Primary Procedure`, category: "Core", priority: "High", status: "Active" },
      { id: "2", item: "Validation and Output Review", category: "Quality", priority: "High", status: "Pending" },
      { id: "3", item: "Surface Projection Mounting", category: "UI", priority: "Medium", status: "Ready" }
    ];

    const nodes: VpsNode[] = [
      {
        id: "root-section",
        type: "section",
        props: { title: `${title.charAt(0).toUpperCase() + title.slice(1)} Workbench`, description: skill.description },
        children: ["metric-grid", ...(headings.length > 0 ? ["headings-grid"] : []), "records-table"]
      },
      {
        id: "metric-grid",
        type: "grid",
        props: { columns: 3, minItemWidth: "sm" },
        children: ["m1", "m2", "m3"]
      },
      { id: "m1", type: "stat", props: { label: "Execution Status", value: "Ready", tone: "positive" } },
      { id: "m2", type: "stat", props: { label: "Declared Tools", value: (skill.allowedTools ?? "read_skill_file").split(/\s+/).length, tone: "info" } },
      { id: "m3", type: "stat", props: { label: "Output Mode", value: "3-Tier Canvas", tone: "positive" } }
    ];

    if (headings.length > 0) {
      nodes.push({
        id: "headings-grid",
        type: "grid",
        props: { columns: Math.min(headings.length, 2), minItemWidth: "md" },
        children: headings.map((_, i) => `heading-card-${i}`)
      });
      headings.forEach((h, i) => {
        nodes.push({
          id: `heading-card-${i}`,
          type: "card",
          props: { title: h, subtitle: "Operational Procedure", tone: i === 0 ? "positive" : "info" },
          children: [`heading-text-${i}`]
        });
        nodes.push({
          id: `heading-text-${i}`,
          type: "text",
          props: { value: `Adheres to the ${h} guidelines defined in ${name}/SKILL.md.` }
        });
      });
    }

    nodes.push({
      id: "records-table",
      type: "table",
      props: {
        title: "Procedure Items",
        columns: ["id", "item", "category", "priority", "status"],
        rows: { records: "{/records}", fields: ["id", "item", "category", "priority", "status"] },
        maxWidth: "full",
        searchable: true,
        sortable: true
      }
    });

    return {
      id: snapId,
      version: 1,
      title: `${title.charAt(0).toUpperCase() + title.slice(1)} Workbench`,
      data: { records },
      nodes
    };
  }

  function generateSkillDag(skill: SkillView, _pkg: SkillPackageView | null, evalRes: SkillEvalResult[]): { nodes: DagNodeDef[]; edges: DagEdgeDef[] } {
    const nodes: DagNodeDef[] = [];
    const edges: DagEdgeDef[] = [];

    const prompts = getDomainTestPrompts(skill);
    const samplePrompt = prompts.positive[0] || `Execute ${skill.name}`;

    // 1. Trigger Node
    nodes.push({
      id: "prompt",
      title: `User Intent: ${skill.name}`,
      glyph: "bubble",
      detail: `"${samplePrompt.length > 36 ? samplePrompt.slice(0, 34) + "…" : samplePrompt}"`,
      badge: "Trigger",
      x: 40,
      y: 160,
      width: 220,
      height: 80,
      inspectorText: `Semantic trigger prompt evaluated against description: "${skill.description}". Routes to this skill when cosine similarity threshold is satisfied on active local model.`
    });

    // 2. Gateway Node
    const evalPassed = evalRes.length > 0 && evalRes.every(r => r.passed);
    const evalBadge = evalRes.length > 0 ? (evalPassed ? `${evalRes.length}/${evalRes.length} Pass` : "Gate Warn") : "Gate";
    nodes.push({
      id: "gate",
      title: `use_skill: ${skill.name}`,
      glyph: "spark",
      detail: `Model Selection Gate · Local 4B / Ollama`,
      badge: evalBadge,
      x: 300,
      y: 160,
      width: 220,
      height: 80,
      inspectorText: `Gateway evaluates intent and injects skill prompt. Skill: ${skill.name}. Required: ${skill.required ? "System Required" : "Configured"}. Allowed tools: ${skill.allowedTools || "read_skill_file"}.${evalRes.length > 0 ? ` Latest rehearsal gate: ${evalRes.filter(r => r.passed).length}/${evalRes.length} test scenarios passed.` : ""}`
    });
    edges.push({ from: "prompt", to: "gate" });

    // 3. Tier 2: Declared Tools & Chained Skills (Column 2, x: 560)
    const declaredTools = (skill.allowedTools || "read_skill_file").split(/\s+/).filter(Boolean);
    const tier2NodeIds: string[] = [];
    let tier2Y = 40;

    for (const t of declaredTools) {
      const id = `tool-${t}`;
      tier2NodeIds.push(id);
      let detail = "Host / Runtime Tool Boundary";
      let glyph = "shield";
      let desc = `Tool declared in frontmatter: ${t}. Rehearsed in isolated Seatbelt sandbox.`;
      if (t === "read_skill_file") {
        detail = "Read SKILL.md & references";
        glyph = "page";
        desc = "Reads markdown instructions and supporting schemas from disk without host mutation.";
      } else if (t === "vak_render") {
        detail = "Mount Canvas Surface";
        glyph = "canvas";
        desc = "Instantiates and renders declarative surface nodes onto the interactive canvas.";
      } else if (t === "vak_update") {
        detail = "Patch Surface State";
        glyph = "spark";
        desc = "Patches canonical store records and state without tearing down mounted UI tree.";
      } else if (t === "vak_submit") {
        detail = "Form Submission Handler";
        glyph = "send";
        desc = "Dispatches user interaction and form submissions to background handler.";
      } else if (t === "use_skill") {
        detail = "Chain Subordinate Skills";
        glyph = "branch";
        desc = "Invokes secondary or subordinate skills in execution pipeline.";
      }

      nodes.push({
        id,
        title: t,
        glyph,
        detail,
        badge: "Tool",
        x: 560,
        y: tier2Y,
        width: 220,
        height: 76,
        inspectorText: desc,
        removableType: "tool",
        removableValue: t
      });
      edges.push({ from: "gate", to: id });
      tier2Y += 92;
    }

    // Chained skills detected in body/text
    const knownChainSkills = ["interactive-ui", "surface-design", "summarize", "task-tracker", "nse-mcp"];
    const bodyText = skill.body || skill.text || "";
    for (const c of knownChainSkills) {
      if (c === skill.name) continue;
      if (new RegExp(`\\b${c}\\b`, "i").test(bodyText)) {
        const id = `chain-${c}`;
        tier2NodeIds.push(id);
        let detail = "Chained Procedural Contract";
        let desc = `Chains to ${c} procedure as specified in ${skill.name}/SKILL.md.`;
        if (c === "interactive-ui") {
          detail = "Data Binding & Forms";
          desc = "Binds user inputs, form controls, and filters to canonical data collections.";
        } else if (c === "surface-design") {
          detail = "3-Tier Layout Standard";
          desc = "Enforces 3-tier layout across 320px mobile, 720px form, and 960px desktop containers.";
        } else if (c === "summarize") {
          detail = "Narrative Distillation";
          desc = "Distills unstructured text and transcripts into concise findings.";
        } else if (c === "task-tracker") {
          detail = "Backlog Integration";
          desc = "Folds extracted deliverables and actions into the project backlog.";
        }

        nodes.push({
          id,
          title: `Chain: ${c}`,
          glyph: "branch",
          detail,
          badge: "Contract",
          x: 560,
          y: tier2Y,
          width: 220,
          height: 76,
          inspectorText: desc,
          removableType: "chain",
          removableValue: c
        });
        edges.push({ from: "gate", to: id });
        tier2Y += 92;
      }
    }

    // 4. Tier 3: Operational Stages / Taxonomy (Column 3, x: 820)
    const tier3NodeIds: string[] = [];
    let tier3Y = 40;

    if (skill.name === "meeting-actions") {
      const stages = [
        { id: "stage-decisions", title: "Agreed Decisions Extraction", detail: "Formal choices & rationale", badge: "Taxonomy", glyph: "shield", text: "Documents formal choices, approved proposals, architectural decisions, and rationale agreed upon by the group." },
        { id: "stage-actions", title: "Action Item Assignment", detail: "Deliverable, owner & deadline", badge: "Taxonomy", glyph: "table", text: "Extracts specific tasks with clear imperative verb deliverable, named owner, and explicit target due date." },
        { id: "stage-questions", title: "Open Questions & Deferrals", detail: "Unresolved topics & leads", badge: "Taxonomy", glyph: "bubble", text: "Records issues discussed but left unresolved, with designated investigation owners." }
      ];
      for (const s of stages) {
        nodes.push({ id: s.id, title: s.title, glyph: s.glyph, detail: s.detail, badge: s.badge, x: 820, y: tier3Y, width: 220, height: 76, inspectorText: s.text, removableType: "stage", removableValue: s.title });
        tier3NodeIds.push(s.id);
        tier3Y += 92;
      }
    } else if (skill.name === "market-dashboard") {
      const stages = [
        { id: "stage-indices", title: "Indices & Derivatives Pulse", detail: "NIFTY, SENSEX, BANK, VIX", badge: "Taxonomy", glyph: "spark", text: "Fetches headline equity index valuations, daily percentage movements, and volatility measures." },
        { id: "stage-breadth", title: "Sector Returns & Breadth", detail: "Advance/decline distribution", badge: "Taxonomy", glyph: "chart", text: "Computes advance/decline ratio and sectoral leadership rotation." },
        { id: "stage-equities", title: "Active Equities Price Action", detail: "Top volume turnover", badge: "Taxonomy", glyph: "table", text: "Extracts top volume gainers, losers, and price trends for key equities." }
      ];
      for (const s of stages) {
        nodes.push({ id: s.id, title: s.title, glyph: s.glyph, detail: s.detail, badge: s.badge, x: 820, y: tier3Y, width: 220, height: 76, inspectorText: s.text, removableType: "stage", removableValue: s.title });
        tier3NodeIds.push(s.id);
        tier3Y += 92;
      }
    } else if (skill.name === "code-review") {
      const stages = [
        { id: "stage-syntax", title: "Type Safety & Syntax Audit", detail: "Strict TypeScript checks", badge: "Taxonomy", glyph: "code", text: "Validates type strictness, interface declarations, and prevents implicit any." },
        { id: "stage-security", title: "Entitlements & Sandboxing", detail: "Process boundary audit", badge: "Taxonomy", glyph: "shield", text: "Checks that external tools and scripts run under verified sandbox profiles." },
        { id: "stage-recs", title: "Actionable Refactor Plan", detail: "Targeted code improvements", badge: "Taxonomy", glyph: "spark", text: "Generates file/line-level recommendations with non-breaking replacements." }
      ];
      for (const s of stages) {
        nodes.push({ id: s.id, title: s.title, glyph: s.glyph, detail: s.detail, badge: s.badge, x: 820, y: tier3Y, width: 220, height: 76, inspectorText: s.text, removableType: "stage", removableValue: s.title });
        tier3NodeIds.push(s.id);
        tier3Y += 92;
      }
    } else {
      const headings = bodyText.split(/\r?\n/)
        .filter(l => /^##\s+/.test(l))
        .map(l => l.replace(/^##\s+/, "").trim())
        .filter(h => !/overview|boundaries|chaining|theming|style/i.test(h))
        .slice(0, 3);
      const stages = headings.length > 0 ? headings : ["Core Domain Procedure", "Verification & Synthesis"];
      for (let i = 0; i < stages.length; i++) {
        const h = stages[i]!;
        const id = `stage-${i}`;
        nodes.push({
          id,
          title: h,
          glyph: "page",
          detail: "Operational Procedure Step",
          badge: "Taxonomy",
          x: 820,
          y: tier3Y,
          width: 220,
          height: 76,
          inspectorText: `Operational procedure step "${h}" defined in ${skill.name}/SKILL.md.`,
          removableType: "stage",
          removableValue: h
        });
        tier3NodeIds.push(id);
        tier3Y += 92;
      }
    }

    // Connect Tier 2 -> Tier 3
    for (const src of tier2NodeIds) {
      for (const dst of tier3NodeIds) {
        edges.push({ from: src, to: dst });
      }
    }

    // 5. Tier 4: Canonical Store
    let storePath = "{/records}";
    let storeDesc = "Canonical state mapped to {/records}. Prevents divergent values across UI and audio.";
    if (skill.name === "meeting-actions") {
      storePath = "{/actions, /decisions}";
      storeDesc = "Single source of truth for action items and ratified decisions. Feeds both visual action register and spoken audio summary.";
    } else if (skill.name === "market-dashboard") {
      storePath = "{/sectors, /breadth, /equities}";
      storeDesc = "Canonical collections for market breadth, sectoral performance, and active equities.";
    } else if (skill.name === "task-tracker") {
      storePath = "{/tasks, /priorities}";
      storeDesc = "Sprint task repository mapped to reactive tables and velocity cards.";
    } else if (skill.name === "code-review") {
      storePath = "{/findings}";
      storeDesc = "Structured static analysis findings with line references and severity classifications.";
    }

    nodes.push({
      id: "store",
      title: "Canonical Data Store",
      glyph: "table",
      detail: storePath,
      badge: "Data",
      x: 1080,
      y: 160,
      width: 220,
      height: 80,
      inspectorText: storeDesc
    });

    for (const src of tier3NodeIds) {
      edges.push({ from: src, to: "store" });
    }

    // 6. Tier 5: Output Projections
    nodes.push({
      id: "surface",
      title: "3-Tier Canvas Surface",
      glyph: "canvas",
      detail: "Executive, Analytics & Table",
      badge: "Visual",
      x: 1340,
      y: 90,
      width: 220,
      height: 80,
      inspectorText: "3-Tier liquid layout reflows across 320px mobile, 720px form, and 960px desktop containers. Preserves responsive data visualization."
    });
    edges.push({ from: "store", to: "surface" });

    nodes.push({
      id: "voice",
      title: "Dual Spoken Projection",
      glyph: "voice",
      detail: "lowerSurface TTS Audio Narrative",
      badge: "Spoken",
      x: 1340,
      y: 220,
      width: 220,
      height: 80,
      inspectorText: "lowerSurface audio readout. Synthesized from resolved surface snapshot: leading sentence carries the primary finding and key caveat for spoken playback."
    });
    edges.push({ from: "surface", to: "voice" });

    return { nodes, edges };
  }

  function generateAppDag(app: AppDetails): { nodes: DagNodeDef[]; edges: DagEdgeDef[] } {
    const nodes: DagNodeDef[] = [];
    const edges: DagEdgeDef[] = [];

    const trigger = app.manifest.triggers[0]?.expression || "Manual / Cron Trigger";
    nodes.push({
      id: "trigger",
      title: "Cron / Action Trigger",
      glyph: "clock",
      detail: trigger,
      badge: "Trigger",
      x: 40,
      y: 140,
      width: 220,
      height: 80,
      inspectorText: `Triggers configured: ${app.manifest.triggers.map(t => `${t.id} (${t.expression ?? t.kind})`).join(", ")}.`
    });

    nodes.push({
      id: "worker",
      title: "Sandboxed Worker",
      glyph: "cpu",
      detail: `Node 24 · ${app.manifest.runtime.memoryLimitMb}MB Limit`,
      badge: "Isolated",
      x: 300,
      y: 140,
      width: 220,
      height: 80,
      inspectorText: `Backend entrypoint: ${app.manifest.entrypoints.backend || "server.ts"}. Maximum execution CPU time: ${app.manifest.runtime.cpuTimeLimitSec}s.`
    });
    edges.push({ from: "trigger", to: "worker" });

    nodes.push({
      id: "security",
      title: "Seatbelt Sandbox Boundary",
      glyph: "shield",
      detail: `Network: ${app.manifest.entitlements.network.mode}`,
      badge: "Security",
      x: 560,
      y: 70,
      width: 220,
      height: 80,
      inspectorText: `Airgap mode: ${app.manifest.entitlements.network.mode}. Ambient host network and unapproved filesystem paths strictly restricted.`
    });
    edges.push({ from: "worker", to: "security" });

    nodes.push({
      id: "storage",
      title: "Airgapped SQLite Storage",
      glyph: "memory",
      detail: `${app.manifest.runtime.maxStorageMb}MB Storage Quota`,
      badge: "Storage",
      x: 560,
      y: 210,
      width: 220,
      height: 80,
      inspectorText: `Embedded SQLite: ${app.manifest.entitlements.storage.sqlite ? "Enabled" : "Disabled"}. Persistent storage quota: ${app.manifest.runtime.maxStorageMb}MB.`
    });
    edges.push({ from: "worker", to: "storage" });

    nodes.push({
      id: "canvas",
      title: "Companion Canvas Surface",
      glyph: "canvas",
      detail: app.manifest.entrypoints.surface || "surface.json",
      badge: "Surface",
      x: 820,
      y: 140,
      width: 220,
      height: 80,
      inspectorText: `Companion surface: ${app.manifest.entrypoints.surface || "surface.json"}. Reactive UI dispatches user actions back to sandboxed worker.`
    });
    edges.push({ from: "security", to: "canvas" });
    edges.push({ from: "storage", to: "canvas" });

    return { nodes, edges };
  }

  // Test prompt evaluation
  async function runEvaluation(): Promise<void> {
    if (isRunningTests || !currentSkillPkg) return;
    isRunningTests = true;
    evalResults = [];
    render();
    try {
      const testsFile = currentSkillPkg.files.find(f => f.path.includes("tests/") || f.path.includes("test_scenarios.json"));
      let testPrompts: string[] = [];
      if (testsFile) {
        try {
          const parsed = JSON.parse(testsFile.text);
          if (Array.isArray(parsed.positive_prompts)) {
            testPrompts = [...parsed.positive_prompts, ...(parsed.distractor_prompts ?? [])];
          }
        } catch {}
      }
      if (testPrompts.length === 0) {
        const domain = getDomainTestPrompts(currentSkillPkg.skill);
        testPrompts = [...domain.positive, ...domain.distractor];
      }

      evalResults = await api<SkillEvalResult[]>("/api/skills/eval", {
        method: "POST",
        body: JSON.stringify({
          name: currentSkillPkg.skill.name,
          prompts: testPrompts
        })
      });
      const passedCount = evalResults.filter(r => r.passed).length;
      showNotice(`Evaluation complete: ${passedCount}/${evalResults.length} test scenarios passed.`);
    } catch (err) {
      showError(err);
    } finally {
      isRunningTests = false;
      render();
    }
  }

  // Sandbox script test execution
  async function runSandboxTest(scriptPath: string): Promise<void> {
    if (activeKind === "app" && currentAppDetails) {
      try {
        if (isDirty || !appDraftFingerprint) await saveDraftAction(true);
        if (isDirty) throw new Error("Save the current draft before rehearsal");
        const result = await api(`/api/apps/${encodeURIComponent(currentAppDetails.manifest.id)}/rehearse`, { method: "POST", body: JSON.stringify({ fingerprint: appDraftFingerprint, controlId: "rehearsal", value: null }) });
        showNotice(`Isolated app rehearsal completed: ${JSON.stringify(result).slice(0, 1000)}`);
      } catch (error) { showError(error); }
      return;
    }
    if (isRunningSandbox || !currentSkillPkg) return;
    isRunningSandbox = true;
    sandboxLog = null;
    render();
    try {
      if (isDirty) {
        await saveDraftAction(true);
        if (isDirty) throw new Error("Save draft before running its script.");
      }
      const script = currentSkillPkg.files.find(file => file.path === scriptPath);
      if (!script) throw new Error("Choose a script from this package.");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script.text));
      const scriptSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      sandboxLog = await api<SkillSandboxRunResponse>(`/api/skills/${encodeURIComponent(currentSkillPkg.skill.name)}/sandbox-test`, {
        method: "POST",
        body: JSON.stringify({ scriptPath, scriptSha256 })
      });
      if (sandboxLog.exitCode === 0) {
        showNotice(`Script exited successfully in ${sandboxLog.durationMs}ms in disposable sandbox.`);
      } else {
        showError(new Error(`Sandbox script exited with code ${sandboxLog.exitCode}: ${sandboxLog.stderr || sandboxLog.stdout}`));
      }
    } catch (err) {
      showError(err);
    } finally {
      isRunningSandbox = false;
      render();
    }
  }

  // --- Render Views ---

  function renderHub(): HTMLElement {
    const hub = el("div", { className: "studio-hub" });

    // Hub Header
    const titleCol = el("div", {},
      el("h1", { className: "studio-hub-title", textContent: "Creator Studio" }),
      el("p", { className: "studio-hub-subtitle", textContent: "Author, orchestrate, test, and rehearse Agent Skills and Sandboxed Dynamic Applications in a governed runtime." })
    );

    const newSkillBtn = el("button", {
      type: "button",
      className: "primary small",
      onclick: () => {
        const name = window.prompt("New Skill identifier (lowercase hyphenated, e.g. market-analyzer):", "custom-skill");
        if (!name || !name.trim()) return;
        activeItemName = name.trim();
        sessionActiveItemName = name.trim();
        activeKind = "skill";
        sessionActiveKind = "skill";
        initNewSkill(name.trim());
        render();
      }
    }, icon("plus", 14), el("span", { textContent: "New Skill" }));

    const newAppBtn = el("button", {
      type: "button",
      className: "ghost small",
      onclick: () => {
        const name = window.prompt("New Sandboxed App identifier (lowercase hyphenated, e.g. risk-dashboard):", "custom-app");
        if (!name || !name.trim()) return;
        activeItemName = name.trim();
        sessionActiveItemName = name.trim();
        activeKind = "app";
        sessionActiveKind = "app";
        initNewApp(name.trim());
        render();
      }
    }, icon("cpu", 14), el("span", { textContent: "New Sandboxed App" }));

    const headActions = el("div", { className: "studio-hub-actions" }, newSkillBtn, newAppBtn);
    const headRow = el("div", { className: "studio-hub-header" }, titleCol, headActions);

    // Working Drafts Banner
    const draftSkills = installedSkills.filter(s => s.hasDraft);
    const draftBanner = draftSkills.length > 0 ? el("div", { className: "studio-draft-banner" },
      el("div", { className: "studio-draft-banner-text" },
        icon("spark", 16),
        el("strong", { textContent: `${draftSkills.length} Unpublished Draft${draftSkills.length > 1 ? "s" : ""}: ` }),
        el("span", { textContent: draftSkills.map(s => s.name).join(", ") })
      ),
      el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "Resume First Draft",
        onclick: async () => {
          activeItemName = draftSkills[0]!.name;
          activeKind = "skill";
          await loadItemData(activeItemName, "skill");
          render();
        }
      })
    ) : null;

    // Filter and Search Bar
    const filterTabs = el("div", { className: "studio-filter-tabs" });
    const filters = [
      ["all", `All Items (${installedSkills.length + installedApps.length})`],
      ["skills", `Skills (${installedSkills.length})`],
      ["apps", `Sandboxed Apps (${installedApps.length})`],
      ["drafts", `Drafts (${draftSkills.length})`],
    ] as const;

    for (const [key, label] of filters) {
      const b = el("button", {
        type: "button",
        className: `studio-filter-tab${hubFilter === key ? " active" : ""}`,
        textContent: label,
        onclick: () => { hubFilter = key; render(); }
      });
      filterTabs.append(b);
    }

    const searchInput = el("input", {
      type: "search",
      placeholder: "Filter skills and apps…",
      value: hubQuery
    });
    searchInput.oninput = () => { hubQuery = searchInput.value.toLowerCase().trim(); render(); };

    const searchBox = el("div", { className: "studio-search-box" }, icon("search", 14), searchInput);
    const filterRow = el("div", { className: "studio-filter-row" }, filterTabs, searchBox);

    // Grid of Items
    const grid = el("div", { className: "studio-grid" });

    // 1. Skill items
    if (hubFilter === "all" || hubFilter === "skills" || hubFilter === "drafts") {
      for (const s of installedSkills) {
        if (hubFilter === "drafts" && !s.hasDraft) continue;
        if (hubQuery && !s.name.toLowerCase().includes(hubQuery) && !s.description.toLowerCase().includes(hubQuery)) continue;

        const card = el("div", {
          className: "studio-card",
          onclick: async () => {
            activeItemName = s.name;
            activeKind = "skill";
            await loadItemData(s.name, "skill");
            render();
          }
        });

        const iconBox = el("div", { className: "studio-card-icon" }, icon("spark", 18));
        const titleRow = el("div", { className: "studio-card-title-row" },
          el("h3", { className: "studio-card-title", textContent: s.name }),
          pill(s.builtin ? "Built in" : "Yours", "info"),
          s.hasDraft ? pill("Draft", "caution") : pill("Published", "ok")
        );
        const desc = el("p", { className: "studio-card-desc", textContent: s.description });
        const head = el("div", { className: "studio-card-head" }, iconBox, el("div", { className: "studio-card-info" }, titleRow, desc));

        const footMeta = el("div", { className: "studio-card-meta" },
          pill("Skill"),
          s.allowedTools ? pill(`Tools: ${s.allowedTools.split(/\s+/).length}`) : null,
          s.files?.length ? pill(`${s.files.length} files`) : null
        );
        const openBtn = el("button", { type: "button", className: "ghost tiny", textContent: "Edit in Studio →" });
        const foot = el("div", { className: "studio-card-foot" }, footMeta, openBtn);

        card.append(head, foot);
        grid.append(card);
      }
    }

    // 2. App items
    if (hubFilter === "all" || hubFilter === "apps" || hubFilter === "drafts") {
      for (const a of installedApps) {
        if (hubFilter === "drafts" && !a.isDraft) continue;
        if (hubQuery && !a.name.toLowerCase().includes(hubQuery) && !a.description.toLowerCase().includes(hubQuery)) continue;

        const card = el("div", {
          className: "studio-card",
          onclick: async () => {
            activeItemName = a.id;
            activeKind = "app";
            await loadItemData(a.id, "app");
            render();
          }
        });

        const iconBox = el("div", { className: "studio-card-icon" }, icon("cpu", 18));
        const titleRow = el("div", { className: "studio-card-title-row" },
          el("h3", { className: "studio-card-title", textContent: a.name }),
          pill("Sandboxed App", "info"),
          a.isDraft ? pill("Draft", "caution") : a.isRunning ? pill("Live", "ok") : pill("Ready")
        );
        const desc = el("p", { className: "studio-card-desc", textContent: a.description });
        const head = el("div", { className: "studio-card-head" }, iconBox, el("div", { className: "studio-card-info" }, titleRow, desc));

        const footMeta = el("div", { className: "studio-card-meta" },
          pill(a.category || "App"),
          pill(`v${a.version}`),
          a.triggerCount > 0 ? pill(`${a.triggerCount} cron triggers`) : null
        );
        const openBtn = el("button", { type: "button", className: "ghost tiny", textContent: "Open in Studio →" });
        const foot = el("div", { className: "studio-card-foot" }, footMeta, openBtn);

        card.append(head, foot);
        grid.append(card);
      }
    }

    hub.append(headRow, ...(draftBanner ? [draftBanner] : []), filterRow, grid);
    return hub;
  }

  // --- View 1: Spec & Code Editor ---
  function renderSpecView(): HTMLElement {
    const wrap = el("div", { className: "studio-code-view" });

    if (activeKind === "skill" && currentSkillPkg) {
      if (activeFileName === "SKILL.md") {
        const nameInput = el("input", {
          type: "text",
          className: "studio-input",
          value: currentSkillPkg.skill.name,
          placeholder: "e.g. market-analyzer"
        });
        nameInput.oninput = () => {
          rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
        };

        const descInput = el("textarea", {
          className: "studio-input",
          rows: 3,
          value: currentSkillPkg.skill.description,
          placeholder: "Stated in third person: Analyze domain records, detect anomalies..."
        });
        const descCount = el("span", { className: "desc-counter", textContent: `${currentSkillPkg.skill.description.length}/1024 chars` });
        descInput.oninput = () => {
          descCount.textContent = `${descInput.value.length}/1024 chars`;
          rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
        };

        const toolsInput = el("input", {
          type: "text",
          className: "studio-input",
          value: currentSkillPkg.skill.allowedTools ?? "",
          placeholder: "read_skill_file run_command"
        });
        toolsInput.oninput = () => {
          rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
        };

        const declaredList = (currentSkillPkg.skill.allowedTools ?? "").split(/\s+/).filter(Boolean);
        const seenToolIds = new Set<string>();
        const chipTools: { id: string; name: string }[] = [];
        for (const d of declaredList) {
          if (!seenToolIds.has(d)) {
            seenToolIds.add(d);
            chipTools.push({ id: d, name: d });
          }
        }
        for (const t of activeTools) {
          if (!seenToolIds.has(t.id)) {
            seenToolIds.add(t.id);
            chipTools.push(t);
          }
        }

        const toolChips = el("div", { className: "studio-tool-chips" });
        for (const t of chipTools) {
          const isSelected = declaredList.includes(t.id);
          const chip = el("button", {
            type: "button",
            className: `tiny ghost chip${isSelected ? " active" : ""}`,
            textContent: `${isSelected ? "✓ " : "+ "}${t.name}`,
            onclick: () => {
              const current = (currentSkillPkg!.skill.allowedTools ?? "").split(/\s+/).filter(Boolean);
              const next = current.includes(t.id) ? current.filter(x => x !== t.id) : [...current, t.id];
              toolsInput.value = next.join(" ");
              rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
              render();
            }
          });
          toolChips.append(chip);
        }

        const bodyEditor = el("textarea", {
          className: "studio-body-editor",
          rows: 20,
          value: currentSkillPkg.skill.body,
          spellcheck: false
        });
        enableTabIndent(bodyEditor);
        bodyEditor.oninput = () => {
          rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
        };

        const insertBar = el("div", { className: "studio-insert-bar" },
          el("span", { className: "studio-field-hint", textContent: "Quick Insert: " }),
          el("button", {
            type: "button",
            className: "ghost tiny",
            textContent: "+ 3-Tier Layout Contract",
            onclick: () => {
              const snippet = `\n## Responsive Canvas Layout Contract\n\nAdhere to 3-tier liquid layout:\n1. **Tier 1 (Executive Strip)**: Fluid grid showing 3-4 top metrics with semantic tones.\n2. **Tier 2 (Analytical Split)**: Split container pairing trend visualization with breakdown.\n3. **Tier 3 (Granular Table)**: Searchable and sortable detail records table.\n`;
              bodyEditor.value += snippet;
              rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
            }
          }),
          el("button", {
            type: "button",
            className: "ghost tiny",
            textContent: "+ Spoken Voice Contract",
            onclick: () => {
              const snippet = `\n## Spoken Audio lowerSurface Contract\n\nEnsure the first sentence contains the primary finding and key caveat for Voice TTS playback.\n`;
              bodyEditor.value += snippet;
              rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
            }
          }),
          el("button", {
            type: "button",
            className: "ghost tiny",
            textContent: "+ Add Procedure Step",
            onclick: () => {
              const title = window.prompt("Procedure Step Title (e.g. Data Extraction & Normalization):");
              if (!title || !title.trim()) return;
              const snippet = `\n## ${title.trim()}\n\n1. Define step procedure.\n`;
              bodyEditor.value += snippet;
              rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
            }
          })
        );

        const formCard = el("div", { className: "studio-form-card" },
          el("div", { className: "studio-field" },
            el("label", { className: "studio-field-label", textContent: "Skill Identifier" }),
            el("span", { className: "studio-field-hint", textContent: "Alphanumeric lowercase with hyphens (e.g. market-dashboard)" }),
            nameInput
          ),
          el("div", { className: "studio-field" },
            el("label", { className: "studio-field-label", textContent: "Trigger Description" }),
            el("span", { className: "studio-field-hint", textContent: "Crucial for semantic use_skill discovery. Stated in third person." }),
            descInput,
            descCount
          ),
          el("div", { className: "studio-field" },
            el("label", { className: "studio-field-label", textContent: "Allowed Tools (Selection Hints)" }),
            el("span", { className: "studio-field-hint", textContent: "Declared tool requirements for local models; does not grant unconfirmed system access." }),
            toolsInput,
            toolChips
          )
        );

        const instructionsCard = el("div", { className: "studio-form-card" },
          el("label", { className: "studio-field-label", textContent: "Skill Instructions & Surface Layout Contract" }),
          el("span", { className: "studio-field-hint", textContent: "Adheres to 3-Tier liquid layout, single canonical projection, and multi-surface degradation." }),
          insertBar,
          bodyEditor
        );

        wrap.append(formCard, instructionsCard);
      } else {
        const fileEditor = el("textarea", {
          className: "studio-raw-editor",
          rows: 26,
          value: getActiveText(),
          spellcheck: false
        });
        enableTabIndent(fileEditor);
        fileEditor.oninput = () => setActiveText(fileEditor.value);

        const fileCard = el("div", { className: "studio-form-card" },
          el("div", { className: "studio-file-editor-header" },
            el("span", { className: "studio-editing-path", textContent: `Editing: ${activeFileName}` }),
            pill(`${getActiveText().length} chars`)
          ),
          fileEditor
        );
        wrap.append(fileCard);
      }
    } else if (activeKind === "app" && currentAppDetails) {
      const rawEditor = el("textarea", {
        className: "studio-raw-editor",
        rows: 26,
        value: getActiveText(),
        spellcheck: false
      });
      enableTabIndent(rawEditor);
      rawEditor.oninput = () => setActiveText(rawEditor.value);

      const appCard = el("div", { className: "studio-form-card" },
        el("div", { className: "studio-file-editor-header" },
          el("span", { className: "studio-editing-path", textContent: `Editing: ${activeFileName}` }),
          pill(`Quota: ${currentAppDetails.manifest.runtime.memoryLimitMb}MB / ${currentAppDetails.manifest.runtime.cpuTimeLimitSec}s`)
        ),
        rawEditor
      );
      wrap.append(appCard);
    }

    return wrap;
  }

  // --- View 2: Interactive Flow DAG View ---
  function renderDagView(): HTMLElement {
    const wrap = el("div", { className: "studio-dag-view" });

    const addToolBtn = el("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "+ Add Tool",
      onclick: () => {
        const toolName = window.prompt("Tool name to declare (e.g. vak_render, run_command, nse_quote):");
        if (!toolName || !toolName.trim() || !currentSkillPkg) return;
        const clean = toolName.trim();
        const current = (currentSkillPkg.skill.allowedTools ?? "").split(/\s+/).filter(Boolean);
        if (!current.includes(clean)) {
          current.push(clean);
          currentSkillPkg.skill.allowedTools = current.join(" ");
          rebuildSkillMdFromVisual(
            currentSkillPkg.skill.name,
            currentSkillPkg.skill.description,
            currentSkillPkg.skill.allowedTools,
            currentSkillPkg.skill.body
          );
          showNotice(`Added tool "${clean}" to package and Flow DAG.`);
          render();
        }
      }
    });

    const addChainBtn = el("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "+ Add Chained Skill",
      onclick: () => {
        const skillName = window.prompt("Skill to chain (e.g. interactive-ui, surface-design, summarize, task-tracker):", "interactive-ui");
        if (!skillName || !skillName.trim() || !currentSkillPkg) return;
        const clean = skillName.trim();
        const chainLine = `\n- Load \`${clean}\` for extended UI and layout contracts.\n`;
        currentSkillPkg.skill.body += chainLine;
        rebuildSkillMdFromVisual(
          currentSkillPkg.skill.name,
          currentSkillPkg.skill.description,
          currentSkillPkg.skill.allowedTools ?? "",
          currentSkillPkg.skill.body
        );
        showNotice(`Chained skill "${clean}" linked into Flow DAG.`);
        render();
      }
    });

    const addStepBtn = el("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "+ Add Procedural Step",
      onclick: () => {
        const stepTitle = window.prompt("Procedural section title (e.g. Risk Assessment & Guardrails):");
        if (!stepTitle || !stepTitle.trim() || !currentSkillPkg) return;
        const clean = stepTitle.trim();
        const stepBlock = `\n## ${clean}\n\n1. Define operational procedure for ${clean.toLowerCase()}.\n`;
        currentSkillPkg.skill.body += stepBlock;
        rebuildSkillMdFromVisual(
          currentSkillPkg.skill.name,
          currentSkillPkg.skill.description,
          currentSkillPkg.skill.allowedTools ?? "",
          currentSkillPkg.skill.body
        );
        showNotice(`Added procedural step "${clean}" to DAG and instructions.`);
        render();
      }
    });

    const dagActions = el("div", { className: "studio-dag-actions" }, addToolBtn, addChainBtn, addStepBtn);
    const toolbar = el("div", { className: "studio-dag-toolbar" },
      el("span", { textContent: "Execution & Surface Projection DAG (Directed Acyclic Graph)" }),
      dagActions
    );

    const canvas = el("div", { className: "studio-dag-canvas" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "studio-dag-svg");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "dag-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const markerPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    markerPath.setAttribute("d", "M 0 1.5 L 8 5 L 0 8.5 z");
    markerPath.setAttribute("fill", "var(--muted)");
    marker.append(markerPath);
    defs.append(marker);
    svg.append(defs);

    let nodes: DagNodeDef[] = [];
    let edges: DagEdgeDef[] = [];

    if (activeKind === "skill" && currentSkillPkg) {
      const generated = generateSkillDag(currentSkillPkg.skill, currentSkillPkg, evalResults);
      nodes = generated.nodes;
      edges = generated.edges;
    } else if (activeKind === "app" && currentAppDetails) {
      const generated = generateAppDag(currentAppDetails);
      nodes = generated.nodes;
      edges = generated.edges;
    }

    const maxX = Math.max(1100, ...nodes.map(n => n.x + n.width + 60));
    const maxY = Math.max(480, ...nodes.map(n => n.y + n.height + 60));
    svg.setAttribute("width", `${maxX}`);
    svg.setAttribute("height", `${maxY}`);
    svg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
    canvas.style.minWidth = `${maxX}px`;
    canvas.style.minHeight = `${maxY}px`;

    // Draw SVG Edges
    for (const edge of edges) {
      const src = nodes.find(n => n.id === edge.from);
      const dst = nodes.find(n => n.id === edge.to);
      if (!src || !dst) continue;

      const x1 = src.x + src.width;
      const y1 = src.y + src.height / 2;
      const x2 = dst.x;
      const y2 = dst.y + dst.height / 2;
      const dx = Math.max((x2 - x1) * 0.5, 30);

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
      path.setAttribute("stroke", "var(--border)");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      path.setAttribute("marker-end", "url(#dag-arrow)");
      svg.append(path);
    }
    canvas.append(svg);

    // Inspector card
    const inspector = el("div", { className: "studio-dag-inspector" });
    const updateInspector = (n: DagNodeDef) => {
      const actionsBox = el("div", { className: "studio-inspector-actions" });

      const toSpecBtn = el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "✏️ Jump to Spec & Code",
        onclick: () => {
          activeStudioTab = "spec";
          sessionActiveStudioTab = "spec";
          render();
        }
      });

      const toPreviewBtn = el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "👁️ Preview in Canvas",
        onclick: () => {
          activeStudioTab = "preview";
          sessionActiveStudioTab = "preview";
          render();
        }
      });

      const toSandboxBtn = el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "🧪 Rehearse in Sandbox",
        onclick: () => {
          activeStudioTab = "sandbox";
          sessionActiveStudioTab = "sandbox";
          render();
        }
      });

      actionsBox.append(toSpecBtn, toPreviewBtn, toSandboxBtn);

      if (n.removableType === "tool" && n.removableValue && currentSkillPkg) {
        const removeToolBtn = el("button", {
          type: "button",
          className: "danger tiny",
          textContent: `Remove "${n.removableValue}" from Package`,
          onclick: () => {
            const current = (currentSkillPkg!.skill.allowedTools ?? "").split(/\s+/).filter(Boolean);
            currentSkillPkg!.skill.allowedTools = current.filter(x => x !== n.removableValue).join(" ");
            rebuildSkillMdFromVisual(
              currentSkillPkg!.skill.name,
              currentSkillPkg!.skill.description,
              currentSkillPkg!.skill.allowedTools,
              currentSkillPkg!.skill.body
            );
            showNotice(`Removed tool "${n.removableValue}" from package.`);
            render();
          }
        });
        actionsBox.append(removeToolBtn);
      } else if (n.removableType === "chain" && n.removableValue && currentSkillPkg) {
        const unlinkChainBtn = el("button", {
          type: "button",
          className: "danger tiny",
          textContent: `Unlink "${n.removableValue}"`,
          onclick: () => {
            const reg = new RegExp(`\\n?-?\\s*Load\\s+\`${n.removableValue}\`[^\\n]*\\n?`, "gi");
            currentSkillPkg!.skill.body = currentSkillPkg!.skill.body.replace(reg, "\n");
            rebuildSkillMdFromVisual(
              currentSkillPkg!.skill.name,
              currentSkillPkg!.skill.description,
              currentSkillPkg!.skill.allowedTools ?? "",
              currentSkillPkg!.skill.body
            );
            showNotice(`Unlinked chained skill "${n.removableValue}".`);
            render();
          }
        });
        actionsBox.append(unlinkChainBtn);
      } else if (n.removableType === "stage" && n.removableValue && currentSkillPkg) {
        const removeStageBtn = el("button", {
          type: "button",
          className: "danger tiny",
          textContent: `Remove Section "${n.removableValue}"`,
          onclick: () => {
            const reg = new RegExp(`\\n?##\\s+${n.removableValue}[\\s\\S]*?(?=\\n##|$)`, "gi");
            currentSkillPkg!.skill.body = currentSkillPkg!.skill.body.replace(reg, "\n");
            rebuildSkillMdFromVisual(
              currentSkillPkg!.skill.name,
              currentSkillPkg!.skill.description,
              currentSkillPkg!.skill.allowedTools ?? "",
              currentSkillPkg!.skill.body
            );
            showNotice(`Removed section "${n.removableValue}" from instructions.`);
            render();
          }
        });
        actionsBox.append(removeStageBtn);
      }

      inspector.replaceChildren(
        el("div", { className: "studio-dag-inspector-head" },
          el("strong", { textContent: `Inspecting Node: ${n.title}` }),
          pill(n.badge, "info")
        ),
        el("p", { className: "studio-field-hint", textContent: n.inspectorText }),
        actionsBox
      );
    };

    if (nodes.length > 0) updateInspector(nodes[0]!);

    // Render HTML Node Cards
    for (const n of nodes) {
      const nodeEl = el("div", {
        className: `studio-dag-node${selectedDagNodeId === n.id ? " active" : ""}`,
        onclick: () => {
          selectedDagNodeId = n.id;
          sessionSelectedDagNodeId = n.id;
          for (const elNode of canvas.querySelectorAll(".studio-dag-node")) elNode.classList.remove("active");
          nodeEl.classList.add("active");
          updateInspector(n);
        }
      },
        el("div", { className: "studio-dag-node-head" },
          el("span", { className: "studio-dag-node-icon" }, icon(n.glyph, 16)),
          el("h4", { className: "studio-dag-node-title", textContent: n.title }),
          pill(n.badge)
        ),
        el("p", { className: "studio-dag-node-desc", textContent: n.detail })
      );
      nodeEl.style.left = `${n.x}px`;
      nodeEl.style.top = `${n.y}px`;
      nodeEl.style.width = `${n.width}px`;
      nodeEl.style.height = `${n.height}px`;
      canvas.append(nodeEl);
    }

    wrap.append(toolbar, canvas, inspector);
    return wrap;
  }

  // --- View 3: Live Preview & Canvas Staging ---
  function renderPreviewView(): HTMLElement {
    const wrap = el("div", { className: "studio-preview-view" });

    const bpSelector = segmented(
      [["sm", "320px Mobile"], ["md", "720px Form"], ["lg", "960px Desktop"], ["full", "100% Fluid"]] as const,
      activeBreakpoint,
      v => {
        activeBreakpoint = v;
        sessionActiveBreakpoint = v;
        const wrapper = wrap.querySelector(".studio-canvas-wrapper") as HTMLElement | null;
        if (wrapper) wrapper.className = `studio-canvas-wrapper bp-${activeBreakpoint}`;
      }
    );

    const topRow = el("div", { className: "studio-preview-top" },
      el("strong", { textContent: "Responsive Canvas Staging Stage" }),
      bpSelector
    );

    const canvasContainer = el("div", { className: "studio-canvas-container" });
    const canvasWrapper = el("div", { className: `studio-canvas-wrapper bp-${activeBreakpoint}` });
    const mount = el("div", { className: "studio-surface-mount" });
    canvasWrapper.append(mount);
    canvasContainer.append(canvasWrapper);

    const linterCard = el("div", { className: "studio-linter-card" });
    const linterHead = el("div", { className: "linter-head" },
      el("strong", { textContent: "Surface Design Linter" }),
      pill("Layout Compliant", "ok")
    );
    const linterNotes = el("ul", { className: "studio-linter-notes" });
    linterCard.append(linterHead, linterNotes);

    const previewNav = el("div", { className: "studio-inspector-actions" },
      el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "🔀 Inspect in Flow DAG",
        onclick: () => {
          activeStudioTab = "dag";
          sessionActiveStudioTab = "dag";
          selectedDagNodeId = "surface";
          render();
        }
      }),
      el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "✏️ Edit Instructions in Spec",
        onclick: () => {
          activeStudioTab = "spec";
          sessionActiveStudioTab = "spec";
          render();
        }
      })
    );
    linterCard.append(previewNav);

    const voiceCard = el("div", { className: "studio-voice-card" });
    const voiceText = el("p", { className: "voice-spoken-text" });
    const playBtn = el("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "▶ Play Voice Gist",
      onclick: () => {
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(voiceText.textContent || "No text available");
          window.speechSynthesis.speak(utterance);
        }
      }
    });
    const voiceHead = el("div", { className: "voice-head" },
      el("strong", { textContent: "Dual Spoken Projection (lowerSurface)" }),
      playBtn
    );
    voiceCard.append(voiceHead, voiceText);

    setTimeout(() => {
      let snap: SurfaceSnapshot | null = null;
      if (activeKind === "skill" && currentSkillPkg) {
        snap = buildRealisticSkillSurface(currentSkillPkg.skill, currentSkillPkg);

        let warnings = 0;
        linterNotes.replaceChildren();
        const bodyLower = currentSkillPkg.skill.body.toLowerCase();
        if (bodyLower.includes('maxwidth: "full"') && (bodyLower.includes("chart") || bodyLower.includes("kind: \"line\""))) {
          linterNotes.append(el("li", { className: "warn", textContent: "Single chart given maxWidth: 'full' can distort aspect ratio on desktop screens. Clamp to 'md' or 'lg'." }));
          warnings++;
        }
        if (/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i.test(currentSkillPkg.skill.body)) {
          linterNotes.append(el("li", { className: "warn", textContent: "Raw hex color detected. Use semantic tones: positive, caution, critical, neutral." }));
          warnings++;
        }
        if (/waterfall|violin|box plot/i.test(bodyLower)) {
          linterNotes.append(el("li", { className: "warn", textContent: "Unsupported chart kind requested. Standard kinds are bar, stacked, line, area, pie, scatter, heatmap, radar, candlestick." }));
          warnings++;
        }

        const badge = linterHead.querySelector(".pill") as HTMLElement | null;
        if (badge) {
          if (warnings > 0) {
            badge.textContent = `⚠️ ${warnings} Warning${warnings > 1 ? "s" : ""}`;
            badge.className = "pill caution";
          } else {
            badge.textContent = "✓ Layout Compliant";
            badge.className = "pill ok";
          }
        }
      } else if (activeKind === "app" && currentAppDetails && currentAppDetails.surface) {
        snap = currentAppDetails.surface as unknown as SurfaceSnapshot;
      }

      if (snap) {
        const store = new SurfaceStore(basicCatalog);
        store.load(snap);
        const surfaceEl = document.createElement("vak-surface") as VakSurfaceElement;
        surfaceMode(surfaceEl);
        surfaceEl.attach(store, snap.id);
        mount.replaceChildren(surfaceEl);

        const resolved = store.resolve(snap.id);
        if (resolved) {
          const lowered = lowerSurface(resolved);
          voiceText.textContent = projectText(lowered).replace(/\s+/g, " ").trim();
        }
      }
    }, 0);

    wrap.append(topRow, canvasContainer, linterCard, voiceCard);
    return wrap;
  }

  // --- View 4: Sandbox & Rehearsal View ---
  function renderSandboxView(): HTMLElement {
    const wrap = el("div", { className: "studio-sandbox-view" });

    const sandboxCard = el("div", { className: "studio-form-card" });
    const scriptFiles = (currentSkillPkg?.files ?? []).filter(f => /\.(?:py|sh|js|mjs|cjs|ts)$/i.test(f.path));
    if (activeKind === "app") scriptFiles.push({ path: "server.ts", text: "", bytes: 0, status: "added" });

    const scriptSel = el("select", { className: "studio-input" });
    for (const s of scriptFiles) scriptSel.append(el("option", { value: s.path, textContent: s.path }));

    const runScriptBtn = el("button", {
      type: "button",
      className: "primary small",
      textContent: isRunningSandbox ? "Running in Sandbox…" : "▶ Run in vak-sandbox",
      disabled: isRunningSandbox || isSavingDraft || scriptFiles.length === 0,
      onclick: () => void runSandboxTest(scriptSel.value)
    });

    const runnerHead = el("div", { className: "sandbox-head" },
      el("strong", { textContent: "Isolated Script Rehearsal" }),
      runScriptBtn
    );

    const term = el("pre", {
      className: "studio-terminal",
      textContent: sandboxLog
        ? [`exit code: ${sandboxLog.exitCode}`, sandboxLog.source && `source: ${sandboxLog.source}`, sandboxLog.scriptSha256 && `script SHA-256: ${sandboxLog.scriptSha256}`, sandboxLog.stdout && `stdout:\n${sandboxLog.stdout}`, sandboxLog.stderr && `stderr:\n${sandboxLog.stderr}`].filter(Boolean).join("\n\n")
        : "Select a script above to execute in a disposable Seatbelt sandbox with SHA-256 integrity verification."
    });

    if (scriptFiles.length === 0) {
      const emptyBox = el("div", { className: "studio-empty-scripts" },
        el("div", { className: "studio-card-head" },
          icon("spark", 18),
          el("div", {},
            el("strong", { textContent: "Instruction & Projection Procedure" }),
            el("p", { className: "muted small", textContent: "This skill executes through local LLM reasoning and declarative canvas projections without standalone shell or Python scripts." })
          )
        ),
        el("p", { className: "studio-field-hint", textContent: "To rehearse executable tool scripts inside the disposable Seatbelt sandbox with SHA-256 receipts, click '+ Add Helper Script' below." }),
        el("button", {
          type: "button",
          className: "ghost small",
          textContent: "+ Add Helper Script (scripts/rehearse.py)",
          onclick: () => {
            const path = "scripts/rehearse.py";
            if (activeKind === "skill" && currentSkillPkg) {
              currentSkillPkg.files.push({
                path,
                text: "#!/usr/bin/env python3\nimport sys\nprint('Rehearsing skill tool boundary inside seatbelt sandbox...')\nsys.exit(0)\n",
                bytes: 110,
                status: "added"
              });
              activeFileName = path;
              sessionActiveFileName = path;
              isDirty = true;
              scheduleAutoSave();
              render();
            }
          }
        })
      );
      sandboxCard.append(runnerHead, emptyBox);
    } else {
      sandboxCard.append(
        runnerHead,
        el("div", { className: "studio-field" },
          el("label", { className: "studio-field-label", textContent: "Executable Target" }),
          scriptSel
        ),
        term
      );
    }

    let evalCard: HTMLElement | null = null;
    if (activeKind === "skill" && currentSkillPkg) {
      evalCard = el("div", { className: "studio-form-card" });
      const runEvalBtn = el("button", {
        type: "button",
        className: "ghost small",
        textContent: isRunningTests ? "Testing Prompts…" : "Verify Selection Gate",
        disabled: isRunningTests,
        onclick: () => void runEvaluation()
      });

      const evalHead = el("div", { className: "sandbox-head" },
        el("strong", { textContent: "use_skill Selection Gate Verification" }),
        runEvalBtn
      );

      const evalList = el("div", { className: "studio-eval-suite" });
      if (evalResults.length) {
        for (const res of evalResults) {
          const item = el("div", { className: "studio-test-result" },
            el("span", { className: `test-dot ${res.passed ? "pass" : "fail"}`, textContent: res.passed ? "✓" : "✗" }),
            el("div", { className: "test-text" },
              el("p", { className: "test-prompt", textContent: res.prompt }),
              el("span", { className: "test-meta", textContent: `${res.durationMs}ms · selected: ${res.selectedSkills.join(", ") || "none"}` })
            )
          );
          evalList.append(item);
        }
      } else {
        const domain = getDomainTestPrompts(currentSkillPkg.skill);
        const testList = el("div", { className: "studio-pending-tests" },
          el("p", { className: "studio-field-hint", textContent: "Ready to test prompt selection gate on active local model with domain-specific scenarios:" })
        );
        for (const p of domain.positive) {
          testList.append(el("div", { className: "studio-test-result" },
            el("span", { className: "test-dot pending", textContent: "•" }),
            el("div", { className: "test-text" },
              el("p", { className: "test-prompt", textContent: p }),
              el("span", { className: "test-meta", textContent: "Positive Intent Scenario" })
            )
          ));
        }
        for (const p of domain.distractor) {
          testList.append(el("div", { className: "studio-test-result" },
            el("span", { className: "test-dot distractor", textContent: "○" }),
            el("div", { className: "test-text" },
              el("p", { className: "test-prompt", textContent: p }),
              el("span", { className: "test-meta", textContent: "Distractor Negative Scenario" })
            )
          ));
        }
        evalList.append(testList);
      }

      evalCard.append(evalHead, evalList);
    }

    wrap.append(sandboxCard, ...(evalCard ? [evalCard] : []));
    return wrap;
  }

  // --- Main Render Function ---
  function render(): void {
    root.replaceChildren();

    if (!activeItemName) {
      root.append(renderHub());
      return;
    }

    const itemName = activeKind === "skill" ? (currentSkillPkg?.skill.name ?? activeItemName) : (currentAppDetails?.manifest.id ?? activeItemName);

    // 1. Top Header
    const backBtn = el("button", {
      type: "button",
      className: "studio-back-btn",
      title: "Back to Hub"
    }, icon("arrow", 14), el("span", { textContent: "Studio Hub" }));
    backBtn.onclick = () => void backAction();

    const pillBox = el("div", { className: "studio-status-pills" });
    const titleBox = el("div", { className: "studio-title-box" },
      el("h2", { className: "studio-skill-title", textContent: itemName }),
      pillBox
    );

    const modeSelector = segmented(
      [
        ["spec", "Spec & Code"],
        ["dag", "Flow DAG"],
        ["preview", "Live Preview"],
        ["sandbox", "Sandbox & Tests"]
      ] as const,
      activeStudioTab,
      v => {
        activeStudioTab = v;
        sessionActiveStudioTab = v;
        render();
      }
    );

    const discardBtn = hasDraft ? el("button", {
      type: "button",
      className: "ghost small",
      textContent: "Discard Draft",
      onclick: () => void discardDraftAction()
    }) : null;

    const saveDraftBtn = el("button", {
      type: "button",
      className: "ghost small",
      textContent: isSavingDraft ? "Saving…" : "Save Draft",
      onclick: () => void saveDraftAction(false)
    });

    const buildAppBtn = activeKind === "app" ? el("button", {
      type: "button", className: "ghost small", textContent: "Build with chat", onclick: async () => {
        if (isDirty || !appDraftFingerprint) await saveDraftAction(true);
        if (isDirty || !currentAppDetails) return;
        window.dispatchEvent(new CustomEvent("vak:build-app", { detail: { id: currentAppDetails.manifest.id, sourceSession: currentAppDetails.manifest.sourceSession } }));
      }
    }) : null;

    const publishBtn = el("button", {
      type: "button",
      className: "primary small",
      textContent: isPublishing ? "Publishing…" : activeKind === "skill" ? "Publish Skill" : "Publish App",
      onclick: () => void publishAction()
    });

    const header = el("header", { className: "studio-header", "data-tauri-drag-region": "true" },
      el("div", { className: "studio-header-left" }, backBtn, el("span", { className: "studio-header-divider" }), titleBox),
      el("div", { className: "studio-header-center" }, modeSelector),
      el("div", { className: "studio-header-right" }, ...(discardBtn ? [discardBtn] : []), ...(buildAppBtn ? [buildAppBtn] : []), saveDraftBtn, publishBtn)
    );

    const feedbackBanner = el("div", {
      className: `studio-feedback-bar${feedback.textContent ? ` ${feedback.className}` : ""}`,
      hidden: !feedback.textContent
    }, feedback);

    // 2. Workspace
    const workspace = el("div", { className: "studio-workspace" });

    // Left Column: File Explorer & Capabilities
    const leftCol = el("div", { className: "studio-col studio-left-col" });

    const treeHeader = el("div", { className: "studio-tree-header" },
      el("span", { className: "studio-section-label", textContent: "Package Files" }),
      el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "+ Add File",
        onclick: async () => {
          const newPath = window.prompt("Relative file path (e.g. references/rules.md, schemas/data.json, scripts/parse.py):");
          if (!newPath || !newPath.trim()) return;
          const clean = newPath.trim().replace(/^\.?\//, "");
          if (activeKind === "skill" && currentSkillPkg) {
            if (clean === "SKILL.md" || currentSkillPkg.files.some(f => f.path === clean)) {
              showError(new Error("File already exists in package."));
              return;
            }
            currentSkillPkg.files.push({
              path: clean,
              text: `# ${clean}\n\nSupporting file content.\n`,
              bytes: 30,
              status: "added"
            });
          }
          activeFileName = clean;
          sessionActiveFileName = clean;
          isDirty = true;
          scheduleAutoSave();
          render();
        }
      })
    );

    const fileList = el("div", { className: "studio-file-tree" });

    const rootName = activeKind === "skill" ? "SKILL.md" : "app.json";
    const rootItem = el("div", {
      className: `studio-tree-item${activeFileName === rootName ? " active" : ""}`,
      onclick: () => {
        activeFileName = rootName;
        sessionActiveFileName = rootName;
        render();
      }
    }, icon(activeKind === "skill" ? "page" : "cpu", 14), el("span", { textContent: rootName }));
    fileList.append(rootItem);

    if (activeKind === "skill" && currentSkillPkg) {
      for (const file of currentSkillPkg.files.toSorted((a, b) => a.path.localeCompare(b.path))) {
        const glyph = /\.(?:py|sh|js|ts)$/i.test(file.path) ? "code" : /\.(?:json)$/i.test(file.path) ? "table" : "page";
        const delBtn = el("button", {
          type: "button",
          className: "tree-del-btn",
          textContent: "×",
          title: "Delete file",
          onclick: (e) => {
            e.stopPropagation();
            currentSkillPkg!.files = currentSkillPkg!.files.filter(f => f.path !== file.path);
            if (activeFileName === file.path) {
              activeFileName = "SKILL.md";
              sessionActiveFileName = "SKILL.md";
            }
            isDirty = true;
            scheduleAutoSave();
            render();
          }
        });
        const fileItem = el("div", {
          className: `studio-tree-item${activeFileName === file.path ? " active" : ""}`,
          onclick: () => {
            activeFileName = file.path;
            sessionActiveFileName = file.path;
            render();
          }
        }, icon(glyph, 14), el("span", { className: "tree-path", textContent: file.path }), el("span", { className: "tree-size", textContent: `${Math.ceil(file.bytes / 1024)}K` }), delBtn);
        fileList.append(fileItem);
      }
    } else if (activeKind === "app" && currentAppDetails) {
      const supporting = ((currentAppDetails as any)._supportingFiles as { path: string; text: string }[] | undefined) ?? [];
      for (const f of supporting) {
        const fileItem = el("div", {
          className: `studio-tree-item${activeFileName === f.path ? " active" : ""}`,
          onclick: () => {
            activeFileName = f.path;
            sessionActiveFileName = f.path;
            render();
          }
        }, icon(f.path.endsWith(".json") ? "table" : "code", 14), el("span", { className: "tree-path", textContent: f.path }));
        fileList.append(fileItem);
      }
    }

    const capsCard = el("div", { className: "studio-entitlements-card" });
    if (activeKind === "skill" && currentSkillPkg) {
      capsCard.append(
        el("span", { className: "studio-section-label", textContent: "Active Capabilities" }),
        el("div", { className: "studio-card-meta" },
          pill("read_skill_file", "ok"),
          (currentSkillPkg.skill.allowedTools ?? "").includes("run_command") ? pill("sandbox_exec", "caution") : null,
          pill(currentSkillPkg.skill.license ?? "MIT")
        )
      );
    } else if (activeKind === "app" && currentAppDetails) {
      capsCard.append(
        el("span", { className: "studio-section-label", textContent: "Runtime Entitlements" }),
        el("div", { className: "studio-card-meta" },
          pill(currentAppDetails.manifest.entitlements.network.mode === "airgap" ? "Airgapped" : "Network Enabled", "ok"),
          pill(`RAM: ${currentAppDetails.manifest.runtime.memoryLimitMb}MB`),
          pill(`CPU: ${currentAppDetails.manifest.runtime.cpuTimeLimitSec}s`),
          currentAppDetails.manifest.entitlements.storage.sqlite ? pill("SQLite: On", "info") : null
        )
      );
    }

    leftCol.append(treeHeader, fileList, capsCard);

    // Center Column: Active View
    const centerCol = el("div", { className: "studio-col studio-center-col" });
    if (activeStudioTab === "spec") centerCol.append(renderSpecView());
    else if (activeStudioTab === "dag") centerCol.append(renderDagView());
    else if (activeStudioTab === "preview") centerCol.append(renderPreviewView());
    else if (activeStudioTab === "sandbox") centerCol.append(renderSandboxView());

    workspace.append(leftCol, centerCol);
    root.append(header, feedbackBanner, workspace);

    updateHeaderPills();
  }

  // Load hub or active item
  await loadHubData();
  if (activeItemName) {
    await loadItemData(activeItemName, activeKind);
  }
  render();
  return root;
}
