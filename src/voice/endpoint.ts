// When someone starts and stops talking, from the microphone's level alone, on
// this Mac. The threshold follows the room's noise floor, so a fan or a quiet
// room both work. While the app is speaking the bar is higher and speech must
// last longer: what echo cancellation leaves of our own voice must not count as
// the person interrupting.

export interface EndpointOptions {
  /** Above the bar this long before it counts as speech (ms). */
  onset: number;
  /** Onset while the app is speaking: an interruption must be deliberate. */
  bargeOnset: number;
  /** Below the bar this long ends the utterance (ms). */
  silence: number;
  /** The bar is this many times the noise floor… */
  ratio: number;
  /** …and this much higher again while the app speaks. */
  echoRatio: number;
  /** Never below this level, so a silent room does not trigger on breath. */
  minimum: number;
}

export const ENDPOINT: EndpointOptions = { onset: 120, bargeOnset: 300, silence: 800, ratio: 3, echoRatio: 2.5, minimum: 0.012 };

export type EndpointEvent = "start" | "end";

export class Endpointer {
  private floor = 0.005;
  private above = 0;
  private below = 0;
  private inSpeech = false;
  private readonly o: EndpointOptions;

  constructor(o: Partial<EndpointOptions> = {}) {
    this.o = { ...ENDPOINT, ...o };
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  /** One frame: its RMS level, its length in ms, and whether the app is speaking now. */
  feed(level: number, ms: number, appSpeaking: boolean): EndpointEvent | undefined {
    const bar = Math.max(this.o.minimum, this.floor * this.o.ratio) * (appSpeaking ? this.o.echoRatio : 1);
    // The floor drops at once to a quieter frame and rises slowly, and only outside speech.
    if (!this.inSpeech) this.floor = level < this.floor ? level : this.floor + (level - this.floor) * Math.min(1, ms / 4000);
    if (!this.inSpeech) {
      this.above = level > bar ? this.above + ms : 0;
      if (this.above >= (appSpeaking ? this.o.bargeOnset : this.o.onset)) {
        this.inSpeech = true;
        this.below = 0;
        return "start";
      }
      return undefined;
    }
    // A little below the starting bar still counts as speech, so a soft word does not cut the sentence.
    this.below = level < bar * 0.7 ? this.below + ms : 0;
    if (this.below >= this.o.silence) {
      this.inSpeech = false;
      this.above = 0;
      return "end";
    }
    return undefined;
  }

  reset(): void {
    this.inSpeech = false;
    this.above = this.below = 0;
  }
}

/** Root mean square of a frame, sampled every `step` samples. */
export function rms(d: Float32Array, step = 4): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += step, n++) sum += d[i]! * d[i]!;
  return n ? Math.sqrt(sum / n) : 0;
}
