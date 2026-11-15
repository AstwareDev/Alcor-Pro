import { makeTextAnimation, textStyleCaption } from "../../model";
import type { Editor } from "../../editor/editor";
import { generateCaptions, importCaptions, makeCaptionRequest } from "../../captions/captionGeneration";
import { makeCaptionGapSettings, captionGapSettingsDefault, captionMaximumGapRange, type CaptionGapSettings } from "../../captions/captionGapSettings";
import { captionDefaultCenter } from "../../captions/constants";
import { SubtitleParseError } from "../../captions/subtitleFileParser";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { ToolError, argBool, argString, exactJSONInt, validateUnknownKeys } from "./toolArgs";
import { applyTextStylePatch, parseTextAnimation, parseTextStylePatch, parseTextTransform } from "./textTools";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";
import { textCenterX } from "./timelinePayload";
import {
  resolveTranscriptionScope, scopeCaptionRequest, transcriptionContext, transcriptionToolDeps,
} from "./transcriptionTools";

// Port of ToolExecutor+Captions.swift: add_captions.

const addCaptionsAllowedKeys = [
  "style", "transform", "censorProfanity", "language", "animation", "highlightColor", "maxWords",
  "maxCharacters", "trackIndex", "maximumGapSeconds", "subtitleMediaRef",
];

function swiftNum(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function captionLimit(key: string, args: ToolArgs): number | undefined {
  if (!(key in args)) return undefined;
  const value = exactJSONInt(args[key]);
  if (value === undefined || value < 1) throw new ToolError(`add_captions: ${key} must be an integer >= 1.`);
  return value;
}

function parseGapSettings(args: ToolArgs): CaptionGapSettings {
  if (!("maximumGapSeconds" in args)) return captionGapSettingsDefault;
  const raw = args.maximumGapSeconds;
  const parsed = typeof raw === "number" ? makeCaptionGapSettings(raw) : undefined;
  if (!parsed) {
    throw new ToolError(
      `add_captions: maximumGapSeconds must be a finite number from ${swiftNum(captionMaximumGapRange.min)} through ${swiftNum(captionMaximumGapRange.max)}.`,
    );
  }
  return parsed;
}

export async function addCaptions({ executor, editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, addCaptionsAllowedKeys, "add_captions");

  if ("subtitleMediaRef" in args) {
    const subtitleMediaRef = argString(args, "subtitleMediaRef");
    if (subtitleMediaRef === undefined) throw new ToolError("add_captions: subtitleMediaRef must be a non-empty media asset id string.");
    const combined = Object.keys(args).filter((k) => k !== "subtitleMediaRef").sort();
    if (combined.length > 0) {
      throw new ToolError(
        `add_captions: subtitleMediaRef uses the file's text, timing, and default styling as-is; remove ${combined.join(", ")}.`,
      );
    }
    return addCaptionsFromSubtitle(executor, editor, subtitleMediaRef);
  }

  const stylePatch = parseTextStylePatch(args, "add_captions");
  const style = textStyleCaption();
  if (stylePatch) applyTextStylePatch(stylePatch, style);

  const transform = parseTextTransform(args.transform, "add_captions.transform");
  const center = { ...captionDefaultCenter };
  if (transform?.x !== undefined) center.x = transform.x;
  if (transform?.y !== undefined) center.y = transform.y;

  const animation = parseTextAnimation(argString(args, "animation"), argString(args, "highlightColor"), "add_captions") ?? makeTextAnimation();

  const maxWords = captionLimit("maxWords", args);
  const maxCharacters = captionLimit("maxCharacters", args);
  const gapSettings = parseGapSettings(args);

  const scope = resolveTranscriptionScope(editor, args, "add_captions");
  const context = transcriptionContext(args);
  // Transcription runs through hosted speech-to-text APIs, which cannot mask words.
  if (argBool(args, "censorProfanity") === true) {
    throw new ToolError("add_captions: censorProfanity is only available with local transcription.");
  }

  const request = makeCaptionRequest({
    ...scopeCaptionRequest(editor, scope),
    style,
    center,
    locale: context.language,
    maxWords,
    maxCharacters,
    gapSettings,
    animation,
  });

  const applyTransform = transform?.x !== undefined || transform?.rotation !== undefined || transform?.rotationX !== undefined || transform?.rotationY !== undefined;
  const snapshot = timelineSnapshot(editor);
  const ids = await generateCaptions(editor, request, { ...transcriptionToolDeps(), measure: executor.measureText }, undefined, (place) =>
    editor.perform("Generate Captions (Agent)", () => {
      const placed = place();
      if (applyTransform) {
        for (const id of placed) {
          const clip = editor.clipFor(id);
          if (!clip) continue;
          if (transform?.x !== undefined) clip.transform.centerX = textCenterX(transform.x, clip.transform.width, style.alignment);
          if (transform?.rotation !== undefined) clip.transform.rotation = transform.rotation;
          if (transform?.rotationX !== undefined) clip.transform.rotationX = transform.rotationX;
          if (transform?.rotationY !== undefined) clip.transform.rotationY = transform.rotationY;
        }
      }
      return placed;
    }),
  );
  if (ids.length === 0) throw new ToolError("No speech detected to caption.");
  return mutationResult(editor, snapshot);
}

async function addCaptionsFromSubtitle(executor: ToolContext["executor"], editor: Editor, mediaRef: string): Promise<ToolResult> {
  const asset = editor.mediaAssets.find((a) => a.id === mediaRef);
  if (!asset) throw new ToolError(`add_captions: media asset not found: ${mediaRef}`);
  if (asset.type !== "subtitle") {
    throw new ToolError(`add_captions: '${mediaRef}' is ${asset.type}, not a subtitle file. Omit subtitleMediaRef to caption spoken audio.`);
  }
  if (editor.ui.offlineMediaRefs.has(asset.id) || editor.ui.missingMediaRefs.has(asset.id)) {
    throw new ToolError(`add_captions: the subtitle file for '${mediaRef}' is offline.`);
  }
  const snapshot = timelineSnapshot(editor);
  try {
    const ids = await importCaptions(editor, asset.url, { ...transcriptionToolDeps(), measure: executor.measureText });
    if (ids.length === 0) throw new ToolError("The subtitle file contains no captions.");
    return mutationResult(editor, snapshot);
  } catch (e) {
    if (e instanceof SubtitleParseError) throw new ToolError(`add_captions: ${e.message}`);
    throw e;
  }
}
