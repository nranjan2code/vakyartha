import { invoke, isTauri } from "@tauri-apps/api/core";
import { el } from "./core.ts";
import { parseProviderConsents, parseConsentSlice, parseConsentReceipt, type ProviderConsent, type ConsentRequestSlice } from "../shared/provider-consent.ts";

export interface ConsentTransport { list(): Promise<unknown>; read(ticket: string, fingerprint: string, offset: number): Promise<unknown>; decide(ticket: string, fingerprint: string, decision: "allow_once" | "deny"): Promise<unknown> }
type Card = { view: ProviderConsent; node: HTMLElement; expires: HTMLElement; controls: HTMLButtonElement[] };

/** Shell-owned controls read native disclosures directly; model surfaces and
 * app-worker routes never supply this permission queue or handle its decisions. */
export class ProviderConsents {
  readonly button = el("button", { type: "button", className: "ghost small native-consent-trigger", textContent: "Permissions", hidden: true, "aria-haspopup": "dialog" });
  readonly dialog = el("dialog", { className: "native-consent-dialog", "aria-label": "Model request permissions" });
  private status = el("p", { role: "status", className: "hint", textContent: "No model requests are waiting." });
  private error = el("p", { role: "alert", hidden: true });
  private list = el("div", { className: "native-consent-list" });
  private cards = new Map<string, Card>();
  private busy = new Set<string>();
  private loading = false;
  private available = true;
  private decisionNotice?: string;
  private timer?: ReturnType<typeof setInterval>;
  constructor(privateTransport: ConsentTransport, parent: HTMLElement) {
    this.transport = privateTransport;
    const close = el("button", { type: "button", className: "ghost small", textContent: "Close", onclick: () => this.dialog.close() });
    this.dialog.append(el("header", {}, el("h2", { textContent: "Model request permissions" }), close), this.status, this.error, this.list);
    this.dialog.addEventListener("close", () => { this.decisionNotice = undefined; });
    this.button.onclick = () => { this.dialog.showModal(); void this.refresh(); };
    parent.append(this.button); document.body.append(this.dialog);
  }
  private transport: ConsentTransport;
  start(): void { void this.refresh(); this.timer ??= setInterval(() => void this.refresh(), 1000); }
  close(): void { clearInterval(this.timer); this.dialog.remove(); this.button.remove(); }
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const views = parseProviderConsents(await this.transport.list());
      this.available = true; this.error.hidden = true;
      if (views.some(view => this.cards.get(view.approval.ticket_id)?.view.approval.fingerprint !== view.approval.fingerprint)) this.decisionNotice = undefined;
      const keys = new Set(views.map(v => v.approval.ticket_id));
      for (const [id, card] of this.cards) if (!keys.has(id)) { card.node.remove(); this.cards.delete(id); }
      for (const view of views) {
        const id = view.approval.ticket_id;
        let card = this.cards.get(id);
        if (card && card.view.approval.fingerprint !== view.approval.fingerprint) { card.node.remove(); this.cards.delete(id); card = undefined; }
        if (!card) { card = this.card(view); this.cards.set(id, card); this.list.append(card.node); }
        card.expires.textContent = `Expires in ${view.remaining_seconds} seconds or when this task changes.`;
        for (const control of card.controls) control.disabled = this.busy.has(id);
      }
      this.button.hidden = views.length === 0 && !this.dialog.open;
      this.button.textContent = views.length ? `Permissions (${views.length})` : "Permissions";
      this.status.textContent = this.decisionNotice ?? (views.length ? "Allow only requests you intend to send. Each decision applies once to this request." : "No model requests are waiting.");
    } catch (error) {
      this.available = false; this.button.hidden = false; this.button.textContent = "Permissions unavailable";
      this.showError(error);
      for (const card of this.cards.values()) for (const control of card.controls) control.disabled = true;
    } finally { this.loading = false; }
  }
  private showError(error: unknown): void { this.error.textContent = String(error instanceof Error ? error.message : error); this.error.hidden = false; }
  private card(view: ProviderConsent): Card {
    const id = view.approval.ticket_id, d = view.approval.disclosure;
    const node = el("section", { className: "native-consent-item", "aria-label": "Model request", "data-ticket": id });
    const expires = el("p", { className: "hint" }), controls: HTMLButtonElement[] = [];
    const details = el("details", {}, el("summary", { textContent: "Review exact request" }));
    const preview = el("pre", { className: "approval-args", textContent: d.preview });
    const page = el("pre", { className: "approval-args", hidden: true, tabIndex: 0, "aria-label": "Exact request page" });
    const position = el("span", { role: "status" });
    let current: ConsentRequestSlice | undefined, offsets: number[] = [], reading = false;
    const previous = el("button", { type: "button", className: "ghost small", textContent: "Previous", disabled: true });
    const next = el("button", { type: "button", className: "ghost small", textContent: "Next", disabled: true });
    const read = async (offset: number): Promise<boolean> => {
      if (reading) return false;
      reading = true; previous.disabled = next.disabled = true;
      try {
        const result = parseConsentSlice(await this.transport.read(id, view.approval.fingerprint, offset));
        if (this.cards.get(id)?.view.approval.fingerprint !== view.approval.fingerprint) return false;
        if (result.offset !== offset) throw new Error("Request page changed; refresh permissions");
        current = result; preview.hidden = true; page.hidden = false; page.textContent = result.text;
        position.textContent = `Bytes ${result.offset + 1}–${result.next} of ${result.total}`;
        return true;
      } catch (error) { this.showError(error); return false; }
      finally { reading = false; previous.disabled = !offsets.length; next.disabled = !current || current.next >= current.total; }
    };
    details.ontoggle = () => { if (details.open && !current) void read(0); };
    previous.onclick = async () => { const offset = offsets.at(-1); if (offset !== undefined && await read(offset)) { offsets.pop(); previous.disabled = !offsets.length; } };
    next.onclick = async () => { const before = current; if (before && await read(before.next)) { offsets.push(before.offset); previous.disabled = false; } };
    details.append(el("p", { className: "hint", textContent: "Review the complete request one page at a time." }), preview, page, el("nav", { className: "native-consent-pages", "aria-label": "Request pages" }, previous, position, next));
    node.append(el("h3", { textContent: "Send this request to the model?" }), el("p", { className: "native-consent-goal", textContent: view.goal }), el("p", { textContent: `${d.provider} · ${d.model} · Up to ${d.max_output_tokens} output tokens` }), el("p", { className: "native-consent-destination", textContent: d.destination }), expires, details);
    const actions = el("div", { className: "approval-actions" });
    for (const [label, decision] of [["Deny", "deny"], ["Allow once", "allow_once"]] as const) {
      const button = el("button", { type: "button", className: decision === "allow_once" ? "primary small" : "ghost small", textContent: label });
      button.onclick = () => void this.decide(view, decision); controls.push(button); actions.append(button);
    }
    node.append(actions); return { view, node, expires, controls };
  }
  private async decide(view: ProviderConsent, decision: "allow_once" | "deny"): Promise<void> {
    const id = view.approval.ticket_id;
    if (!this.available || this.busy.has(id) || this.cards.get(id)?.view.approval.fingerprint !== view.approval.fingerprint) return;
    this.busy.add(id); for (const control of this.cards.get(id)!.controls) control.disabled = true;
    try {
      const receipt = parseConsentReceipt(await this.transport.decide(id, view.approval.fingerprint, decision), id);
      this.decisionNotice = receipt.state === "allowed" ? "Allowed once for this exact request." : receipt.state === "denied" ? "Request denied." : "This request ended or could not start. Review a new request to continue.";
      this.decisionNotice = `${[...view.goal].slice(0, 80).join("")}: ${this.decisionNotice}`;
      await this.refresh();
    } catch (error) { this.showError(error); }
    finally { this.busy.delete(id); for (const control of this.cards.get(id)?.controls ?? []) control.disabled = !this.available; }
  }
}

export function startProviderConsents(): ProviderConsents | undefined {
  if (!isTauri()) return;
  const parent = document.querySelector<HTMLElement>(".topbar-right");
  if (!parent) throw new Error("Permission controls need the application toolbar");
  const ui = new ProviderConsents({
    list: () => invoke("control_provider_consents"),
    read: (ticketId, fingerprint, offset) => invoke("control_provider_consent_request", { ticketId, fingerprint, offset }),
    decide: (ticketId, fingerprint, decision) => invoke("control_provider_consent_decide", { ticketId, fingerprint, decision }),
  }, parent);
  ui.start(); return ui;
}
