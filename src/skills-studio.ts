// Skill Studio: integrated authoring, testing, canvas staging, and Co-Pilot workbench.
// Adheres to Agent Skills specification, single canonical projection, and Vakyartha's liquid layout rules.

import { api, ask, el } from "./core.ts";
import { icon, tile } from "./icons.ts";
import { group, pill, row, segmented, title, toggle } from "./ui.ts";
import { renderMarkdown, type VakSurfaceElement } from "@vak/web";
import { basicCatalog, lowerSurface, projectText, type ResolvedSurface, SurfaceStore, type SurfaceSnapshot, type VpsNode } from "@vak/core";
import { surfaceMode } from "./theme.ts";
import type {
  SkillDraftResponse,
  SkillDraftSaveResponse,
  SkillEvalResult,
  SkillGenerateResponse,
  SkillPackageFile,
  SkillPackageView,
  SkillSandboxRunResponse,
  SkillSuggestResponse,
  SkillView,
} from "../shared/skills.ts";

export async function openSkillStudio(
  skillName: string | undefined,
  onBack: () => void | Promise<void>,
  reloadParentList: () => Promise<void>
): Promise<HTMLElement> {
  const root = el("div", { className: "skill-studio-layout" });

  let pkg: SkillPackageView;
  let hasDraft = false;
  let draftSavedAt: string | undefined = undefined;
  let isDirty = false;
  let isSavingDraft = false;
  let isPublishing = false;

  let activeFileName = "SKILL.md";
  let activeMode: "visual" | "raw" | "yolo" = "visual";
  let activeBreakpoint: "sm" | "md" | "lg" | "full" = "md";
  let evalResults: SkillEvalResult[] = [];
  let sandboxLog: SkillSandboxRunResponse | null = null;
  let isRunningTests = false;
  let isRunningSandbox = false;
  let activeTools: { id: string; name: string }[] = [];

  // Feedback banner
  const feedback = el("p", { className: "settings-feedback", role: "status", "aria-live": "polite" });
  const showError = (err: unknown) => {
    feedback.textContent = (err as Error).message;
    feedback.className = "settings-feedback bad";
  };
  const showNotice = (msg: string) => {
    feedback.textContent = msg;
    feedback.className = "settings-feedback ok";
  };

  // Load existing draft/package or initialize a fresh new package
  try {
    const integrations = await api<{ entry: { id: string; name: string }; enabled: boolean }[]>("/api/integrations").catch(() => []);
    activeTools = integrations.map(i => ({ id: i.entry.id, name: i.entry.name }));

    if (skillName) {
      const draftResp = await api<SkillDraftResponse>(`/api/skills/${encodeURIComponent(skillName)}/draft`);
      pkg = draftResp.package;
      hasDraft = draftResp.hasDraft;
      draftSavedAt = draftResp.draftSavedAt;
      if (hasDraft) {
        showNotice(`Loaded working draft${draftSavedAt ? ` from ${new Date(draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. Live assistant uses published version until you publish.`);
      }
    } else {
      const template = `---
name: my-new-skill
description: Analyze domain records, detect anomalies, and present 3-tier canvas projections and spoken findings.
allowed-tools: read_skill_file
license: MIT
compatibility: Compliant with Agent Skills specification and Vakyartha Projection.
metadata:
  author: Studio Author
  version: "1.0.0"
---

# my-new-skill

## Objective
Analyze domain records from supplied inputs and project structured findings across interactive canvas surfaces.

## Procedure
1. Resolve reporting window, currency, and verified data collections.
2. Load \`interactive-ui\` when binding canonical data or receiving form submissions.
3. The shared, required \`surface-design\` guidance applies automatically:
   - Tier 1: Executive headline and 3-column KPI metric strip.
   - Tier 2: 2-column analytics grid pairing a trend chart with category distribution.
   - Tier 3: Dense detail inspection table with sorting and filtering.
4. Keep one canonical collection under \`/records\` rather than duplicating numbers.
5. Formulate the visible narrative so the first sentence carries the primary finding and key caveat for Voice TTS.
`;
      pkg = {
        skill: {
          name: "my-new-skill",
          description: "Analyze domain records, detect anomalies, and present 3-tier canvas projections and spoken findings.",
          enabled: false,
          body: template,
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
            path: "references/rules.md",
            text: "# Domain Rules\n- Maintain verified data timestamps.\n- Flag variance greater than 15%.\n",
            bytes: 75,
            status: "added",
          },
          {
            path: "tests/test_scenarios.json",
            text: JSON.stringify({
              positive_prompts: [
                "Review my-new-skill performance and show the dashboard",
                "What is the segment value breakdown and status distribution?"
              ],
              distractor_prompts: [
                "What is the weather in Paris?",
                "Draft an email to schedule a meeting"
              ]
            }, null, 2),
            bytes: 260,
            status: "added",
          }
        ]
      };
      hasDraft = false;
      draftSavedAt = undefined;
    }
  } catch (err) {
    showError(err);
    pkg = {
      skill: { name: skillName || "skill", description: "", enabled: false, body: "", text: "" },
      files: []
    };
  }

  // --- Helpers for parsing and editing ---
  function getActiveText(): string {
    if (activeFileName === "SKILL.md") return pkg.skill.text;
    const f = pkg.files.find(item => item.path === activeFileName);
    return f ? f.text : "";
  }

  function setActiveText(content: string): void {
    isDirty = true;
    if (activeFileName === "SKILL.md") {
      pkg.skill.text = content;
      const mName = /^name:\s*([a-z0-9-]+)/m.exec(content);
      if (mName?.[1]) pkg.skill.name = mName[1];
      const mDesc = /^description:\s*(.+)$/m.exec(content);
      if (mDesc?.[1]) pkg.skill.description = mDesc[1].trim();
      const mTools = /^allowed-tools:\s*(.+)$/m.exec(content);
      if (mTools?.[1]) pkg.skill.allowedTools = mTools[1].trim();
      const parts = content.split(/^---\s*$/m);
      if (parts.length >= 3) pkg.skill.body = parts.slice(2).join("---").trim();
    } else {
      let f = pkg.files.find(item => item.path === activeFileName);
      if (!f) {
        f = { path: activeFileName, text: content, bytes: new TextEncoder().encode(content).length, status: "added" };
        pkg.files.push(f);
      } else {
        f.text = content;
        f.bytes = new TextEncoder().encode(content).length;
      }
    }
  }

  function rebuildSkillMdFromVisual(name: string, desc: string, tools: string, bodyText: string): void {
    isDirty = true;
    const header = [
      "---",
      `name: ${name.trim()}`,
      `description: ${desc.trim()}`,
      tools.trim() ? `allowed-tools: ${tools.trim()}` : null,
      `license: ${pkg.skill.license ?? "MIT"}`,
      `compatibility: ${pkg.skill.compatibility ?? "Compliant with Agent Skills specification."}`,
      "metadata:",
      "  author: Studio Author",
      `  updated: "${new Date().toISOString()}"`,
      "---",
      "",
      bodyText.trim()
    ].filter(Boolean).join("\n");
    pkg.skill.name = name.trim();
    pkg.skill.description = desc.trim();
    pkg.skill.allowedTools = tools.trim();
    pkg.skill.body = bodyText.trim();
    pkg.skill.text = header;
  }

  // --- Draft vs Publish Operations ---

  async function saveDraftAction(): Promise<void> {
    if (isSavingDraft) return;
    isSavingDraft = true;
    feedback.textContent = "Saving draft…";
    feedback.className = "settings-feedback";
    try {
      const payload = {
        text: pkg.skill.text,
        files: pkg.files.map(f => ({ path: f.path, text: f.text }))
      };
      const res = await api<SkillDraftSaveResponse>(`/api/skills/${encodeURIComponent(pkg.skill.name)}/draft`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      hasDraft = true;
      draftSavedAt = res.draftSavedAt;
      isDirty = false;
      showNotice(`Draft saved at ${new Date(res.draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Live assistant will NOT see changes until published.`);
      await reloadParentList();
      render();
    } catch (err) {
      showError(err);
    } finally {
      isSavingDraft = false;
      render();
    }
  }

  async function discardDraftAction(): Promise<void> {
    if (!hasDraft) return;
    const ok = await ask(`Discard working draft for “${pkg.skill.name}”? Workspace will revert to the live published package.`, "Discard Draft");
    if (!ok) return;
    feedback.textContent = "Discarding draft…";
    feedback.className = "settings-feedback";
    try {
      await api(`/api/skills/${encodeURIComponent(pkg.skill.name)}/draft`, { method: "DELETE" });
      hasDraft = false;
      draftSavedAt = undefined;
      isDirty = false;
      pkg = await api<SkillPackageView>(`/api/skills/${encodeURIComponent(pkg.skill.name)}/package`);
      showNotice(`Draft discarded. Workspace reverted to live published package.`);
      await reloadParentList();
      render();
    } catch (err) {
      showError(err);
    }
  }

  async function publishAction(): Promise<void> {
    if (isPublishing) return;
    isPublishing = true;
    feedback.textContent = "Publishing skill to assistant…";
    feedback.className = "settings-feedback";
    try {
      const payload = {
        text: pkg.skill.text,
        files: pkg.files.map(f => ({ path: f.path, text: f.text }))
      };
      const saved = await api<SkillView>(`/api/skills/${encodeURIComponent(pkg.skill.name)}/publish`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      pkg.skill = saved;
      hasDraft = false;
      draftSavedAt = undefined;
      isDirty = false;
      showNotice(`⚡ Successfully published “${saved.name}”! The live assistant can now use this skill.`);
      await reloadParentList();
      render();
    } catch (err) {
      showError(err);
    } finally {
      isPublishing = false;
      render();
    }
  }

  async function backAction(): Promise<void> {
    if (isDirty) {
      const shouldSave = await ask("You have unsaved edits in Skill Studio. Save them as a draft before leaving?", "Save Draft");
      if (shouldSave) {
        await saveDraftAction();
      }
    }
    await onBack();
  }

  // --- Run Test Prompts ---
  async function runEvaluation(): Promise<void> {
    if (isRunningTests) return;
    isRunningTests = true;
    evalResults = [];
    render();
    try {
      const testsFile = pkg.files.find(f => f.path.includes("tests/") || f.path.includes("test_scenarios.json"));
      let testPrompts = [
        `Review the latest ${pkg.skill.name.replace(/-/g, " ")} metrics and show the dashboard`,
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
          name: pkg.skill.name,
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

  // --- Run Sandbox Script ---
  async function runSandboxTest(scriptPath: string): Promise<void> {
    if (isRunningSandbox) return;
    isRunningSandbox = true;
    sandboxLog = null;
    render();
    try {
      sandboxLog = await api<SkillSandboxRunResponse>(`/api/skills/${encodeURIComponent(pkg.skill.name)}/sandbox-test`, {
        method: "POST",
        body: JSON.stringify({ scriptPath })
      });
      if (sandboxLog.exitCode === 0) {
        showNotice(`Sandbox test run succeeded (0 errors in ${sandboxLog.durationMs}ms).`);
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

  // --- Main Render Function ---
  function render(): void {
    root.replaceChildren();

    // 1. Toolbar
    const backBtn = el("button", {
      type: "button",
      className: "ghost small studio-back-btn",
      textContent: "‹ Skills"
    });
    backBtn.onclick = () => void backAction();

    const titleBox = el("div", { className: "studio-title-box" },
      el("h2", { className: "studio-skill-title", textContent: pkg.skill.name }),
      pill(pkg.skill.builtin ? "Built in" : "Yours", "info"),
      pill(pkg.skill.enabled ? "On" : "Off", pkg.skill.enabled ? "ok" : ""),
      hasDraft
        ? pill(`Draft · Unpublished${draftSavedAt ? ` (${new Date(draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""}`, "caution")
        : pill("Live / Published", "ok"),
      isDirty ? pill("Unsaved edits", "info") : null,
      pill(`${Math.ceil((new TextEncoder().encode(pkg.skill.text).length + pkg.files.reduce((acc, f) => acc + f.bytes, 0)) / 1024)} KB`),
    );

    const modeSelector = segmented(
      [["visual", "Visual Spec"], ["raw", "Raw SKILL.md"], ["yolo", "⚡ YOLO Co-Pilot"]] as const,
      activeMode,
      v => { activeMode = v; render(); }
    );
    modeSelector.classList.add("studio-mode-selector");

    const bpSelector = segmented(
      [["sm", "320px (Mobile)"], ["md", "720px (Medium)"], ["lg", "960px (Grid)"], ["full", "Full Width"]] as const,
      activeBreakpoint,
      v => { activeBreakpoint = v; updateCanvasWidth(); }
    );
    bpSelector.classList.add("studio-bp-selector");

    const saveDraftBtn = el("button", {
      type: "button",
      className: "ghost small studio-save-draft-btn",
      textContent: isSavingDraft ? "Saving Draft…" : "Save Draft",
      title: "Save draft to isolated drafts directory without affecting the live assistant."
    });
    saveDraftBtn.onclick = () => void saveDraftAction();

    const discardDraftBtn = hasDraft
      ? el("button", {
          type: "button",
          className: "ghost small studio-discard-btn",
          textContent: "Discard Draft",
          title: "Discard your working draft and revert back to the live published package."
        })
      : null;
    if (discardDraftBtn) discardDraftBtn.onclick = () => void discardDraftAction();

    const publishBtn = el("button", {
      type: "button",
      className: "primary small studio-publish-btn",
      textContent: isPublishing ? "Publishing…" : "⚡ Publish Skill",
      title: "Promote this package to the live assistant. Clears draft and activates immediately."
    });
    publishBtn.onclick = () => void publishAction();

    const runTestsBtn = el("button", {
      type: "button",
      className: "ghost small studio-test-btn",
      textContent: isRunningTests ? "Testing…" : "Run Test Suite"
    });
    runTestsBtn.onclick = () => void runEvaluation();

    const toolbar = el("div", { className: "studio-toolbar" },
      el("div", { className: "studio-toolbar-left" }, backBtn, titleBox),
      el("div", { className: "studio-toolbar-center" }, modeSelector, bpSelector),
      el("div", { className: "studio-toolbar-right" },
        runTestsBtn,
        saveDraftBtn,
        ...(discardDraftBtn ? [discardDraftBtn] : []),
        publishBtn
      )
    );

    // 2. Three-Column Workspace Layout
    const workspace = el("div", { className: "studio-workspace" });

    // --- LEFT COLUMN: File Tree & Smart Suggestions ---
    const leftCol = el("div", { className: "studio-col studio-left-col" });

    // File Explorer Header
    const treeHeader = el("div", { className: "studio-tree-header" },
      el("span", { className: "studio-section-label", textContent: "Package Files" }),
      el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: "+ Add File",
        onclick: async () => {
          const newPath = window.prompt("Relative file path (e.g. references/guide.md or scripts/parse.py):");
          if (!newPath || !newPath.trim()) return;
          const clean = newPath.trim().replace(/^\.?\//, "");
          if (clean === "SKILL.md" || pkg.files.some(f => f.path === clean)) {
            showError(new Error("File already exists in package."));
            return;
          }
          pkg.files.push({
            path: clean,
            text: `# ${clean}\n\nSupporting file content.\n`,
            bytes: 30,
            status: "added"
          });
          activeFileName = clean;
          isDirty = true;
          render();
        }
      })
    );

    const fileList = el("div", { className: "studio-file-tree" });

    // Root SKILL.md
    const rootItem = el("div", {
      className: `studio-tree-item${activeFileName === "SKILL.md" ? " active" : ""}`,
      onclick: () => { activeFileName = "SKILL.md"; render(); }
    }, icon("spark", 14), el("span", { textContent: "SKILL.md" }), el("span", { className: "tree-size", textContent: `${Math.ceil(new TextEncoder().encode(pkg.skill.text).length / 1024)}K` }));
    fileList.append(rootItem);

    // Supporting Files
    for (const file of pkg.files.toSorted((a, b) => a.path.localeCompare(b.path))) {
      const isScript = /\.(?:py|sh|js|mjs|ts)$/i.test(file.path);
      const isSchema = /\.(?:json)$/i.test(file.path);
      const fileGlyph = isScript ? "code" : isSchema ? "table" : "page";

      const delBtn = el("button", {
        type: "button",
        className: "ghost tiny tree-del-btn",
        title: "Remove file",
        textContent: "×",
        onclick: (e) => {
          e.stopPropagation();
          pkg.files = pkg.files.filter(f => f.path !== file.path);
          if (activeFileName === file.path) activeFileName = "SKILL.md";
          isDirty = true;
          render();
        }
      });

      const fileItem = el("div", {
        className: `studio-tree-item${activeFileName === file.path ? " active" : ""}`,
        onclick: () => { activeFileName = file.path; render(); }
      }, icon(fileGlyph, 14), el("span", { className: "tree-path", textContent: file.path }), el("span", { className: "tree-size", textContent: `${Math.ceil(file.bytes / 1024)}K` }), delBtn);
      fileList.append(fileItem);
    }

    // Smart Co-Pilot Suggestions Drawer
    const suggestionsBox = el("div", { className: "studio-suggestions-drawer" },
      el("div", { className: "studio-section-label", textContent: "✨ Smart Element Suggestions" }),
      el("div", { className: "studio-chip-group" },
        el("button", {
          type: "button",
          className: "ghost tiny studio-suggest-chip",
          textContent: "Optimize Trigger",
          onclick: async () => {
            try {
              const res = await api<SkillSuggestResponse>("/api/skills/suggest", {
                method: "POST",
                body: JSON.stringify({ type: "trigger", name: pkg.skill.name, description: pkg.skill.description })
              });
              pkg.skill.description = res.suggestion;
              rebuildSkillMdFromVisual(pkg.skill.name, res.suggestion, pkg.skill.allowedTools ?? "", pkg.skill.body);
              showNotice(res.rationale);
              render();
            } catch (err) { showError(err); }
          }
        }),
        el("button", {
          type: "button",
          className: "ghost tiny studio-suggest-chip",
          textContent: "Suggest Best Chart",
          onclick: async () => {
            try {
              const res = await api<SkillSuggestResponse>("/api/skills/suggest", {
                method: "POST",
                body: JSON.stringify({ type: "chart", body: pkg.skill.body })
              });
              showNotice(`Recommended chart kind: “${res.suggestion}”. ${res.rationale}`);
            } catch (err) { showError(err); }
          }
        }),
        el("button", {
          type: "button",
          className: "ghost tiny studio-suggest-chip",
          textContent: "Auto-Bind Schema",
          onclick: async () => {
            try {
              const res = await api<SkillSuggestResponse>("/api/skills/suggest", {
                method: "POST",
                body: JSON.stringify({ type: "binding", field: "value" })
              });
              navigator.clipboard?.writeText(res.suggestion).catch(() => {});
              showNotice(`Copied canonical pointer fragment to clipboard: ${res.suggestion}`);
            } catch (err) { showError(err); }
          }
        }),
        el("button", {
          type: "button",
          className: "ghost tiny studio-suggest-chip",
          textContent: "Detect Tools",
          onclick: async () => {
            try {
              const res = await api<SkillSuggestResponse>("/api/skills/suggest", {
                method: "POST",
                body: JSON.stringify({ type: "tools", body: pkg.skill.body })
              });
              pkg.skill.allowedTools = res.suggestion;
              rebuildSkillMdFromVisual(pkg.skill.name, pkg.skill.description, res.suggestion, pkg.skill.body);
              showNotice(res.rationale);
              render();
            } catch (err) { showError(err); }
          }
        }),
        el("button", {
          type: "button",
          className: "ghost tiny studio-suggest-chip",
          textContent: "Voice Gist Summary",
          onclick: async () => {
            try {
              const res = await api<SkillSuggestResponse>("/api/skills/suggest", {
                method: "POST",
                body: JSON.stringify({ type: "gist", name: pkg.skill.name, body: pkg.skill.body })
              });
              showNotice(`Spoken summary proposal: “${res.suggestion}”`);
            } catch (err) { showError(err); }
          }
        })
      )
    );

    // Test Scenarios Drawer
    const testsDrawer = el("div", { className: "studio-tests-drawer" },
      el("div", { className: "studio-section-label", textContent: "Test Scenarios & Selection Gate" })
    );

    if (evalResults.length) {
      for (const res of evalResults) {
        const item = el("div", { className: "studio-test-result" },
          el("span", { className: `test-dot ${res.passed ? "pass" : "fail"}`, textContent: res.passed ? "✓" : "✗" }),
          el("div", { className: "test-text" },
            el("p", { className: "test-prompt", textContent: res.prompt }),
            el("span", { className: "test-meta", textContent: `${res.durationMs}ms · selected: ${res.selectedSkills.join(", ") || "none"}` })
          )
        );
        testsDrawer.append(item);
      }
    } else {
      testsDrawer.append(el("p", { className: "row-hint", textContent: "Run test suite to verify use_skill selection gate on active provider." }));
    }

    leftCol.append(treeHeader, fileList, suggestionsBox, testsDrawer);

    // --- CENTER COLUMN: Workspace & Editors ---
    const centerCol = el("div", { className: "studio-col studio-center-col" });

    if (activeMode === "yolo") {
      // YOLO Mode: Natural language package generator
      const yoloCard = el("div", { className: "studio-yolo-card" },
        el("div", { className: "yolo-badge", textContent: "⚡ YOLO Mode · Autonomous Package Synthesis" }),
        el("p", { className: "lead", textContent: "Describe the skill you want to create in plain language. The Co-Pilot will synthesize the complete package: instructions, canonical schemas, reference formulas, inert scripts, and test prompts." }),
        el("div", { className: "yolo-input-group" },
          (() => {
            const yoloPrompt = el("textarea", {
              className: "yolo-prompt-input",
              rows: 3,
              placeholder: "e.g. Create a Customer Retention & Churn Analytics skill with interactive forecast chart, customer health table, and sandbox Python data parser."
            });
            const genBtn = el("button", {
              type: "button",
              className: "primary",
              textContent: "⚡ Synthesize Full Package",
              onclick: async () => {
                const text = yoloPrompt.value.trim();
                if (!text) return;
                genBtn.disabled = true;
                genBtn.textContent = "Synthesizing Package…";
                try {
                  const res = await api<SkillGenerateResponse>("/api/skills/generate", {
                    method: "POST",
                    body: JSON.stringify({ prompt: text })
                  });
                  pkg.skill.name = res.name;
                  pkg.skill.description = res.description;
                  pkg.skill.allowedTools = res.allowedTools;
                  pkg.skill.body = res.body;
                  rebuildSkillMdFromVisual(res.name, res.description, res.allowedTools ?? "", res.body);
                  pkg.files = res.files.map(f => ({
                    path: f.path,
                    text: f.text,
                    bytes: new TextEncoder().encode(f.text).length,
                    status: "added"
                  }));
                  isDirty = true;
                  showNotice(res.rationale ?? "Synthesized full Agent Skills package.");
                  activeMode = "visual";
                  render();
                } catch (err) {
                  showError(err);
                } finally {
                  genBtn.disabled = false;
                  genBtn.textContent = "⚡ Synthesize Full Package";
                }
              }
            });
            return el("div", {}, yoloPrompt, el("div", { className: "row-actions" }, genBtn));
          })()
        )
      );
      centerCol.append(yoloCard);
    } else if (activeFileName === "SKILL.md" && activeMode === "visual") {
      // Visual Form Editor for Frontmatter + Instructions
      const nameInput = el("input", {
        type: "text",
        className: "wide studio-input",
        value: pkg.skill.name,
        "aria-label": "Skill Name"
      });
      nameInput.oninput = () => {
        rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
      };

      const descInput = el("textarea", {
        className: "wide studio-input",
        rows: 3,
        value: pkg.skill.description,
        "aria-label": "Trigger Description"
      });
      const descCount = el("span", { className: "desc-counter", textContent: `${pkg.skill.description.length}/1024 chars` });
      descInput.oninput = () => {
        descCount.textContent = `${descInput.value.length}/1024 chars`;
        rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
      };

      const toolsInput = el("input", {
        type: "text",
        className: "wide studio-input",
        value: pkg.skill.allowedTools ?? "",
        placeholder: "read_skill_file sandbox_exec search_web",
        "aria-label": "Allowed Tools"
      });
      toolsInput.oninput = () => {
        rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
      };

      // Tool Quick-Select Chips
      const toolChips = el("div", { className: "studio-tool-chips" });
      for (const t of activeTools) {
        const isSelected = (pkg.skill.allowedTools ?? "").includes(t.id);
        const chip = el("button", {
          type: "button",
          className: `tiny ghost chip${isSelected ? " active" : ""}`,
          textContent: `${isSelected ? "✓ " : "+ "}${t.name}`,
          onclick: () => {
            const current = (pkg.skill.allowedTools ?? "").split(/\s+/).filter(Boolean);
            const next = current.includes(t.id) ? current.filter(x => x !== t.id) : [...current, t.id];
            toolsInput.value = next.join(" ");
            rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
            render();
          }
        });
        toolChips.append(chip);
      }

      const bodyEditor = el("textarea", {
        className: "skill-editor studio-body-editor",
        rows: 16,
        value: pkg.skill.body,
        spellcheck: false,
        "aria-label": "Skill Instructions"
      });
      bodyEditor.oninput = () => {
        rebuildSkillMdFromVisual(nameInput.value, descInput.value, toolsInput.value, bodyEditor.value);
        updateLiveCanvas();
      };

      centerCol.append(
        group("Identity & Semantic Trigger",
          row("Skill Name", "Alphanumeric lowercase with hyphens (e.g. market-dashboard).", nameInput),
          row("Trigger Description", "Crucial for use_skill semantic discovery. Stated in third person.", el("div", {}, descInput, descCount)),
          row("Declared Tools (allowed-tools)", "Guards tool coordination; does not grant ambient authority.", el("div", {}, toolsInput, toolChips))
        ),
        group("Instructions & Visual Layout Contract",
          el("p", { className: "row-hint", textContent: "Adheres to 3-Tier liquid layout, single canonical projection, and multi-surface degradation." }),
          bodyEditor
        )
      );
    } else {
      // Raw or Supporting File Editor
      const fileHeader = el("div", { className: "studio-file-editor-header" },
        el("span", { className: "studio-editing-path", textContent: `Editing: ${activeFileName}` }),
        pill(`${getActiveText().length} chars`)
      );

      const codeEditor = el("textarea", {
        className: "skill-editor studio-raw-editor",
        rows: 24,
        value: getActiveText(),
        spellcheck: false,
        "aria-label": activeFileName
      });
      codeEditor.oninput = () => {
        setActiveText(codeEditor.value);
        updateLiveCanvas();
      };

      centerCol.append(fileHeader, codeEditor);
    }

    // --- RIGHT COLUMN: Live Staged Projection & Inspection ---
    const rightCol = el("div", { className: "studio-col studio-right-col" });

    // Canvas Preview Wrapper
    const canvasContainer = el("div", { className: "studio-canvas-container" });
    const canvasWrapper = el("div", { className: `studio-canvas-wrapper bp-${activeBreakpoint}` });
    const surfaceMount = el("div", { className: "studio-surface-mount" });
    canvasWrapper.append(surfaceMount);
    canvasContainer.append(canvasWrapper);

    // Layout Linter Card
    const linterCard = el("div", { className: "studio-linter-card" });
    const linterBadge = el("span", { className: "pill ok", textContent: "✓ Layout Compliant" });
    const linterNotes = el("ul", { className: "studio-linter-notes" });
    linterCard.append(el("div", { className: "linter-head" }, el("span", { className: "studio-section-label", textContent: "Surface Design Linter" }), linterBadge), linterNotes);

    // Voice Projection Card
    const voiceCard = el("div", { className: "studio-voice-card" });
    const voiceText = el("p", { className: "voice-spoken-text" });
    const voicePlayBtn = el("button", {
      type: "button",
      className: "ghost tiny voice-play-btn",
      textContent: "▶ Play Voice Gist",
      onclick: () => {
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(voiceText.textContent || "No text available");
          window.speechSynthesis.speak(utterance);
        }
      }
    });
    voiceCard.append(el("div", { className: "voice-head" }, el("span", { className: "studio-section-label", textContent: "Dual Spoken Projection (lowerSurface)" }), voicePlayBtn), voiceText);

    // Sandbox Test Execution Card
    const sandboxCard = el("div", { className: "studio-sandbox-card" });
    const scriptFiles = pkg.files.filter(f => /\.(?:py|sh|js)$/i.test(f.path));
    if (scriptFiles.length) {
      const scriptSel = el("select", { className: "tiny" });
      for (const s of scriptFiles) scriptSel.append(el("option", { value: s.path, textContent: s.path }));

      const runScriptBtn = el("button", {
        type: "button",
        className: "ghost tiny",
        textContent: isRunningSandbox ? "Running…" : "▶ Run in Sandbox",
        onclick: () => void runSandboxTest(scriptSel.value)
      });

      const sandboxOutput = el("pre", {
        className: "studio-sandbox-output",
        textContent: sandboxLog ? (sandboxLog.stdout || sandboxLog.stderr || "Process exited with code 0") : "Click 'Run in Sandbox' to test script execution in disposable realm."
      });

      sandboxCard.append(
        el("div", { className: "sandbox-head" }, el("span", { className: "studio-section-label", textContent: "vak-sandbox Rehearsal" }), el("div", { className: "row-actions" }, scriptSel, runScriptBtn)),
        sandboxOutput
      );
    }

    rightCol.append(
      el("div", { className: "studio-section-label", textContent: "Live Canvas Staging" }),
      canvasContainer,
      linterCard,
      voiceCard,
      ...(scriptFiles.length ? [sandboxCard] : [])
    );

    workspace.append(leftCol, centerCol, rightCol);
    root.append(toolbar, feedback, workspace);

    // Initial canvas paint
    updateCanvasWidth();
    updateLiveCanvas();
  }

  function updateCanvasWidth(): void {
    const wrapper = root.querySelector(".studio-canvas-wrapper") as HTMLElement | null;
    if (!wrapper) return;
    wrapper.className = `studio-canvas-wrapper bp-${activeBreakpoint}`;
  }

  function updateLiveCanvas(): void {
    const mount = root.querySelector(".studio-surface-mount") as HTMLElement | null;
    const notes = root.querySelector(".studio-linter-notes") as HTMLElement | null;
    const badge = root.querySelector(".studio-linter-card .pill") as HTMLElement | null;
    const voiceOutput = root.querySelector(".voice-spoken-text") as HTMLElement | null;
    if (!mount || !notes || !badge || !voiceOutput) return;

    // Linting checks
    notes.replaceChildren();
    let warnings = 0;
    const bodyLower = pkg.skill.body.toLowerCase();

    // Distortion check
    if (bodyLower.includes('maxwidth: "full"') && (bodyLower.includes("chart") || bodyLower.includes("kind: \"line\"") || bodyLower.includes("kind: \"bar\""))) {
      notes.append(el("li", { className: "warn", textContent: "Single chart given maxWidth: 'full' can distort aspect ratio on desktop screens. Clamp to 'md' or 'lg'." }));
      warnings++;
    }

    // Hex color check
    if (/#[0-9a-f]{3,8}\b/i.test(pkg.skill.body)) {
      notes.append(el("li", { className: "warn", textContent: "Raw hex color detected. Use semantic tones: positive, caution, critical, neutral." }));
      warnings++;
    }

    // Unsupported chart check
    if (/candlestick|waterfall|box-plot|bubble/i.test(bodyLower)) {
      notes.append(el("li", { className: "warn", textContent: "Unsupported chart kind requested. Standard kinds are bar, stacked, line, area, pie, scatter, heatmap, radar." }));
      warnings++;
    }

    if (warnings > 0) {
      badge.textContent = `⚠️ ${warnings} Warning${warnings > 1 ? "s" : ""}`;
      badge.className = "pill caution";
    } else {
      badge.textContent = "✓ Layout Compliant";
      badge.className = "pill ok";
    }

    // Load canonical mock data
    let records = [
      { id: "1", label: "Alpha Segment", value: 45000, status: "normal" },
      { id: "2", label: "Beta Segment", value: 68200, status: "normal" },
      { id: "3", label: "Gamma Segment", value: 29400, status: "caution" },
      { id: "4", label: "Delta Segment", value: 12800, status: "critical" },
    ];

    const schemaFile = pkg.files.find(f => f.path.includes("records.json") || f.path.includes("schemas/"));
    if (schemaFile) {
      try {
        const parsed = JSON.parse(schemaFile.text);
        if (Array.isArray(parsed.records)) records = parsed.records;
      } catch {}
    }

    // Construct live surface store and element
    const store = new SurfaceStore(basicCatalog);
    const snapId = `studio-${pkg.skill.name}`;

    const nodes: VpsNode[] = [
      {
        id: "root-section",
        type: "section",
        props: {
          title: pkg.skill.name.replace(/-/g, " "),
          description: pkg.skill.description
        },
        children: ["metric-grid", "analytics-split", "records-table"]
      },
      {
        id: "metric-grid",
        type: "grid",
        props: { columns: 4, minItemWidth: "xs" },
        children: ["m1", "m2", "m3", "m4"]
      },
      {
        id: "m1",
        type: "metric",
        props: { label: "Total Volume", value: { records: "{/records}", field: "value", aggregate: "sum" } }
      },
      {
        id: "m2",
        type: "metric",
        props: { label: "Average Size", value: { records: "{/records}", field: "value", aggregate: "mean" } }
      },
      {
        id: "m3",
        type: "metric",
        props: { label: "Peak Observed", value: { records: "{/records}", field: "value", aggregate: "max" } }
      },
      {
        id: "m4",
        type: "metric",
        props: { label: "Tracked Entities", value: { records: "{/records}", field: "id", aggregate: "count" } }
      },
      {
        id: "analytics-split",
        type: "split",
        props: { ratio: [2, 1], maxWidth: "lg" },
        children: ["trend-chart", "status-chart"]
      },
      {
        id: "trend-chart",
        type: "chart",
        props: {
          title: "Observed Distribution",
          kind: "bar",
          series: { records: "{/records}", label: "label", fields: ["value"] }
        }
      },
      {
        id: "status-chart",
        type: "chart",
        props: {
          title: "Entity Breakdown",
          kind: "pie",
          series: { records: "{/records}", label: "label", fields: ["value"] }
        }
      },
      {
        id: "records-table",
        type: "table",
        props: {
          title: "Granular Source Records",
          maxWidth: "full",
          searchable: true,
          sortable: true,
          rows: { records: "{/records}", fields: ["id", "label", "value", "status"] }
        }
      }
    ];

    const snap: SurfaceSnapshot = {
      id: snapId,
      version: 1,
      title: pkg.skill.name.replace(/-/g, " "),
      data: { records },
      nodes
    };

    store.load(snap);
    const surfaceEl = document.createElement("vak-surface") as VakSurfaceElement;
    surfaceMode(surfaceEl);
    surfaceEl.attach(store, snapId);
    mount.replaceChildren(surfaceEl);

    // Compute Voice Gist simulation
    const resolved = store.resolve(snapId);
    if (resolved) {
      const lowered = lowerSurface(resolved);
      const spoken = projectText(lowered).replace(/\s+/g, " ").trim();
      voiceOutput.textContent = spoken || "Summary: Review complete across all observed entities with 0 unhandled variances.";
    }
  }

  render();
  return root;
}
