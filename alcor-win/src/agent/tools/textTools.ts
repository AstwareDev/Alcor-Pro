import { commitClipProperties } from "../../editor/mutations/clipMutations";
import { captionGroupTextClipIdsForGroup, placeTextClips, type TextClipSpec } from "../../editor/mutations/captions";
import { deepEqual } from "../../editor/mutations/core";
import { fitTextClipToContent } from "../../editor/mutations/textFit";
import { insertTrack, removeTrack } from "../../editor/mutations/tracks";
import {
  clipSetBlurKeyframeTrack, clipBlurKeyframeTrack, clipSetTextFillMode, defaultFootageMatteColor, fontCases, makeTextAnimation,
  makeTextStyle, makeTransform, rgbaSetRGB, textAnimationAgentValues, textFillModes,
  textLayoutNaturalSize, textStyleAxisScaleRange, transformTiltRotationRange, clipTypeIsCompatible, textAnimationPresets,
  type FontCase, type RGBA, type TextAlignment, type TextAnimation, type TextAnimationPreset, type TextFillMode, type TextStyle, type Transform,
} from "../../model";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { textAnchorX, textCenterX } from "./timelinePayload";
import { ToolError, argInt, argString, argStringArray, isRecord, parseAlignment, parseColorHex, requireInt, requireString, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of ToolExecutor+Texts.swift: add_texts / update_text.

export interface ParsedTextColorPatch {
  value: RGBA;
  includesOpacity: boolean;
}

export interface ParsedTextStylePatch {
  fontName?: string;
  fontSize?: number;
  widthScale?: number;
  heightScale?: number;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderlined?: boolean;
  isStruckThrough?: boolean;
  isOverlined?: boolean;
  tracking?: number;
  lineSpacing?: number;
  fontCase?: FontCase;
  color?: RGBA;
  alignment?: TextAlignment;
  outline?: { enabled?: boolean; color?: RGBA; width?: number };
  shadow?: { enabled?: boolean; color?: ParsedTextColorPatch; opacity?: number; offsetX?: number; offsetY?: number; blur?: number };
  background?: {
    enabled?: boolean;
    color?: ParsedTextColorPatch;
    opacity?: number;
    paddingX?: number;
    paddingY?: number;
    offsetX?: number;
    offsetY?: number;
    cornerRadius?: number;
    outlineColor?: RGBA;
    outlineWidth?: number;
  };
  blur?: number;
}

export interface ParsedTextTransform {
  x?: number;
  y?: number;
  rotation?: number;
  rotationX?: number;
  rotationY?: number;
}

type Obj = Record<string, unknown>;
type Range = { min: number; max: number };

const anyDefined = (o: object): boolean => Object.values(o).some((v) => v !== undefined);

function patchHasAnyField(p: ParsedTextStylePatch): boolean {
  return (
    p.fontName !== undefined || p.fontSize !== undefined || p.widthScale !== undefined || p.heightScale !== undefined ||
    p.isBold !== undefined || p.isItalic !== undefined || p.isUnderlined !== undefined || p.isStruckThrough !== undefined ||
    p.isOverlined !== undefined || p.tracking !== undefined || p.lineSpacing !== undefined || p.fontCase !== undefined ||
    p.color !== undefined || p.alignment !== undefined || (p.outline !== undefined && anyDefined(p.outline)) ||
    (p.shadow !== undefined && anyDefined(p.shadow)) || (p.background !== undefined && anyDefined(p.background)) || p.blur !== undefined
  );
}

function patchAffectsLayout(p: ParsedTextStylePatch): boolean {
  return (
    p.fontName !== undefined || p.fontSize !== undefined || p.widthScale !== undefined || p.heightScale !== undefined ||
    p.isBold !== undefined || p.isItalic !== undefined || p.tracking !== undefined || p.lineSpacing !== undefined ||
    p.fontCase !== undefined ||
    (p.outline !== undefined && (p.outline.enabled !== undefined || p.outline.width !== undefined)) ||
    (p.shadow !== undefined && (p.shadow.enabled !== undefined || p.shadow.offsetX !== undefined || p.shadow.offsetY !== undefined || p.shadow.blur !== undefined)) ||
    (p.background !== undefined && (p.background.enabled !== undefined || p.background.paddingX !== undefined || p.background.paddingY !== undefined))
  );
}

function optionalBool(args: Obj, key: string, path: string): boolean | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (typeof value !== "boolean") throw new ToolError(`${path}.${key}: expected boolean`);
  return value;
}

function optionalString(args: Obj, key: string, path: string): string | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`${path}.${key}: expected non-empty string`);
  return value;
}

function swiftNum(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function optionalNumber(args: Obj, key: string, path: string, range?: Range): number | undefined {
  if (!(key in args)) return undefined;
  const raw = args[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new ToolError(`${path}.${key}: expected finite number`);
  if (range && !(raw >= range.min && raw <= range.max)) {
    throw new ToolError(`${path}.${key}: must be between ${swiftNum(range.min)} and ${swiftNum(range.max)}`);
  }
  return raw;
}

function optionalObject(args: Obj, key: string, path: string): Obj | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (!isRecord(value)) throw new ToolError(`${path}.${key}: expected object`);
  return value;
}

function optionalColor(args: Obj, key: string, path: string): ParsedTextColorPatch | undefined {
  if (!(key in args)) return undefined;
  const raw = args[key];
  if (typeof raw !== "string") throw new ToolError(`${path}.${key}: expected string`);
  const value = parseColorHex(raw, `${path}.${key}`);
  if (!value) return undefined;
  const digits = raw.trim().replace(/^#+/, "");
  return { value, includesOpacity: Array.from(digits).length === 8 };
}

function optionalPair(args: Obj, key: string, path: string, range: Range): { x?: number; y?: number } | undefined {
  const pair = optionalObject(args, key, path);
  if (!pair) return undefined;
  const pairPath = `${path}.${key}`;
  validateUnknownKeys(pair, ["x", "y"], pairPath);
  return { x: optionalNumber(pair, "x", pairPath, range), y: optionalNumber(pair, "y", pairPath, range) };
}

function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function parseOutlinePatch(raw: unknown, path: string): ParsedTextStylePatch["outline"] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ToolError(`${path}: expected object`);
  validateUnknownKeys(raw, ["enabled", "color", "width"], path);
  return definedOnly({
    enabled: optionalBool(raw, "enabled", path),
    color: optionalColor(raw, "color", path)?.value,
    width: optionalNumber(raw, "width", path, { min: 0, max: 40 }),
  });
}

function parseShadowPatch(raw: unknown, path: string): ParsedTextStylePatch["shadow"] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ToolError(`${path}: expected object`);
  validateUnknownKeys(raw, ["enabled", "color", "opacity", "offset", "blur"], path);
  const offset = optionalPair(raw, "offset", path, { min: -200, max: 200 });
  return definedOnly({
    enabled: optionalBool(raw, "enabled", path),
    color: optionalColor(raw, "color", path),
    opacity: optionalNumber(raw, "opacity", path, { min: 0, max: 1 }),
    offsetX: offset?.x,
    offsetY: offset?.y,
    blur: optionalNumber(raw, "blur", path, { min: 0, max: 100 }),
  });
}

function parseBackgroundPatch(raw: unknown, path: string): ParsedTextStylePatch["background"] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ToolError(`${path}: expected object`);
  validateUnknownKeys(raw, ["enabled", "color", "opacity", "padding", "center", "cornerRadius", "outline"], path);
  const padding = optionalPair(raw, "padding", path, { min: 0, max: 300 });
  const center = optionalPair(raw, "center", path, { min: -500, max: 500 });
  const outline = optionalObject(raw, "outline", path);
  if (outline) validateUnknownKeys(outline, ["color", "width"], `${path}.outline`);
  return definedOnly({
    enabled: optionalBool(raw, "enabled", path),
    color: optionalColor(raw, "color", path),
    opacity: optionalNumber(raw, "opacity", path, { min: 0, max: 1 }),
    paddingX: padding?.x,
    paddingY: padding?.y,
    offsetX: center?.x,
    offsetY: center?.y,
    cornerRadius: optionalNumber(raw, "cornerRadius", path, { min: 0, max: 300 }),
    outlineColor: outline ? optionalColor(outline, "color", `${path}.outline`)?.value : undefined,
    outlineWidth: outline ? optionalNumber(outline, "width", `${path}.outline`, { min: 0, max: 40 }) : undefined,
  });
}

function parseTextStylePatchObject(args: Obj, path: string): ParsedTextStylePatch {
  validateUnknownKeys(
    args,
    [
      "fontName", "fontSize", "widthScale", "heightScale", "bold", "italic", "underline", "strikethrough", "overline",
      "tracking", "lineSpacing", "fontCase", "color", "alignment", "outline", "shadow", "background", "blur",
    ],
    path,
  );
  const outline = parseOutlinePatch(args.outline, `${path}.outline`);
  const shadow = parseShadowPatch(args.shadow, `${path}.shadow`);
  const background = parseBackgroundPatch(args.background, `${path}.background`);

  let fontCase: FontCase | undefined;
  if ("fontCase" in args) {
    if (typeof args.fontCase !== "string" || !(fontCases as readonly string[]).includes(args.fontCase)) {
      throw new ToolError(`${path}.fontCase: expected mixed, uppercase, or lowercase`);
    }
    fontCase = args.fontCase as FontCase;
  }
  let alignment: TextAlignment | undefined;
  if ("alignment" in args) {
    if (typeof args.alignment !== "string") throw new ToolError(`${path}.alignment: expected string`);
    alignment = parseAlignment(args.alignment, `${path}.alignment`);
  }

  return definedOnly({
    fontName: optionalString(args, "fontName", path),
    fontSize: optionalNumber(args, "fontSize", path, { min: 12, max: 300 }),
    widthScale: optionalNumber(args, "widthScale", path, textStyleAxisScaleRange),
    heightScale: optionalNumber(args, "heightScale", path, textStyleAxisScaleRange),
    isBold: optionalBool(args, "bold", path),
    isItalic: optionalBool(args, "italic", path),
    isUnderlined: optionalBool(args, "underline", path),
    isStruckThrough: optionalBool(args, "strikethrough", path),
    isOverlined: optionalBool(args, "overline", path),
    tracking: optionalNumber(args, "tracking", path, { min: -20, max: 100 }),
    lineSpacing: optionalNumber(args, "lineSpacing", path, { min: -100, max: 300 }),
    fontCase,
    color: optionalColor(args, "color", path)?.value,
    alignment,
    outline,
    shadow,
    background,
    blur: optionalNumber(args, "blur", path, { min: 0, max: 100 }),
  });
}

export function parseTextStylePatch(args: Obj, path: string): ParsedTextStylePatch | undefined {
  if (!("style" in args)) return undefined;
  if (!isRecord(args.style)) throw new ToolError(`${path}.style: expected object`);
  return parseTextStylePatchObject(args.style, `${path}.style`);
}

export function applyTextStylePatch(patch: ParsedTextStylePatch, style: TextStyle): void {
  if (patch.fontName !== undefined) style.fontName = patch.fontName;
  if (patch.fontSize !== undefined) style.fontSize = patch.fontSize;
  if (patch.widthScale !== undefined) style.widthScale = patch.widthScale;
  if (patch.heightScale !== undefined) style.heightScale = patch.heightScale;
  if (patch.isBold !== undefined) style.isBold = patch.isBold;
  if (patch.isItalic !== undefined) style.isItalic = patch.isItalic;
  if (patch.isUnderlined !== undefined) style.isUnderlined = patch.isUnderlined;
  if (patch.isStruckThrough !== undefined) style.isStruckThrough = patch.isStruckThrough;
  if (patch.isOverlined !== undefined) style.isOverlined = patch.isOverlined;
  if (patch.tracking !== undefined) style.tracking = patch.tracking;
  if (patch.lineSpacing !== undefined) style.lineSpacing = patch.lineSpacing;
  if (patch.fontCase !== undefined) style.fontCase = patch.fontCase;
  if (patch.color !== undefined) style.color = structuredClone(patch.color);
  if (patch.alignment !== undefined) style.alignment = patch.alignment;
  if (patch.blur !== undefined) style.blur = patch.blur;
  const outline = patch.outline;
  if (outline) {
    if (outline.enabled !== undefined) style.border.enabled = outline.enabled;
    if (outline.color !== undefined) style.border.color = structuredClone(outline.color);
    if (outline.width !== undefined) style.border.width = outline.width;
  }
  const shadow = patch.shadow;
  if (shadow) {
    if (shadow.enabled !== undefined) style.shadow.enabled = shadow.enabled;
    if (shadow.color) {
      if (shadow.color.includesOpacity) style.shadow.color = structuredClone(shadow.color.value);
      else rgbaSetRGB(style.shadow.color, shadow.color.value);
    }
    if (shadow.opacity !== undefined) style.shadow.color.a = shadow.opacity;
    if (shadow.offsetX !== undefined) style.shadow.offsetX = shadow.offsetX;
    if (shadow.offsetY !== undefined) style.shadow.offsetY = shadow.offsetY;
    if (shadow.blur !== undefined) style.shadow.blur = shadow.blur;
  }
  const background = patch.background;
  if (background) {
    if (background.enabled !== undefined) style.background.enabled = background.enabled;
    if (background.color) {
      if (background.color.includesOpacity) style.background.color = structuredClone(background.color.value);
      else rgbaSetRGB(style.background.color, background.color.value);
    }
    if (background.opacity !== undefined) style.background.color.a = background.opacity;
    if (background.paddingX !== undefined) style.background.paddingX = background.paddingX;
    if (background.paddingY !== undefined) style.background.paddingY = background.paddingY;
    if (background.offsetX !== undefined) style.background.offsetX = background.offsetX;
    if (background.offsetY !== undefined) style.background.offsetY = background.offsetY;
    if (background.cornerRadius !== undefined) style.background.cornerRadius = background.cornerRadius;
    if (background.outlineColor !== undefined) style.background.outlineColor = structuredClone(background.outlineColor);
    if (background.outlineWidth !== undefined) style.background.outlineWidth = background.outlineWidth;
  }
}

/** Returns a TextAnimation for an agent 'animation' spec, or undefined if 'off' or not set. */
export function parseTextAnimation(preset: string | undefined, highlightColor: string | undefined, path: string): TextAnimation | undefined {
  if (preset === undefined || preset === "off") return undefined;
  if (!(textAnimationPresets as readonly string[]).includes(preset) || preset === "none") {
    throw new ToolError(`${path}: animation must be one of ${textAnimationAgentValues.join(", ")}`);
  }
  const anim = makeTextAnimation({ preset: preset as TextAnimationPreset });
  const hex = parseColorHex(highlightColor, path);
  if (hex) anim.highlight = hex;
  return anim;
}

function parseTextFillMode(raw: string | undefined, path: string): TextFillMode | undefined {
  if (raw === undefined) return undefined;
  if (!(textFillModes as readonly string[]).includes(raw)) throw new ToolError(`${path}.fillMode: expected ${textFillModes.join(", ")}`);
  return raw as TextFillMode;
}

export function parseTextTransform(raw: unknown, path: string): ParsedTextTransform | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ToolError(`${path}: expected object`);
  validateUnknownKeys(raw, ["x", "y", "rotation", "rotationX", "rotationY"], path);
  const transform = definedOnly({
    x: optionalNumber(raw, "x", path),
    y: optionalNumber(raw, "y", path),
    rotation: optionalNumber(raw, "rotation", path),
    rotationX: optionalNumber(raw, "rotationX", path, transformTiltRotationRange),
    rotationY: optionalNumber(raw, "rotationY", path, transformTiltRotationRange),
  });
  return anyDefined(transform) ? transform : undefined;
}

function makeAddTextTransform(
  executor: ToolContext["executor"],
  transform: ParsedTextTransform | undefined,
  content: string,
  style: TextStyle,
  canvas: { w: number; h: number },
): Transform | undefined {
  if (!transform) return undefined;
  const natural = textLayoutNaturalSize(content, style, canvas.w * 0.9, canvas.h, executor.measureText);
  const width = natural.width / canvas.w;
  return makeTransform({
    centerX: transform.x !== undefined ? textCenterX(transform.x, width, style.alignment) : 0.5,
    centerY: transform.y ?? 0.5,
    width,
    height: natural.height / canvas.h,
    rotation: transform.rotation ?? 0,
    rotationX: transform.rotationX ?? 0,
    rotationY: transform.rotationY ?? 0,
  });
}

const addTextsAllowedKeys = ["trackIndex", "startFrame", "endFrame", "content", "style", "transform", "animation", "highlightColor", "fillMode"];
const updateTextAllowedKeys = ["clipIds", "captionGroupId", "content", "style", "transform", "animation", "highlightColor", "fillMode"];

interface PartialTextSpec {
  trackId?: string;
  startFrame: number;
  durationFrames: number;
  content: string;
  style: TextStyle;
  transform?: Transform;
  animation?: TextAnimation;
  fillMode?: TextFillMode;
}

export function addTexts({ executor, editor }: ToolContext, args: ToolArgs): ToolResult {
  const rawEntries = args.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) throw new ToolError("Missing or empty 'entries' array");

  const partials: PartialTextSpec[] = rawEntries.map((raw, idx) => {
    const path = `entries[${idx}]`;
    if (!isRecord(raw)) throw new ToolError(`${path} must be an object`);
    validateUnknownKeys(raw, addTextsAllowedKeys, path);

    const trackIndex = argInt(raw, "trackIndex");
    const startFrame = requireInt(raw, "startFrame");
    const endFrame = requireInt(raw, "endFrame");
    const content = requireString(raw, "content");

    let trackId: string | undefined;
    if (trackIndex !== undefined) {
      const tracks = editor.timeline.tracks;
      if (!(trackIndex >= 0 && trackIndex < tracks.length)) {
        throw new ToolError(`${path}: track index ${trackIndex} out of range (0..${tracks.length - 1})`);
      }
      if (!clipTypeIsCompatible("text", tracks[trackIndex].type)) {
        throw new ToolError(`${path}: track ${trackIndex} is an audio track; text requires a video/image/text track`);
      }
      trackId = tracks[trackIndex].id;
    }
    if (!(startFrame >= 0)) throw new ToolError(`${path}: startFrame must be >= 0 (got ${startFrame})`);
    if (!(endFrame > startFrame)) throw new ToolError(`${path}: endFrame (${endFrame}) must be greater than startFrame (${startFrame})`);

    const stylePatch = parseTextStylePatch(raw, path);
    const fillMode = parseTextFillMode(argString(raw, "fillMode"), path);
    const style = makeTextStyle();
    if (stylePatch) applyTextStylePatch(stylePatch, style);
    if (fillMode === "footage" && stylePatch?.color === undefined) style.color = defaultFootageMatteColor();

    const transform = makeAddTextTransform(
      executor,
      parseTextTransform(raw.transform, `${path}.transform`),
      content,
      style,
      { w: editor.timeline.width, h: editor.timeline.height },
    );
    const animation = parseTextAnimation(argString(raw, "animation"), argString(raw, "highlightColor"), path);
    return {
      ...(trackId !== undefined ? { trackId } : {}),
      startFrame,
      durationFrames: endFrame - startFrame,
      content,
      style,
      ...(transform ? { transform } : {}),
      ...(animation ? { animation } : {}),
      ...(fillMode ? { fillMode } : {}),
    };
  });

  // All-or-none: a new track at index 0 would shift any explicit indices.
  const omittedCount = partials.filter((p) => p.trackId === undefined).length;
  if (!(omittedCount === 0 || omittedCount === partials.length)) {
    throw new ToolError(
      `Mixed trackIndex: ${omittedCount} of ${partials.length} entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create a shared new track).`,
    );
  }

  const snapshot = timelineSnapshot(editor);
  editor.perform(partials.length === 1 ? "Add Text (Agent)" : "Add Texts (Agent)", () => {
    let createdTrackId: string | undefined;
    let resolvedTrackId: string | undefined;
    if (omittedCount === partials.length) {
      const newIdx = insertTrack(editor, 0, "video");
      createdTrackId = newIdx >= 0 && newIdx < editor.timeline.tracks.length ? editor.timeline.tracks[newIdx].id : undefined;
      resolvedTrackId = createdTrackId;
    }

    const specs: TextClipSpec[] = partials.flatMap((p) => {
      const id = resolvedTrackId ?? p.trackId;
      const trackIdx = id === undefined ? -1 : editor.timeline.tracks.findIndex((t) => t.id === id);
      if (trackIdx < 0) return [];
      return [{
        trackIndex: trackIdx,
        startFrame: p.startFrame,
        durationFrames: p.durationFrames,
        content: p.content,
        style: p.style,
        ...(p.transform ? { transform: p.transform } : {}),
        ...(p.animation ? { animation: p.animation } : {}),
        ...(p.fillMode ? { fillMode: p.fillMode } : {}),
      }];
    });

    const ids = placeTextClips(editor, specs, { measure: executor.measureText });
    if (ids.length === 0) {
      if (createdTrackId !== undefined) removeTrack(editor, createdTrackId);
      throw new ToolError("Failed to place any text clips");
    }
  });
  return mutationResult(editor, snapshot);
}

export function updateText({ executor, editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, updateTextAllowedKeys, "update_text");

  const hasContent = "content" in args;
  let content: string | undefined;
  if (hasContent) {
    if (typeof args.content !== "string") throw new ToolError("update_text.content: expected String");
    content = args.content;
  }

  const clipIds = argStringArray(args, "clipIds");
  const gid = argString(args, "captionGroupId");
  if (gid !== undefined) {
    const groupIds = captionGroupTextClipIdsForGroup(editor, gid);
    if (groupIds.length === 0) throw new ToolError(`No caption clips found for captionGroupId: ${gid}`);
    const seen = new Set(clipIds);
    for (const id of groupIds) {
      if (!seen.has(id)) {
        seen.add(id);
        clipIds.push(id);
      }
    }
  }
  if (clipIds.length === 0) throw new ToolError("Provide a non-empty 'clipIds' array or a 'captionGroupId'");

  const textStylePatch = parseTextStylePatch(args, "update_text");
  const transform = parseTextTransform(args.transform, "update_text.transform");
  const animationName = argString(args, "animation");
  const animation = parseTextAnimation(animationName, argString(args, "highlightColor"), "update_text");
  const shouldSetAnimation = animationName !== undefined;
  const highlightOnly = shouldSetAnimation ? undefined : parseColorHex(argString(args, "highlightColor"), "update_text");
  const fillMode = parseTextFillMode(argString(args, "fillMode"), "update_text");

  if (!(hasContent || (textStylePatch !== undefined && patchHasAnyField(textStylePatch)) || transform !== undefined || shouldSetAnimation || highlightOnly !== undefined || fillMode !== undefined)) {
    throw new ToolError("update_text needs at least one text property to apply");
  }

  for (const id of clipIds) {
    const loc = editor.findClip(id);
    if (!loc) throw new ToolError(`Clip not found: ${id}`);
    const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
    if (clip.mediaType !== "text") throw new ToolError(`update_text only applies to text clips: ${id} is ${clip.mediaType}`);
  }

  const notes: string[] = [];
  if (hasContent) {
    const timingCleared = clipIds.filter((id) => {
      const clip = editor.clipFor(id);
      return clip !== null && clip.wordTimings !== undefined && clip.textContent !== content;
    });
    if (timingCleared.length > 0) {
      notes.push(`Content change cleared word timings on ${timingCleared.length} clip${timingCleared.length === 1 ? "" : "s"} — karaoke highlighting falls back to plain text there.`);
    }
  }
  if (transform?.rotation !== undefined) {
    const cleared = clipIds.filter((id) => editor.clipFor(id)?.rotationTrack !== undefined);
    if (cleared.length > 0) notes.push(`Static rotation cleared existing rotation keyframes on: ${cleared.join(", ")}.`);
  }
  if (textStylePatch?.blur !== undefined) {
    const cleared = clipIds.filter((id) => {
      const clip = editor.clipFor(id);
      return clip !== null && clipBlurKeyframeTrack(clip) !== undefined;
    });
    if (cleared.length > 0) notes.push(`Static blur cleared existing blur keyframes on: ${cleared.join(", ")}.`);
  }

  const beforeClips = new Map(clipIds.map((id) => [id, editor.clipFor(id)] as const));
  const snapshot = timelineSnapshot(editor);
  const shouldFitToContent = hasContent || (textStylePatch !== undefined && patchAffectsLayout(textStylePatch));
  const canvasW = editor.timeline.width;
  const canvasH = editor.timeline.height;
  commitClipProperties(
    editor,
    clipIds,
    (clip) => {
      const originalStyle = clip.textStyle ?? makeTextStyle();
      const originalAnchorX = textAnchorX(clip.transform.centerX, clip.transform.width, originalStyle.alignment);
      if (content !== undefined) {
        if (clip.textContent !== content) delete clip.wordTimings;
        clip.textContent = content;
      }
      if (textStylePatch && patchHasAnyField(textStylePatch)) {
        const style = structuredClone(clip.textStyle ?? makeTextStyle());
        applyTextStylePatch(textStylePatch, style);
        clip.textStyle = style;
        if (textStylePatch.blur !== undefined) clipSetBlurKeyframeTrack(clip, undefined);
      }
      if (shouldFitToContent) fitTextClipToContent(clip, canvasW, canvasH, executor.measureText);
      const updatedStyle = clip.textStyle ?? makeTextStyle();
      if (shouldFitToContent || textStylePatch?.alignment !== undefined || transform?.x !== undefined) {
        clip.transform.centerX = textCenterX(transform?.x ?? originalAnchorX, clip.transform.width, updatedStyle.alignment);
      }
      if (transform?.y !== undefined) clip.transform.centerY = transform.y;
      if (transform?.rotation !== undefined) {
        clip.transform.rotation = transform.rotation;
        delete clip.rotationTrack;
      }
      if (transform?.rotationX !== undefined) clip.transform.rotationX = transform.rotationX;
      if (transform?.rotationY !== undefined) clip.transform.rotationY = transform.rotationY;
      if (shouldSetAnimation) {
        if (animation) {
          const current = clip.textAnimation ? structuredClone(clip.textAnimation) : makeTextAnimation();
          current.preset = animation.preset;
          if (animation.highlight) current.highlight = animation.highlight;
          clip.textAnimation = current;
        } else {
          delete clip.textAnimation;
        }
      }
      if (highlightOnly) {
        const a = clip.textAnimation ? structuredClone(clip.textAnimation) : makeTextAnimation();
        a.highlight = highlightOnly;
        clip.textAnimation = a;
      }
      if (fillMode) clipSetTextFillMode(clip, fillMode, textStylePatch?.color);
    },
    clipIds.length === 1 ? "Update Text (Agent)" : "Update Texts (Agent)",
  );

  const changed = [...beforeClips].some(([id, clip]) => !deepEqual(editor.clipFor(id), clip));
  return mutationResult(editor, snapshot, { touched: clipIds, extra: { changed }, notes });
}

