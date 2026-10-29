// Settings → Sandbox uses the app's actual helper, settings and integration state.
import { api, el } from "./core.ts";
import { icon } from "./icons.ts";
import { group, pill, row, title, toggle } from "./ui.ts";
import { realmSettings } from "./sandbox-realms-page.ts";
import { checkEgressDetailed, normalizeEgressTarget, pickFolder } from "./backend.ts";
import type { SandboxStatus } from "../shared/sandbox.ts";

export async function sandboxPage(openIntegration: () => void, openSkill: () => void): Promise<HTMLElement[]> {
  const root = el("div", { className: "sandbox-layout" });
  let status = await api<SandboxStatus>("/api/sandbox");
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
    el("p", { id: "sandbox-workspace-hint", className: "row-hint", textContent: "Use an absolute path to one project. One-shot runs use a fresh copy; Realms keep a separate copy across commands." }),
    workspaceField, el("div", { className: "row-actions" }, save, reset));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = workspace.value.trim();
    save.disabled = true; workspace.disabled = true; reset.disabled = true;
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { VAK_SANDBOX_WORKSPACE: value } }) });
      saved = value; workspace.value = value; workspace.removeAttribute("aria-invalid");
      report(value ? "Folder saved. The next command uses a fresh copy." : "Folder cleared. Command execution needs a project folder.");
      await refresh().catch(error => report(`Folder saved, but status could not refresh: ${error.message}`, true));
    } catch (error) { workspace.setAttribute("aria-invalid", "true"); report((error as Error).message, true); }
    finally { workspace.disabled = false; reset.disabled = false; updateDraft(); }
  });
  const protection = toggle(status.enabled, async on => {
    const input = protection as HTMLInputElement;
    input.disabled = true;
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { VAK_SANDBOX_ENABLED: String(on) } }) });
      report(on ? "Isolation enabled for command runs. Local MCP server settings apply after restarting the app." : "Command execution is blocked. Restart the app to apply the local MCP server setting.");
      await refresh().catch(error => report(`Setting saved, but status could not refresh: ${error.message}`, true));
    } catch (error) { input.checked = !on; report((error as Error).message, true); }
    finally { input.disabled = false; }
  });
  protection.setAttribute("aria-label", "Enable OS-level isolation");
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
    const ready = status.enabled && status.platform === "darwin" && status.helper.available && status.helper.compatible && status.workspace.valid && status.execution.enabled && status.execution.status === "ready" && status.execution.policy !== "off";
    test.disabled = !ready;
    const headline = !status.enabled ? "Command execution is blocked" : status.platform !== "darwin" ? "Command isolation needs macOS" : !status.helper.available ? "Sandbox helper unavailable" : !status.helper.compatible ? "Sandbox helper needs an update" : !status.workspace.valid ? "Choose a project to get started" : !status.execution.enabled ? "Enable sandboxed execution" : status.execution.policy === "off" ? "Command tool is off" : ready ? "Ready for isolated commands" : "Execution needs attention";
    const detail = status.helper.available && !status.helper.compatible ? status.helper.error! : !status.helper.available ? "Commands fail closed. Local MCP servers can fall back to running without OS isolation when the helper is missing." : status.restartRequired ? "Restart required for the local MCP server setting. Command runs already use the saved switch." : ready ? "Commands run in isolated copies with network denied. Use a Realm to keep changes across runs." : "Finish the setup below. Enabling a skill does not grant tool access.";
    health.replaceChildren(el("div", { className: "sandbox-health-icon" }, icon("shield", 24)), el("div", {}, el("h2", { textContent: headline }), el("p", { className: "row-hint", textContent: detail })), pill(ready ? "Ready" : "Needs attention", ready ? "ok" : ""));
    execution.replaceChildren(row("Sandboxed execution", `Integration ${status.execution.enabled ? "on" : "off"} · run_command policy: ${status.execution.policy === "ask" ? "Ask before running" : status.execution.policy === "allow" ? "Allowed without asking" : "Blocked"}.`, button("Manage tool & approvals", openIntegration)), row("Sandbox skill", "Guides command planning and error recovery. Instructions use the same governed execution tool.", button("Open skill", openSkill)));
    helperDetails.replaceChildren(row("Helper", status.helper.error ?? status.helper.version ?? "Unavailable", pill(status.helper.compatible ? "Compatible" : status.helper.available ? "Outdated" : "Missing", status.helper.compatible ? "ok" : "bad")), row("Helper location", status.helper.path), row("Local MCP server setting at startup", status.processIsolationEnabled ? "Isolation requested. This is not confirmation that every running server is contained." : "OS isolation was disabled at startup."), row("Project folder", status.workspace.error ?? status.workspace.path, pill(status.workspace.valid ? "Accessible" : "Not configured", status.workspace.valid ? "ok" : "")));
  }

  // Network Egress Allowlist & Testing
  function cleanEndpointString(raw: string): string {
    let s = raw.trim();
    if (!s) return "";
    s = s.replace(/^https?:\/\//i, "");
    const slash = s.indexOf("/");
    if (slash !== -1) s = s.slice(0, slash);
    return s.trim();
  }

  function endpointType(item: string): string {
    if (item.startsWith(".")) return "Domain suffix";
    if (item.includes(":") && !item.includes("://")) return "Host:port";
    return "Host";
  }

  function parseEndpointList(str: string): string[] {
    const set = new Set<string>();
    for (const part of str.split(/[\s,]+/)) {
      const clean = cleanEndpointString(part);
      if (clean) set.add(clean);
    }
    return Array.from(set);
  }

  let currentEgressSettings = await api<Array<{ name: string; value?: string }>>("/api/settings").catch(() => []);
  let savedExtraEgress = currentEgressSettings.find(s => s.name === "VAK_EXTRA_EGRESS_HOSTS")?.value ?? "";
  let endpointsList: string[] = parseEndpointList(savedExtraEgress);

  const customListEl = el("div", { className: "egress-custom-list" });
  const addInput = el("input", { type: "text", placeholder: "e.g. mcp.alphavantage.co or .internal.net", spellcheck: false, autocomplete: "off" });
  const normalizeHint = el("span", { className: "egress-normalize-hint" });
  const addBtn = el("button", { type: "button", className: "ghost small", textContent: "+ Add endpoint", disabled: true });

  const saveEgress = el("button", { type: "button", className: "primary small", textContent: "Save allowlist", disabled: true });
  const resetEgress = el("button", { type: "button", className: "ghost small", textContent: "Discard changes", hidden: true });

  const testUrlInput = el("input", { type: "text", placeholder: "https://mcp.alphavantage.co or api.openai.com", spellcheck: false, autocomplete: "off" });
  const testResultCard = el("div", { className: "egress-result-card", hidden: true });
  const testBtn = el("button", { type: "button", className: "ghost small", textContent: "Test destination" });

  const updateDirty = () => {
    const currentJoined = endpointsList.join(", ");
    const savedParsed = parseEndpointList(savedExtraEgress).join(", ");
    const isDirty = currentJoined !== savedParsed;
    saveEgress.disabled = !isDirty;
    resetEgress.hidden = !isDirty;
  };

  const renderCustomList = () => {
    customListEl.replaceChildren();
    if (endpointsList.length === 0) {
      customListEl.append(el("p", { className: "egress-empty", textContent: "No custom egress endpoints configured. Outbound traffic is restricted to default providers." }));
      return;
    }
    for (const ep of endpointsList) {
      const epType = endpointType(ep);
      const testItemBtn = el("button", { type: "button", className: "ghost small", textContent: "Test", title: `Test ${ep}` });
      testItemBtn.addEventListener("click", () => {
        testUrlInput.value = ep;
        void runDetailedCheck(ep);
      });
      const removeBtn = el("button", { type: "button", className: "ghost small", textContent: "Remove", title: `Remove ${ep}` });
      removeBtn.addEventListener("click", () => {
        endpointsList = endpointsList.filter(e => e !== ep);
        renderCustomList();
        updateDirty();
      });
      const itemRow = el("div", { className: "egress-custom-item" },
        el("div", { className: "egress-item-main" },
          el("span", { className: "egress-item-host", textContent: ep }),
          el("span", { className: "egress-item-type", textContent: epType })
        ),
        el("div", { className: "egress-item-actions" }, testItemBtn, removeBtn)
      );
      customListEl.append(itemRow);
    }
  };

  const addEndpoint = (raw: string) => {
    const cleaned = cleanEndpointString(raw);
    if (!cleaned) return;
    if (!endpointsList.includes(cleaned)) {
      endpointsList.push(cleaned);
      renderCustomList();
      updateDirty();
    }
    addInput.value = "";
    normalizeHint.textContent = "";
    addBtn.disabled = true;
  };

  addInput.addEventListener("input", () => {
    const val = addInput.value.trim();
    const cleaned = cleanEndpointString(val);
    addBtn.disabled = !cleaned;
    if (val && cleaned && val !== cleaned) {
      normalizeHint.textContent = `Normalized as: ${cleaned}`;
    } else {
      normalizeHint.textContent = "";
    }
  });

  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addEndpoint(addInput.value);
    }
  });

  addBtn.addEventListener("click", () => {
    addEndpoint(addInput.value);
  });

  saveEgress.addEventListener("click", async () => {
    saveEgress.disabled = true;
    addInput.disabled = true;
    const valueToSave = endpointsList.join(", ");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { VAK_EXTRA_EGRESS_HOSTS: valueToSave } }) });
      savedExtraEgress = valueToSave;
      report("Custom egress endpoints saved. Network policy updated.");
    } catch (error) {
      report((error as Error).message, true);
    } finally {
      addInput.disabled = false;
      updateDirty();
    }
  });

  resetEgress.addEventListener("click", () => {
    endpointsList = parseEndpointList(savedExtraEgress);
    renderCustomList();
    updateDirty();
  });

  renderCustomList();
  updateDirty();

  async function runDetailedCheck(targetStr: string) {
    if (!targetStr.trim()) return;
    testBtn.disabled = true;
    testResultCard.hidden = false;
    testResultCard.className = "egress-result-card";
    testResultCard.replaceChildren(el("div", { className: "egress-result-headline", textContent: "Checking policy..." }));

    try {
      const activeCustom = endpointsList.length > 0 ? endpointsList : parseEndpointList(savedExtraEgress);
      const res = await checkEgressDetailed(targetStr.trim(), activeCustom);
      testResultCard.className = `egress-result-card ${res.allowed ? "ok" : "bad"}`;

      const headlineText = res.allowed ? "✓ Destination Permitted" : "× Destination Blocked";
      const headline = el("div", { className: "egress-result-headline", textContent: headlineText });

      const meta = el("div", { className: "egress-result-meta", textContent: `Host: ${res.host} · Scheme: ${res.scheme || "https"} · Port: ${res.port ?? (res.scheme === "http" ? 80 : 443)}` });

      let descText = "";
      if (res.allowed) {
        if (res.matchType === "builtin") descText = "Matches default built-in AI / API provider allowlist.";
        else if (res.matchType === "loopback") descText = "Matches local loopback service (Ollama 11434 / LM Studio 1234).";
        else if (res.matchType === "custom") descText = "Matches configured custom egress allowlist.";
        else if (res.matchType === "suffix") descText = "Matches cloud workspace domain suffix.";
        else descText = "Admitted by egress firewall policy.";
      } else {
        descText = res.reason ?? `Destination "${res.host}" is not on the admitted provider list or custom allowlist.`;
      }
      const desc = el("div", { className: "row-hint", textContent: descText });

      testResultCard.replaceChildren(headline, meta, desc);

      if (!res.allowed && res.host && !endpointsList.includes(res.host)) {
        const candidate = res.host;
        const inlineAddBtn = el("button", {
          type: "button",
          className: "primary small egress-inline-add-btn",
          textContent: `+ Add "${candidate}" to Custom Allowlist`
        });
        inlineAddBtn.addEventListener("click", () => {
          addEndpoint(candidate);
          void runDetailedCheck(candidate);
        });
        testResultCard.append(inlineAddBtn);
      }
    } catch (err) {
      testResultCard.className = "egress-result-card bad";
      testResultCard.replaceChildren(
        el("div", { className: "egress-result-headline", textContent: "× Egress Check Error" }),
        el("div", { className: "row-hint", textContent: (err as Error).message })
      );
    } finally {
      testBtn.disabled = false;
    }
  }

  testBtn.addEventListener("click", () => {
    void runDetailedCheck(testUrlInput.value);
  });
  testUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runDetailedCheck(testUrlInput.value);
    }
  });

  const makePreset = (label: string, url: string) => {
    const b = el("button", { type: "button", className: "egress-quick-btn", textContent: label });
    b.addEventListener("click", () => {
      testUrlInput.value = url;
      void runDetailedCheck(url);
    });
    return b;
  };

  const admittedSummary = el("div", { className: "egress-admitted-summary" },
    el("div", { className: "egress-category" },
      el("span", { className: "egress-category-title", textContent: "Default AI Providers (Click to test)" }),
      el("div", { className: "egress-chips" },
        ...["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.elevenlabs.io", "api.telegram.org", "huggingface.co"].map(h => {
          const chip = el("button", { type: "button", className: "egress-chip", textContent: h });
          chip.addEventListener("click", () => { testUrlInput.value = `https://${h}`; void runDetailedCheck(`https://${h}`); });
          return chip;
        })
      )
    ),
    el("div", { className: "egress-category" },
      el("span", { className: "egress-category-title", textContent: "Integrations & Registries" }),
      el("div", { className: "egress-chips" },
        ...["registry.npmjs.org", "mcp.kite.trade", "mcp.nseindia.in", ".databricks.com", ".azuredatabricks.net"].map(h => {
          const chip = el("button", { type: "button", className: "egress-chip", textContent: h });
          chip.addEventListener("click", () => { testUrlInput.value = h.startsWith(".") ? `workspace${h}` : h; void runDetailedCheck(testUrlInput.value); });
          return chip;
        })
      )
    ),
    el("div", { className: "egress-category" },
      el("span", { className: "egress-category-title", textContent: "Local Loopback Engines" }),
      el("div", { className: "egress-chips" },
        ...[{ label: "localhost:11434 (Ollama)", url: "http://localhost:11434" }, { label: "localhost:1234 (LM Studio)", url: "http://localhost:1234" }].map(item => {
          const chip = el("button", { type: "button", className: "egress-chip", textContent: item.label });
          chip.addEventListener("click", () => { testUrlInput.value = item.url; void runDetailedCheck(item.url); });
          return chip;
        })
      )
    )
  );

  const customSection = el("div", { className: "egress-custom-section" },
    el("div", {},
      el("strong", { textContent: "Custom allowed egress endpoints" }),
      el("p", { className: "row-hint", textContent: "Specify custom AI provider hosts, domain wildcards (e.g. .azure.com), or host:port pairs for private/self-hosted AI servers." })
    ),
    customListEl,
    el("div", { className: "egress-add-box" },
      el("div", { className: "egress-add-line" }, addInput, addBtn),
      normalizeHint
    ),
    el("div", { className: "row-actions" }, saveEgress, resetEgress)
  );

  const testingContainer = el("div", { className: "egress-test-container" },
    el("div", {},
      el("strong", { textContent: "Outbound Egress Policy Tester" }),
      el("p", { className: "row-hint", textContent: "Verify any URL or hostname against the active engine firewall policy." })
    ),
    el("div", { className: "egress-test-box" }, testUrlInput, testBtn),
    el("div", { className: "egress-quick-tests" },
      el("span", { textContent: "Quick test:" }),
      makePreset("api.openai.com", "https://api.openai.com"),
      makePreset("localhost:11434", "http://localhost:11434"),
      makePreset("mcp.alphavantage.co", "https://mcp.alphavantage.co"),
      makePreset("evil.com (blocked)", "https://evil.com")
    ),
    testResultCard
  );
  const realms = realmSettings(() => status);
  async function refresh(): Promise<void> { status = await api<SandboxStatus>("/api/sandbox"); paint(); realms.dispatchEvent(new Event("sandbox:refresh")); }
  root.append(...title("Sandbox", "Control where local commands run and inspect the protection available on this computer."), health,
    group("Execution settings", row("OS-level isolation", "Contain command runs with the sandbox helper. Local stdio MCP servers use this setting at app startup.", protection), form), notice,
    group("Connected capabilities", execution, el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: "Run a fixed printf command to check the full execution path. This copies the configured project and records the result in the integration log." }), el("div", { className: "row-actions" }, test), testOutput)),
    realms,
    group("Network Egress Policy",
      row("Policy status", "The Rust engine restricts all outbound network traffic. Unapproved destinations, arbitrary IPs, and unlisted local ports fail closed.", pill("Fail-Closed", "ok")),
      admittedSummary,
      customSection,
      testingContainer
    ),
    group("Command boundaries", el("div", { className: "sandbox-boundaries" },
      ...[["globe", "Network denied", "Commands cannot connect to the internet."], ["folder", "Isolated files", "Commands write to copies. Only reviewed promotion changes the project. Check for sensitive files beyond the common credential exclusions."], ["key", "Minimal environment", "No provider keys or app environment are passed to commands."], ["clock", "Bounded runs", "30 seconds · 32 KiB output · 512 MiB / 50,000 files per snapshot."]].map(([glyph, label, hint]) => el("div", { className: "sandbox-boundary" }, icon(glyph!, 18), el("div", {}, el("strong", { textContent: label }), el("p", { className: "row-hint", textContent: hint })))))),
    el("details", { className: "sandbox-diagnostics" }, el("summary", { textContent: "Runtime details" }), helperDetails, el("div", { className: "row-actions" }, check, el("a", { href: "https://github.com/nranjan2code/sandbox", target: "_blank", rel: "noreferrer", textContent: "Sandbox documentation ↗" }))));
  paint();
  return [root];
}
