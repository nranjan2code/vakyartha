import { estimateCost, shapeTotal, type FinopsView, type Shape, type Turn } from "../finops.ts";
import { api, el } from "./core.ts";
import { select, title } from "./ui.ts";

let observer: ResizeObserver | undefined;
export function disposeFinops(): void { observer?.disconnect(); observer = undefined; }
const keys = ["user", "text", "projection", "tools", "feedback", "results"] as const;
const names = ["User / actions", "Assistant text", "UI arguments", "Other tool args", "Engine feedback", "External results"];
const palette = ["var(--accent)", "var(--finops-2)", "var(--finops-3)", "var(--finops-4)", "var(--finops-5)", "var(--finops-6)"];
const number = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const usd = (n: number) => `$${n.toFixed(6)}`;
const sum = (s: Shape) => keys.map((k) => s[k]);
const svgNS = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function finopsPage(): Promise<HTMLElement[]> {
  let data = await api<FinopsView>("/api/finops");
  const box = el("div", { className: "finops" });
  const summary = el("p", { className: "lead" });
  const controls = el("div", { className: "finops-controls" });
  const charts = el("div", { className: "finops-plots" });
  const detail = el("div", { className: "finops-detail", "aria-live": "polite" });
  const error = el("p", { className: "error", role: "alert" });
  let session = "", selected = "";
  const sessions = [...new Set(data.turns.map((t) => t.session))];
  const labels = new Map(sessions.map((id, i) => [id, String.fromCharCode(65 + i)]));
  const ordinals = new Map<string, string>();
  for (const id of sessions) data.turns.filter((t) => t.session === id).forEach((t, i) => ordinals.set(t.id, `${labels.get(id)}${i + 1}`));
  const filter = select([["", "All chats"], ...sessions.map((id) => [id, `Chat ${labels.get(id)} · ${id.slice(0, 8)}`] as const)], "", (v) => { session = v; selected = ""; render(); });
  filter.setAttribute("aria-label", "FinOps chat");
  const refresh = el("button", { type: "button", className: "ghost", textContent: "Refresh" });
  refresh.addEventListener("click", () => window.dispatchEvent(new Event("vak:finops-refresh")));
  const exportButton = el("button", { type: "button", className: "ghost", textContent: "Export CSV" });
  controls.append(filter, refresh, exportButton);
  const picker = el("select", { "aria-label": "Inspect turn" });
  picker.addEventListener("change", () => { selected = picker.value; showDetail(); });
  function visible(): Turn[] { return data.turns.filter((t) => !session || t.session === session); }
  const usage = (t: Turn, k: "input" | "cachedInput" | "outputTokens"): number | undefined => t.source === "recorded" && t.complete && t.steps.length && t.steps.every((s) => s.complete && s[k] !== undefined) ? t.steps.reduce((a, s) => a + s[k]!, 0) : undefined;
  function showDetail(): void {
    const t = visible().find((t) => t.id === selected) ?? visible().at(-1);
    detail.replaceChildren();
    if (!t) return;
    selected = t.id; picker.value = t.id;
    const table = el("table", { className: "finops-table" });
    const tr = (k: string, v: string) => table.append(el("tr", {}, el("th", { scope: "row", textContent: k }), el("td", { textContent: v })));
    tr("Turn", `${ordinals.get(t.id)} · ${t.provider} / ${t.model}`);
    tr("When", new Date(t.at).toLocaleString());
    tr("Source", t.source === "recorded" ? (t.complete ? "Measured provider requests" : "Incomplete request; billing may be partial") : "Saved messages; assumed last 10 turns");
    tr("Duration", `${number(t.ms / 1000)}s · ${t.steps.length} model steps`);
    tr("Calls", `${t.projectionCalls} projection · ${t.externalCalls} external · ${t.errors} error feedback`);
    tr("First conversation", `${number(shapeTotal(t.context))} characters`);
    tr("Repeated conversation", `${number(t.steps.reduce((a, s) => a + shapeTotal(s.context), 0))} characters across requests`);
    if (t.source === "recorded") {
      tr("System / schemas", `${number(t.steps.reduce((a, s) => a + s.systemChars, 0))} / ${number(t.steps.reduce((a, s) => a + s.schemaChars, 0))} characters across requests`);
      tr("Native replay", `${number(t.steps.reduce((a, s) => a + s.nativeChars, 0))} serialized characters, overlaps visible content; encrypted bytes are not tokens`);
    }
    for (const [name, key] of [["Input tokens", "input"], ["Cached input tokens", "cachedInput"], ["Output tokens", "outputTokens"]] as const) tr(name, usage(t, key) === undefined ? "Unknown" : number(usage(t, key)!));
    const cost = estimateCost(t, data.rates);
    tr("Estimated API cost", cost === undefined ? "Unknown — missing usage, cache detail, or model rate" : t.local ? "$0 API rate · compute / hosting excluded" : `${usd(cost)} · current configured rates`);
    tr("Generated UI / tool args / text", `${number(t.output.projection)} / ${number(t.output.tools)} / ${number(t.output.text)} characters`);
    detail.append(table);
  }

  function plot(heading: string, units: string, legends: string[], colors: string[], values: (t: Turn) => number[] | undefined): void {
    const turns = visible(), fig = el("figure"), svg = sv("svg", { role: "img", "aria-label": heading });
    const legend = el("div", { className: "finops-legend" });
    legends.forEach((n, i) => { const swatch = el("i"); swatch.style.background = colors[i]!; legend.append(el("span", {}, swatch, n)); });
    fig.append(el("figcaption", { textContent: heading }), legend, svg); charts.append(fig);
    const w = Math.max(260, charts.clientWidth || box.clientWidth || 600), h = 220, l = 66, r = 14, top = 24, bottom = 48, pw = w - l - r, ph = h - top - bottom;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.append(sv("title", {}, heading));
    const all = turns.map(values), max = Math.max(0, ...all.map((v) => v?.reduce((a, b) => a + b, 0) ?? 0));
    const ceiling = max > 0 ? max * 1.15 : 1, y = (n: number) => top + ph * (1 - n / ceiling), band = pw / Math.max(1, turns.length);
    svg.append(sv("rect", { x: l, y: top, width: pw, height: ph, fill: "none", stroke: "var(--border)" }));
    const tick = (n: number) => units === "USD" ? (n < .01 ? n.toFixed(4) : n.toFixed(2)) : n >= 1000 ? `${number(n / 1000)}k` : number(n);
    for (let i = 0; i <= 3; i++) { const n = ceiling * i / 3; svg.append(sv("text", { x: l - 8, y: y(n) + 4, "text-anchor": "end" }, tick(n))); }
    svg.append(sv("text", { x: l, y: 14 }, units), sv("text", { x: l + pw / 2, y: h - 3, "text-anchor": "middle" }, "Turn · chronological across chats"));
    if (!max) svg.append(sv("text", { x: l + pw / 2, y: top + ph / 2, "text-anchor": "middle" }, all.some((v) => v !== undefined) ? "All recorded values are zero" : "Not recorded / not configured"));
    turns.forEach((t, i) => {
      const x = l + band * i + band * .12, bw = band * .76, v = all[i]; let acc = 0;
      if (v) v.forEach((n, j) => { svg.append(sv("rect", { x, y: y(acc + n), width: bw, height: y(acc) - y(acc + n), fill: colors[j] ?? palette[0]! })); acc += n; });
      else svg.append(sv("text", { x: x + bw / 2, y: y(0) - 5, "text-anchor": "middle" }, "·"));
      const stride = Math.max(1, Math.ceil(turns.length / Math.max(3, Math.floor(pw / 34))));
      if ((i % stride === 0 && (i === 0 || turns.length - 1 - i >= stride / 2)) || i === turns.length - 1) svg.append(sv("text", { x: x + bw / 2, y: top + ph + 19, "text-anchor": "middle" }, ordinals.get(t.id)));
      const hit = sv("rect", { x: l + band * i, y: top, width: band, height: ph, fill: "transparent", class: "finops-hit" });
      hit.append(sv("title", {}, `${ordinals.get(t.id)} · ${t.model}\n${v ? v.map((n, j) => `${legends[j]}: ${number(n)} ${units}`).join('\n') : 'Unknown'}`));
      hit.addEventListener("click", () => { selected = t.id; showDetail(); detail.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
      svg.append(hit);
    });
  }

  function render(): void {
    charts.replaceChildren();
    const turns = visible(), known = turns.flatMap((t) => { const n = estimateCost(t, data.rates); return n === undefined ? [] : [n]; });
    summary.textContent = `${turns.length} turns · ${number(turns.reduce((a, t) => a + t.ms, 0) / 1000)}s · ${usd(known.reduce((a, b) => a + b, 0))} known estimate · ${turns.length - known.length} turns with unknown cost`;
    picker.replaceChildren(...turns.map((t) => el("option", { value: t.id, textContent: `${ordinals.get(t.id)} · ${t.model} · ${number(t.ms / 1000)}s` })));
    if (!turns.length) { charts.append(el("p", { textContent: "No saved chat turns yet. Usage is recorded locally when you chat." })); detail.replaceChildren(); return; }
    plot("Turn duration", "Seconds", ["Whole turn"], [palette[0]!], (t) => [t.ms / 1000]);
    plot("Context at turn start", "Characters", names, palette, (t) => sum(t.context));
    plot("Conversation payload across model steps", "Characters", ["Repeated conversation"], [palette[0]!], (t) => [t.steps.reduce((a, s) => a + shapeTotal(s.context), 0)]);
    plot("Visible model output", "Characters", ["UI arguments", "Other tool args", "Assistant text"], [palette[2]!, palette[3]!, palette[1]!], (t) => [t.output.projection, t.output.tools, t.output.text]);
    plot("Provider token usage", "Tokens", ["Input (cache split unknown)", "Uncached input", "Cached input", "Output"], [palette[1]!, palette[0]!, palette[4]!, palette[2]!], (t) => {
      const input = usage(t, "input"), output = usage(t, "outputTokens"), cached = usage(t, "cachedInput");
      return input === undefined || output === undefined ? undefined : cached === undefined ? [input, 0, 0, output] : [0, Math.max(0, input - cached), cached, output];
    });
    plot("Estimated API cost", "USD", ["Current configured rates · dots = unknown"], [palette[0]!], (t) => { const n = estimateCost(t, data.rates); return n === undefined ? undefined : [n]; });
    showDetail();
  }

  const pricing = el("details", { className: "finops-pricing" }, el("summary", { textContent: "Model rates · USD per million tokens" }));
  const models = [...new Map(data.turns.filter((t) => !t.local).map((t) => [JSON.stringify([t.provider, t.model]), t])).entries()];
  const rateModel = select(models.map(([id, t]) => [id, `${t.provider} / ${t.model}`] as const), models[0]?.[0] ?? "", loadRate);
  rateModel.setAttribute("aria-label", "Rate model");
  const fields = ["Input", "Cached input", "Output"].map((label) => el("input", { type: "number", min: "0", step: "any", "aria-label": `${label} USD per million tokens` }));
  const rateDate = el("span", { className: "muted small" });
  function loadRate(): void {
    const model = models.find(([id]) => id === rateModel.value)?.[1];
    const r = data.rates.find((r) => r.provider === model?.provider && r.model === model?.model);
    fields.forEach((f, i) => f.value = r ? String([r.input, r.cached, r.output][i]) : "");
    rateDate.textContent = r ? `Updated ${new Date(r.updated).toLocaleString()}` : "No rate configured";
  }
  const save = el("button", { type: "button", className: "ghost", textContent: "Save rates", disabled: !models.length });
  save.addEventListener("click", async () => {
    error.textContent = "";
    if (fields.some((f) => !f.value.trim() || !f.checkValidity())) { error.textContent = "Enter a non-negative number for all three rates."; return; }
    const t = models.find(([id]) => id === rateModel.value)?.[1];
    if (!t) return;
    try {
      data = await api<FinopsView>("/api/finops", { method: "PUT", body: JSON.stringify({ provider: t.provider, model: t.model, input: Number(fields[0]!.value), cached: Number(fields[1]!.value), output: Number(fields[2]!.value) }) });
      loadRate(); render();
    } catch (e) { error.textContent = (e as Error).message; }
  });
  pricing.append(el("p", { className: "row-hint", textContent: "Estimates use your current rates, not an invoice. Excludes cache-write premiums, provider extras, tool fees and local compute. Missing usage stays unknown. Chat turns only; calibration and channels are outside this view." }), rateModel,
    el("div", { className: "finops-controls" }, ...fields.map((f, i) => el("label", {}, ["Input", "Cached input", "Output"][i], f))), save, rateDate);
  loadRate();
  exportButton.addEventListener("click", () => {
    const rows: (string | number)[][] = [["turn", "session", "at", "provider", "model", "source", "seconds", "steps", "input_tokens", "cached_tokens", "output_tokens", "estimated_usd", "first_context_chars", "repeated_context_chars", "ui_chars", "tool_arg_chars", "text_chars"]];
    for (const t of visible()) rows.push([ordinals.get(t.id)!, t.session, t.at, t.provider, t.model, t.source, t.ms / 1000, t.steps.length, usage(t, "input") ?? "", usage(t, "cachedInput") ?? "", usage(t, "outputTokens") ?? "", estimateCost(t, data.rates) ?? "", shapeTotal(t.context), t.steps.reduce((a, s) => a + shapeTotal(s.context), 0), t.output.projection, t.output.tools, t.output.text]);
    // Guard spreadsheet formula execution even when a custom provider supplies the model id.
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { href: url, download: "vak-finops.csv" }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  box.append(controls, summary, pricing, error, charts, el("label", { className: "finops-picker" }, "Inspect turn", picker), detail,
    el("p", { className: "row-hint", textContent: "Character charts exclude system instructions, tool schemas and native replay; their measured sizes appear in turn details. Characters are not tokens. Old turns use saved messages and the default last 10 turns; their actual window and token usage were not recorded. Tool and approval waits are included in turn duration. Empty token/cost marks mean unknown, not zero." }));
  // Settings attaches the page after this function returns; observe actual width then.
  observer = new ResizeObserver(() => { if (box.isConnected) render(); }); observer.observe(box);
  render();
  return [...title("FinOps", "Cost, context and output shape for your desktop chats. Stored on this machine."), box];
}
