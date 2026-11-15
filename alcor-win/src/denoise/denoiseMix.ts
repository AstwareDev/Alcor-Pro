// Denoise dry/wet blend (CompositionBuilder.insertDenoisedTwin + the audio-mix gain in buildAudioMix): a clip with a
// baked wet twin plays the wet file at `strength` x envelope and the original at `(1 - strength)` x envelope.
import { clipDenoiseAmount, clipHasDenoiseEnabled, type Clip } from "../model";
import type { AudioSource } from "../preview/frameGraph";

const wetPrefix = "denoise:";
const wetKeySuffix = "~wet";

/** Pseudo media ref naming the baked wet file of `mediaRef` (resolved through `wetPathFor`). */
export const wetMediaRef = (mediaRef: string): string => `${wetPrefix}${mediaRef}`;
export const isWetMediaRef = (mediaRef: string): boolean => mediaRef.startsWith(wetPrefix);
export const dryMediaRef = (mediaRef: string): string => (isWetMediaRef(mediaRef) ? mediaRef.slice(wetPrefix.length) : mediaRef);

/** `Float(min(1, max(0, clip.denoiseAmount)))` when denoise is on, else 0. */
export function denoiseStrength(clip: Clip): number {
  return clipHasDenoiseEnabled(clip) ? Math.fround(Math.min(1, Math.max(0, clipDenoiseAmount(clip)))) : 0;
}

/** Whether `clip` gets a wet twin: denoise on, amount above 0 and a baked file for its media. */
export function hasWetTwin(clip: Clip, wetRefs: ReadonlySet<string> | undefined): boolean {
  return wetRefs !== undefined && wetRefs.has(clip.mediaRef) && clipHasDenoiseEnabled(clip) && clipDenoiseAmount(clip) > 0;
}

export function blendGains(gain: number, strength: number): { dry: number; wet: number } {
  return { dry: gain * (1 - strength), wet: gain * strength };
}

/** Replaces a plain-clip source by its dry/wet pair when a wet twin exists (nested sources never blend, like Swift). */
export function splitDenoiseSource(source: AudioSource, wetRefs: ReadonlySet<string> | undefined): AudioSource[] {
  if (source.key.includes("/") || !hasWetTwin(source.clip, wetRefs)) return [source];
  const { dry, wet } = blendGains(source.gain, denoiseStrength(source.clip));
  return [
    { ...source, gain: dry },
    { ...source, key: `${source.key}${wetKeySuffix}`, mediaRef: wetMediaRef(source.mediaRef), gain: wet },
  ];
}
