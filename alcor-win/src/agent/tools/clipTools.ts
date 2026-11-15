import type { Editor } from "../../editor/editor";
import { clearRegion, moveClips, removeClips, splitClips } from "../../editor/mutations/clipMutations";
import { nestBlockReason, placeClip, timelineFor } from "../../editor/mutations/core";
import { expandToLinkGroup, linkClips, linkTargets, partnerMoves, unlinkClips, unlinkTargets } from "../../editor/mutations/linking";
import { multicamMoveViolation, type ClipMove } from "../../editor/mutations/multicamRules";
import { swapClipMedia, ClipMediaSwapError } from "../../editor/mutations/mediaSwap";
import { rippleDeleteRangesOnTrack, rippleInsertClipsWithSpecs, type RippleInsertSpec } from "../../editor/mutations/ripple";
import { makeFrameRange, type FrameRange } from "../../editor/rippleEngine";
import {
  insertTrack, removeTrack, removeTracks, reorderTrackLive, setTrackName, timelineTrackDisplayLabel, toggleTrackHidden,
  toggleTrackMute, toggleTrackSyncLock,
} from "../../editor/mutations/tracks";
import {
  TrackName, trackNameNormalized, clipEndFrame, clipTypeIsCompatible, makeMediaAsset, timelineHasAudioClips,
  timelineTotalFrames, type Clip, type MediaAsset,
} from "../../model";
import { secondsToFrame } from "../../util/timeFormatting";
import { applySettingsIfNeededForAgent } from "./projectSettingsTools";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import {
  ToolError, argStringArray, clampInt, decodeToolArgs, exactJSONInt, isRecord, requireString, validateUnknownKeys,
} from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of the structural half of ToolExecutor+Clips.swift: add / insert / remove / move / split / ripple delete /
// link / swap / tracks. Property edits live in clipPropertyTools.ts.

/** Media asset, or a synthetic stand-in when `id` names a timeline (nest insertion). */
export function clipSource(editor: Editor, id: string, path: string): MediaAsset {
  const existing = editor.mediaAssets.find((a) => a.id === id);
  if (existing) {
    if (existing.type === "subtitle") {
      throw new ToolError(
        `${path}: '${id}' is a subtitle file and can't be placed as a clip. Use add_captions with subtitleMediaRef to place its cues as captions.`,
      );
    }
    return existing;
  }
  const child = timelineFor(editor, id);
  if (!child) throw new ToolError(`${path}: media asset or timeline not found: ${id}`);
  const reason = nestBlockReason(editor, id);
  if (reason !== null) throw new ToolError(`${path}: ${reason}`);
  const stand = makeMediaAsset({
    id: child.id,
    url: "/dev/null",
    type: "sequence",
    name: child.name,
    duration: timelineTotalFrames(child) / editor.timeline.fps,
  });
  stand.sourceWidth = child.width;
  stand.sourceHeight = child.height;
  stand.hasAudio = timelineHasAudioClips(child);
  return stand;
}

/**
 * Resolves (trimStart, duration) for a clip placement. One length expression per domain: `source: [startSeconds,
 * endSeconds]` picks a span of the asset (unclamped for stills), an exact frame count pins the timeline length.
 */
function resolvePlacement(
  asset: MediaAsset,
  fps: number,
  durationFrames: number | undefined,
  source: number[] | undefined,
  path: string,
  framesLabel = "durationFrames",
): { trimStart: number; duration: number } {
  if (durationFrames !== undefined && source !== undefined) {
    throw new ToolError(
      `${path}: set source OR ${framesLabel}, not both — source picks a span of the asset, ${framesLabel} an exact timeline length.`,
    );
  }
  const isStill = asset.type === "image";
  const sourceLen = secondsToFrame(asset.duration, fps);

  if (source !== undefined) {
    if (source.length !== 2) {
      throw new ToolError(`${path}: source must be [startSeconds, endSeconds] (got ${source.length} element${source.length === 1 ? "" : "s"})`);
    }
    if (!(asset.duration > 0 || isStill)) throw new ToolError(`${path}: source needs a known source length; this asset has none. Use ${framesLabel}.`);
    const start = Math.max(source[0], 0);
    const end = isStill ? source[1] : Math.min(source[1], asset.duration);
    if (!(end > start)) {
      throw new ToolError(
        `${path}: source end (${swiftNumber(source[1])}) must be greater than start (${swiftNumber(source[0])})${isStill ? "" : `; source is ${swiftNumber(asset.duration)}s`}.`,
      );
    }
    const trimStart = secondsToFrame(start, fps);
    return { trimStart, duration: Math.max(1, secondsToFrame(end, fps) - trimStart) };
  }
  if (durationFrames !== undefined) {
    if (!(durationFrames >= 1)) throw new ToolError(`${path}: ${framesLabel} must span at least 1 frame`);
    if (!isStill && sourceLen > 0 && durationFrames > sourceLen) {
      throw new ToolError(`${path}: ${framesLabel} spans ${durationFrames} frames but the source is only ${sourceLen}.`);
    }
    return { trimStart: 0, duration: durationFrames };
  }
  if (!(sourceLen > 0)) throw new ToolError(`${path}: ${framesLabel} is required for this asset — its source length is unknown.`);
  return { trimStart: 0, duration: sourceLen };
}

/** Swift prints integral Doubles as "5.0". */
export function swiftNumber(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function trackRangeError(index: number, count: number): string {
  return `${index} out of range (0..${count - 1})`;
}

// MARK: add_clips

interface AddClipsEntry {
  mediaRef: string;
  trackIndex?: number;
  startFrame: number;
  endFrame?: number;
  source?: number[];
}

interface AddClipSpec {
  asset: MediaAsset;
  trackId?: string;
  startFrame: number;
  durationFrames: number;
  trimStartFrame: number;
}

const doubleArray = { array: "double" } as const;

export function addClips({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ entries: AddClipsEntry[] }>(args, "add_clips", {
    entries: {
      required: true,
      spec: {
        array: {
          typeName: "Entry",
          object: {
            mediaRef: { spec: "string", required: true },
            trackIndex: { spec: "int" },
            startFrame: { spec: "int", required: true },
            endFrame: { spec: "int" },
            source: { spec: doubleArray },
          },
        },
      },
    },
  });
  if (input.entries.length === 0) throw new ToolError("Missing or empty 'entries' array");

  const prepared: { entry: AddClipsEntry; asset: MediaAsset; trackId?: string }[] = [];
  input.entries.forEach((entry, idx) => {
    const asset = clipSource(editor, entry.mediaRef, `entries[${idx}]`);
    let trackId: string | undefined;
    if (entry.trackIndex !== undefined) {
      const tracks = editor.timeline.tracks;
      if (!(entry.trackIndex >= 0 && entry.trackIndex < tracks.length)) {
        throw new ToolError(`entries[${idx}]: track index ${trackRangeError(entry.trackIndex, tracks.length)}`);
      }
      const targetType = tracks[entry.trackIndex].type;
      if (!clipTypeIsCompatible(asset.type, targetType)) {
        throw new ToolError(`entries[${idx}]: asset type ${asset.type} is not compatible with ${targetType} track at index ${entry.trackIndex}`);
      }
      trackId = tracks[entry.trackIndex].id;
    }
    if (!(entry.startFrame >= 0)) throw new ToolError(`entries[${idx}]: startFrame must be >= 0 (got ${entry.startFrame})`);
    prepared.push({ entry, asset, ...(trackId !== undefined ? { trackId } : {}) });
  });

  // All-or-none for trackIndex: a new track at index 0 would shift any explicit indices.
  const omittedCount = prepared.filter((p) => p.trackId === undefined).length;
  if (!(omittedCount === 0 || omittedCount === prepared.length)) {
    throw new ToolError(
      `Mixed trackIndex: ${omittedCount} of ${prepared.length} entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create shared tracks).`,
    );
  }

  const specs: AddClipSpec[] = prepared.map((p, idx) => {
    if (p.entry.endFrame !== undefined && p.entry.endFrame <= p.entry.startFrame) {
      throw new ToolError(`entries[${idx}]: endFrame (${p.entry.endFrame}) must be greater than startFrame (${p.entry.startFrame})`);
    }
    const place = resolvePlacement(
      p.asset,
      editor.timeline.fps,
      p.entry.endFrame === undefined ? undefined : p.entry.endFrame - p.entry.startFrame,
      p.entry.source,
      `entries[${idx}]`,
      "endFrame",
    );
    return {
      asset: p.asset,
      ...(p.trackId !== undefined ? { trackId: p.trackId } : {}),
      startFrame: p.entry.startFrame,
      durationFrames: place.duration,
      trimStartFrame: place.trimStart,
    };
  });

  const snapshot = timelineSnapshot(editor);
  const actionName = specs.length === 1 ? "Add Clip (Agent)" : "Add Clips (Agent)";
  let settingsNote: string | undefined;
  editor.perform(actionName, () => {
    settingsNote = applySettingsIfNeededForAgent(editor, prepared.map((p) => p.asset).filter((a) => a.type !== "sequence"));
    if (omittedCount === specs.length) {
      const needsVideo = specs.some((s) => s.asset.type !== "audio");
      const needsAudio = specs.some((s) => s.asset.type === "audio");
      let videoTrackId: string | undefined;
      let audioTrackId: string | undefined;
      if (needsVideo) videoTrackId = editor.timeline.tracks[insertTrack(editor, 0, "video")].id;
      if (needsAudio) audioTrackId = editor.timeline.tracks[insertTrack(editor, editor.timeline.tracks.length, "audio")].id;
      for (const spec of specs) {
        const id = spec.asset.type === "audio" ? audioTrackId : videoTrackId;
        if (id !== undefined) spec.trackId = id;
      }
    }

    const nonEmptyBefore = new Set(editor.timeline.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));
    const orderedIndices = specs
      .map((_, i) => i)
      .sort((a, b) => {
        const aAudio = specs[a].asset.type === "audio" ? 0 : 1;
        const bAudio = specs[b].asset.type === "audio" ? 0 : 1;
        if (aAudio !== bAudio) return aAudio - bAudio;
        const ta = specs[a].trackId ?? "";
        const tb = specs[b].trackId ?? "";
        if (ta !== tb) return ta < tb ? -1 : 1;
        return specs[a].startFrame - specs[b].startFrame;
      });
    for (const i of orderedIndices) {
      const spec = specs[i];
      const trackIdx = editor.timeline.tracks.findIndex((t) => t.id === spec.trackId);
      if (trackIdx < 0) throw new ToolError(`entries[${i}]: destination track no longer exists`);
      clearRegion(editor, trackIdx, spec.startFrame, spec.startFrame + spec.durationFrames, { prune: false });
      const ids = placeClip(editor, spec.asset, trackIdx, spec.startFrame, spec.durationFrames, { trimStartFrame: spec.trimStartFrame });
      if (ids.length === 0) throw new ToolError(`entries[${i}]: failed to place clip on track ${trackIdx} at frame ${spec.startFrame}`);
    }

    const emptied = editor.timeline.tracks.filter((t) => t.clips.length === 0 && nonEmptyBefore.has(t.id)).map((t) => t.id);
    for (const id of emptied) removeTrack(editor, id);
  });
  return mutationResult(editor, snapshot, { notes: settingsNote !== undefined ? [settingsNote] : [] });
}

// MARK: insert_clips

export function insertClips({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{
    trackIndex: number;
    atFrame: number;
    entries: { mediaRef: string; durationFrames?: number; source?: number[] }[];
  }>(args, "insert_clips", {
    trackIndex: { spec: "int", required: true },
    atFrame: { spec: "int", required: true },
    entries: {
      required: true,
      spec: {
        array: {
          typeName: "Entry",
          object: {
            mediaRef: { spec: "string", required: true },
            durationFrames: { spec: "int" },
            source: { spec: doubleArray },
          },
        },
      },
    },
  });
  if (input.entries.length === 0) throw new ToolError("Missing or empty 'entries' array");
  const tracks = editor.timeline.tracks;
  if (!(input.trackIndex >= 0 && input.trackIndex < tracks.length)) {
    throw new ToolError(`trackIndex ${trackRangeError(input.trackIndex, tracks.length)}`);
  }
  if (!(input.atFrame >= 0)) throw new ToolError(`atFrame must be >= 0 (got ${input.atFrame})`);
  const targetType = tracks[input.trackIndex].type;

  const resolvedAssets = input.entries.map((entry, idx) => {
    const asset = clipSource(editor, entry.mediaRef, `entries[${idx}]`);
    if (!clipTypeIsCompatible(asset.type, targetType)) {
      throw new ToolError(`entries[${idx}]: asset type ${asset.type} is not compatible with ${targetType} track at index ${input.trackIndex}`);
    }
    return asset;
  });

  const specs: RippleInsertSpec[] = input.entries.map((entry, idx) => {
    const place = resolvePlacement(resolvedAssets[idx], editor.timeline.fps, entry.durationFrames, entry.source, `entries[${idx}]`);
    return { asset: resolvedAssets[idx], durationFrames: place.duration, trimStartFrame: place.trimStart };
  });

  const snapshot = timelineSnapshot(editor);
  let settingsNote: string | undefined;
  const ids = editor.perform(specs.length === 1 ? "Insert Clip (Agent)" : "Insert Clips (Agent)", () => {
    settingsNote = applySettingsIfNeededForAgent(editor, resolvedAssets.filter((a) => a.type !== "sequence"));
    return rippleInsertClipsWithSpecs(editor, specs, input.trackIndex, input.atFrame);
  });
  if (ids.length === 0) throw new ToolError(`Insert failed on track ${input.trackIndex} at frame ${input.atFrame}`);
  return mutationResult(editor, snapshot, { notes: settingsNote !== undefined ? [settingsNote] : [] });
}

// MARK: remove_clips

export function removeClipsTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["clipIds"], "remove_clips");
  const clipIds = argStringArray(args, "clipIds");
  if (clipIds.length === 0) throw new ToolError("Missing or empty 'clipIds' array");
  for (const id of clipIds) if (editor.findClip(id) === null) throw new ToolError(`Clip not found: ${id}`);
  const expanded = expandToLinkGroup(editor, new Set(clipIds));
  const snapshot = timelineSnapshot(editor);
  editor.perform(clipIds.length === 1 ? "Remove Clip (Agent)" : "Remove Clips (Agent)", () => removeClips(editor, expanded));
  return mutationResult(editor, snapshot);
}

// MARK: manage_clip_links

export function manageClipLinks({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ action: string; clipIds: string[] }>(args, "manage_clip_links", {
    action: { spec: "string", required: true },
    clipIds: { spec: { array: "string" }, required: true },
  });
  if (input.action !== "link" && input.action !== "unlink") {
    throw new ToolError(`manage_clip_links.action: Cannot initialize Action from invalid String value ${input.action}`);
  }
  if (input.clipIds.length === 0) throw new ToolError("manage_clip_links.clipIds must be a non-empty array");
  input.clipIds.forEach((id, index) => {
    if (id === "") throw new ToolError(`manage_clip_links.clipIds[${index}] must be a non-empty clip ID`);
    if (editor.findClip(id) === null) throw new ToolError(`Clip not found: ${id}`);
  });

  const clipIds = new Set(input.clipIds);
  let targets: Set<string>;
  if (input.action === "link") {
    const resolved = linkTargets(editor, clipIds);
    if (!resolved) throw new ToolError("Link requires at least two clips of different media types that are not already one link group");
    targets = resolved;
  } else {
    targets = unlinkTargets(editor, clipIds);
    if (targets.size === 0) throw new ToolError("None of the provided clips is linked");
  }

  const snapshot = timelineSnapshot(editor);
  if (input.action === "link") linkClips(editor, targets);
  else unlinkClips(editor, targets);
  return mutationResult(editor, snapshot, { touched: [...targets] });
}

// MARK: move_clips

interface ParsedMove {
  clipId: string;
  destTrackId?: string;
  toFrame?: number;
}

export function moveClipsTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ moves: { clipId: string; toTrack?: number; toFrame?: number }[] }>(args, "move_clips", {
    moves: {
      required: true,
      spec: {
        array: {
          typeName: "Move",
          object: { clipId: { spec: "string", required: true }, toTrack: { spec: "int" }, toFrame: { spec: "int" } },
        },
      },
    },
  });
  if (input.moves.length === 0) throw new ToolError("Missing or empty 'moves' array");

  const parsed: ParsedMove[] = input.moves.map((m, idx) => {
    const path = `moves[${idx}]`;
    if (m.toTrack === undefined && m.toFrame === undefined) throw new ToolError(`${path}: at least one of 'toTrack' or 'toFrame' is required`);
    const loc = editor.findClip(m.clipId);
    if (!loc) throw new ToolError(`${path}: clip not found: ${m.clipId}`);
    let destTrackId: string | undefined;
    const tracks = editor.timeline.tracks;
    if (m.toTrack !== undefined) {
      if (!(m.toTrack >= 0 && m.toTrack < tracks.length)) throw new ToolError(`${path}: toTrack ${trackRangeError(m.toTrack, tracks.length)}`);
      const srcType = tracks[loc.trackIndex].type;
      const destType = tracks[m.toTrack].type;
      if (!clipTypeIsCompatible(destType, srcType)) {
        throw new ToolError(`${path}: toTrack ${m.toTrack} (${destType}) is incompatible with clip's ${srcType} source track`);
      }
      destTrackId = tracks[m.toTrack].id;
    }
    if (m.toFrame !== undefined && m.toFrame < 0) throw new ToolError(`${path}: toFrame must be >= 0 (got ${m.toFrame})`);
    return { clipId: m.clipId, ...(destTrackId !== undefined ? { destTrackId } : {}), ...(m.toFrame !== undefined ? { toFrame: m.toFrame } : {}) };
  });

  // Expand to linked partners via the shared model helper.
  const seen = new Set(parsed.map((p) => p.clipId));
  const allMoves = [...parsed];
  for (const p of parsed) {
    if (p.toFrame === undefined) continue;
    for (const pm of partnerMoves(editor, p.clipId, p.toFrame)) {
      if (seen.has(pm.clipId)) continue;
      allMoves.push({ clipId: pm.clipId, toFrame: pm.toFrame });
      seen.add(pm.clipId);
    }
  }

  const moves: ClipMove[] = [];
  for (const m of allMoves) {
    const loc = editor.findClip(m.clipId);
    if (!loc) continue;
    const currentFrame = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame;
    const destIdx = m.destTrackId === undefined ? -1 : editor.timeline.tracks.findIndex((t) => t.id === m.destTrackId);
    moves.push({ clipId: m.clipId, toTrack: destIdx >= 0 ? destIdx : loc.trackIndex, toFrame: m.toFrame ?? currentFrame });
  }
  const violation = multicamMoveViolation(editor, moves);
  if (violation !== null) throw new ToolError(violation);

  const snapshot = timelineSnapshot(editor);
  editor.perform(parsed.length === 1 ? "Move Clip (Agent)" : "Move Clips (Agent)", () => {
    if (moves.length > 0) moveClips(editor, moves);
  });
  return mutationResult(editor, snapshot, { touched: allMoves.map((m) => m.clipId) });
}

// MARK: swap_clip_media

export function swapClipMediaTool({ executor, editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["clipId", "mediaRef"], "swap_clip_media");
  const clipId = requireString(args, "clipId");
  const replacement = executor.asset(requireString(args, "mediaRef"), editor, "Replacement media");
  const snapshot = timelineSnapshot(editor);
  let plan;
  try {
    plan = swapClipMedia(editor, clipId, replacement);
  } catch (e) {
    if (e instanceof ClipMediaSwapError) throw new ToolError(e.message);
    throw e;
  }
  return mutationResult(editor, snapshot, {
    touched: plan.changed ? plan.affectedClipIds : [],
    extra: {
      changed: plan.changed,
      clipId: plan.clipId,
      oldMediaRef: plan.oldMediaRef,
      mediaRef: plan.newMediaRef,
      affectedClipIds: plan.affectedClipIds,
    },
  });
}

// MARK: split_clips

export function splitClipsTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ splits?: { clipId: string; atFrame: number }[]; trackIndex?: number; frames?: number[] }>(args, "split_clips", {
    splits: {
      spec: {
        array: {
          typeName: "Split",
          object: { clipId: { spec: "string", required: true }, atFrame: { spec: "int", required: true } },
        },
      },
    },
    trackIndex: { spec: "int" },
    frames: { spec: { array: "int" } },
  });
  const hasSplits = (input.splits ?? []).length > 0;
  const hasTrack = input.trackIndex !== undefined || (input.frames ?? []).length > 0;
  if (hasSplits === hasTrack) {
    throw new ToolError("Provide exactly one of 'splits' (an array of {clipId, atFrame}) or 'trackIndex'+'frames' (project frames to cut on one track).");
  }

  // Resolve every cut to a (trackIndex, atFrame) pair against the CURRENT timeline
  const points: { trackIndex: number; atFrame: number }[] = [];
  const seen = new Set<string>();
  const addCut = (trackIndex: number, atFrame: number, clip: Clip): void => {
    if (!(atFrame > clip.startFrame && atFrame < clipEndFrame(clip))) {
      throw new ToolError(`Frame ${atFrame} is outside clip ${clip.id} range (${clip.startFrame}..${clipEndFrame(clip)})`);
    }
    const key = `${trackIndex}:${atFrame}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ trackIndex, atFrame });
  };

  if (hasSplits) {
    for (const s of input.splits ?? []) {
      const loc = editor.findClip(s.clipId);
      if (!loc) throw new ToolError(`Clip not found: ${s.clipId}`);
      addCut(loc.trackIndex, s.atFrame, editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
    }
  } else {
    const trackIndex = input.trackIndex;
    const count = editor.timeline.tracks.length;
    if (trackIndex === undefined || !(trackIndex >= 0 && trackIndex < count)) {
      throw new ToolError(`trackIndex is required and must be in 0..${count - 1}`);
    }
    const frames = input.frames;
    if (!frames || frames.length === 0) throw new ToolError("'frames' must be a non-empty array of project frames");
    const track = editor.timeline.tracks[trackIndex];
    for (const f of frames) {
      const clip = track.clips.find((c) => f > c.startFrame && f < clipEndFrame(c));
      if (!clip) throw new ToolError(`Frame ${f} is not strictly inside any clip on track ${trackIndex}`);
      addCut(trackIndex, f, clip);
    }
  }

  if (points.length === 0) throw new ToolError("No valid split points");
  const snapshot = timelineSnapshot(editor);
  editor.perform(points.length === 1 ? "Split Clip (Agent)" : "Split Clips (Agent)", () => {
    splitClips(editor, points);
  });
  return mutationResult(editor, snapshot);
}

// MARK: ripple_delete_ranges

export function rippleDeleteRangesTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{
    clipId?: string;
    trackIndex?: number;
    ranges: number[][];
    units?: string;
    ignoreSyncLockedTracks?: number[];
  }>(args, "ripple_delete_ranges", {
    clipId: { spec: "string" },
    trackIndex: { spec: "int" },
    ranges: { spec: { array: doubleArray }, required: true },
    units: { spec: "string" },
    ignoreSyncLockedTracks: { spec: { array: "int" } },
  });
  if (input.ranges.length === 0) throw new ToolError("Missing or empty 'ranges' array");
  const units = input.units ?? "frames";
  if (units !== "seconds" && units !== "frames") throw new ToolError(`units must be 'seconds' or 'frames' (got '${units}')`);
  if ((input.clipId !== undefined) === (input.trackIndex !== undefined)) {
    throw new ToolError(
      "Provide exactly one of 'clipId' (cut within a single clip; allows 'seconds') or 'trackIndex' (cut project-frame ranges spanning a whole track in one call).",
    );
  }
  const fps = editor.timeline.fps;

  input.ranges.forEach((r, i) => {
    if (r.length !== 2) throw new ToolError(`ranges[${i}]: expected [start, end] (got ${r.length} element${r.length === 1 ? "" : "s"})`);
    if (!(r[1] > r[0])) throw new ToolError(`ranges[${i}]: end (${swiftNumber(r[1])}) must be greater than start (${swiftNumber(r[0])})`);
  });

  const frameRanges: FrameRange[] = [];
  let dropped = 0;
  let resolvedTrackIndex: number;

  if (input.clipId !== undefined) {
    const loc = editor.findClip(input.clipId);
    if (!loc) throw new ToolError(`Clip not found: ${input.clipId}`);
    const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
    // 'frames' are project frames as-is; 'seconds' are source seconds → map through trim/speed/position.
    const toFrame = (v: number): number =>
      units === "frames" ? v : clip.startFrame + (v * fps - clip.trimStartFrame) / Math.max(clip.speed, 0.0001);
    for (const r of input.ranges) {
      const s = clampInt(toFrame(r[0]), clip.startFrame, clipEndFrame(clip));
      const e = clampInt(toFrame(r[1]), clip.startFrame, clipEndFrame(clip));
      if (e > s) frameRanges.push(makeFrameRange(s, e));
      else dropped += 1;
    }
    if (frameRanges.length === 0) {
      throw new ToolError(
        `No ranges fall within clip ${input.clipId} (frames ${clip.startFrame}..${clipEndFrame(clip)}). In '${units}' units, ranges must overlap the clip's visible span.`,
      );
    }
    resolvedTrackIndex = loc.trackIndex;
  } else {
    const trackIndex = input.trackIndex as number;
    if (units !== "frames") {
      throw new ToolError("units 'seconds' requires a clipId for source-media mapping; with trackIndex, ranges are project frames.");
    }
    if (!(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length)) throw new ToolError(`Track index out of range: ${trackIndex}`);
    const total = timelineTotalFrames(editor.timeline);
    for (const r of input.ranges) {
      const s = clampInt(r[0], 0, total);
      const e = clampInt(r[1], 0, total);
      if (e > s) frameRanges.push(makeFrameRange(s, e));
      else dropped += 1;
    }
    if (frameRanges.length === 0) throw new ToolError(`No valid project-frame ranges to delete on track ${trackIndex}.`);
    resolvedTrackIndex = trackIndex;
  }

  const ignoreSyncLocked = new Set(input.ignoreSyncLockedTracks ?? []);
  const snapshot = timelineSnapshot(editor);
  const outcome = editor.perform("Ripple Delete (Agent)", () =>
    rippleDeleteRangesOnTrack(editor, resolvedTrackIndex, frameRanges, ignoreSyncLocked),
  );
  if (outcome.kind === "refused") throw new ToolError(outcome.reason);
  const extra: Record<string, unknown> = { removedFrames: outcome.report.removedFrames };
  if (dropped > 0) extra.rangesIgnored = dropped;
  return mutationResult(editor, snapshot, { touched: outcome.report.resultingFragments.map((f) => f.clipId), extra });
}

// MARK: manage_tracks

export function manageTracks({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["reorder", "set", "remove"], "manage_tracks");
  const tracks = editor.timeline.tracks;

  const trackIdAt = (index: number, path: string): string => {
    if (!(index >= 0 && index < tracks.length)) {
      throw new ToolError(`${path}: track index ${index} out of range (timeline has ${tracks.length} tracks)`);
    }
    return tracks[index].id;
  };
  const trackIdOf = (entry: Record<string, unknown>, path: string): string => {
    if (typeof entry.trackId === "string") {
      if (entry.index !== undefined || !tracks.some((t) => t.id === entry.trackId)) throw new ToolError(`${path}: pass one current trackId or index`);
      return entry.trackId;
    }
    const index = exactJSONInt(entry.index);
    if (entry.trackId !== undefined || index === undefined) throw new ToolError(`${path}: pass one current trackId or index`);
    return trackIdAt(index, path);
  };
  const listOf = (key: string): unknown[] => (Array.isArray(args[key]) ? (args[key] as unknown[]) : []);

  const reorders: { id: string; to: number }[] = [];
  listOf("reorder").forEach((raw, i) => {
    if (!isRecord(raw)) throw new ToolError(`reorder[${i}] must be an object`);
    const path = `reorder[${i}]`;
    validateUnknownKeys(raw, ["trackId", "index", "to"], path);
    const to = exactJSONInt(raw.to);
    if (to === undefined) throw new ToolError(`${path}: 'to' is required and must be an integer`);
    const id = trackIdOf(raw, path);
    const from = tracks.findIndex((t) => t.id === id);
    if (!(from >= 0 && to >= 0 && to < tracks.length && tracks[from].type === tracks[to].type)) {
      throw new ToolError(`${path}: destination index ${to} is outside the track's type zone`);
    }
    reorders.push({ id, to });
  });

  interface Update {
    id: string;
    muted?: boolean;
    hidden?: boolean;
    syncLocked?: boolean;
    name?: string;
    includesName: boolean;
  }
  const updates: Update[] = [];
  listOf("set").forEach((raw, i) => {
    if (!isRecord(raw)) throw new ToolError(`set[${i}] must be an object`);
    const path = `set[${i}]`;
    validateUnknownKeys(raw, ["trackId", "index", "muted", "hidden", "syncLocked", "name"], path);
    const muted = typeof raw.muted === "boolean" ? raw.muted : undefined;
    const hidden = typeof raw.hidden === "boolean" ? raw.hidden : undefined;
    const syncLocked = typeof raw.syncLocked === "boolean" ? raw.syncLocked : undefined;
    const includesName = "name" in raw;
    let name: string | undefined;
    if (includesName) {
      if (typeof raw.name !== "string") throw new ToolError(`${path}.name must be a string`);
      try {
        name = trackNameNormalized(raw.name);
      } catch {
        throw new ToolError(`${path}.name must be one line of at most ${TrackName.maximumLength} characters`);
      }
    }
    if (muted === undefined && hidden === undefined && syncLocked === undefined && !includesName) {
      throw new ToolError(`${path}: pass at least one of muted, hidden, syncLocked, name`);
    }
    updates.push({
      id: trackIdOf(raw, path),
      ...(muted !== undefined ? { muted } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
      ...(syncLocked !== undefined ? { syncLocked } : {}),
      ...(name !== undefined ? { name } : {}),
      includesName,
    });
  });

  const removeIds: string[] = [];
  listOf("remove").forEach((raw, i) => {
    const path = `remove[${i}]`;
    if (isRecord(raw)) {
      validateUnknownKeys(raw, ["trackId", "index"], path);
      removeIds.push(trackIdOf(raw, path));
      return;
    }
    const index = exactJSONInt(raw);
    if (index === undefined) throw new ToolError(`${path} must be an integer index or track selector object`);
    removeIds.push(trackIdAt(index, path));
  });

  if (reorders.length === 0 && updates.length === 0 && removeIds.length === 0) {
    throw new ToolError("Nothing to do — pass at least one of reorder, set, remove.");
  }

  const multicamTrackIds = new Set(tracks.filter((t) => t.clips.some((c) => c.multicamGroupId !== undefined)).map((t) => t.id));
  if (removeIds.some((id) => multicamTrackIds.has(id))) {
    throw new ToolError("A multicam group's track can't be removed — delete the group's clips first (remove_clips) and the empty track prunes itself.");
  }
  if (updates.some((u) => multicamTrackIds.has(u.id) && u.syncLocked === false)) {
    throw new ToolError("Sync lock stays on for a multicam group's tracks — unlocking would let ripples shift the group's members apart.");
  }

  const snapshot = timelineSnapshot(editor);
  const removeIdSet = new Set(removeIds);
  const removedTracks = tracks.flatMap((track, i) =>
    removeIdSet.has(track.id) ? [{ trackId: track.id, index: i, label: timelineTrackDisplayLabel(editor, i), type: track.type }] : [],
  );
  const reorderResults: { trackId: string; from: number; to: number }[] = [];
  const renamedTracks: { trackId: string; name: string | null; changed: boolean }[] = [];
  editor.perform("Manage Tracks (Agent)", () => {
    for (const r of reorders) {
      const from = editor.timeline.tracks.findIndex((t) => t.id === r.id);
      if (from < 0) continue;
      reorderTrackLive(editor, r.id, r.to);
      const destination = editor.timeline.tracks.findIndex((t) => t.id === r.id);
      reorderResults.push({ trackId: r.id, from, to: destination < 0 ? from : destination });
    }
    for (const update of updates) {
      const idx = editor.timeline.tracks.findIndex((t) => t.id === update.id);
      if (idx < 0) continue;
      const track = editor.timeline.tracks[idx];
      if (update.muted !== undefined && track.muted !== update.muted) toggleTrackMute(editor, idx);
      if (update.hidden !== undefined && track.hidden !== update.hidden) toggleTrackHidden(editor, idx);
      if (update.syncLocked !== undefined && track.syncLocked !== update.syncLocked) toggleTrackSyncLock(editor, idx);
      if (update.includesName) {
        const changed = setTrackName(editor, update.id, update.name);
        renamedTracks.push({ trackId: update.id, name: editor.timeline.tracks[idx].name ?? null, changed });
      }
    }
    if (removeIds.length > 0) removeTracks(editor, removeIds);
  });

  const order = editor.timeline.tracks.map((track, i) => {
    const entry: Record<string, unknown> = {
      trackId: track.id,
      index: i,
      label: timelineTrackDisplayLabel(editor, i),
      type: track.type,
    };
    if (track.name !== undefined) entry.name = track.name;
    if (track.muted) entry.muted = true;
    if (track.hidden) entry.hidden = true;
    if (!track.syncLocked) entry.syncLocked = false;
    return entry;
  });
  const extra: Record<string, unknown> = { tracks: order };
  if (reorderResults.length > 0) extra.reordered = reorderResults.map((r) => ({ ...r, changed: r.from !== r.to }));
  if (renamedTracks.length > 0) extra.renamed = renamedTracks;
  if (removedTracks.length > 0) extra.removedTracks = removedTracks;
  return mutationResult(editor, snapshot, { extra });
}
