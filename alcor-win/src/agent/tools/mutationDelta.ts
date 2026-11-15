import type { Editor } from "../../editor/editor";
import { deepEqual } from "../../editor/mutations/core";
import { timelineTrackDisplayLabel } from "../../editor/mutations/tracks";
import type { TimelineMarker } from "../../model";
import { snapshot as detach } from "../../util/snapshot";
import { jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { compactTracks, focusedRawTracks, timelineMarkerDict, type Json } from "./timelinePayload";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+MutationDelta.swift. Clip mutations return timeline diffs using get_timeline format,
// showing changed, shifted, or removed clips.

interface ClipPlacement {
  trackId: string;
  index: number;
  start: number;
  duration: number;
}

export interface TimelineSnapshot {
  placements: Map<string, ClipPlacement>;
  trackIds: string[];
  markers: Map<string, TimelineMarker>;
}

const mutationClipLimit = 30;
const shiftGroupMinimum = 3;

function samePlace(a: ClipPlacement, b: ClipPlacement): boolean {
  return a.trackId === b.trackId && a.start === b.start && a.duration === b.duration;
}

export function timelineSnapshot(editor: Editor): TimelineSnapshot {
  const placements = new Map<string, ClipPlacement>();
  editor.timeline.tracks.forEach((track, i) => {
    for (const clip of track.clips) placements.set(clip.id, { trackId: track.id, index: i, start: clip.startFrame, duration: clip.durationFrames });
  });
  return {
    placements,
    trackIds: editor.timeline.tracks.map((t) => t.id),
    markers: new Map(editor.timeline.markers.map((m) => [m.id, detach(m)])),
  };
}

export interface MutationResultOptions {
  touched?: readonly string[];
  extra?: Json;
  notes?: readonly string[];
}

export function mutationResult(editor: Editor, since: TimelineSnapshot, options: MutationResultOptions = {}): ToolResult {
  const after = timelineSnapshot(editor);
  const notes = [...(options.notes ?? [])];

  const changed = new Set((options.touched ?? []).filter((id) => after.placements.has(id)));
  for (const id of after.placements.keys()) if (!since.placements.has(id)) changed.add(id);
  const pureShifts = new Map<string, { from: number; delta: number }>();
  for (const [id, p] of after.placements) {
    const b = since.placements.get(id);
    if (!b || samePlace(b, p) || changed.has(id)) continue;
    if (b.trackId === p.trackId && b.duration === p.duration) pureShifts.set(id, { from: b.start, delta: p.start - b.start });
    else changed.add(id);
  }

  // Uniform moves compress to rules; tiny groups enumerate instead.
  const shifts: { track: number; fromFrame: number; by: number; count: number }[] = [];
  const grouped = new Map<string, string[]>();
  for (const id of pureShifts.keys()) {
    const key = `${after.placements.get(id)?.index}|${pureShifts.get(id)?.delta}`;
    grouped.set(key, [...(grouped.get(key) ?? []), id]);
  }
  for (const ids of grouped.values()) {
    if (ids.length >= shiftGroupMinimum) {
      const first = pureShifts.get(ids[0]);
      if (!first) continue;
      shifts.push({
        track: after.placements.get(ids[0])?.index ?? 0,
        fromFrame: Math.min(...ids.map((id) => pureShifts.get(id)?.from ?? first.from)),
        by: first.delta,
        count: ids.length,
      });
    } else {
      for (const id of ids) changed.add(id);
    }
  }
  shifts.sort((a, b) => a.track - b.track || a.fromFrame - b.fromFrame);

  const payload: Json = { ...(options.extra ?? {}) };
  const captionGroups = collapseCaptionGroups(editor, changed);
  if (captionGroups.length > 0) payload.captionGroups = captionGroups;
  let clips = readShapedClips(editor, changed);
  if (clips.length > mutationClipLimit) {
    payload.clipsNote = `Showing ${mutationClipLimit} of ${clips.length} changed clips — re-read get_timeline for the rest.`;
    clips = clips.slice(0, mutationClipLimit);
  }
  if (clips.length > 0) payload.clips = clips;
  if (shifts.length > 0) payload.shifted = shifts;

  const removedIds = [...since.placements.keys()].filter((id) => !after.placements.has(id)).sort();
  if (removedIds.length > 0) payload.removedClipIds = removedIds;

  const changedMarkers = editor.timeline.markers.filter((m) => !deepEqual(since.markers.get(m.id), m));
  if (changedMarkers.length > 0) payload.markers = changedMarkers.map(timelineMarkerDict);
  const remainingMarkerIds = new Set(editor.timeline.markers.map((m) => m.id));
  const removedMarkerIds = [...since.markers.keys()].filter((id) => !remainingMarkerIds.has(id)).sort();
  if (removedMarkerIds.length > 0) payload.removedMarkerIds = removedMarkerIds;

  const created = after.trackIds
    .map((id, i) => ({ id, i }))
    .filter(({ id }) => !since.trackIds.includes(id))
    .map(({ i }) => ({ index: i, label: timelineTrackDisplayLabel(editor, i), type: editor.timeline.tracks[i].type }));
  if (created.length > 0) payload.createdTracks = created;
  // Track index changes invalidate index-based calls unless new order is included.
  const afterTrackIds = new Set(after.trackIds);
  const trackListChanged =
    since.trackIds.some((id) => !afterTrackIds.has(id)) ||
    after.trackIds.some((id, i) => {
      const was = since.trackIds.indexOf(id);
      return was >= 0 && was !== i;
    });
  if (trackListChanged && payload.tracks === undefined) {
    notes.push("Track indices shifted — re-read get_timeline before the next index-based call.");
  }

  if (notes.length > 0) payload.notes = notes;
  return ok(jsonString(roundJSONFloatingPointNumbers(payload, 3)));
}

/** If 3+ changed clips share a captionGroupId, collapse to one group summary in get_timeline. */
function collapseCaptionGroups(editor: Editor, changed: Set<string>): Json[] {
  const gidByMember = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (!changed.has(clip.id) || clip.captionGroupId === undefined) continue;
      gidByMember.set(clip.id, clip.captionGroupId);
      counts.set(clip.captionGroupId, (counts.get(clip.captionGroupId) ?? 0) + 1);
    }
  }
  const collapsed = new Set([...counts].filter(([, n]) => n >= shiftGroupMinimum).map(([gid]) => gid));
  if (collapsed.size === 0) return [];
  for (const id of [...changed]) {
    const gid = gidByMember.get(id);
    if (gid !== undefined && collapsed.has(gid)) changed.delete(id);
  }

  const out: Json[] = [];
  for (const track of compactTracks(focusedRawTracks(editor, { captionGroupIds: collapsed }), editor, undefined, false)) {
    for (const group of (track.captionGroups as Json[] | undefined) ?? []) {
      const gid = group.captionGroupId;
      if (typeof gid !== "string" || !collapsed.has(gid)) continue;
      out.push({ ...group, track: track.index ?? 0 });
    }
  }
  return out;
}

/** Returns clips in get_timeline shape with track index, folding audio and captions. */
function readShapedClips(editor: Editor, ids: ReadonlySet<string>): Json[] {
  if (ids.size === 0) return [];
  const tracks = compactTracks(focusedRawTracks(editor, { clipIds: ids }), editor, undefined, true);

  const byId = new Map<string, Json>();
  for (const track of tracks) {
    const index = typeof track.index === "number" ? track.index : 0;
    for (const raw of (track.clips as Json[] | undefined) ?? []) {
      const clip: Json = { ...raw, track: index };
      if (typeof clip.id === "string") byId.set(clip.id, clip);
      const audio = clip.audio as Json | undefined;
      if (audio && typeof audio.id === "string") byId.set(audio.id, clip);
    }
    for (const group of (track.captionGroups as Json[] | undefined) ?? []) {
      for (const row of (group.clips as unknown[][] | undefined) ?? []) {
        if (row.length < 4 || typeof row[0] !== "string") continue;
        byId.set(row[0], {
          id: row[0],
          track: index,
          frames: [row[1], row[2]],
          textContent: row[3],
          captionGroupId: group.captionGroupId ?? "",
        });
      }
    }
  }

  // Caption rows are capped per group; echo over-cap clips straight from the model.
  editor.timeline.tracks.forEach((track, index) => {
    for (const clip of track.clips) {
      if (!ids.has(clip.id) || byId.has(clip.id)) continue;
      const entry: Json = { id: clip.id, track: index, frames: [clip.startFrame, clip.startFrame + clip.durationFrames] };
      if (clip.textContent !== undefined) entry.textContent = clip.textContent;
      if (clip.captionGroupId !== undefined) entry.captionGroupId = clip.captionGroupId;
      byId.set(clip.id, entry);
    }
  });

  const seen = new Set<string>();
  return [...ids]
    .flatMap((id) => {
      const c = byId.get(id);
      return c ? [c] : [];
    })
    .filter((c) => {
      const id = typeof c.id === "string" ? c.id : "";
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => {
      const ta = typeof a.track === "number" ? a.track : 0;
      const tb = typeof b.track === "number" ? b.track : 0;
      const fa = Array.isArray(a.frames) ? Number(a.frames[0]) : 0;
      const fb = Array.isArray(b.frames) ? Number(b.frames[0]) : 0;
      return ta - tb || fa - fb;
    });
}
