import { describe, expect, it } from "vitest";
import { whisperSampleRate, whisperWindowSamples } from "./whisperMel";
import { WindowSlicer, stitchWindows, windowOverlapSamples, type AudioWindow } from "./whisperWindows";

const hop = whisperWindowSamples - windowOverlapSamples;

function ramp(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => i);
}

function slice(audio: Float32Array, block: number): AudioWindow[] {
  const s = new WindowSlicer();
  const out: AudioWindow[] = [];
  for (let at = 0; at < audio.length; at += block) out.push(...s.push(audio.slice(at, at + block)));
  out.push(...s.finish());
  return out;
}

describe("WindowSlicer", () => {
  it("cutsThirtySecondWindowsFiveSecondsOverlapping", () => {
    const windows = slice(ramp(whisperSampleRate * 70), 4096);
    expect(windows.map((w) => w.startSample / whisperSampleRate)).toEqual([0, 25, 50]);
    expect(windows.map((w) => w.samples.length / whisperSampleRate)).toEqual([30, 30, 20]);
    for (const w of windows) expect(w.samples[0]).toBe(w.startSample);
    expect(windows[1]?.samples[hop - 1]).toBe(hop + hop - 1);
  });

  it("givesTheSameWindowsWhateverTheBlockSize", () => {
    const audio = ramp(whisperSampleRate * 83 + 123);
    const a = slice(audio, 1000);
    const b = slice(audio, 480_000);
    const c = slice(audio, audio.length);
    expect(b.map((w) => w.startSample)).toEqual(a.map((w) => w.startSample));
    expect(c.map((w) => w.samples.length)).toEqual(a.map((w) => w.samples.length));
    expect(a.every((w, i) => w.samples.every((v, j) => v === (b[i] as AudioWindow).samples[j]))).toBe(true);
  });

  it("emitsOneShortWindowForShortAudioAndNothingForNone", () => {
    expect(slice(ramp(whisperSampleRate * 4), 1000).map((w) => w.samples.length)).toEqual([whisperSampleRate * 4]);
    expect(slice(new Float32Array(0), 1000)).toEqual([]);
  });

  it("doesNotRepeatATailThatThePreviousWindowAlreadyCovered", () => {
    // 35 s: window 0 is 0-30 s, the 5 s left are exactly its overlap.
    expect(slice(ramp(whisperWindowSamples + windowOverlapSamples), 8000).map((w) => w.startSample / whisperSampleRate)).toEqual([0, 25]);
    expect(slice(ramp(whisperWindowSamples), 8000).map((w) => w.startSample)).toEqual([0]);
  });
});

const word = (text: string, start: number, end: number) => ({ text, start, end });

describe("stitchWindows", () => {
  it("shiftsWordsIntoSourceTime", () => {
    expect(stitchWindows([{ start: 100, end: 130, words: [word("a", 1, 1.5)] }])).toEqual([word("a", 101, 101.5)]);
  });

  it("keepsEachOverlapWordOnceCuttingAtTheMiddleOfTheOverlap", () => {
    // Windows 0-30 and 25-55 overlap on 25-30; the cut is at 27.5 s.
    const first = { start: 0, end: 30, words: [word("a", 10, 10.5), word("b", 26, 26.4), word("c", 28, 28.4)] };
    const second = { start: 25, end: 55, words: [word("b", 1, 1.4), word("c", 3, 3.4), word("d", 10, 10.5)] };
    const out = stitchWindows([first, second]);
    expect(out.map((w) => w.text)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((w) => w.start)).toEqual([10, 26, 28, 35]);
  });

  it("takesAWordFromTheWindowWhoseHalfOfTheOverlapItLiesIn", () => {
    const first = { start: 0, end: 30, words: [word("go", 26.9, 27.3), word("now", 27.6, 27.9)] }; // "now" centres at 27.75
    const second = { start: 25, end: 55, words: [word("go", 2.0, 2.4), word("now", 2.6, 2.9)] };
    const out = stitchWindows([first, second]);
    expect(out.map((w) => w.text)).toEqual(["go", "now"]);
    expect(out[1]?.start).toBeCloseTo(27.6, 5);
  });

  it("handlesThreeWindowsEmptyOnesAndNone", () => {
    const windows = [
      { start: 0, end: 30, words: [word("a", 1, 2)] },
      { start: 25, end: 55, words: [] },
      { start: 50, end: 80, words: [word("z", 20, 21)] },
    ];
    expect(stitchWindows(windows).map((w) => w.text)).toEqual(["a", "z"]);
    expect(stitchWindows([])).toEqual([]);
  });
});
