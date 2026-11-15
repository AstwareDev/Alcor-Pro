import { clipFadeInterpolation, clipInterpolation, type AnimatableProperty, type Interpolation } from "../../model";
import { addAdjustmentLayer } from "../../editor/mutations/adjustmentLayer";
import { canPasteClips, copySelectedClipsToClipboard, pasteClips } from "../../editor/mutations/clipboard";
import { compatibleClipSettingsTargets, copiedClipSettings, pasteClipSettingsFromClipboard } from "../../editor/mutations/clipSettings";
import { removeKeyframe, setFadeInterpolation, setInterpolation } from "../../editor/mutations/keyframes";
import { canLinkSelected, canUnlinkSelected, expandToLinkGroup, linkClips, unlinkClips } from "../../editor/mutations/linking";
import { rippleDelete, rippleDeleteGapRefusal } from "../../editor/mutations/ripple";
import { selectForward } from "../../editor/mutations/selection";
import { activateTimeline } from "../../editor/mutations/timelines";
import { clearTimelineRange, timelineRangeContains, validSelectedTimelineRange } from "../../editor/mutations/timelineRange";
import { selectAllClips } from "../../editor/mutations/tracks";
import { menuSections, type ContextMenuItem } from "../../ui/ContextMenu";
import { clipRectFor, frameAt, rowLocationAt, trackAt } from "../timelineGeometry";
import { keyframeLaneHit } from "../timelineInput";
import { openCurveEditor } from "../../curveEditor/CurveEditorPopover";
import { deadAirClickMenu } from "../../deadair/menu";
import { switchAngleInRangeItem } from "./multicamMenus";
import type { TimelineInputController, TimelinePointer } from "./inputController";

// The Swift context menus of TimelineView.menu(for:) and TimelineHeaderView.menu(for:).
// Not ported (features absent in this port): Add to Chat / AI Edit, Swap Media,
// Save as Media / Audio, Synchronize, Detect / Mark Beats, multicam Switch Angle / Layout / Ungroup,
// Create AI Transition, Add Range to Chat, Save Range as Media.

/** Extension point: features that add clip-menu sections (AI, sync, multicam) register a provider here. */
export const clipMenuSectionProviders: ((clipId: string) => ContextMenuItem[])[] = [];

const item = (label: string, onSelect: () => void, extra: Partial<Extract<ContextMenuItem, { kind: "item" }>> = {}): ContextMenuItem => ({
  kind: "item",
  label,
  onSelect,
  ...extra,
});

function keyframeMenu(c: TimelineInputController, clipId: string, property: AnimatableProperty, frame: number): ContextMenuItem[] {
  const editor = c.editor;
  const clip = editor.clipFor(clipId);
  const current: Interpolation = (clip && clipInterpolation(clip, property, frame)) ?? "smooth";
  const choices: [Interpolation, string][] = [
    ["linear", "Linear"],
    ["hold", "Hold"],
    ["smooth", "Smooth"],
    ["easeIn", "Ease in"],
    ["easeOut", "Ease out"],
    ["easeInOut", "Ease in and out"],
  ];
  return menuSections(
    [
      ...choices.map(([interp, label]) => item(label, () => setInterpolation(editor, clipId, property, frame, interp), { checked: current === interp })),
      item("Custom curve…", () => openCurveEditor(editor, { clipId, property, frame }), { checked: current === "bezier" }),
    ],
    [item("Delete Keyframe", () => removeKeyframe(editor, clipId, property, frame))],
  );
}

function rangeItems(c: TimelineInputController): ContextMenuItem[] {
  const switchAngle = switchAngleInRangeItem(c.editor);
  return [...(switchAngle ? [switchAngle] : []), item("Clear Range", () => clearTimelineRange(c.editor))];
}

/** Menu for a right-click at `p`, or undefined when the Swift view shows none. May change the selection like Swift. */
export function timelineContextMenu(c: TimelineInputController, p: TimelinePointer): ContextMenuItem[] | undefined {
  const editor = c.editor;
  const geometry = c.host.geometry();
  const point = { x: p.x + c.host.scrollX(), y: p.y + c.host.scrollY() };
  const row = rowLocationAt(geometry, point.y);
  if (row?.kind === "keyframeLane") {
    const hit = keyframeLaneHit(editor.timeline, editor.ui.selectedClipIds, point, row.trackIndex, row.property, geometry);
    return hit ? keyframeMenu(c, hit.clipId, row.property, hit.frame) : undefined;
  }
  const trackIndex = trackAt(geometry, point.y);
  const clickFrame = Math.max(0, frameAt(geometry, point.x));
  const range = validSelectedTimelineRange(editor);
  const clickedRange = range !== null && timelineRangeContains(range, clickFrame);
  const hit = c.hitTestClip(point, trackIndex, geometry);

  if (!hit) {
    const items: ContextMenuItem[] = [];
    if (canPasteClips(editor) && editor.timeline.tracks[trackIndex]) items.push(item("Paste", () => pasteClips(editor, trackIndex, clickFrame)));
    const gap = c.hitTestGap(point, trackIndex, geometry);
    if (gap) {
      const refusal = rippleDeleteGapRefusal(editor, gap);
      items.push(item("Ripple Delete Gap", () => rippleDelete(editor, gap), { disabled: refusal !== null, tooltip: refusal ?? undefined }));
    }
    items.push(item("New Adjustment Layer", () => addAdjustmentLayer(editor, { startFrame: clickFrame })));
    const all = clickedRange ? menuSections(items, rangeItems(c)) : items;
    return all.length > 0 ? all : undefined;
  }

  const clip = editor.timeline.tracks[hit.trackIndex].clips[hit.clipIndex];
  const rect = clipRectFor(geometry, clip, hit.trackIndex);
  const fadeEdge = c.fadeKneeHit(point, clip, rect);
  if (fadeEdge) {
    const current = clipFadeInterpolation(clip, fadeEdge);
    return (["linear", "smooth"] as const).map((interp) =>
      item(interp === "linear" ? "Linear" : "Smooth", () => setFadeInterpolation(editor, clip.id, fadeEdge, interp), { checked: current === interp }),
    );
  }
  if (clip.mediaType === "audio") {
    const kfFrame = c.audioVolumeKfHit(point, clip, rect, hit.trackIndex);
    if (kfFrame !== undefined) return keyframeMenu(c, clip.id, "volume", kfFrame);
    const deadAir = deadAirClickMenu(editor, clip, clickFrame);
    if (deadAir) return deadAir;
  }

  if (!editor.ui.selectedClipIds.has(clip.id)) {
    editor.ui.selectedClipIds = expandToLinkGroup(editor, new Set([clip.id]));
    c.host.invalidate();
  }
  const selected = editor.ui.selectedClipIds;
  const targetClipIds = editor.timeline.tracks.flatMap((t) => t.clips).filter((x) => selected.has(x.id)).map((x) => x.id);

  const timelineItems: ContextMenuItem[] = [
    item("Select Forward on Track", () => selectForward(editor, clip.id, "track")),
    item("Select Forward on All Tracks", () => selectForward(editor, clip.id, "allTracks")),
    item("Copy", () => copySelectedClipsToClipboard(editor)),
  ];
  if (canPasteClips(editor)) timelineItems.push(item("Paste", () => pasteClips(editor, hit.trackIndex, clickFrame)));
  const snapshot = copiedClipSettings(editor, clip.mediaType);
  if (snapshot) {
    const targets = compatibleClipSettingsTargets(editor, targetClipIds, snapshot);
    if (targets.length > 0) timelineItems.push(item("Paste Settings", () => pasteClipSettingsFromClipboard(editor, targets)));
  }
  if (canLinkSelected(editor)) timelineItems.push(item("Link", () => linkClips(editor, editor.ui.selectedClipIds)));
  if (canUnlinkSelected(editor)) timelineItems.push(item("Unlink", () => unlinkClips(editor, editor.ui.selectedClipIds)));

  const nestItems: ContextMenuItem[] =
    clip.sourceClipType === "sequence" ? [item("Open Timeline", () => activateTimeline(editor, clip.mediaRef))] : [];

  const menu = menuSections(timelineItems, ...clipMenuSectionProviders.map((provide) => provide(clip.id)), nestItems);
  const all = clickedRange ? menuSections(menu, rangeItems(c)) : menu;
  return all.length > 0 ? all : undefined;
}

export function trackHeaderContextMenu(
  c: TimelineInputController,
  trackIndex: number,
  canRename: boolean,
  beginRename: (trackId: string) => void,
): ContextMenuItem[] | undefined {
  const editor = c.editor;
  const track = editor.timeline.tracks[trackIndex];
  if (!track) return undefined;
  return menuSections(
    [item("Rename Track", () => beginRename(track.id), { disabled: !canRename })],
    [item("Select All Clips on Track", () => selectAllClips(editor, track.id), { disabled: track.clips.length === 0 })],
  );
}
