import type { Editor } from "../../editor/editor";
import { deepEqual } from "../../editor/mutations/core";
import { timelineTrackDisplayLabel } from "../../editor/mutations/tracks";
import { folderPath } from "../../media/folders";
import {
  VolumeScale, gaussianBlurRadiusKey, gaussianBlurType, makeClip, makeTextStyle, rgbaHexString,
  type Timeline, type TimelineMarker, type Track, type TextAlignment,
} from "../../model";
import { jsonString } from "./jsonFormat";
import { agentToolHooks } from "./toolHooks";

// Port of the payload-shaping half of ToolExecutor+Timeline.swift: raw Codable JSON of the timeline, compacted into
// the get_timeline vocabulary (defaults stripped, linked audio folded, caption groups summarised).

export type Json = Record<string, unknown>;

const captionRowLimit = 200;
const captionRowFormat = ["clipId", "startFrame", "endFrame", "text"];
const captionPreviewLimit = 60;

const trackDefaults: Json = { muted: false, hidden: false, syncLocked: true };

function buildClipDefaults(): Json {
  const clip = makeClip({ mediaRef: "", startFrame: 0, durationFrames: 0 });
  clip.textStyle = makeTextStyle();
  const obj = rawJson(clip);
  // Identity fields stay; sourceClipType strips only when it matches mediaType.
  for (const key of ["id", "mediaRef", "startFrame", "durationFrames", "sourceClipType"]) delete obj[key];
  return obj;
}

let clipDefaultsCache: Json | undefined;
function clipDefaults(): Json {
  clipDefaultsCache ??= buildClipDefaults();
  return clipDefaultsCache;
}

/** Codable-equivalent JSON of a model value (the in-memory shape is the persisted shape). */
export function rawJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export function rawTimelineDict(timeline: Timeline): Json {
  return rawJson(timeline);
}

function asDict(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}
function asDictArray(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter((x): x is Json => typeof x === "object" && x !== null && !Array.isArray(x)) : [];
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function textAnchorX(centerX: number, width: number, alignment: TextAlignment): number {
  return alignment === "left" ? centerX - width / 2 : alignment === "right" ? centerX + width / 2 : centerX;
}

export function textCenterX(anchorX: number, width: number, alignment: TextAlignment): number {
  return alignment === "left" ? anchorX + width / 2 : alignment === "right" ? anchorX - width / 2 : anchorX;
}

export function timelineMarkerDict(marker: TimelineMarker): Json {
  return {
    markerId: marker.id,
    name: marker.name,
    startFrame: marker.startFrame,
    endFrame: marker.startFrame + marker.durationFrames,
    durationFrames: marker.durationFrames,
    color: rgbaHexString(marker.color),
    comment: marker.comment,
    status: marker.status,
  };
}

export function focusedRawTracks(
  editor: Editor,
  p: { clipIds?: ReadonlySet<string>; captionGroupIds?: ReadonlySet<string> } = {},
): Json[] {
  const clipIds = p.clipIds ?? new Set<string>();
  const linkGroupIds = new Set<string>();
  const includedCaptionGroupIds = new Set(p.captionGroupIds ?? []);
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (!clipIds.has(clip.id)) continue;
      if (clip.linkGroupId !== undefined) linkGroupIds.add(clip.linkGroupId);
      if (clip.captionGroupId !== undefined) includedCaptionGroupIds.add(clip.captionGroupId);
    }
  }
  return editor.timeline.tracks.map((track) => ({
    id: track.id,
    type: track.type,
    clips: track.clips
      .filter(
        (clip) =>
          clipIds.has(clip.id) ||
          (clip.captionGroupId !== undefined && includedCaptionGroupIds.has(clip.captionGroupId)) ||
          (clip.linkGroupId !== undefined && linkGroupIds.has(clip.linkGroupId)),
      )
      .map(rawJson),
  }));
}

export function folderPathString(editor: Editor, folderId: string | undefined): string | undefined {
  if (folderId === undefined) return undefined;
  const path = folderPath(editor, folderId);
  return path.length === 0 ? undefined : path.map((f) => f.name).join("/");
}

export function timelineEntries(editor: Editor, detailed = false): Json[] {
  return editor.timelines.map((t) => {
    const e: Json = { timelineId: t.id, name: t.name };
    if (t.id === editor.doc.activeTimelineId) e.active = true;
    if (detailed) {
      e.durationSeconds = timelineFrames(t) / Math.max(t.fps, 1);
      const path = folderPathString(editor, t.folderId);
      if (path !== undefined) e.folder = path;
    }
    return e;
  });
}

function timelineFrames(t: Timeline): number {
  let max = 0;
  for (const track of t.tracks) for (const clip of track.clips) max = Math.max(max, clip.startFrame + clip.durationFrames);
  return max;
}

// MARK: - Track and clip compaction

export type FrameWindow = { start: number; end: number };

export function compactTracks(tracks: Json[], editor: Editor, window: FrameWindow | undefined, captionDetail: boolean): Json[] {
  const fold = linkFoldPlan(tracks);
  const grades = new Map<string, Json>();
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      const grade = clip.effects ? agentToolHooks.colorObject?.(clip.effects) : undefined;
      if (grade) grades.set(clip.id, grade);
    }
  }
  return tracks.map((raw, i) => {
    const track = compactTrack(raw, window, captionDetail, fold, grades);
    // Report the displayed label (mirrored video numbering), not the stored seed.
    track.label = timelineTrackDisplayLabel(editor, i);
    track.index = i;
    track.trackId = track.id;
    delete track.id;
    delete track.displayHeight;
    const count = fold.foldedCountByTrack.get(i);
    if (count !== undefined) track.linkedClips = count;
    const gaps = trackGaps(editor.timeline.tracks[i]);
    if (gaps.length > 0) track.gaps = gaps;
    return track;
  });
}

/** Empty spans between non-caption clips; leading/trailing space reads off the clip frames. */
function trackGaps(track: Track): number[][] {
  const spans = track.clips
    .filter((c) => c.captionGroupId === undefined)
    .map((c) => [c.startFrame, c.startFrame + c.durationFrames])
    .sort((a, b) => a[0] - b[0]);
  const gaps: number[][] = [];
  let maxEnd: number | undefined;
  for (const span of spans) {
    if (maxEnd !== undefined && span[0] > maxEnd) gaps.push([maxEnd, span[0]]);
    maxEnd = Math.max(maxEnd ?? span[1], span[1]);
  }
  return gaps;
}

// MARK: Linked audio fold

interface LinkFold {
  partnerByVisualId: Map<string, { clip: Json; trackIndex: number }>;
  foldedAudioIds: Set<string>;
  foldedCountByTrack: Map<number, number>;
}

function linkFoldPlan(tracks: Json[]): LinkFold {
  const groups = new Map<string, { clip: Json; trackIndex: number }[]>();
  tracks.forEach((track, ti) => {
    for (const clip of asDictArray(track.clips)) {
      const gid = clip.linkGroupId;
      if (typeof gid === "string") {
        const list = groups.get(gid) ?? [];
        list.push({ clip, trackIndex: ti });
        groups.set(gid, list);
      }
    }
  });
  const plan: LinkFold = { partnerByVisualId: new Map(), foldedAudioIds: new Set(), foldedCountByTrack: new Map() };
  for (const members of groups.values()) {
    if (members.length !== 2) continue;
    const audio = members.find((m) => m.clip.mediaType === "audio");
    const visual = members.find((m) => m.clip.mediaType !== "audio");
    if (!audio || !visual || typeof visual.clip.id !== "string" || typeof audio.clip.id !== "string") continue;
    plan.partnerByVisualId.set(visual.clip.id, audio);
    plan.foldedAudioIds.add(audio.clip.id);
    plan.foldedCountByTrack.set(audio.trackIndex, (plan.foldedCountByTrack.get(audio.trackIndex) ?? 0) + 1);
  }
  return plan;
}

/** The folded audio partner: id, track, and only what deviates from its visual clip. */
function audioSummary(partner: Json, trackIndex: number, visual: Json): Json {
  const out: Json = { id: partner.id ?? "", track: trackIndex };
  const pStart = num(partner.startFrame);
  const pDur = num(partner.durationFrames);
  if (pStart !== num(visual.startFrame) || pDur !== num(visual.durationFrames)) out.frames = [pStart, pStart + pDur];
  for (const key of ["trimStartFrame", "trimEndFrame", "speed"]) {
    const pv = partner[key];
    const vv = visual[key];
    if (typeof pv === "number" && typeof vv === "number" && pv !== vv) out[key] = pv;
  }
  const stripped = strippingDefaults(compactClipKeyframes(partner), clipDefaults());
  for (const key of ["volumeDb", "fadeInFrames", "fadeOutFrames", "fadeInInterpolation", "fadeOutInterpolation", "keyframes"]) {
    if (stripped[key] !== undefined) out[key] = stripped[key];
  }
  const fx = stripped.effects;
  if (Array.isArray(fx)) {
    const cleaned = compactEffects(asDictArray(fx));
    if (cleaned.length > 0) out.effects = cleaned;
  }
  return out;
}

/**
 * Read shape for the effect stack: no ids (removal is by type), flat params, enabled only when false. color.*
 * entries live in the clip's `color` object instead.
 */
function compactEffects(raw: Json[]): Json[] {
  return raw.flatMap((e) => {
    const type = e.type;
    if (typeof type !== "string" || type.startsWith("color.")) return [];
    const out: Json = { type };
    const params = asDict(e.params);
    if (params) {
      const flat: Json = {};
      for (const [k, v] of Object.entries(params)) {
        const p = asDict(v);
        if (!p) {
          flat[k] = v;
          continue;
        }
        flat[k] = p.value ?? p.string ?? (p.track !== undefined ? "animated" : undefined) ?? v;
      }
      if (Object.keys(flat).length > 0) out.params = flat;
    }
    if (e.enabled === false) out.enabled = false;
    return [out];
  });
}

function compactTrack(track: Json, window: FrameWindow | undefined, captionDetail: boolean, fold: LinkFold, grades: Map<string, Json>): Json {
  const out = strippingDefaults(track, trackDefaults);
  if (!Array.isArray(track.clips)) return out;
  const compacted = asDictArray(track.clips)
    .filter((c) => !fold.foldedAudioIds.has(typeof c.id === "string" ? c.id : ""))
    .map((c) => compactClip(c, fold, grades));

  let loose: Json[] = [];
  const groupOrder: string[] = [];
  const grouped = new Map<string, Json[]>();
  for (const clip of compacted) {
    const gid = clip.captionGroupId;
    if (typeof gid === "string") {
      if (!grouped.has(gid)) groupOrder.push(gid);
      grouped.set(gid, [...(grouped.get(gid) ?? []), clip]);
    } else {
      loose.push(clip);
    }
  }

  const groups: Json[] = [];
  for (const gid of groupOrder) {
    const { group, deviants } = captionGroup(gid, grouped.get(gid) ?? [], window, captionDetail);
    groups.push(group);
    loose.push(...deviants);
  }
  loose = loose.sort((a, b) => firstFrame(a) - firstFrame(b));

  const visible = window ? loose.filter((c) => clipIntersects(c, window)) : loose;
  delete out.clips;
  if (visible.length > 0) out.clips = visible;
  if (visible.length < loose.length) out.totalClips = loose.length;
  if (groups.length > 0) out.captionGroups = groups;
  return out;
}

function firstFrame(clip: Json): number {
  const frames = clip.frames;
  return Array.isArray(frames) ? num(frames[0]) : 0;
}

function compactClip(clip: Json, fold: LinkFold, grades: Map<string, Json>): Json {
  let out = compactClipKeyframes(clip);
  if (typeof out.sourceClipType === "string" && out.sourceClipType === out.mediaType) delete out.sourceClipType;
  // Text has no source media; trims are placement bookkeeping, not signal.
  if (out.mediaType === "text") {
    delete out.trimStartFrame;
    delete out.trimEndFrame;
  }
  out = strippingDefaults(out, clipDefaults());
  const id = typeof out.id === "string" ? out.id : undefined;
  const grade = id !== undefined ? grades.get(id) : undefined;
  if (grade) out.color = grade;
  if (Array.isArray(out.effects)) {
    const isText = out.mediaType === "text";
    const cleaned = compactEffects(asDictArray(out.effects)).filter((e) => !isText || e.type !== gaussianBlurType);
    if (cleaned.length === 0) delete out.effects;
    else out.effects = cleaned;
  }
  const start = num(out.startFrame);
  out.frames = [start, start + num(out.durationFrames)];
  delete out.startFrame;
  delete out.durationFrames;
  const partner = id !== undefined ? fold.partnerByVisualId.get(id) : undefined;
  if (partner) {
    out.audio = audioSummary(partner.clip, partner.trackIndex, clip);
    delete out.linkGroupId;
  }
  if (clip.mediaType === "text") shapeTextTransform(out, clip);
  return out;
}

function shapeTextTransform(output: Json, rawClip: Json): void {
  const rawTransform = asDict(rawClip.transform);
  if (!rawTransform) return;
  const { centerX, centerY, width } = rawTransform;
  if (typeof centerX !== "number" || typeof centerY !== "number" || typeof width !== "number") return;
  const rawAlignment = asDict(rawClip.textStyle)?.alignment;
  const alignment: TextAlignment =
    rawAlignment === "left" || rawAlignment === "center" || rawAlignment === "right" ? rawAlignment : "center";
  const transform: Json = { ...(asDict(output.transform) ?? {}) };
  delete transform.centerX;
  delete transform.centerY;
  delete transform.width;
  delete transform.height;
  transform.x = textAnchorX(centerX, width, alignment);
  transform.y = centerY;
  output.transform = transform;
}

/** Removes keys whose values equal the defaults; recurses into nested objects. */
function strippingDefaults(dict: Json, defaults: Json): Json {
  const out: Json = { ...dict };
  for (const [key, def] of Object.entries(defaults)) {
    const val = out[key];
    if (val === undefined) continue;
    const v = asDict(val);
    const d = asDict(def);
    if (v && d) {
      const stripped = strippingDefaults(v, d);
      if (Object.keys(stripped).length === 0) delete out[key];
      else out[key] = stripped;
    } else if (deepEqual(val, def)) {
      delete out[key];
    }
  }
  return out;
}

// MARK: Caption groups

/** Collapses one caption group into shared properties + a summary (default) or compact rows (detail). */
function captionGroup(
  gid: string,
  members: Json[],
  window: FrameWindow | undefined,
  detail: boolean,
): { group: Json; deviants: Json[] } {
  const rowKeys = new Set(["id", "frames", "textContent", "captionGroupId", "wordTimings"]);
  const counts = new Map<string, number>();
  let modalKey = "";
  let shared: Json = {};
  const entries = members.map((clip) => {
    const residual: Json = Object.fromEntries(Object.entries(clip).filter(([k]) => !rowKeys.has(k)));
    // Caption boxes are auto-fit per text; size is derived data, not signal.
    const t = asDict(residual.transform);
    if (t) {
      const trimmed = { ...t };
      delete trimmed.width;
      delete trimmed.height;
      if (Object.keys(trimmed).length === 0) delete residual.transform;
      else residual.transform = trimmed;
    }
    const key = jsonString(residual);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) > (counts.get(modalKey) ?? 0)) {
      modalKey = key;
      shared = residual;
    }
    return { clip, key };
  });

  let rows: unknown[][] = [];
  const deviants: Json[] = [];
  let frameMin = Number.MAX_SAFE_INTEGER;
  let frameMax = 0;
  for (const { clip, key } of entries) {
    const frames = Array.isArray(clip.frames) ? clip.frames : [];
    const start = num(frames[0]);
    const end = num(frames[frames.length - 1]);
    frameMin = Math.min(frameMin, start);
    frameMax = Math.max(frameMax, end);
    if (key === modalKey) rows.push([clip.id ?? "", start, end, clip.textContent ?? ""]);
    else deviants.push(clip);
  }

  const total = rows.length;
  if (window) rows = rows.filter((r) => num(r[1]) < window.end && num(r[2]) > window.start);
  rows.sort((a, b) => num(a[1]) - num(b[1]));

  const group: Json = { captionGroupId: gid, clipCount: total, frameRange: [frameMin, frameMax] };
  if (Object.keys(shared).length > 0) group.shared = shared;

  if (!detail) {
    const first = rows[0]?.[3];
    const last = rows[rows.length - 1]?.[3];
    if (typeof first === "string" && typeof last === "string") {
      group.textPreview = rows.length === 1 ? truncate(first) : `${truncate(first)} … ${truncate(last)}`;
    }
    group.clipsNote = `Per-clip rows omitted — re-read with captionDetail:true for ${swiftArray(captionRowFormat)} rows; get_transcript has the spoken words.`;
    return { group, deviants };
  }

  const shown = rows.slice(0, captionRowLimit);
  group.clipFormat = captionRowFormat;
  group.clips = shown;
  if (shown.length < total) group.clipsNote = `Showing ${shown.length} of ${total} caption clips. Page with startFrame/endFrame.`;
  return { group, deviants };
}

/** Swift interpolates `[String]` as `["a", "b"]`. */
function swiftArray(items: string[]): string {
  return `[${items.map((s) => `"${s}"`).join(", ")}]`;
}

function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length > captionPreviewLimit ? chars.slice(0, captionPreviewLimit).join("") + "…" : text;
}

function clipIntersects(clip: Json, window: FrameWindow): boolean {
  const frames = Array.isArray(clip.frames) ? clip.frames : [];
  return num(frames[0]) < window.end && num(frames[frames.length - 1]) > window.start;
}

// MARK: Keyframes

type Shape = "scalar" | "pair" | "crop";

function shapeValues(shape: Shape, raw: unknown): unknown[] {
  if (shape === "scalar") return [raw ?? 0];
  const v = asDict(raw);
  if (shape === "pair") return v ? [v.a ?? 0, v.b ?? 0] : [0, 0];
  return v ? [v.top ?? 0, v.right ?? 0, v.bottom ?? 0, v.left ?? 0] : [0, 0, 0, 0];
}

function nearlyEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.0005);
}

const keyframeTracks: [string, string, Shape][] = [
  ["volumeTrack", "volumeDb", "scalar"],
  ["opacityTrack", "opacity", "scalar"],
  ["rotationTrack", "rotation", "scalar"],
  ["positionTrack", "position", "pair"],
  ["scaleTrack", "scale", "pair"],
  ["cropTrack", "crop", "crop"],
];

function compactClipKeyframes(clip: Json): Json {
  const out: Json = { ...clip };
  if (typeof clip.volume === "number") {
    delete out.volume;
    const volumeDb = VolumeScale.dbFromLinear(clip.volume);
    if (!nearlyEqual([volumeDb], [0])) out.volumeDb = volumeDb;
  }
  const keyframes: Json = {};
  for (const [trackKey, propKey, shape] of keyframeTracks) {
    delete out[trackKey];
    const track = asDict(clip[trackKey]);
    const kfs = track ? asDictArray(track.keyframes) : [];
    if (kfs.length === 0) continue;

    const values = kfs.map((kf) => shapeValues(shape, kf.value).map((v) => (typeof v === "number" ? v : 0)));
    const first = values[0];
    if (values.every((v) => nearlyEqual(v, first)) && collapseConstantKeyframes(first, propKey, clip, out)) continue;

    keyframes[propKey] = kfs.map((kf, i) => {
      const row: unknown[] = [kf.frame ?? 0, ...values[i]];
      pushInterpolation(row, kf);
      return row;
    });
  }
  const effects = asDictArray(clip.effects);
  const blurEffect = effects.find((e) => e.type === gaussianBlurType);
  const radius = asDict(asDict(blurEffect?.params)?.[gaussianBlurRadiusKey]);
  const blurKeyframes = asDictArray(asDict(radius?.track)?.keyframes);
  if (blurKeyframes.length > 0) {
    keyframes.blur = blurKeyframes.map((kf) => {
      const row: unknown[] = [kf.frame ?? 0, typeof kf.value === "number" ? kf.value : 0];
      pushInterpolation(row, kf);
      return row;
    });
  }
  if (Object.keys(keyframes).length > 0) out.keyframes = keyframes;
  return out;
}

/** True when absorbed: identity tracks vanish; constants become the static field when it's at default. */
function collapseConstantKeyframes(value: number[], propKey: string, clip: Json, out: Json): boolean {
  switch (propKey) {
    case "volumeDb":
      if (nearlyEqual(value, [0])) return true;
      if (clip.volume !== 1) return false;
      out[propKey] = value[0];
      return true;
    case "opacity":
      if (nearlyEqual(value, [1])) return true;
      if (clip[propKey] !== 1) return false;
      out[propKey] = value[0];
      return true;
    case "rotation":
      return nearlyEqual(value, [0]);
    case "position":
      return nearlyEqual(value, [0, 0]);
    case "scale":
      return nearlyEqual(value, [1, 1]);
    case "crop": {
      if (nearlyEqual(value, [0, 0, 0, 0])) return true;
      const staticCrop = asDict(clip.crop) ?? {};
      if (!Object.values(staticCrop).every((v) => (typeof v === "number" ? v : 0) === 0)) return false;
      out.crop = { top: value[0], right: value[1], bottom: value[2], left: value[3] };
      return true;
    }
    default:
      return false;
  }
}

function pushInterpolation(row: unknown[], kf: Record<string, unknown>): void {
  if (typeof kf.interpolationOut !== "string" || kf.interpolationOut === "smooth") return;
  row.push(kf.interpolationOut);
  if (kf.interpolationOut === "bezier" && Array.isArray(kf.bezier)) row.push(kf.bezier);
}
