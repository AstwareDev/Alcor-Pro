// Port of Audio/Analysis/SpeechMaskStore.swift: session store for VAD speech masks and derived dead-air masks
// (32 ms cells). `analyze` is injected (production: Silero VAD with the JSON sidecar cache; tests: stubs).
import { analysisMask, type VoiceAnalysis } from "./voiceActivity";
import { removableMask, silenceRemovalSettingsEqual, type SilenceRemovalSettings } from "./silenceRemovalSettings";

const f = Math.fround;
// Marks a span as dead air if its median level is `speechGap` below the file's speech level (normalized waveform values).
const speechGap = f(0.24); // 12 dB
const noSpeechFloor = f(0.56); // absolute fallback, about -28 dB
const quietFloorMin = f(0.44);
const quietFloorMax = f(0.8);

export type MaskAnalyzer = (url: string, mediaRef: string) => Promise<VoiceAnalysis>;

export class SpeechMaskStore {
  private readonly speechMasks = new Map<string, boolean[]>();
  private readonly quietNonSpeechMasks = new Map<string, boolean[]>();
  private readonly deadAirMasks = new Map<string, { settings: SilenceRemovalSettings; mask: boolean[] }>();
  private readonly failed = new Set<string>();
  private readonly epoch = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly settling = new Map<string, Promise<void>>();

  onAnalyzingCountChange?: (count: number) => void;
  onMaskReady?: (mediaRef: string, url: string) => void;

  constructor(private readonly analyze: MaskAnalyzer) {}

  get analyzingCount(): number {
    return this.inFlight.size;
  }

  private setInFlight(key: string, present: boolean): void {
    const before = this.inFlight.size;
    if (present) this.inFlight.add(key);
    else this.inFlight.delete(key);
    if (this.inFlight.size !== before) this.onAnalyzingCountChange?.(this.inFlight.size);
  }

  hasSpeechMask(mediaRef: string): boolean {
    return this.speechMasks.has(mediaRef);
  }

  /** Starts analysis once per asset; no-op while in flight, done, or after a failure (until `reset`/`invalidate`). */
  generate(asset: { id: string; url: string }): void {
    const key = asset.id;
    if (this.speechMasks.has(key) || this.inFlight.has(key) || this.failed.has(key)) return;
    this.setInFlight(key, true);
    const startEpoch = this.epoch.get(key) ?? 0;
    const run = this.analyze(asset.url, key).then(
      (analysis) => this.finish(key, startEpoch, asset.url, analysisMask(analysis)),
      () => this.finish(key, startEpoch, asset.url, undefined),
    );
    this.settling.set(key, run);
    void run.then(() => {
      if (this.settling.get(key) === run) this.settling.delete(key);
    });
  }

  /** Resolves when the in-flight analysis for `mediaRef` (if any) has finished, successfully or not. */
  settled(mediaRef: string): Promise<void> {
    return this.settling.get(mediaRef) ?? Promise.resolve();
  }

  private finish(key: string, startEpoch: number, url: string, mask: boolean[] | undefined): void {
    if ((this.epoch.get(key) ?? 0) !== startEpoch) return;
    this.setInFlight(key, false);
    if (!mask) {
      this.failed.add(key);
      return;
    }
    this.speechMasks.set(key, mask);
    this.quietNonSpeechMasks.delete(key);
    this.deadAirMasks.delete(key);
    if (mask.length > 0) this.onMaskReady?.(key, url);
  }

  /** Drops all session state so cleared disk caches regenerate. */
  reset(): void {
    for (const key of this.inFlight) this.epoch.set(key, (this.epoch.get(key) ?? 0) + 1);
    const hadInFlight = this.inFlight.size > 0;
    this.inFlight.clear();
    if (hadInFlight) this.onAnalyzingCountChange?.(0);
    this.speechMasks.clear();
    this.quietNonSpeechMasks.clear();
    this.deadAirMasks.clear();
    this.failed.clear();
  }

  invalidate(mediaRef: string): void {
    this.epoch.set(mediaRef, (this.epoch.get(mediaRef) ?? 0) + 1);
    this.setInFlight(mediaRef, false);
    this.speechMasks.delete(mediaRef);
    this.quietNonSpeechMasks.delete(mediaRef);
    this.deadAirMasks.delete(mediaRef);
    this.failed.delete(mediaRef);
  }

  /** Quiet, non-speech cells before minimum-pause and speech-padding policy is applied. */
  quietNonSpeechMask(mediaRef: string, samples: Float32Array | undefined): boolean[] | undefined {
    const cached = this.quietNonSpeechMasks.get(mediaRef);
    if (cached) return cached;
    const speech = this.speechMasks.get(mediaRef);
    if (!speech || speech.length === 0 || !samples || samples.length === 0) return undefined;
    const mask = buildQuietNonSpeechMask(speech, samples);
    this.quietNonSpeechMasks.set(mediaRef, mask);
    return mask;
  }

  /** Derived lazily once the speech mask and waveform samples both exist. */
  deadAirMask(mediaRef: string, samples: Float32Array | undefined, settings: SilenceRemovalSettings): boolean[] | undefined {
    const cached = this.deadAirMasks.get(mediaRef);
    if (cached && silenceRemovalSettingsEqual(cached.settings, settings)) return cached.mask;
    const quiet = this.quietNonSpeechMask(mediaRef, samples);
    if (!quiet) return undefined;
    const mask = removableMask(quiet, settings);
    this.deadAirMasks.set(mediaRef, { settings, mask });
    return mask;
  }

  /** Test seam (`installQuietNonSpeechMask`). */
  installQuietNonSpeechMask(mask: boolean[], mediaRef: string): void {
    this.quietNonSpeechMasks.set(mediaRef, mask);
    this.deadAirMasks.delete(mediaRef);
  }
}

function median(values: Float32Array | number[]): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.trunc(sorted.length / 2)];
}

export function buildQuietNonSpeechMask(speech: readonly boolean[], samples: Float32Array): boolean[] {
  const n = speech.length;
  const cellPeak = (c: number): number => {
    const s0 = Math.trunc((c * samples.length) / n);
    const s1 = Math.min(samples.length, Math.max(s0 + 1, Math.trunc(((c + 1) * samples.length) / n)));
    let peak = 1;
    for (let s = s0; s < s1; s++) if (samples[s] < peak) peak = samples[s];
    return peak;
  };

  const speechPeaks: number[] = [];
  for (let c = 0; c < n; c++) if (speech[c]) speechPeaks.push(cellPeak(c));
  const quietFloor = speechPeaks.length === 0
    ? noSpeechFloor
    : Math.min(quietFloorMax, Math.max(quietFloorMin, f(median(speechPeaks) + speechGap)));

  const dead = new Array<boolean>(n).fill(false);
  let i = 0;
  while (i < n) {
    if (speech[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !speech[j]) j += 1;
    const peaks: number[] = [];
    for (let c = i; c < j; c++) peaks.push(cellPeak(c));
    if (median(peaks) >= quietFloor) for (let c = i; c < j; c++) dead[c] = true;
    i = j;
  }
  return dead;
}
