// Conversation mode: talk, hear the reply, talk again, without touching
// anything. The microphone stays open while the mode is on; endpoint.ts decides
// when a sentence starts and ends. Speaking over a reply stops it. A sentence
// goes to the same transcription model as dictation, then to the app as if
// typed. Recordings live in memory only for that one transcription.
// Anything showing the mode hears "vak:conversation".

import { prefs } from "../core.ts";
import { downsample, recordingChoice, transcribeWav, wav16k } from "./dictation.ts";
import { Endpointer, rms } from "./endpoint.ts";
import { voiceMaster } from "./master.ts";
import { isEcho, modeCommand, type VoiceCommand } from "./commands.ts";
import { recentlySaid, stopReading, voiceState } from "./read-aloud.ts";
import { mediaPlaying, pauseMedia } from "../media.ts";

export type ConversationState = "off" | "listening" | "hearing" | "understanding" | "speaking";

export const conversationPrefs = {
  /** The person's own setting; `enabled` is also off under the master switch. */
  get own(): boolean { return prefs.get("conversation:enabled") !== "false"; },
  get enabled(): boolean { return voiceMaster.on && this.own; },
  set enabled(v: boolean) { prefs.set("conversation:enabled", String(v)); if (!v) stopConversation(); window.dispatchEvent(new Event("vak:conversation")); },
};

export interface ConversationHandlers {
  /** A finished sentence, as text. */
  onUtterance(text: string): void | Promise<void>;
  /** "repeat", "new", "canvas": the app acts; "end" and "hush" are handled here. */
  onCommand?(command: VoiceCommand): void;
  onError(message: string): void;
}

/** A sentence longer than this is cut and sent, so the mode never records without end. */
const MAX_UTTERANCE_MS = 60_000;
/** Kept from before speech was recognised, so its first syllable is not lost. */
const PREROLL_MS = 350;

let state: ConversationState = "off";
let release: (() => void) | undefined;
export const conversationState = () => state;
/** Read fresh each time: the mode can end while a transcription is awaited. */
const off = () => state === "off";
const announce = (s: ConversationState) => {
  if (s === state) return;
  state = s;
  window.dispatchEvent(new Event("vak:conversation"));
};

/** Follow the reply being read: speaking while it plays, listening after. Master off ends the mode. */
function onVoice(): void {
  if (state === "off") return;
  if (!voiceMaster.on || !conversationPrefs.enabled) return stopConversation();
  const reading = voiceState().state !== "idle";
  if (reading && state === "listening") announce("speaking");
  else if (!reading && state === "speaking") announce("listening");
}
window.addEventListener("vak:voice", onVoice);

export function stopConversation(): void {
  release?.();
  release = undefined;
  announce("off");
}

export async function startConversation(h: ConversationHandlers): Promise<void> {
  if (state !== "off" || !conversationPrefs.enabled) return;
  const choice = await recordingChoice();
  if (!choice) return h.onError("Conversation mode needs a transcription model: install Whistle (free, on this Mac) or add an OpenAI or Gemini key in Integrations → Voice.");
  if (!navigator.mediaDevices?.getUserMedia) return h.onError("This window cannot use the microphone.");
  let stream: MediaStream;
  try {
    // Echo cancellation keeps the reply we play out of what we hear.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    return h.onError("Microphone access is off. Allow Vakyartha in System Settings → Privacy & Security → Microphone.");
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor needs no worklet module, which this page's CSP would refuse.
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const frameMs = (2048 / ctx.sampleRate) * 1000;
  const ends = new Endpointer();
  const preroll: Float32Array[] = [];
  let segment: Float32Array[] | undefined;
  let heard = 0;
  const abort = new AbortController();

  // When the app last made sound: a sentence that began during it, or just after, may be our own echo.
  let lastSpoke = 0;
  let overlapped = false;
  let mediaQuietUntil = 0;
  const finish = async (chunks: Float32Array[], overlap: boolean) => {
    announce("understanding");
    try {
      const text = await transcribeWav(choice, wav16k(downsample(chunks, ctx.sampleRate)), abort.signal);
      if (off()) return;
      // Our own words heard back are never the person (and never consent).
      if (overlap && isEcho(text, recentlySaid())) return void announce(voiceState().state !== "idle" ? "speaking" : "listening");
      const command = modeCommand(text);
      if (command === "end") return stopConversation();
      if (command && command !== "hush") h.onCommand?.(command);
      if (text && !command) await h.onUtterance(text);
    } catch (err) {
      if (off()) return;
      // Noise the endpointer took for speech is not worth a message.
      if ((err as Error).message !== "Nothing was heard.") h.onError((err as Error).message);
    }
    if (!off()) announce(voiceState().state !== "idle" ? "speaking" : "listening");
  };

  proc.onaudioprocess = (e) => {
    if (off()) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    const media = mediaPlaying();
    if (Date.now() < mediaQuietUntil) { ends.reset(); preroll.length = 0; return; }
    const reading = voiceState().state !== "idle" || media;
    if (reading) lastSpoke = Date.now();
    // While a sentence is being understood, the next is not started: one at a time keeps replies in order.
    const event = state === "understanding" ? undefined : ends.feed(rms(frame), frameMs, reading);
    if (event === "start") {
      // Speaking over the reply stops it: the person has something to say.
      if (reading) stopReading();
      // A clip can contain arbitrary speech, including approval words. Pause
      // on barge-in and discard that overlapping utterance before transcription.
      if (media) { pauseMedia(); mediaQuietUntil = Date.now() + 1000; ends.reset(); preroll.length = 0; announce("listening"); return; }
      overlapped = Date.now() - lastSpoke < 700;
      segment = [...preroll];
      heard = 0;
      announce("hearing");
    }
    if (segment) {
      segment.push(frame);
      heard += frameMs;
      if (event === "end" || heard >= MAX_UTTERANCE_MS) {
        const chunks = segment;
        segment = undefined;
        ends.reset();
        void finish(chunks, overlapped);
      }
    }
    preroll.push(frame);
    while (preroll.length * frameMs > PREROLL_MS) preroll.shift();
  };
  source.connect(proc);
  proc.connect(ctx.destination);
  release = () => {
    abort.abort();
    proc.onaudioprocess = null;
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
    segment = undefined;
    preroll.length = 0;
  };
  announce(voiceState().state !== "idle" ? "speaking" : "listening");
}
