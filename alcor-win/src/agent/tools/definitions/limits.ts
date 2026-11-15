// Constants the Swift tool schemas read from SilenceRemovalSettings, CaptionGapSettings and Skill.Limits.
export const silenceRemovalLimits = {
  minimumPause: { min: 0.25, max: 3.0 },
  speechPadding: { min: 0.0, max: 0.5 },
} as const;

export const captionGapLimits = { maximumGap: { min: 0.0, max: 2.0 } } as const;

export const skillLimits = {
  maximumNameLength: 120,
  maximumDescriptionLength: 500,
  maximumInstructionsLength: 50_000,
} as const;
