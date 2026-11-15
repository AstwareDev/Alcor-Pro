import { swiftRound } from "../util/math";

export const previewPlaybackRates = [0.5, 0.75, 1, 1.5, 2, 4, 10] as const;
export type PreviewPlaybackRate = (typeof previewPlaybackRates)[number];

const labels: Record<PreviewPlaybackRate, string> = {
  0.5: "0.5×",
  0.75: "0.75×",
  1: "1×",
  1.5: "1.5×",
  2: "2×",
  4: "4×",
  10: "10×",
};

export function previewPlaybackRateLabel(rate: PreviewPlaybackRate): string {
  return labels[rate];
}

export function previewPlaybackRateAllowsAudioMetering(rate: PreviewPlaybackRate): boolean {
  return rate <= 2;
}

export function isPreviewPlaybackRate(value: number): value is PreviewPlaybackRate {
  return (previewPlaybackRates as readonly number[]).includes(value);
}

/** `PreviewSeekMode` */
export type PreviewSeekMode = "exact" | "interactiveScrub" | "audibleStepForward" | "audibleStepBackward";

/** `VideoEngine.frameCount(for:fps:)` with the duration in seconds; rounds half away from zero. */
export function frameCountForDuration(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !(fps > 0) || !Number.isInteger(fps)) return 0;
  return Math.max(0, swiftRound(seconds * fps));
}
