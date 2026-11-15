import type { Editor } from "../../editor/editor";
import { makeAgentActivityHighlight, showAgentChanges, type AgentActivityHighlight } from "../../editor/mutations/agentActivity";
import { timelineTotalFrames, type Clip, type Timeline, type Track } from "../../model";
import { deepEqual } from "../../editor/mutations/core";
import { ToolError, argInt, argString } from "./toolArgs";
import type { ToolArgs } from "./toolRegistry";

// Port of ToolExecutor+AgentActivity.swift. Which tools publish changes is declared per registration
// (`publishesTimelineChanges`); this file maps tool calls and timeline diffs onto editor highlights.

// MARK: - Change highlights

interface LocatedClip {
  trackId: string;
  clip: Clip;
}

function locatedClips(timeline: Timeline): Map<string, LocatedClip> {
  const result = new Map<string, LocatedClip>();
  for (const track of timeline.tracks) for (const clip of track.clips) result.set(clip.id, { trackId: track.id, clip });
  return result;
}

function changedTrackIds(before: Timeline, after: Timeline): Set<string> {
  const beforeTracks = new Map<string, Track>();
  for (const t of before.tracks) if (!beforeTracks.has(t.id)) beforeTracks.set(t.id, t);
  const afterTracks = new Map<string, Track>();
  for (const t of after.tracks) if (!afterTracks.has(t.id)) afterTracks.set(t.id, t);
  const surviving = new Set([...beforeTracks.keys()].filter((id) => afterTracks.has(id)));
  const changed = new Set<string>();
  for (const id of surviving) {
    const previous = beforeTracks.get(id);
    const current = afterTracks.get(id);
    if (!previous || !current) continue;
    if (
      previous.name !== current.name || previous.muted !== current.muted ||
      previous.hidden !== current.hidden || previous.syncLocked !== current.syncLocked
    ) {
      changed.add(id);
    }
  }
  // Ignore index shifts caused only by insertion or removal.
  const beforeOrder = before.tracks.map((t) => t.id).filter((id) => surviving.has(id));
  const afterOrder = after.tracks.map((t) => t.id).filter((id) => surviving.has(id));
  beforeOrder.forEach((previous, i) => {
    const current = afterOrder[i];
    if (current !== undefined && previous !== current) changed.add(current);
  });
  return changed;
}

export function publishAgentChanges(before: Timeline, after: Timeline, editor: Editor): void {
  const beforeClips = locatedClips(before);
  const afterClips = locatedClips(after);
  const addedClipIds = new Set([...afterClips.keys()].filter((id) => !beforeClips.has(id)));
  const mutatedClipIds = new Set<string>();
  for (const [id, previous] of beforeClips) {
    const current = afterClips.get(id);
    if (current && !(current.trackId === previous.trackId && deepEqual(current.clip, previous.clip))) mutatedClipIds.add(id);
  }
  showAgentChanges(editor, { addedClipIds, mutatedClipIds, mutatedTrackIds: changedTrackIds(before, after) });
}

// MARK: - Read highlights

/** `frameWindow(args)`: the half-open frame window a read tool asked for, if any. */
export function frameWindow(args: ToolArgs): { start: number; end: number } | undefined {
  const start = argInt(args, "startFrame");
  const rawEnd = argInt(args, "endFrame");
  const end = rawEnd === 0 ? undefined : rawEnd;
  if (end === undefined && (start === undefined || start === 0)) return undefined;
  const s = start ?? 0;
  const e = end ?? Number.MAX_SAFE_INTEGER;
  if (!(s < e)) throw new ToolError(`Invalid window [${s}, ${end === undefined ? "9223372036854775807" : e}): startFrame must be less than endFrame`);
  return { start: s, end: e };
}

function clampedTimelineReadRange(start: number, end: number, editor: Editor): { start: number; end: number } | undefined {
  const lower = Math.max(0, start);
  const upper = Math.min(timelineTotalFrames(editor.timeline), end);
  return lower < upper ? { start: lower, end: upper } : undefined;
}

function timelineReadWindow(args: ToolArgs, editor: Editor): { start: number; end: number } | undefined {
  let window: { start: number; end: number } | undefined;
  try {
    window = frameWindow(args);
  } catch {
    return undefined;
  }
  if (!window) return undefined;
  const end = window.end === Number.MAX_SAFE_INTEGER ? timelineTotalFrames(editor.timeline) : window.end;
  return clampedTimelineReadRange(window.start, end, editor);
}

export function timelineReadActivity(tool: string, args: ToolArgs, editor: Editor): AgentActivityHighlight | undefined {
  const readClipIds = new Set<string>();
  let range: { start: number; end: number } | undefined;
  switch (tool) {
    case "inspect_media":
    case "inspect_color": {
      const clipId = argString(args, "clipId");
      if (clipId !== undefined) readClipIds.add(clipId);
      break;
    }
    case "get_transcript":
    case "get_multicam": {
      const clipId = argString(args, "clipId");
      if (clipId !== undefined) readClipIds.add(clipId);
      range = timelineReadWindow(args, editor);
      break;
    }
    case "inspect_timeline": {
      const start = Math.max(0, argInt(args, "startFrame") ?? 0);
      const rawEnd = argInt(args, "endFrame");
      const end = rawEnd !== undefined && rawEnd > start ? rawEnd : start + 1;
      range = clampedTimelineReadRange(start, end, editor);
      break;
    }
    case "get_timeline":
      range = timelineReadWindow(args, editor);
      break;
    case "capture_frame": {
      const frame = argInt(args, "timelineFrame");
      if (frame !== undefined && frame >= 0) range = clampedTimelineReadRange(frame, frame + 1, editor);
      break;
    }
    default:
      return undefined;
  }
  const existing = new Set([...readClipIds].filter((id) => editor.findClip(id) !== null));
  if (existing.size === 0 && range === undefined) return undefined;
  return makeAgentActivityHighlight({ readClipIds: existing, ...(range ? { range } : {}) });
}
