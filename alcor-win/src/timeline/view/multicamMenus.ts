import type { Editor } from "../../editor/editor";
import { editorSyncServices } from "../../audio/sourceTiming";
import {
  applyMulticamLayout, multicamAudioBearers, switchMulticamRange, switchMulticamSegment, ungroupMulticam,
} from "../../editor/mutations/multicam";
import { multicamGroupById, multicamGroupOf } from "../../editor/mutations/multicamRules";
import { syncClips, syncSelection, synchronizeSummary, type SyncMode } from "../../editor/mutations/sync";
import { validSelectedTimelineRange } from "../../editor/mutations/timelineRange";
import { clipEndFrame, multicamAngles, videoLayoutDisplayName, videoLayouts } from "../../model";
import type { ContextMenuItem } from "../../ui/ContextMenu";

// The Synchronize / multicam sections of TimelineView.menu(for:) and TimelineView+SyncMenu.swift.
// Register with `clipMenuSectionProviders.push(...multicamClipMenuProviders(editor))` (contextMenus.ts).

const item = (label: string, onSelect: () => void, extra: Partial<Extract<ContextMenuItem, { kind: "item" }>> = {}): ContextMenuItem => ({
  kind: "item",
  label,
  onSelect,
  ...extra,
});

let synchronizing = false;

/** `performSynchronize`: runs the selection sync and reports the outcome in a toast. */
export async function synchronizeSelection(editor: Editor, referenceClipId: string, targetClipIds: readonly string[], mode: SyncMode): Promise<void> {
  if (synchronizing || targetClipIds.length === 0) return;
  synchronizing = true;
  editor.showToast("Synchronizing…");
  try {
    const report = await syncClips(editor, editorSyncServices(editor), { referenceClipId, targetClipIds, mode });
    editor.showToast(synchronizeSummary(report), report.synced.length === 0 ? "error" : "info");
  } catch (e) {
    editor.showToast(e instanceof Error ? e.message : "Couldn't synchronize.", "error");
  } finally {
    synchronizing = false;
  }
}

/** "Synchronize" submenu when the selection holds a reference plus at least one other unit. */
export function syncMenuSection(editor: Editor): ContextMenuItem[] {
  const pair = syncSelection(editor);
  if (!pair) return [];
  const modes: [string, SyncMode][] = [["Auto", "auto"], ["Audio", "audio"], ["Timecode", "timecode"]];
  return [
    item("Synchronize", () => undefined, {
      submenu: modes.map(([title, mode]) => item(title, () => void synchronizeSelection(editor, pair.referenceClipId, pair.targetClipIds, mode))),
    }),
  ];
}

/** Switch Angle / Switch Mic, Layout and Ungroup Multicam for a stamped clip. */
export function multicamMenuSection(editor: Editor, clipId: string): ContextMenuItem[] {
  const clip = editor.clipFor(clipId);
  const group = clip ? multicamGroupOf(editor, clip) : undefined;
  if (!clip || !group) return [];
  const items: ContextMenuItem[] = [];

  const audio = clip.mediaType === "audio";
  const members = audio ? multicamAudioBearers(editor, group) : multicamAngles(group);
  if (members.some((m) => m.mediaRef !== clip.mediaRef)) {
    items.push(
      item(audio ? "Switch Mic" : "Switch Angle", () => undefined, {
        submenu: members.map((m) => item(m.angleLabel, () => switchMulticamSegment(editor, clip.id, m.angleLabel), { checked: m.mediaRef === clip.mediaRef })),
      }),
    );
  }
  if (!audio && multicamAngles(group).length >= 2) {
    const submenu: ContextMenuItem[] = [];
    for (const layout of videoLayouts) {
      submenu.push(item(videoLayoutDisplayName(layout), () => applyMulticamLayout(editor, clip.id, layout)));
      if (layout === "full") submenu.push({ kind: "divider" });
    }
    items.push(item("Layout", () => undefined, { submenu }));
  }
  items.push(item("Ungroup Multicam", () => ungroupMulticam(editor, group.id)));
  return items;
}

/** "Switch Angle in Range" for the range section of the menu: only when the range touches exactly one group. */
export function switchAngleInRangeItem(editor: Editor): ContextMenuItem | undefined {
  const range = validSelectedTimelineRange(editor);
  if (!range) return undefined;
  const groupIds = new Set<string>();
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.multicamGroupId !== undefined && clip.startFrame < range.endFrame && clipEndFrame(clip) > range.startFrame) groupIds.add(clip.multicamGroupId);
    }
  }
  const groupId = groupIds.size === 1 ? [...groupIds][0] : undefined;
  const group = groupId === undefined ? undefined : multicamGroupById(editor, groupId);
  const angles = group ? multicamAngles(group) : [];
  if (!group || angles.length === 0) return undefined;
  return item("Switch Angle in Range", () => undefined, {
    submenu: angles.map((m) =>
      item(m.angleLabel, () => switchMulticamRange(editor, group.id, { lowerBound: range.startFrame, upperBound: range.endFrame }, m.angleLabel)),
    ),
  });
}

/** Providers for `clipMenuSectionProviders`, in the Swift section order (sync, then multicam). */
export function multicamClipMenuProviders(editor: Editor): ((clipId: string) => ContextMenuItem[])[] {
  return [() => syncMenuSection(editor), (clipId) => multicamMenuSection(editor, clipId)];
}
