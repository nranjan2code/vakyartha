// The one switch over all of voice. Off: no microphone, no spoken output, no
// speech requests; read aloud and dictation keep their own settings beneath it,
// so turning voice back on restores them as they were.

import { prefs } from "../core.ts";

export const voiceMaster = {
  get on(): boolean { return prefs.get("voice:on") !== "false"; },
  set on(v: boolean) {
    prefs.set("voice:on", String(v));
    // Everything that shows a speaker or a mic repaints from these.
    window.dispatchEvent(new Event("vak:voice"));
    window.dispatchEvent(new Event("vak:dictation"));
  },
};
