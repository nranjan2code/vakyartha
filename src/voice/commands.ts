// Words that steer voice itself rather than going to the model. Matched on the
// whole sentence: inside a longer one they are content ("stop the server").

import { answerWords } from "@vak/core";

/** Said on their own, these end the mode. */
const END = ["stop listening", "end conversation", "stop conversation", "goodbye", "bye", "thats all", "that is all"];
/** Said on their own, these only quiet the reply. */
const HUSH = ["stop", "quiet", "be quiet", "shush", "enough", "okay stop", "ok stop"];

/** What a short sentence means for the mode itself: "end", "hush", or nothing (it is a message). */
export function modeCommand(text: string): "end" | "hush" | undefined {
  const w = answerWords(text);
  if (END.includes(w)) return "end";
  if (HUSH.includes(w)) return "hush";
  return undefined;
}
