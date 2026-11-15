import { addMask, deleteMaskKeyframe, maskIn, removeMask, reorderMaskIn, upsertMaskKeyframe } from "../../editor/mutations/masks";
import { mutateClips } from "../../editor/mutations/clipMutations";
import {
  clipContainsTimelineFrame, clipTypeIsVisual, interpolations, keyframeTrackIsActive, makeEllipsePath, makeMaskPath,
  makeMaskVertex, makeRectanglePath, maskExpansionRange, maskFeatherMax, maskModes, maskProperties, maskShapes, maskTrack,
  maskTrackKey, type Clip, type Interpolation, type Mask, type MaskMode, type MaskPath, type MaskProperty, type MaskShape,
} from "../../model";
import { snapshot } from "../../util/snapshot";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { ToolError, decodeToolArgs, isRecord } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

const minimumVertices = 3;

function finite(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${path}: expected a finite number.`);
  return v;
}

function ranged(v: unknown, path: string, min: number, max: number): number {
  const n = finite(v, path);
  if (n < min || n > max) throw new ToolError(`${path}: must be from ${min} through ${max}.`);
  return n;
}

function parsePoints(raw: unknown, path: string, closed: boolean): MaskPath {
  if (!Array.isArray(raw)) throw new ToolError(`${path}: expected an array of {x, y} points.`);
  const vertices = raw.map((p, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(p)) throw new ToolError(`${at}: expected an object with x and y.`);
    const num = (key: string, fallback?: number): number => (p[key] === undefined && fallback !== undefined ? fallback : finite(p[key], `${at}.${key}`));
    return makeMaskVertex(num("x"), num("y"), { inX: num("inX", 0), inY: num("inY", 0), outX: num("outX", 0), outY: num("outY", 0) });
  });
  if (vertices.length < minimumVertices) throw new ToolError(`${path}: a mask path needs at least ${minimumVertices} points.`);
  return makeMaskPath(vertices, closed);
}

function enumArg<T extends string>(raw: unknown, values: readonly T[], path: string): T {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) throw new ToolError(`${path}: expected one of ${values.join(", ")}.`);
  return raw as T;
}

function requireMaskClip({ editor }: ToolContext, clipId: string): Clip {
  const clip = editor.clipFor(clipId);
  if (!clip) throw new ToolError(`Clip not found: ${clipId}`);
  if (!clipTypeIsVisual(clip.mediaType)) throw new ToolError(`Clip ${clipId} is a ${clip.mediaType} clip; masks need a video, image or text clip.`);
  return clip;
}

function requireMask(clip: Clip, maskId: string): Mask {
  const mask = maskIn(clip, maskId);
  if (!mask) {
    const known = (clip.masks ?? []).map((m) => `${m.id} (${m.name})`).join(", ") || "none";
    throw new ToolError(`Mask not found: ${maskId}. Masks on this clip: ${known}.`);
  }
  return mask;
}

function maskSummary(mask: Mask): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: mask.id, name: mask.name, shape: mask.shape, mode: mask.mode, inverted: mask.inverted,
    feather: mask.feather, expansion: mask.expansion, opacity: mask.opacity, closed: mask.path.closed, points: mask.path.vertices.length,
  };
  const animated = maskProperties.filter((p) => maskTrack(mask, p) !== undefined);
  if (animated.length > 0) summary.keyframed = animated;
  return summary;
}

function masksExtra(editor: ToolContext["editor"], clipId: string, maskId?: string): Record<string, unknown> {
  const masks = (editor.clipFor(clipId)?.masks ?? []).map(maskSummary);
  return maskId === undefined ? { clipId, masks } : { clipId, maskId, masks };
}

interface Rect { x: number; y: number; width: number; height: number }

function parseRect(raw: unknown): Rect {
  if (!isRecord(raw)) throw new ToolError("rect: expected {x, y, width, height}.");
  const r = { x: finite(raw.x, "rect.x"), y: finite(raw.y, "rect.y"), width: finite(raw.width, "rect.width"), height: finite(raw.height, "rect.height") };
  if (!(r.width > 0 && r.height > 0)) throw new ToolError("rect: width and height must be greater than 0.");
  return r;
}

const baseFields = {
  clipId: { spec: "string", required: true },
  name: { spec: "string" },
  mode: { spec: "string" },
  inverted: { spec: "bool" },
  feather: { spec: "double" },
  expansion: { spec: "double" },
  opacity: { spec: "double" },
  points: { spec: "any" },
  closed: { spec: "bool" },
} as const;

interface BaseArgs {
  clipId: string; name?: string; mode?: string; inverted?: boolean; feather?: number; expansion?: number; opacity?: number;
  points?: unknown; closed?: boolean;
}

function validateBase(a: BaseArgs): { mode?: MaskMode; feather?: number; expansion?: number; opacity?: number } {
  const out: { mode?: MaskMode; feather?: number; expansion?: number; opacity?: number } = {};
  if (a.name !== undefined && a.name.trim() === "") throw new ToolError("name: must not be empty.");
  if (a.mode !== undefined) out.mode = enumArg(a.mode, maskModes, "mode");
  if (a.feather !== undefined) out.feather = ranged(a.feather, "feather", 0, maskFeatherMax);
  if (a.expansion !== undefined) out.expansion = ranged(a.expansion, "expansion", maskExpansionRange.min, maskExpansionRange.max);
  if (a.opacity !== undefined) out.opacity = ranged(a.opacity, "opacity", 0, 1);
  return out;
}

export function addMaskTool(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const a = decodeToolArgs<BaseArgs & { shape: string; rect?: unknown }>(args, "add_mask", {
    ...baseFields, shape: { spec: "string", required: true }, rect: { spec: "any" },
  });
  requireMaskClip(context, a.clipId);
  const shape: MaskShape = enumArg(a.shape, maskShapes, "shape");
  const fields = validateBase(a);
  let path: MaskPath | undefined;
  if (shape === "path") {
    if (a.points === undefined) throw new ToolError("add_mask: shape 'path' needs `points`.");
    if (a.rect !== undefined) throw new ToolError("add_mask: `rect` applies to rectangle and ellipse only.");
    path = parsePoints(a.points, "points", a.closed ?? true);
  } else {
    if (a.points !== undefined || a.closed !== undefined) throw new ToolError(`add_mask: \`points\` and \`closed\` apply to shape 'path' only.`);
    if (a.rect !== undefined) {
      const r = parseRect(a.rect);
      path = shape === "rectangle"
        ? makeRectanglePath(r.x, r.y, r.x + r.width, r.y + r.height)
        : makeEllipsePath(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2);
    }
  }

  const since = timelineSnapshot(editor);
  const id = addMask(editor, a.clipId, shape, {
    ...(path ? { path } : {}),
    ...(a.name ? { name: a.name.trim() } : {}),
    ...fields,
    ...(a.inverted !== undefined ? { inverted: a.inverted } : {}),
  });
  if (id === undefined) throw new ToolError(`add_mask: could not add a mask to clip ${a.clipId}.`);
  return mutationResult(editor, since, { touched: [a.clipId], extra: masksExtra(editor, a.clipId, id) });
}

interface KeyframeArg { property?: unknown; frame?: unknown; value?: unknown; points?: unknown; interpolation?: unknown }

function parseKeyframes(raw: unknown, clip: Clip, mask: Mask): { property: MaskProperty; frame: number; value: number | MaskPath; interpolation?: Interpolation }[] {
  if (!Array.isArray(raw)) throw new ToolError("keyframes: expected an array.");
  return raw.map((entry: KeyframeArg, i) => {
    const at = `keyframes[${i}]`;
    if (!isRecord(entry)) throw new ToolError(`${at}: expected an object.`);
    const property = enumArg(entry.property, maskProperties, `${at}.property`);
    const frame = finite(entry.frame, `${at}.frame`);
    if (!Number.isInteger(frame) || !clipContainsTimelineFrame(clip, frame)) {
      throw new ToolError(`${at}.frame: must be an integer timeline frame inside the clip (${clip.startFrame}–${clip.startFrame + clip.durationFrames - 1}).`);
    }
    const interpolation = entry.interpolation === undefined ? undefined : enumArg(entry.interpolation, interpolations, `${at}.interpolation`);
    let value: number | MaskPath;
    if (property === "path") {
      if (entry.points === undefined) throw new ToolError(`${at}: a path keyframe needs \`points\`.`);
      value = parsePoints(entry.points, `${at}.points`, mask.path.closed);
    } else {
      if (entry.value === undefined) throw new ToolError(`${at}: a ${property} keyframe needs \`value\`.`);
      value = property === "opacity" ? ranged(entry.value, `${at}.value`, 0, 1)
        : property === "feather" ? ranged(entry.value, `${at}.value`, 0, maskFeatherMax)
        : ranged(entry.value, `${at}.value`, maskExpansionRange.min, maskExpansionRange.max);
    }
    return { property, frame, value, ...(interpolation ? { interpolation } : {}) };
  });
}

function isKeyframed(mask: Mask, property: MaskProperty): boolean {
  const track = maskTrack(mask, property);
  return track !== undefined && keyframeTrackIsActive(track);
}

export function updateMaskTool(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const a = decodeToolArgs<BaseArgs & { maskId: string; order?: number; keyframes?: unknown }>(args, "update_mask", {
    ...baseFields, maskId: { spec: "string", required: true }, order: { spec: "int" }, keyframes: { spec: "any" },
  });
  const clip = requireMaskClip(context, a.clipId);
  const mask = requireMask(clip, a.maskId);
  const fields = validateBase(a);
  const keyframes = a.keyframes === undefined ? [] : parseKeyframes(a.keyframes, clip, mask);
  const path = a.points !== undefined ? parsePoints(a.points, "points", a.closed ?? mask.path.closed) : undefined;
  if (path === undefined && a.closed !== undefined && isKeyframed(mask, "path")) throw new ToolError("closed: the path is keyframed; stamp new path keyframes instead.");
  for (const [property, given] of [["feather", fields.feather], ["expansion", fields.expansion], ["opacity", fields.opacity], ["path", path]] as const) {
    if (given !== undefined && isKeyframed(mask, property)) {
      throw new ToolError(`${property} is keyframed on this mask; use \`keyframes\` to change it or remove its keyframes with remove_mask first.`);
    }
  }
  const stackSize = clip.masks?.length ?? 0;
  if (a.order !== undefined && (a.order < 0 || a.order >= stackSize)) throw new ToolError(`order: must be from 0 through ${stackSize - 1}.`);
  const changes = a.name !== undefined || a.inverted !== undefined || a.order !== undefined || a.closed !== undefined || path !== undefined ||
    Object.keys(fields).length > 0 || keyframes.length > 0;
  if (!changes) throw new ToolError("update_mask: provide at least one field to change.");

  const since = timelineSnapshot(editor);
  mutateClips(editor, new Set([a.clipId]), "Edit Mask (Agent)", (c) => {
    const m = maskIn(c, a.maskId);
    if (!m) return;
    if (a.name !== undefined) m.name = a.name.trim();
    if (fields.mode !== undefined) m.mode = fields.mode;
    if (a.inverted !== undefined) m.inverted = a.inverted;
    if (fields.feather !== undefined) m.feather = fields.feather;
    if (fields.expansion !== undefined) m.expansion = fields.expansion;
    if (fields.opacity !== undefined) m.opacity = fields.opacity;
    if (path !== undefined) m.path = path;
    else if (a.closed !== undefined) m.path = { closed: a.closed, vertices: structuredClone(snapshot(m.path.vertices)) };
    for (const k of keyframes) upsertMaskKeyframe(c, a.maskId, k.property, k.frame, k.value, k.interpolation);
    if (a.order !== undefined) reorderMaskIn(c, a.maskId, a.order);
  });
  return mutationResult(editor, since, { touched: [a.clipId], extra: masksExtra(editor, a.clipId, a.maskId) });
}

export function removeMaskTool(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const a = decodeToolArgs<{ clipId: string; maskId: string; keyframes?: unknown }>(args, "remove_mask", {
    clipId: { spec: "string", required: true }, maskId: { spec: "string", required: true }, keyframes: { spec: "any" },
  });
  const clip = requireMaskClip(context, a.clipId);
  const mask = requireMask(clip, a.maskId);
  const since = timelineSnapshot(editor);
  if (a.keyframes === undefined) {
    removeMask(editor, a.clipId, a.maskId);
    return mutationResult(editor, since, { touched: [a.clipId], extra: { ...masksExtra(editor, a.clipId), removedMaskId: a.maskId } });
  }
  if (!Array.isArray(a.keyframes) || a.keyframes.length === 0) throw new ToolError("keyframes: expected a non-empty array.");
  const entries = a.keyframes.map((entry: unknown, i) => {
    const at = `keyframes[${i}]`;
    if (!isRecord(entry)) throw new ToolError(`${at}: expected an object.`);
    const property = enumArg(entry.property, maskProperties, `${at}.property`);
    const frame = entry.frame === undefined ? undefined : finite(entry.frame, `${at}.frame`);
    const track = maskTrack(mask, property);
    if (!track) throw new ToolError(`${at}: mask has no ${property} keyframes.`);
    if (frame !== undefined && !track.keyframes.some((k) => k.frame === frame - clip.startFrame)) {
      throw new ToolError(`${at}: no ${property} keyframe at frame ${frame}.`);
    }
    return { property, frame };
  });
  mutateClips(editor, new Set([a.clipId]), "Delete Mask Keyframes (Agent)", (c) => {
    for (const { property, frame } of entries) {
      const m = maskIn(c, a.maskId);
      if (!m) return;
      if (frame !== undefined) deleteMaskKeyframe(c, a.maskId, property, frame);
      else delete m[maskTrackKey(property)];
    }
  });
  return mutationResult(editor, since, { touched: [a.clipId], extra: masksExtra(editor, a.clipId, a.maskId) });
}
