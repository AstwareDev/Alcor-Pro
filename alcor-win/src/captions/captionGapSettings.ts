// Port of MediaPanel/CaptionsTab/CaptionGapSettings.swift.

export interface CaptionGapSettings {
  readonly maximumGapSeconds: number;
}

export const captionMaximumGapRange = { min: 0, max: 2 } as const;

export const captionGapSettingsDefault: CaptionGapSettings = { maximumGapSeconds: 0.5 };

/** Failable init: undefined unless finite and within 0...2 seconds. */
export function makeCaptionGapSettings(maximumGapSeconds: number): CaptionGapSettings | undefined {
  if (!Number.isFinite(maximumGapSeconds)) return undefined;
  if (maximumGapSeconds < captionMaximumGapRange.min || maximumGapSeconds > captionMaximumGapRange.max) return undefined;
  return { maximumGapSeconds };
}

export function captionMaximumGapFrames(settings: CaptionGapSettings, fps: number): number {
  if (!(fps > 0) || !(settings.maximumGapSeconds > 0)) return 0;
  const frames = Math.floor(settings.maximumGapSeconds * fps);
  return Number.isFinite(frames) ? frames : 0;
}
