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
import type { AppManifest } from "../shared/app-manifest.ts";

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
  if (flushPendingAutoSave) {
    await flushPendingAutoSave();
  }
  const root = document.getElementById("skills-studio-page");
  if (root) {
    root.hidden = true;
  }
  document.body.classList.remove("in-skill-studio");
  window.dispatchEvent(new Event("vak:studio-closed"));
}

export async function openSkillStudio(
  initialItemName: string | undefined,
  onBack: () => void | Promise<void>,
  reloadParentList: () => Promise<void>,
  initialType: "skill" | "app" = "skill"
): Promise<HTMLElement> {
  const root = (document.getElementById("skills-studio-page") ?? el("div", { id: "skills-studio-page", className: "skills-studio-page" })) as HTMLElement;
  if (!root.parentElement) document.body.append(root);

  root.hidden = false;
  document.body.classList.add("in-skill-studio");
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
        api<AppSummary[]>("/api/apps").catch(() => []),
        api<{ entry: { id: string; name: string }; enabled: boolean }[]>("/api/integrations").catch(() => []),
      ]);
      installedSkills = skills;
      installedApps = apps;
      activeTools = integrations.map(i => ({ id: i.entry.id, name: i.entry.name }));
    } catch (err) {
      showError(err);
    }
  }

  async function loadItemData(name: string, kind: "skill" | "app"): Promise<void> {
    isDirty = false;
    hasDraft = false;
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
        currentAppDetails = await api<AppDetails>(`/api/apps/${encodeURIComponent(name)}`);
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
              { id: "1", label: "Alpha Segment", value: 45000, status: "normal" },
              { id: "2", label: "Beta Segment", value: 68200, status: "normal" },
              { id: "3", label: "Gamma Segment", value: 29400, status: "caution" },
              { id: "4", label: "Delta Segment", value: 12800, status: "critical" },
            ]
          }, null, 2),
          bytes: 350,
          status: "added",
        },
        {
          path: "tests/test_scenarios.json",
          text: JSON.stringify({
            positive_prompts: [
              `Review the latest ${slug.replace(/-/g, " ")} metrics and show the dashboard`,
              "Inspect segment anomalies and show the breakdown table"
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
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    const manifest: AppManifest = {
      $schema: "https://vakyartha.dev/schemas/app-manifest.v1.json",
      id: slug,
      version: "1.0.0",
      name: slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      description: "Sandboxed application executing in an isolated Seatbelt runtime with Canvas projection.",
      author: "Studio Author",
      icon: "cpu",
      category: "utilities",
      entrypoints: {
        backend: "server.ts",
        surface: "surface.json",
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
          action: "recalculateMetrics",
          maxDurationSec: 30,
        }
      ],
    };

    const serverScript = `// Sandboxed Application Backend Worker
export async function handleAction(action: string, payload: Record<string, unknown>) {
  console.log(\`[app] Received action: \${action}\`, payload);
  return {
    patches: [
      { op: "replace", path: "/records/0/status", value: "normal" }
    ]
  };
}

export async function handleTrigger(triggerId: string) {
  console.log(\`[app] Trigger fired: \${triggerId}\`);
  return { status: "ok", timestamp: new Date().toISOString() };
}
`;

    const surfaceJson = JSON.stringify({
      id: `${slug}-surface`,
      version: 1,
      title: manifest.name,
      data: {
        records: [
          { id: "1", label: "Worker Process", value: 100, status: "normal" },
          { id: "2", label: "Sandbox Security", value: 95, status: "normal" },
        ]
      },
      nodes: [
        {
          id: "root-section",
          type: "section",
          props: { title: manifest.name, description: manifest.description },
          children: ["stats-grid", "records-table"]
        },
        {
          id: "stats-grid",
          type: "grid",
          props: { columns: 2 },
          children: ["s1", "s2"]
        },
        {
          id: "s1",
          type: "stat",
          props: { label: "Memory Limit", value: "256 MB" }
        },
        {
          id: "s2",
          type: "stat",
          props: { label: "Sandbox Isolation", value: "Seatbelt Airgapped" }
        },
        {
          id: "records-table",
          type: "table",
          props: {
            title: "Application Components",
            columns: ["id", "label", "value", "status"],
            rows: { records: "{/records}", fields: ["id", "label", "value", "status"] }
          }
        }
      ]
    }, null, 2);

    currentAppDetails = {
      manifest,
      workspaceDir: "",
      isRunning: false,
      storageBytes: 0,
      state: {},
      surface: JSON.parse(surfaceJson),
      lastExecutedAt: null,
    };

    (currentAppDetails as any)._supportingFiles = [
      { path: "server.ts", text: serverScript },
      { path: "surface.json", text: surfaceJson }
    ];
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
      if (activeFileName === "app.json") return JSON.stringify(currentAppDetails.manifest, null, 2);
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
        try { currentAppDetails.manifest = JSON.parse(content); } catch {}
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
        await api("/api/apps", {
          method: "POST",
          body: JSON.stringify({ manifest: currentAppDetails.manifest, files: filesMap })
        });
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
      await saveDraftAction(false);
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

  // Test prompt evaluation
  async function runEvaluation(): Promise<void> {
    if (isRunningTests || !currentSkillPkg) return;
    isRunningTests = true;
    evalResults = [];
    render();
    try {
      const testsFile = currentSkillPkg.files.find(f => f.path.includes("tests/") || f.path.includes("test_scenarios.json"));
      let testPrompts = [
        `Review the latest ${currentSkillPkg.skill.name.replace(/-/g, " ")} metrics and show the dashboard`,
        "Show me segment anomalies and data summary",
        "What is the weather outside right now?"
      ];
      if (testsFile) {
        try {
          const parsed = JSON.parse(testsFile.text);
          if (Array.isArray(parsed.positive_prompts)) {
            testPrompts = [...parsed.positive_prompts, ...(parsed.distractor_prompts ?? [])];
          }
        } catch {}
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

    const closeHubBtn = el("button", {
      type: "button",
      className: "quiet small",
      title: "Close Studio",
      onclick: () => void backAction()
    }, icon("close", 14));

    const headActions = el("div", { className: "studio-hub-actions" }, newSkillBtn, newAppBtn, closeHubBtn);
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
    if (hubFilter === "all" || hubFilter === "apps") {
      for (const a of installedApps) {
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
          a.isRunning ? pill("Live", "ok") : pill("Ready")
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

        const toolChips = el("div", { className: "studio-tool-chips" });
        for (const t of activeTools) {
          const isSelected = (currentSkillPkg.skill.allowedTools ?? "").includes(t.id);
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
    const toolbar = el("div", { className: "studio-dag-toolbar" },
      el("span", { textContent: "Execution & Surface Projection DAG (Directed Acyclic Graph)" }),
      el("span", { textContent: "Click any node to inspect execution properties and boundary contracts" })
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
    }

    interface DagEdgeDef {
      from: string;
      to: string;
    }

    let nodes: DagNodeDef[] = [];
    let edges: DagEdgeDef[] = [];

    if (activeKind === "skill" && currentSkillPkg) {
      nodes = [
        {
          id: "prompt",
          title: "User Request",
          glyph: "bubble",
          detail: "Human prompt matching skill intent",
          badge: "Trigger",
          x: 40,
          y: 130,
          width: 200,
          height: 80,
          inspectorText: `Semantic trigger prompt evaluated against description: "${currentSkillPkg.skill.description}"`
        },
        {
          id: "gate",
          title: "use_skill Selection",
          glyph: "spark",
          detail: "Model selects tool gate",
          badge: "Gate",
          x: 280,
          y: 130,
          width: 200,
          height: 80,
          inspectorText: `Target skill: "${currentSkillPkg.skill.name}". Allowed tools declared: ${currentSkillPkg.skill.allowedTools || "none"}`
        },
        {
          id: "tools",
          title: "Capabilities & Tools",
          glyph: "shield",
          detail: "read_skill_file / sandbox execution",
          badge: "Sandbox",
          x: 520,
          y: 50,
          width: 200,
          height: 80,
          inspectorText: `Tools: ${currentSkillPkg.skill.allowedTools || "read_skill_file"}. Rehearsals run inside isolated Seatbelt sandbox.`
        },
        {
          id: "chain",
          title: "Chained Procedures",
          glyph: "branch",
          detail: "interactive-ui / surface-design",
          badge: "Contract",
          x: 520,
          y: 210,
          width: 200,
          height: 80,
          inspectorText: "Chains to interactive-ui when data binding is active, and surface-design for 3-tier layout compliance."
        },
        {
          id: "store",
          title: "Canonical Records",
          glyph: "table",
          detail: "Single source of truth under /records",
          badge: "Data",
          x: 760,
          y: 130,
          width: 200,
          height: 80,
          inspectorText: "Data collection mapped to {/records}. Prevents divergent values between charts and tables."
        },
        {
          id: "surface",
          title: "3-Tier Canvas",
          glyph: "canvas",
          detail: "Metrics, Analytics Split, Detail Table",
          badge: "Visual",
          x: 1000,
          y: 50,
          width: 200,
          height: 80,
          inspectorText: "3-Tier liquid layout reflows across 320px, 720px, and 960px container query breakpoints."
        },
        {
          id: "voice",
          title: "Dual Spoken Projection",
          glyph: "voice",
          detail: "lowerSurface TTS audio narrative",
          badge: "Spoken",
          x: 1000,
          y: 210,
          width: 200,
          height: 80,
          inspectorText: "First sentence carries headline finding and primary caveat for text-to-speech audio playback."
        }
      ];

      edges = [
        { from: "prompt", to: "gate" },
        { from: "gate", to: "tools" },
        { from: "gate", to: "chain" },
        { from: "tools", to: "store" },
        { from: "chain", to: "store" },
        { from: "store", to: "surface" },
        { from: "surface", to: "voice" }
      ];
    } else if (activeKind === "app" && currentAppDetails) {
      nodes = [
        {
          id: "trigger",
          title: "Cron / Action Trigger",
          glyph: "clock",
          detail: currentAppDetails.manifest.triggers[0]?.expression || "Scheduled trigger",
          badge: "Trigger",
          x: 60,
          y: 130,
          width: 220,
          height: 80,
          inspectorText: `Triggers configured: ${currentAppDetails.manifest.triggers.map(t => `${t.id} (${t.expression ?? t.kind})`).join(", ")}`
        },
        {
          id: "worker",
          title: "Sandboxed Worker",
          glyph: "cpu",
          detail: `Node 24 · ${currentAppDetails.manifest.runtime.memoryLimitMb}MB Limit`,
          badge: "Isolated",
          x: 340,
          y: 130,
          width: 220,
          height: 80,
          inspectorText: `Backend entrypoint: ${currentAppDetails.manifest.entrypoints.backend || "server.ts"}. Airgap mode: ${currentAppDetails.manifest.entitlements.network.mode}.`
        },
        {
          id: "storage",
          title: "Airgapped Storage",
          glyph: "memory",
          detail: "Embedded SQLite & State",
          badge: "Storage",
          x: 620,
          y: 130,
          width: 220,
          height: 80,
          inspectorText: `Storage quota: ${currentAppDetails.manifest.runtime.maxStorageMb}MB. SQLite: ${currentAppDetails.manifest.entitlements.storage.sqlite ? "Enabled" : "Disabled"}.`
        },
        {
          id: "canvas",
          title: "Canvas Projection",
          glyph: "canvas",
          detail: "surface.json mount",
          badge: "Surface",
          x: 900,
          y: 130,
          width: 220,
          height: 80,
          inspectorText: `Companion surface: ${currentAppDetails.manifest.entrypoints.surface || "surface.json"}. Reactive canvas dispatches actions to worker.`
        }
      ];

      edges = [
        { from: "trigger", to: "worker" },
        { from: "worker", to: "storage" },
        { from: "storage", to: "canvas" }
      ];
    }

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
      inspector.replaceChildren(
        el("div", { className: "studio-dag-inspector-head" },
          el("strong", { textContent: `Inspecting Node: ${n.title}` }),
          pill(n.badge, "info")
        ),
        el("p", { className: "studio-field-hint", textContent: n.inspectorText })
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
      let records = [
        { id: "1", label: "Alpha Segment", value: 45000, status: "normal" },
        { id: "2", label: "Beta Segment", value: 68200, status: "normal" },
        { id: "3", label: "Gamma Segment", value: 29400, status: "caution" },
        { id: "4", label: "Delta Segment", value: 12800, status: "critical" },
      ];

      if (activeKind === "skill" && currentSkillPkg) {
        const schemaFile = currentSkillPkg.files.find(f => f.path.includes("records.json") || f.path.includes("schemas/"));
        if (schemaFile) {
          try {
            const parsed = JSON.parse(schemaFile.text);
            if (Array.isArray(parsed.records)) records = parsed.records;
          } catch {}
        }

        const nodes: VpsNode[] = [
          {
            id: "root-section",
            type: "section",
            props: {
              title: currentSkillPkg.skill.name.replace(/-/g, " "),
              description: currentSkillPkg.skill.description
            },
            children: ["metric-grid", "analytics-split", "records-table"]
          },
          {
            id: "metric-grid",
            type: "grid",
            props: { columns: 4, minItemWidth: "sm" },
            children: ["m1", "m2", "m3", "m4"]
          },
          { id: "m1", type: "stat", props: { label: "Total Volume", value: { records: "{/records}", field: "value", aggregate: "sum" } } },
          { id: "m2", type: "stat", props: { label: "Average Size", value: { records: "{/records}", field: "value", aggregate: "mean" } } },
          { id: "m3", type: "stat", props: { label: "Peak Observed", value: { records: "{/records}", field: "value", aggregate: "max" } } },
          { id: "m4", type: "stat", props: { label: "Tracked Entities", value: { records: "{/records}", field: "id", aggregate: "count" } } },
          {
            id: "analytics-split",
            type: "split",
            props: { ratio: "2:1", maxWidth: "lg" },
            children: ["trend-chart", "status-chart"]
          },
          {
            id: "trend-chart",
            type: "chart",
            props: { title: "Observed Distribution", kind: "bar", series: { records: "{/records}", label: "label", fields: ["value"] } }
          },
          {
            id: "status-chart",
            type: "chart",
            props: { title: "Entity Breakdown", kind: "pie", series: { records: "{/records}", label: "label", fields: ["value"] } }
          },
          {
            id: "records-table",
            type: "table",
            props: {
              title: "Granular Source Records",
              columns: ["id", "label", "value", "status"],
              rows: { records: "{/records}", fields: ["id", "label", "value", "status"] },
              maxWidth: "full",
              searchable: true,
              sortable: true
            }
          }
        ];

        snap = {
          id: `studio-${currentSkillPkg.skill.name}`,
          version: 1,
          title: currentSkillPkg.skill.name.replace(/-/g, " "),
          data: { records },
          nodes
        };

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
        if (/candlestick|waterfall/i.test(bodyLower)) {
          linterNotes.append(el("li", { className: "warn", textContent: "Unsupported chart kind requested. Standard kinds are bar, stacked, line, area, pie, scatter, heatmap, radar." }));
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

    sandboxCard.append(
      runnerHead,
      el("div", { className: "studio-field" },
        el("label", { className: "studio-field-label", textContent: "Executable Target" }),
        scriptSel
      ),
      term
    );

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
        evalList.append(el("p", { className: "studio-field-hint", textContent: "Run test suite to verify whether prompts correctly select this skill over competitors on local models." }));
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

    const publishBtn = el("button", {
      type: "button",
      className: "primary small",
      textContent: isPublishing ? "Publishing…" : activeKind === "skill" ? "Publish Skill" : "Save App",
      onclick: () => void publishAction()
    });

    const header = el("header", { className: "studio-header", "data-tauri-drag-region": "true" },
      el("div", { className: "studio-header-left" }, backBtn, el("span", { className: "studio-header-divider" }), titleBox),
      el("div", { className: "studio-header-center" }, modeSelector),
      el("div", { className: "studio-header-right" }, ...(discardBtn ? [discardBtn] : []), saveDraftBtn, publishBtn)
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
