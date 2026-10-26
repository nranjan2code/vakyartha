// Words that steer voice itself rather than going to the model. Matched on the
// whole sentence: inside a longer one they are content ("stop the server").

import { answerWords } from "@vak/core";

/** Said on their own, these end the mode. */
const END = ["stop listening", "end conversation", "stop conversation", "goodbye", "bye", "thats all", "that is all"];
/** Said on their own, these only quiet the reply. */
const HUSH = ["stop", "quiet", "be quiet", "shush", "enough", "okay stop", "ok stop"];

/** Said on their own, these steer the app. */
const APP: Record<string, readonly string[]> = {
  repeat: ["repeat", "repeat that", "say that again", "say again", "read it again", "again"],
  new: ["new conversation", "new chat", "start over", "start a new chat"],
  details: ["more", "details", "tell me more", "the details", "read the table", "read it all", "read everything", "the rest"],
  canvas: ["show it", "show me", "open it", "show it on the canvas", "open the canvas", "put it on the canvas"],
};

export type VoiceCommand = "end" | "hush" | "repeat" | "new" | "details" | "canvas";

/** What a short sentence means for voice or the app itself, or nothing (it is a message). */
export function modeCommand(text: string): VoiceCommand | undefined {
  const w = answerWords(text);
  if (END.includes(w)) return "end";
  if (HUSH.includes(w)) return "hush";
  for (const [c, phrases] of Object.entries(APP)) if (phrases.includes(w)) return c as VoiceCommand;
  return undefined;
}

/**
 * Our own speech heard back: most of its words, in order, are in something the
 * app said in the last moments. Echo cancellation leaves traces of loud
 * replies; without this, a page read aloud that contains "allow write" could
 * be heard as the person saying it.
 */
export function isEcho(heard: string, said: readonly string[]): boolean {
  const h = answerWords(heard).split(" ").filter(Boolean);
  if (!h.length) return false;
  return said.some((s) => {
    const w = answerWords(s).split(" ");
    let i = 0;
    let hits = 0;
    for (const t of h) {
      const at = w.indexOf(t, i);
      if (at >= 0) { hits++; i = at + 1; }
    }
    return hits / h.length >= 0.8;
  });
}
