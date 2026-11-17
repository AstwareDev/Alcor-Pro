// Long audio is cut into overlapping 30 s windows (Whisper's input size) and the words are stitched back together.
import type { TimedWord } from "./whisperAlign";
import { whisperSampleRate, whisperWindowSamples } from "./whisperMel";

export const windowOverlapSamples = 5 * whisperSampleRate;
const hopSamples = whisperWindowSamples - windowOverlapSamples;

export interface AudioWindow {
  /** Index of the first sample in the whole stream. */
  startSample: number;
  samples: Float32Array;
}

/** Streaming splitter: feed 16 kHz mono audio in any block size, get windows in order; `finish` emits the tail. */
export class WindowSlicer {
  private blocks: Float32Array[] = [];
  private held = 0;
  private origin = 0;
  private emitted = 0;

  private take(): Float32Array {
    const all = new Float32Array(this.held);
    let at = 0;
    for (const b of this.blocks) {
      all.set(b, at);
      at += b.length;
    }
    return all;
  }

  push(samples: Float32Array): AudioWindow[] {
    this.blocks.push(samples);
    this.held += samples.length;
    const out: AudioWindow[] = [];
    while (this.held >= whisperWindowSamples) {
      const all = this.take();
      out.push({ startSample: this.origin, samples: all.slice(0, whisperWindowSamples) });
      const rest = all.subarray(hopSamples);
      this.blocks = [rest];
      this.held = rest.length;
      this.origin += hopSamples;
      this.emitted += 1;
    }
    return out;
  }

  /** The last, shorter window, unless everything left was already covered by the previous window's overlap. */
  finish(): AudioWindow[] {
    const covered = this.emitted > 0 ? windowOverlapSamples : 0;
    if (this.held <= covered) return [];
    const last = { startSample: this.origin, samples: this.take() };
    this.blocks = [];
    this.held = 0;
    return [last];
  }
}

export interface WindowWords {
  /** Seconds in the source at which the window's audio starts and ends. */
  start: number;
  end: number;
  /** Seconds from the window start. */
  words: readonly TimedWord[];
}

/**
 * Merges per-window words into source time. A word belongs to the window whose half of each overlap it lies in
 * (cut at the middle of the overlap, where neither window is near its edge), so none is repeated or dropped.
 */
export function stitchWindows(windows: readonly WindowWords[]): TimedWord[] {
  const out: TimedWord[] = [];
  windows.forEach((w, i) => {
    const prev = windows[i - 1];
    const next = windows[i + 1];
    const lo = prev === undefined ? -Infinity : (w.start + prev.end) / 2;
    const hi = next === undefined ? Infinity : (next.start + w.end) / 2;
    for (const word of w.words) {
      const start = word.start + w.start;
      const end = word.end + w.start;
      const centre = (start + end) / 2;
      if (centre >= lo && centre < hi) out.push({ text: word.text, start, end });
    }
  });
  return out;
}
