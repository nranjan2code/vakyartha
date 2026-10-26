// Approvals by voice, in conversation mode. A tool waiting on "Ask" is put as a
// question; the next sentence heard is resolved by @vak/core's deterministic
// resolver, never by a model. Only words from the microphone reach it.
//
// Every approval counts as a change: a tool only asks when its server says it
// writes or reaches out, or says nothing, and those hints are the server's own
// claim. So consent must name the operation ("allow write"), a bare "yes" is
// not enough, and anything unclear or silent leaves the request on screen.
// Voice can only allow once; "for this chat" stays a click.

import { type AgendaItem, answerWords, question, resolveAnswer } from "@vak/core";

export interface ApprovalRequest { id: string; tool: string; server: string; title: string }

/**
 * Words that cannot be the one consent must say: vague ones, and words of
 * agreement. A server names its own tools, so one titled "Yes" or "Allow"
 * must not turn a bare yes back into consent.
 */
const VAGUE = new Set(["the", "a", "an", "to", "of", "and", "in", "on", "for", "with", "tool", "use", "run", "call", "get", "mcp", "server", "api",
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "correct", "right", "go", "ahead", "do", "it", "please", "sounds", "good", "thats", "allow", "approve", "agreed", "fine", "no", "not", "dont"]);

/** The approval as an agenda item: its words are the tool's own ("write_file" → write, file), never the model's. */
export function approvalItem(r: ApprovalRequest, serverName = r.server): AgendaItem & { kind: "approval" } {
  const named = (s: string) => [...new Set(answerWords(s.replace(/[_-]+/g, " ")).split(" ").filter((w) => w.length > 2 && !VAGUE.has(w)))];
  const words = named(`${r.tool} ${r.title}`);
  return { kind: "approval", id: r.id, title: `${serverName} wants to ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}`, change: true, words: words.length ? words : [...named(r.server), "this"] };
}

export interface ApprovalVoice {
  /** Send the decision exactly as the card's buttons do. */
  decide(id: string, decision: "allow" | "deny"): Promise<void>;
  say(text: string): void;
}

/** One unclear answer is asked again; after that the request waits on screen. */
const TRIES = 2;

export class VoiceApprovals {
  private queue: { item: AgendaItem & { kind: "approval" }; tries: number }[] = [];
  private readonly io: ApprovalVoice;

  constructor(io: ApprovalVoice) {
    this.io = io;
  }

  get waiting(): boolean {
    return this.queue.length > 0;
  }

  /** A request arrived: ask it now, or after the ones before it. */
  offer(r: ApprovalRequest, serverName?: string): void {
    if (this.queue.some((q) => q.item.id === r.id)) return;
    this.queue.push({ item: approvalItem(r, serverName), tries: 0 });
    if (this.queue.length === 1) this.ask();
  }

  /** Settled elsewhere (a click, or the run ended): stop asking about it. */
  settled(id: string): void {
    const first = this.queue[0]?.item.id === id;
    this.queue = this.queue.filter((q) => q.item.id !== id);
    if (first && this.queue.length) this.ask();
  }

  /** Conversation mode ended: the requests stay on screen, unanswered. */
  clear(): void {
    this.queue = [];
  }

  /** A sentence heard while a request waits. True when it was the answer (or about it), so it is not sent as a message. */
  async hear(said: string): Promise<boolean> {
    const head = this.queue[0];
    if (!head) return false;
    const r = resolveAnswer(head.item, said);
    if (r.kind === "repeat") return this.ask(), true;
    if (r.kind === "yes" || r.kind === "no") {
      this.queue.shift();
      await this.io.decide(head.item.id, r.kind === "yes" ? "allow" : "deny");
      this.io.say(r.kind === "yes" ? "Allowed once." : "Declined.");
      if (this.queue.length) this.ask();
      return true;
    }
    if (++head.tries < TRIES) {
      this.io.say(`I did not take that as an answer. ${question(head.item)}`);
      return true;
    }
    // Never decided by default: it waits for a click, and the person can talk about other things.
    this.queue.shift();
    this.io.say("It is waiting on screen for you.");
    if (this.queue.length) this.ask();
    return true;
  }

  private ask(): void {
    const head = this.queue[0];
    if (head) this.io.say(question(head.item));
  }
}
