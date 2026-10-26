// Choices by voice, in conversation mode. When a reply leaves a decision on
// screen (a comparison, a row of buttons, a "Choose" on each card), it is asked
// aloud after the reply. The answer is matched by meaning ("the cheaper one",
// "the second", "Hilton") with @vak/core's deterministic resolver, read back,
// and on a yes the control is activated exactly as a click would. A form is
// filled one question at a time (an answer may fill several fields), its
// checks explained aloud, the values shown on screen as they are heard, then
// read back and submitted the same way.

import { type AgendaItem, agenda, answerSchema, answerWords, fillAnswer, getAt, question, readBack, readModelAnswer, type Resolution, resolveAnswer, type SurfaceStore } from "@vak/core";

type Decision = AgendaItem & { kind: "decision" };
type Form = AgendaItem & { kind: "form" };

export interface DecisionVoice {
  store(): SurfaceStore;
  say(text: string): void;
  /** Activate the control as a click; false if it could not be sent. */
  activate(surface: string, key: string): boolean;
  /** Values were written to these data paths: show them, and keep them as drafts. */
  filled?(surface: string, paths: string[]): void;
  /**
   * When the rules cannot place an answer: the model's JSON for `schema`, or
   * undefined. Its result is read through readModelAnswer, so only values the
   * surface allows are used. Never asked about approvals.
   */
  model?(question: string, said: string, schema: Record<string, unknown>): Promise<unknown>;
}

/** A short unclear answer is asked again once; after that the choice waits on screen. */
const TRIES = 2;
/** Longer than this, an answer that names no option is the person saying something else: it goes to the model. */
const ASIDE_WORDS = 4;

export class VoiceDecisions {
  private item: Decision | Form | undefined;
  private chosen: number | undefined;
  /** The form field being asked; undefined once every field is answered and the read-back is out. */
  private field: string | undefined;
  /** Form fields already asked or answered: an optional one is asked once. */
  private asked = new Set<string>();
  private tries = 0;
  private readonly io: DecisionVoice;

  constructor(io: DecisionVoice) {
    this.io = io;
  }

  get waiting(): boolean {
    return this.item !== undefined;
  }

  /** A reply ended with these surfaces: the first decision among them becomes the question, returned to be said after the reply. */
  offer(surfaces: readonly string[]): string | undefined {
    this.clear();
    for (const id of surfaces) {
      const d = agenda(this.io.store(), id).find((i): i is Decision | Form => (i.kind === "decision" && i.options.length > 0) || (i.kind === "form" && i.fields.length > 0));
      if (d?.kind === "decision") {
        this.item = d;
        return question(d);
      }
      if (d?.kind === "form") {
        this.item = d;
        this.field = this.nextField(d) ?? d.fields[0]!.key;
        this.asked.add(this.field);
        return `${d.title ?? d.action} needs ${d.fields.length === 1 ? "one thing" : `${d.fields.length} things`}: ${d.fields.map((f) => f.label).join(", ")}. ${question(d, this.field)}`;
      }
    }
    return undefined;
  }

  /** Anything else acted on the surfaces (a click, a new turn): stop asking. */
  clear(): void {
    this.item = undefined;
    this.chosen = undefined;
    this.field = undefined;
    this.asked.clear();
    this.tries = 0;
  }

  /** A sentence heard while a choice waits. True when it was about the choice, so it is not sent as a message. */
  async hear(said: string): Promise<boolean> {
    const d = this.item;
    if (!d) return false;
    if (d.kind === "form") return this.hearForm(d, said);
    let r = resolveAnswer(d, said);
    if (r.kind === "unknown" && this.chosen === undefined) r = await this.ask(d, said, r);
    if (this.item !== d) return true;
    if (r.kind === "choose") return this.pick(r.index), true;
    if (r.kind === "ambiguous") {
      this.io.say(`Did you mean ${r.indices.map((i) => d.options[i]!.label).join(" or ")}?`);
      return true;
    }
    if (r.kind === "repeat") return this.io.say(this.chosen === undefined ? question(d) : readBack(this.io.store(), d, this.chosen)), true;
    if (r.kind === "cancel") return this.clear(), this.io.say("All right."), true;
    if (this.chosen !== undefined && r.kind === "yes") {
      const option = d.options[this.chosen]!;
      this.clear();
      if (!this.io.activate(d.surface, option.source)) this.io.say("That choice is no longer available on screen.");
      return true;
    }
    if (this.chosen !== undefined && r.kind === "no") {
      this.chosen = undefined;
      this.io.say(`Which one, then? ${question(d)}`);
      return true;
    }
    if (r.kind === "yes" && d.options.length === 1) return this.pick(0), true;
    // Not an answer: a longer sentence is the person talking about something else.
    if (answerWords(said).split(" ").length > ASIDE_WORDS) return this.clear(), false;
    if (++this.tries < TRIES) return this.io.say(`Sorry, which one? ${question(d)}`), true;
    this.clear();
    this.io.say("It is waiting on screen for you.");
    return true;
  }

  private async hearForm(f: Form, said: string): Promise<boolean> {
    let r = resolveAnswer(f, said, { field: this.field });
    if (this.field !== undefined && (r.kind === "unknown" || (r.kind === "fill" && this.field in r.errors))) {
      const m = await this.ask(f, said, r);
      if (this.item !== f) return true;
      if (m.kind === "fill" && this.field in m.values) r = m;
    }
    const ask = () => this.io.say(question(f, this.field));
    if (r.kind === "cancel") return this.clear(), this.io.say("All right. The form stays on screen."), true;
    if (r.kind === "repeat") return (this.field ? ask() : this.io.say(readBack(this.io.store(), f))), true;
    if (this.field === undefined) {
      // The read-back is out: yes submits, no asks what to change.
      if (r.kind === "yes") {
        this.clear();
        if (!this.io.activate(f.surface, f.source)) this.io.say("That form is no longer available on screen.");
        return true;
      }
      if (r.kind === "no") return (this.field = f.fields[0]!.key), this.io.say(`What should change? ${question(f, this.field)}`), true;
    }
    if (r.kind === "back") {
      const i = f.fields.findIndex((x) => x.key === this.field);
      this.field = f.fields[Math.max(0, (i < 0 ? f.fields.length : i) - 1)]!.key;
      return ask(), true;
    }
    if (r.kind !== "fill") {
      if (++this.tries < TRIES) return this.io.say(`Sorry. ${question(f, this.field)}`), true;
      this.clear();
      this.io.say("It is waiting on screen for you.");
      return true;
    }
    this.tries = 0;
    fillAnswer(this.io.store(), f, r.values);
    for (const k of Object.keys(r.values)) this.asked.add(k);
    this.io.filled?.(f.surface, f.fields.filter((x) => x.key in r.values).map((x) => x.bindPath));
    const error = this.field ? r.errors[this.field] : undefined;
    if (error) return this.io.say(`${error}. ${question(f, this.field)}`), true;
    this.field = this.nextField(f);
    if (this.field) this.asked.add(this.field);
    this.io.say(this.field ? question(f, this.field) : readBack(this.io.store(), f));
    return true;
  }

  /** The model's reading, constrained to the item's schema and checked like any answer; `fallback` when it has none. */
  private async ask(item: Decision | Form, said: string, fallback: Resolution): Promise<Resolution> {
    const schema = answerSchema(item);
    if (!this.io.model || !schema) return fallback;
    try {
      const r = readModelAnswer(item, await this.io.model(question(item, this.field), said, schema));
      return r.kind === "unknown" ? fallback : r;
    } catch {
      return fallback;
    }
  }

  /** In reading order: a field failing its checks, else an empty optional one not yet asked. */
  private nextField(f: Form): string | undefined {
    const store = this.io.store();
    const failing = new Set(fillAnswer(store, f, {}).map((x) => x.key));
    const data = store.get(f.surface)?.data;
    const empty = (path: string) => [undefined, null, ""].includes(getAt(data, path) as never);
    return f.fields.find((x) => failing.has(x.key))?.key ?? f.fields.find((x) => !this.asked.has(x.key) && empty(x.bindPath))?.key;
  }

  private pick(index: number): void {
    this.chosen = index;
    this.tries = 0;
    this.io.say(readBack(this.io.store(), this.item as Decision, index));
  }
}
