import { clipTypeIsVisual, type Clip, type Timeline } from "../model";
import { swiftRound } from "../util/math";

/** Port of `InspectorClipSelection`. */
export interface InspectorClipSelection {
  textClips: Clip[];
  nonTextVisualClips: Clip[];
  audioClips: Clip[];
  firstVisualClip?: Clip;
  firstAudioClip?: Clip;
}

export function inspectorClipCount(s: InspectorClipSelection): number {
  return s.textClips.length + s.nonTextVisualClips.length + s.audioClips.length;
}

export function resolveInspectorSelection(timeline: Timeline, selectedIds: ReadonlySet<string>): InspectorClipSelection {
  const selection: InspectorClipSelection = { textClips: [], nonTextVisualClips: [], audioClips: [] };
  if (selectedIds.size === 0) return selection;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (!selectedIds.has(clip.id)) continue;
      if (clip.mediaType === "audio") {
        selection.firstAudioClip ??= clip;
        selection.audioClips.push(clip);
      }
      else if (clipTypeIsVisual(clip.mediaType)) {
        selection.firstVisualClip ??= clip;
        if (clip.mediaType === "text" && clip.adjustment !== true) selection.textClips.push(clip);
        else selection.nonTextVisualClips.push(clip);
      }
    }
  }
  return selection;
}

export type ClipTab = "text" | "textAnimate" | "video" | "effects" | "audio" | "multicam" | "ai";

export const clipTabTitles: Record<ClipTab, string> = {
  text: "Content",
  textAnimate: "Animate",
  video: "Video",
  effects: "Adjust",
  audio: "Audio",
  multicam: "Multicam",
  ai: "AI Edit",
};

/** First selected visual or audio clip stamped with a group that still exists (`selectedMulticamGroupId`). */
export function selectedMulticamGroupId(selection: InspectorClipSelection, groupExists: (id: string) => boolean): string | undefined {
  for (const clips of [selection.nonTextVisualClips, selection.audioClips]) {
    for (const clip of clips) {
      if (clip.multicamGroupId !== undefined && groupExists(clip.multicamGroupId)) return clip.multicamGroupId;
    }
  }
  return undefined;
}

/**
 * Port of `aiEditEligible`: one visual clip (plus only its linked audio partners) or one lone audio clip,
 * whose media asset resolved.
 */
export function aiEditEligible(
  selection: InspectorClipSelection,
  hasResolvedAsset: boolean,
  linkedPartnerIds: (clipId: string) => readonly string[],
): boolean {
  if (!hasResolvedAsset) return false;
  const visualCount = selection.textClips.length + selection.nonTextVisualClips.length;
  const audios = selection.audioClips;
  if (visualCount === 0) return audios.length === 1;
  const visual = selection.firstVisualClip;
  if (visualCount !== 1 || !visual) return false;
  if (audios.length === 0) return true;
  const partners = new Set(linkedPartnerIds(visual.id));
  return audios.every((c) => partners.has(c.id));
}

/** Tabs for a selection; `aiEdit` appends the AI Edit tab (`availableTabs`' last case). */
export function availableTabs(selection: InspectorClipSelection, multicamGroupId?: string, aiEdit = false): ClipTab[] {
  const tabs: ClipTab[] = [];
  const textOnly = selection.textClips.length > 0 && selection.nonTextVisualClips.length === 0 && selection.audioClips.length === 0;
  if (textOnly) tabs.push("text", "textAnimate");
  if (selection.nonTextVisualClips.length > 0) {
    // Adjustment layers have no transform: only the effect stack applies.
    if (selection.nonTextVisualClips.every((c) => c.adjustment === true)) tabs.push("effects");
    else tabs.push("video", "effects");
  }
  if (selection.audioClips.length > 0) tabs.push("audio");
  if (multicamGroupId !== undefined) tabs.push("multicam");
  if (aiEdit) tabs.push("ai");
  return tabs;
}

export function activeTab(tabs: readonly ClipTab[], preferred: ClipTab): ClipTab | undefined {
  return tabs.includes(preferred) ? preferred : tabs[0];
}

/** Port of `resolvePreferredTab`. */
export function preferredTabAfterSelection(selectedClipTypes: readonly string[], current: ClipTab): ClipTab {
  if (selectedClipTypes.length === 1 && selectedClipTypes[0] === "text") return "text";
  return current === "text" ? "video" : current;
}

/** Port of `AdjustSectionState`. */
export function adjustSectionState(
  effectIds: ReadonlySet<string>,
  clips: readonly Clip[],
  chromaKeySamplingClipId: string | null,
): { hasEffects: boolean; isEnabled: boolean } {
  let hasEffects = false;
  let hasEnabledEffect = false;
  for (const clip of clips) {
    for (const effect of clip.effects ?? []) {
      if (!effectIds.has(effect.type)) continue;
      hasEffects = true;
      hasEnabledEffect = hasEnabledEffect || effect.enabled;
    }
  }
  const sampling = effectIds.has("key.chroma") && clips.some((c) => c.id === chromaKeySamplingClipId);
  return { hasEffects, isEnabled: !hasEffects || hasEnabledEffect || sampling };
}

/** Port of `formatDuration` (h:mm:ss or m:ss). */
export function formatDuration(seconds: number): string {
  const total = swiftRound(seconds);
  const hours = Math.trunc(total / 3600);
  const mins = Math.trunc((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(mins)}:${two(secs)}` : `${mins}:${two(secs)}`;
}

// MARK: - Project settings presets (Project/Settings/ProjectSettingsPresets.swift)

export type AspectRatioErrorCode = "invalidFormat" | "resolutionTooSmall" | "resolutionTooLarge";

export const aspectRatioErrorMessages: Record<AspectRatioErrorCode, string> = {
  invalidFormat: "Use an aspect ratio with two positive numbers, such as 3:2.",
  resolutionTooSmall: "Resolution must be at least 2 × 2 pixels.",
  resolutionTooLarge: "Resolution must not exceed 8192 pixels on either edge.",
};

export type Resolution = { width: number; height: number };

/** `CanvasAspectRatio(text).resolution(shortEdge:)`. */
export function resolutionForAspectText(text: string, shortEdge: number): { ok: true; value: Resolution } | { ok: false; code: AspectRatioErrorCode } {
  const parts = text.split(":");
  const num = (s: string | undefined): number => (s !== undefined && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s) ? Number(s) : Number.NaN);
  const horizontal = num(parts[0]);
  const vertical = num(parts[1]);
  if (parts.length !== 2 || !(Number.isFinite(horizontal) && Number.isFinite(vertical) && horizontal > 0 && vertical > 0 && Number.isFinite(horizontal / vertical))) {
    return { ok: false, code: "invalidFormat" };
  }
  if (shortEdge < 2) return { ok: false, code: "resolutionTooSmall" };
  const ratio = horizontal / vertical;
  const short = shortEdge % 2 === 0 ? shortEdge : shortEdge + 1;
  const longValue = short * Math.max(ratio, 1 / ratio);
  if (longValue > 8192) return { ok: false, code: "resolutionTooLarge" };
  const long = swiftRound(longValue / 2) * 2;
  return { ok: true, value: ratio >= 1 ? { width: long, height: short } : { width: short, height: long } };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** `CanvasAspectRatio.displayLabel(width:height:)`. */
export function aspectDisplayLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "—";
  const g = gcd(width, height);
  const rw = Math.trunc(width / g);
  const rh = Math.trunc(height / g);
  if (Math.max(rw, rh) <= 100) return `${rw}:${rh}`;
  const ratio = width / height;
  return ratio >= 1 ? `${swiftRound(ratio * 100) / 100}:1` : `1:${swiftRound((1 / ratio) * 100) / 100}`;
}

export const aspectPresets: readonly { label: string; width: number; height: number }[] = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:14", width: 1080, height: 1680 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:3", width: 1440, height: 1080 },
  { label: "2.4:1", width: 2592, height: 1080 },
];

export const qualityPresets: readonly { label: string; shortEdge: number }[] = [
  { label: "720p", shortEdge: 720 },
  { label: "1080p", shortEdge: 1080 },
  { label: "2K", shortEdge: 1440 },
  { label: "4K", shortEdge: 2160 },
];

export function qualityResolution(shortEdge: number, currentWidth: number, currentHeight: number): Resolution {
  if (currentWidth <= currentHeight) return { width: shortEdge, height: Math.trunc((shortEdge * currentHeight) / currentWidth) };
  return { width: Math.trunc((shortEdge * currentWidth) / currentHeight), height: shortEdge };
}

/** Swift offers 24/25/30/50/60; 12, 15, 48 and 120 are extra integer rates. */
export const frameRatePresets: readonly number[] = [12, 15, 24, 25, 30, 48, 50, 60, 120];
