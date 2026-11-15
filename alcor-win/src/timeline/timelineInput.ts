// Pure helpers extracted from TimelineInputController / TimelineView and the EditorViewModel
// extensions they call (zoom, selection, track labels, keyframe-lane hit testing). No event handling here.
import {
  TimelineAutoScroll,
  Zoom,
  clipContainsTimelineFrame,
  clipKeyframeFrames,
  clipSupportsKeyframes,
  clipTypeTrackLabelPrefix,
  timelineDisplayFrames,
  type AnimatableProperty,
  type Clip,
  type Point,
  type Timeline,
} from "../model";
import {
  laneRect,
  rectContains,
  timelineKeyframeHitSize,
  xForFrame,
  type TimelineGeometry,
} from "./timelineGeometry";

// MARK: - Zoom

/** Minimum zoom scale that fits the entire timeline with end padding (EditorViewModel.minZoomScale). */
export function minZoomScale(timeline: Timeline, timelineVisibleWidth: number): number {
  const totalFrames = timelineDisplayFrames(timeline);
  if (!(totalFrames > 0) || !(timelineVisibleWidth > 0)) return Zoom.min;
  const fitAll = timelineVisibleWidth / (totalFrames * Zoom.fitAllBuffer);
  return Math.min(Zoom.max, Math.max(Zoom.floor, fitAll));
}

/**
 * Cursor-anchored zoom (TimelineInputController.applyZoom). Returns undefined when the scale does not change.
 * `scrollX` is the new horizontal scroll origin that keeps the frame under the cursor in place.
 */
export function zoomAnchored(p: {
  zoomScale: number;
  minZoomScale: number;
  factor: number;
  anchorDocX: number;
  scrollOriginX: number;
}): { newScale: number; scrollX: number } | undefined {
  const anchorViewportX = p.anchorDocX - p.scrollOriginX;
  const frameUnderCursor = Math.max(0.0, p.anchorDocX / p.zoomScale);
  const newScale = Math.max(p.minZoomScale, Math.min(Zoom.max, p.zoomScale * p.factor));
  if (newScale === p.zoomScale) return undefined;
  return { newScale, scrollX: Math.max(0, frameUnderCursor * newScale - anchorViewportX) };
}

/** New scroll X after a toolbar zoom change, keeping the playhead in place (TimelineView.applyPlayheadAnchoredScroll). */
export function playheadAnchoredScrollX(p: {
  previousZoom: number;
  zoomScale: number;
  activeFrame: number;
  originX: number;
  visibleWidth: number;
}): number | undefined {
  if (!(p.visibleWidth > 0)) return undefined;
  const playheadPrevX = p.activeFrame * p.previousZoom;
  const anchorViewportX =
    playheadPrevX >= p.originX && playheadPrevX <= p.originX + p.visibleWidth
      ? playheadPrevX - p.originX
      : p.visibleWidth * 0.5;
  const newScrollX = Math.max(0, p.activeFrame * p.zoomScale - anchorViewportX);
  return newScrollX !== p.originX ? newScrollX : undefined;
}

export function horizontalAutoScrollStep(distance: number, zone: number): number {
  const progress = Math.min(1, Math.max(0, distance / zone));
  return TimelineAutoScroll.minStep + (TimelineAutoScroll.maxStep - TimelineAutoScroll.minStep) * progress;
}

// MARK: - Selection

export type SelectForwardScope = "track" | "allTracks";

/** EditorViewModel.expandToLinkGroup: every clip id sharing a link group with any id in `ids`, including the inputs. */
export function expandToLinkGroup(timeline: Timeline, ids: ReadonlySet<string>): Set<string> {
  const index = new Map<string, string[]>();
  const clipToGroup = new Map<string, string>();
  for (const t of timeline.tracks) {
    for (const c of t.clips) {
      if (c.linkGroupId !== undefined) {
        const members = index.get(c.linkGroupId);
        if (members) members.push(c.id);
        else index.set(c.linkGroupId, [c.id]);
        clipToGroup.set(c.id, c.linkGroupId);
      }
    }
  }
  const groups = new Set<string>();
  for (const id of ids) {
    const g = clipToGroup.get(id);
    if (g !== undefined) groups.add(g);
  }
  const result = new Set(ids);
  if (groups.size === 0) return result;
  for (const g of groups) for (const m of index.get(g) ?? []) result.add(m);
  return result;
}

/** The clip ids `selectForward(from:scope:)` selects (link-expanded), or null when the anchor is missing. */
export function selectForwardIds(timeline: Timeline, clipId: string, scope: SelectForwardScope): Set<string> | null {
  let anchorTrack = -1;
  let anchorClip: Clip | undefined;
  for (let t = 0; t < timeline.tracks.length && !anchorClip; t++) {
    anchorClip = (timeline.tracks[t] as { clips: Clip[] }).clips.find((x) => x.id === clipId);
    if (anchorClip) anchorTrack = t;
  }
  if (!anchorClip) return null;
  const startFrame = anchorClip.startFrame;
  const ids = new Set<string>();
  timeline.tracks.forEach((track, trackIndex) => {
    if (scope !== "allTracks" && trackIndex !== anchorTrack) return;
    for (const clip of track.clips) if (clip.startFrame >= startFrame) ids.add(clip.id);
  });
  return expandToLinkGroup(timeline, ids);
}

/** Earliest selected clip (ties broken by lower track index), as `forwardSelectionAnchorId`. */
export function forwardSelectionAnchorId(timeline: Timeline, selectedClipIds: ReadonlySet<string>): string | undefined {
  const picked: { trackIndex: number; clip: Clip }[] = [];
  timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) if (selectedClipIds.has(clip.id)) picked.push({ trackIndex, clip });
  });
  picked.sort((a, b) =>
    a.clip.startFrame === b.clip.startFrame ? a.trackIndex - b.trackIndex : a.clip.startFrame - b.clip.startFrame,
  );
  return picked[0]?.clip.id;
}

export function selectForwardFromCurrentSelection(
  timeline: Timeline,
  selectedClipIds: ReadonlySet<string>,
  scope: SelectForwardScope,
): Set<string> | null {
  const anchorId = forwardSelectionAnchorId(timeline, selectedClipIds);
  return anchorId === undefined ? null : selectForwardIds(timeline, anchorId, scope);
}

/** Ids `selectAllClips(onTrack:)` selects, or null when the track is missing or empty (selection must stay untouched). */
export function trackClipIds(timeline: Timeline, trackId: string): Set<string> | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track || track.clips.length === 0) return null;
  return new Set(track.clips.map((c) => c.id));
}

// MARK: - Track labels

/** "V1", "A1", "T1" label for the track at the given index. */
export function timelineTrackDisplayLabel(timeline: Timeline, trackIndex: number): string {
  const tracks = timeline.tracks;
  const track = tracks[trackIndex];
  if (!track) return "";
  const type = track.type;
  let n = 0;
  if (type === "audio") {
    for (let i = 0; i <= trackIndex; i++) if ((tracks[i] as { type: string }).type === type) n++;
  } else {
    const firstAudio = tracks.findIndex((t) => t.type === "audio");
    const end = Math.max(trackIndex + 1, firstAudio < 0 ? tracks.length : firstAudio);
    for (let i = trackIndex; i < end; i++) if ((tracks[i] as { type: string }).type === type) n++;
  }
  return `${clipTypeTrackLabelPrefix(type)}${n}`;
}

// MARK: - Keyframe lanes

export interface KeyframeLaneNavigationTarget {
  clipId: string;
  frame: number;
}

export interface KeyframeLaneHit {
  clipId: string;
  frame: number;
}

export function keyframeLaneTarget(
  timeline: Timeline,
  trackId: string,
  property: AnimatableProperty,
  frame: number,
): Clip | undefined {
  const track = timeline.tracks.find((t) => t.id === trackId);
  return track?.clips.find((c) => clipContainsTimelineFrame(c, frame) && clipSupportsKeyframes(c, property));
}

export function keyframeLaneNavigationList(
  timeline: Timeline,
  trackId: string,
  property: AnimatableProperty,
): KeyframeLaneNavigationTarget[] {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const targets: KeyframeLaneNavigationTarget[] = [];
  for (const clip of track.clips) {
    if (!clipSupportsKeyframes(clip, property)) continue;
    for (const frame of clipKeyframeFrames(clip, property)) targets.push({ clipId: clip.id, frame });
  }
  targets.sort((a, b) => (a.frame === b.frame ? (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0) : a.frame - b.frame));
  return targets;
}

function firstNavigationIndex(targets: readonly KeyframeLaneNavigationTarget[], frame: number, strictlyAfter: boolean): number {
  let lower = 0;
  let upper = targets.length;
  while (lower < upper) {
    const middle = Math.trunc((lower + upper) / 2);
    const t = targets[middle] as KeyframeLaneNavigationTarget;
    const advances = strictlyAfter ? t.frame <= frame : t.frame < frame;
    if (advances) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

/** Uncached version of `keyframeLaneNavigationTargets`; callers may memoise per timeline revision. */
export function keyframeLaneNavigationTargets(
  timeline: Timeline,
  trackId: string,
  property: AnimatableProperty,
  around: number,
): { previous: KeyframeLaneNavigationTarget | undefined; next: KeyframeLaneNavigationTarget | undefined } {
  const targets = keyframeLaneNavigationList(timeline, trackId, property);
  return {
    previous: targets[firstNavigationIndex(targets, around, false) - 1],
    next: targets[firstNavigationIndex(targets, around, true)],
  };
}

/** TimelineInputController.keyframeLaneHit: nearest keyframe diamond under `point` in a lane, selected clips win ties. */
export function keyframeLaneHit(
  timeline: Timeline,
  selectedClipIds: ReadonlySet<string>,
  point: Point,
  trackIndex: number,
  property: AnimatableProperty,
  geometry: TimelineGeometry,
): KeyframeLaneHit | undefined {
  const track = timeline.tracks[trackIndex];
  const lane = track ? laneRect(geometry, trackIndex, property) : undefined;
  if (!track || !lane || !rectContains(lane, point)) return undefined;
  const hitHalf = timelineKeyframeHitSize / 2;
  let best: { hit: KeyframeLaneHit; distance: number; selected: boolean } | undefined;
  for (const clip of track.clips) {
    if (!clipSupportsKeyframes(clip, property)) continue;
    for (const frame of clipKeyframeFrames(clip, property)) {
      const distance = Math.abs(xForFrame(geometry, frame) - point.x);
      if (distance > hitHalf) continue;
      const selected = selectedClipIds.has(clip.id);
      if (best && (best.distance < distance || (best.distance === distance && best.selected && !selected))) continue;
      best = { hit: { clipId: clip.id, frame }, distance, selected };
    }
  }
  return best?.hit;
}
