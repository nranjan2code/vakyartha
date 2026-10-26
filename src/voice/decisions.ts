// Choices by voice, in conversation mode. When a reply leaves a decision on
// screen (a comparison, a row of buttons, a "Choose" on each card), it is asked
// aloud after the reply. The answer is matched by meaning ("the cheaper one",
// "the second", "Hilton") with @vak/core's deterministic resolver, read back,
// and on a yes the control is activated exactly as a click would.
// Forms come later (V6); they stay on screen.

import { type AgendaItem, agenda, answerWords, question, readBack, resolveAnswer, type SurfaceStore } from "@vak/core";

type Decision = AgendaItem & { kind: "decision" };

export interface DecisionVoice {
  store(): SurfaceStore;
  say(text: string): void;
  /** Activate the control as a click; false if it could not be sent. */
  activate(surface: string, key: string): boolean;
}

/** A short unclear answer is asked again once; after that the choice waits on screen. */
const TRIES = 2;
/** Longer than this, an answer that names no option is the person saying something else: it goes to the model. */
const ASIDE_WORDS = 4;

export class VoiceDecisions {
  private item: Decision | undefined;
  private chosen: number | undefined;
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
      const d = agenda(this.io.store(), id).find((i): i is Decision => i.kind === "decision" && i.options.length > 0);
      if (d) {
        this.item = d;
        return question(d);
      }
    }
    return undefined;
  }

  /** Anything else acted on the surfaces (a click, a new turn): stop asking. */
  clear(): void {
    this.item = undefined;
    this.chosen = undefined;
    this.tries = 0;
  }

  /** A sentence heard while a choice waits. True when it was about the choice, so it is not sent as a message. */
  hear(said: string): boolean {
    const d = this.item;
    if (!d) return false;
    const r = resolveAnswer(d, said);
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

  private pick(index: number): void {
    this.chosen = index;
    this.tries = 0;
    this.io.say(readBack(this.io.store(), this.item!, index));
  }
}
