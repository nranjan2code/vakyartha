// Settings → Integrations: the marketplace, one page per integration (setup,
// every tool with its policy and a test run, recent calls), and adding a
// server of your own. What an integration can reach is shown before install.

import { api, ask, el } from "./core.ts";
import { icon, tile } from "./icons.ts";
import { group, pill, row, segmented, title, toggle } from "./ui.ts";

type Trust = "built-in" | "official" | "vendor" | "custom";
type Policy = "allow" | "ask" | "off";

interface Field { key: string; label: string; kind: "secret" | "folders" | "text"; required?: boolean; help?: string }
interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, { type?: string | string[]; description?: string; default?: unknown }>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
  policy: Policy;
  defaultPolicy: Policy;
}
interface Call { at: string; tool: string; decision: string; ok?: boolean; ms?: number; preview?: string }
export interface Integration {
  entry: { id: string; name: string; publisher: string; trust: Trust; summary: string; description: string; homepage: string; icon: string; access: string[]; config: Field[]; sourceKind: string; version?: string; package?: string; url?: string; command?: string };
  installed: boolean;
  version?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  missing: string[];
  status: "off" | "ready" | "error" | "needs-setup" | "not-installed";
  error?: string;
  tools: Tool[];
  calls: Call[];
}

const TRUST: Record<Trust, [string, string]> = {
  "built-in": ["Built in", "Made by vak and runs inside the app: no outside code."],
  official: ["Official", "A reference server from the Model Context Protocol project."],
  vendor: ["By the vendor", "Published by the company whose service it connects to."],
  custom: ["Unverified", "Added by you. vak has not reviewed it."],
};

const STATUS: Record<Integration["status"], [string, "" | "ok" | "bad"]> = {
  ready: ["On", "ok"],
  off: ["Off", ""],
  error: ["Problem", "bad"],
  "needs-setup": ["Needs setup", "bad"],
  "not-installed": ["Not installed", ""],
};

function trustBadge(t: Trust): HTMLElement {
  const [label, hint] = TRUST[t];
  return el("span", { className: `trust ${t}`, title: hint }, t === "custom" ? null : icon("shield", 12), label);
}

/** What a tool can do, from its own annotations, in three words or fewer. */
function risk(t: Tool): HTMLElement[] {
  const a = t.annotations ?? {};
  const out: HTMLElement[] = [];
  if (a.destructiveHint) out.push(pill("Can delete or overwrite", "bad"));
  else if (a.readOnlyHint) out.push(pill("Reads only"));
  else out.push(pill("Can make changes"));
  if (a.openWorldHint) out.push(pill("Uses the internet"));
  return out;
}

let filter: "all" | "installed" | "voice" | Trust = "all";
let query = "";

/** The marketplace grid. `open(id)` shows one integration's page. */
/** `voice`: the Voice category, shown under All and alone under its own filter. */
export async function marketplace(open: (id: string) => void, addOwn: () => void, voice: HTMLElement[] = []): Promise<HTMLElement[]> {
  const list = await api<Integration[]>("/api/integrations");
  const grid = el("div", { className: "market" });
  const voiceBox = el("div", {}, ...voice);
  const paint = () => {
    // .market sets display, which the hidden attribute does not override.
    grid.style.display = filter === "voice" ? "none" : "";
    voiceBox.style.display = filter === "all" || filter === "voice" ? "" : "none";
    if (filter === "voice") return;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = list.filter((i) => (filter === "all" ? true : filter === "installed" ? i.installed && i.entry.sourceKind !== "builtin" ? true : i.enabled : i.entry.trust === filter)).filter((i) => words.every((w) => `${i.entry.name} ${i.entry.publisher} ${i.entry.summary}`.toLowerCase().includes(w)));
    grid.replaceChildren(
      ...shown.map((i) => {
        const [label, tone] = STATUS[i.status];
        const card = el("button", { type: "button", className: "market-card" }, tile(i.entry.icon, 40), el("div", { className: "market-text" }, el("div", { className: "market-name" }, i.entry.name), el("div", { className: "market-pub" }, i.entry.publisher), el("div", { className: "market-sum" }, i.entry.summary)), el("div", { className: "market-foot" }, trustBadge(i.entry.trust), pill(label, tone)));
        card.addEventListener("click", () => open(i.entry.id));
        return card;
      }),
    );
    if (!shown.length) grid.append(el("p", { className: "row-hint", textContent: "Nothing matches." }));
  };
  const search = el("input", { type: "search", className: "market-search", placeholder: "Search integrations", value: query, "aria-label": "Search integrations" });
  search.addEventListener("input", () => {
    query = search.value;
    paint();
  });
  const filters = segmented(
    [
      ["all", "All"],
      ["installed", "In use"],
      ["built-in", "Built in"],
      ["official", "Official"],
      ["vendor", "Vendors"],
      ["custom", "Yours"],
      ...(voice.length ? [["voice", "Voice"] as const] : []),
    ] as const,
    filter,
    (v) => {
      filter = v;
      paint();
    },
  );
  const add = el("button", { type: "button", className: "ghost small", textContent: "Add your own server…" });
  add.addEventListener("click", addOwn);
  paint();
  return [
    ...title("Integrations", "Tools the model can use to work with real data: your files, the web, your accounts. Each runs with only the access shown on its page, and anything that changes something asks you first."),
    el("div", { className: "market-bar" }, search, filters, add),
    grid,
    voiceBox,
  ];
}

/** One integration: setup, every tool and its policy, test runs, recent calls. */
export async function integrationPage(id: string, back: () => void, reload: () => void): Promise<HTMLElement[]> {
  const list = await api<Integration[]>("/api/integrations");
  const i = list.find((x) => x.entry.id === id);
  if (!i) return [...title("Not found"), el("p", { className: "row-hint", textContent: "This integration was removed." })];
  const e = i.entry;
  const note = el("p", { className: "row-hint bad" });
  const act = async (fn: () => Promise<unknown>, busy?: HTMLButtonElement) => {
    note.textContent = "";
    if (busy) busy.disabled = true;
    try {
      await fn();
      reload();
    } catch (err) {
      note.textContent = (err as Error).message;
      if (busy) busy.disabled = false;
    }
  };
  const put = (body: unknown) => api(`/api/integrations/${id}`, { method: "PUT", body: JSON.stringify(body) });

  const backLink = el("button", { type: "button", className: "link", textContent: "‹ All integrations" });
  backLink.addEventListener("click", back);

  // Header: what it is, who made it, how far to trust it.
  const head = el(
    "div",
    { className: "int-head" },
    tile(e.icon, 56),
    el("div", {}, el("h1", { textContent: e.name }), el("div", { className: "int-meta" }, el("span", { textContent: e.publisher }), trustBadge(e.trust), e.version ? el("span", { className: "mono", textContent: `${e.package ?? ""}@${e.version}` }) : e.url ? el("span", { className: "mono", textContent: e.url }) : e.command ? el("span", { className: "mono", textContent: e.command }) : null)),
  );
  const description = el("p", { className: "lead", textContent: e.description });

  // Install / enable / remove.
  const controls: HTMLElement[] = [];
  if (!i.installed) {
    const install = el("button", { type: "button", className: "primary", textContent: e.sourceKind === "npm" ? `Install ${e.version ?? ""}` : "Add" });
    install.addEventListener("click", () => {
      install.textContent = "Installing…";
      void act(() => api(`/api/integrations/${id}/install`, { method: "POST" }), install);
    });
    controls.push(install);
  } else {
    controls.push(
      el("div", { className: "row-actions" }, pill(...STATUS[i.status]), toggle(i.enabled, (on) => act(() => put({ enabled: on })))),
    );
  }
  const access = group("What it can reach", ...e.access.map((a) => el("div", { className: "row" }, el("div", { className: "row-label", textContent: a }))), i.error ? el("div", { className: "row stack" }, el("p", { className: "row-hint bad", textContent: i.error })) : null);

  // Setup fields.
  const setup = e.config.length
    ? group(
        "Setup",
        ...e.config.map((f) => {
          if (f.kind === "secret") {
            const input = el("input", { type: "password", autocomplete: "off", placeholder: i.secretsSet[f.key] ? "•••••••• saved" : "Paste it here", "aria-label": f.label });
            const save = el("button", { type: "button", className: "primary small", textContent: "Save", hidden: true });
            const remove = el("button", { type: "button", className: "ghost small", textContent: "Remove", hidden: !i.secretsSet[f.key] });
            input.addEventListener("input", () => (save.hidden = !input.value.trim()));
            save.addEventListener("click", () => void act(() => put({ secrets: { [f.key]: input.value.trim() } }), save));
            remove.addEventListener("click", async () => {
              if (await ask(`Remove the saved ${f.label}?`, "Remove")) void act(() => put({ secrets: { [f.key]: null } }));
            });
            return el("div", { className: "row stack" }, el("div", { className: "field-label", textContent: f.label }), el("div", { className: "field-line" }, input, save, remove), f.help ? el("p", { className: "row-hint", textContent: f.help }) : null);
          }
          const value = f.kind === "folders" ? ((i.config[f.key] as string[] | undefined) ?? []).join("\n") : String(i.config[f.key] ?? "");
          const input = f.kind === "folders" ? el("textarea", { rows: 3, value, placeholder: "/Users/you/Documents/Project", spellcheck: false }) : el("input", { type: "text", value });
          const save = el("button", { type: "button", className: "primary small", textContent: "Save" });
          save.addEventListener("click", () => void act(() => put({ config: { [f.key]: input.value } }), save));
          return el("div", { className: "row stack" }, el("div", { className: "field-label", textContent: f.label }), input, el("div", { className: "row-actions" }, save), f.help ? el("p", { className: "row-hint", textContent: f.help }) : null);
        }),
      )
    : null;

  // Tools: policy per tool, and a test run with inputs from its schema.
  const toolRows = i.tools.map((t) => {
    const policy = segmented(
      [
        ["allow", "Allow"],
        ["ask", "Ask"],
        ["off", "Off"],
      ] as const,
      t.policy,
      (v) => void put({ policies: { [t.name]: v } }),
    );
    const tryBtn = el("button", { type: "button", className: "link", textContent: "Try it" });
    const box = el("div", { className: "try", hidden: true });
    tryBtn.addEventListener("click", () => {
      box.hidden = !box.hidden;
      if (!box.hidden && !box.children.length) box.append(...tryForm(id, t));
    });
    return el(
      "div",
      { className: "row stack tool-row" },
      el("div", { className: "tool-top" }, el("div", { className: "row-text" }, el("div", { className: "row-label" }, el("span", { textContent: t.annotations?.title ?? t.title ?? t.name }), " ", el("code", { textContent: t.name })), el("div", { className: "row-hint", textContent: (t.description ?? "").slice(0, 280) }), el("div", { className: "badges" }, ...risk(t), t.policy !== t.defaultPolicy ? pill("Changed", "") : null)), el("div", { className: "row-control" }, policy)),
      el("div", { className: "row-actions" }, tryBtn),
      box,
    );
  });
  const tools = i.installed
    ? group(
        `Tools${i.tools.length ? ` (${i.tools.length})` : ""}`,
        ...(toolRows.length ? toolRows : [el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: i.enabled ? "No tools listed yet." : "Turn it on to see its tools." }))]),
        i.tools.length ? el("div", { className: "row stack" }, el("p", { className: "row-hint", textContent: "Allow: runs without asking. Ask: you approve each call in the chat (or for the whole chat). Off: the model never sees it." })) : null,
      )
    : null;

  const calls = i.calls.length
    ? group(
        "Recent calls",
        ...i.calls.slice(0, 12).map((c) =>
          el("div", { className: "row" }, el("div", { className: "row-text" }, el("div", { className: "row-label" }, el("code", { textContent: c.tool }), " ", pill(c.decision === "denied" ? "Declined" : c.ok === false ? "Failed" : "Done", c.decision === "denied" || c.ok === false ? "bad" : "ok")), el("div", { className: "row-hint", textContent: `${new Date(c.at).toLocaleString()}${c.ms !== undefined ? ` · ${c.ms} ms` : ""}${c.preview ? ` · ${c.preview.slice(0, 120)}` : ""}` }))),
        ),
      )
    : null;

  const danger = i.installed && e.sourceKind !== "builtin" ? el("button", { type: "button", className: "danger small", textContent: e.trust === "custom" ? "Remove this server" : "Uninstall" }) : null;
  danger?.addEventListener("click", async () => {
    if (await ask(`Remove ${e.name}? Its saved keys and data in this app are deleted too.`, "Remove")) void act(() => api(`/api/integrations/${id}/uninstall`, { method: "POST" }).then(back));
  });
  const links = el("div", { className: "row-actions" }, e.homepage ? el("a", { href: e.homepage, textContent: "Source and docs" }) : null);

  return [
    el("div", { className: "crumbs" }, backLink),
    head,
    description,
    el("div", { className: "int-controls" }, ...controls),
    note,
    access,
    setup,
    tools,
    calls,
    el("section", { className: "group" }, el("div", { className: "row-actions spread" }, links, danger)),
  ].filter(Boolean) as HTMLElement[];
}

/** Inputs from the tool's JSON schema; the raw JSON stays editable for anything else. */
function tryForm(id: string, t: Tool): HTMLElement[] {
  const props = t.inputSchema?.properties ?? {};
  const example: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) if ((t.inputSchema.required ?? []).includes(k)) example[k] = p.default ?? (p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : p.type === "array" ? [] : "");
  const args = el("textarea", { className: "mono", rows: Math.min(8, Object.keys(example).length + 2), value: JSON.stringify(example, null, 2), spellcheck: false, "aria-label": "Input (JSON)" });
  const hints = el("div", { className: "row-hint" }, ...Object.entries(props).map(([k, p]) => el("div", {}, el("code", { textContent: k }), ` ${p.description ?? ""}${(t.inputSchema.required ?? []).includes(k) ? " (required)" : ""}`)));
  const runBtn = el("button", { type: "button", className: "primary small", textContent: "Run" });
  const out = el("pre", { className: "try-out", hidden: true });
  runBtn.addEventListener("click", async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.value || "{}");
    } catch {
      out.hidden = false;
      out.textContent = "That isn't valid JSON.";
      return;
    }
    runBtn.disabled = true;
    out.hidden = false;
    out.textContent = "Running…";
    try {
      const r = await api<{ text: string; isError: boolean; ms: number }>(`/api/integrations/${id}/test`, { method: "POST", body: JSON.stringify({ tool: t.name, args: parsed }) });
      out.textContent = `${r.isError ? "Error · " : ""}${r.ms} ms\n\n${r.text}`;
    } catch (err) {
      out.textContent = (err as Error).message;
    } finally {
      runBtn.disabled = false;
    }
  });
  return [hints, args, el("div", { className: "row-actions" }, runBtn, el("span", { className: "row-hint", textContent: "Runs now, as you. It is logged like any other call." })), out];
}

/** Add a server that isn't in the catalog: a local command or an https URL. */
export function addOwnPage(back: () => void, opened: (id: string) => void): HTMLElement[] {
  let kind: "url" | "command" = "url";
  const name = el("input", { type: "text", placeholder: "Name", "aria-label": "Name" });
  const url = el("input", { type: "text", placeholder: "https://example.com/mcp", "aria-label": "Server URL" });
  const token = el("input", { type: "password", placeholder: "Bearer token (optional)", "aria-label": "Token" });
  const command = el("input", { type: "text", placeholder: "/usr/local/bin/my-mcp-server --flag", "aria-label": "Command", hidden: true });
  const note = el("p", { className: "row-hint bad" });
  const switcher = segmented(
    [
      ["url", "Remote (URL)"],
      ["command", "Local (command)"],
    ] as const,
    kind,
    (v) => {
      kind = v;
      url.hidden = token.hidden = v !== "url";
      command.hidden = v !== "command";
    },
  );
  const add = el("button", { type: "button", className: "primary", textContent: "Add server" });
  add.addEventListener("click", async () => {
    note.textContent = "";
    const parts = command.value.trim().split(/\s+/).filter(Boolean);
    try {
      const res = await api<{ id: string }>("/api/integrations/custom", {
        method: "POST",
        body: JSON.stringify(kind === "url" ? { name: name.value, url: url.value.trim(), token: token.value.trim() || undefined } : { name: name.value, command: parts[0], args: parts.slice(1) }),
      });
      opened(res.id);
    } catch (err) {
      note.textContent = (err as Error).message;
    }
  });
  const backLink = el("button", { type: "button", className: "link", textContent: "‹ All integrations" });
  backLink.addEventListener("click", back);
  return [
    el("div", { className: "crumbs" }, backLink),
    ...title("Add your own server", "Any MCP server. It runs with the same limits as the catalog's (its own folder, none of your keys), and every tool asks before it runs until you change that."),
    group(null, el("div", { className: "row stack" }, switcher, name, url, token, command, el("p", { className: "row-hint", textContent: "Only add servers you trust: a local command runs a program on this computer." }), el("div", { className: "row-actions" }, add), note)),
  ];
}
