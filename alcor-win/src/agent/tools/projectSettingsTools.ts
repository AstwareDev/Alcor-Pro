import type { Editor } from "../../editor/editor";
import {
  AspectRatioError, applyTimelineSettings, canvasAspectDisplayLabel, canvasAspectRatioResolution, checkProjectSettings,
  parseCanvasAspectRatio, qualityPresetResolution, qualityPresetShortEdges, type CanvasAspectRatio, type QualityPresetLabel,
} from "../../editor/mutations/projectSettings";
import type { MediaAsset, Timeline } from "../../model";
import { swiftRound } from "../../util/math";
import { ToolError, decodeToolArgs } from "./toolArgs";
import { jsonString } from "./jsonFormat";
import type { ToolArgs } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+ProjectSettings.swift.

interface SetProjectSettingsInput {
  fps?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  quality?: string;
}

export interface ResolvedProjectSettings {
  fps: number;
  width: number;
  height: number;
}

export interface ValidatedProjectSettings {
  resolve(timeline: Timeline): ResolvedProjectSettings;
}

function wrapAspectError<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof AspectRatioError) throw new ToolError(e.message);
    throw e;
  }
}

export function validateProjectSettings(args: ToolArgs): ValidatedProjectSettings {
  const input = decodeToolArgs<SetProjectSettingsInput>(args, "set_project_settings", {
    fps: { spec: "int" },
    width: { spec: "int" },
    height: { spec: "int" },
    aspectRatio: { spec: "string" },
    quality: { spec: "string" },
  });

  if (input.fps === undefined && input.width === undefined && input.height === undefined && input.aspectRatio === undefined && input.quality === undefined) {
    throw new ToolError("Provide at least one of: fps, width, height, aspectRatio, quality");
  }
  if ((input.width === undefined) !== (input.height === undefined)) throw new ToolError("Provide both width and height");
  if (input.width !== undefined && (input.aspectRatio !== undefined || input.quality !== undefined)) {
    throw new ToolError("Explicit dimensions can't be combined with aspectRatio or quality");
  }
  if (input.fps !== undefined && !(input.fps >= 1 && input.fps <= 120)) {
    throw new ToolError(`fps must be between 1 and 120 (got ${input.fps})`);
  }
  const aspectRatio: CanvasAspectRatio | undefined =
    input.aspectRatio === undefined ? undefined : wrapAspectError(() => parseCanvasAspectRatio(input.aspectRatio as string));
  let quality: number | undefined;
  if (input.quality !== undefined) {
    if (!(input.quality in qualityPresetShortEdges)) throw new ToolError(`Unknown quality '${input.quality}'. Use one of: 720p, 1080p, 2K, 4K`);
    quality = qualityPresetShortEdges[input.quality as QualityPresetLabel];
  }

  return {
    resolve(timeline) {
      let size = { width: input.width ?? timeline.width, height: input.height ?? timeline.height };
      if (aspectRatio) {
        size = wrapAspectError(() => canvasAspectRatioResolution(aspectRatio, quality ?? Math.min(timeline.width, timeline.height)));
      } else if (quality !== undefined && size.width > 0 && size.height > 0) {
        size = qualityPresetResolution(quality, size.width, size.height);
      }
      const changesResolution = input.width !== undefined || aspectRatio !== undefined || quality !== undefined;
      if (!(size.width > 0 && size.height > 0) || (changesResolution && !(size.width <= 8_192 && size.height <= 8_192))) {
        throw new ToolError("Resolution must be positive and no larger than 8192 pixels on either edge");
      }
      return { fps: input.fps ?? timeline.fps, width: size.width, height: size.height };
    },
  };
}

export function applyResolvedProjectSettings(editor: Editor, resolved: ResolvedProjectSettings): ToolResult {
  const prevFPS = editor.timeline.fps;
  const prevWidth = editor.timeline.width;
  const prevHeight = editor.timeline.height;

  applyTimelineSettings(editor, resolved.fps, resolved.width, resolved.height);

  const changed: string[] = [];
  if (resolved.fps !== prevFPS) changed.push("fps");
  if (resolved.width !== prevWidth || resolved.height !== prevHeight) changed.push("resolution");

  const payload: Record<string, unknown> = {
    fps: resolved.fps,
    resolution: `${resolved.width}x${resolved.height}`,
    aspectRatio: canvasAspectDisplayLabel(resolved.width, resolved.height),
    changed,
  };
  if (changed.length === 0) payload.note = "Settings already matched.";
  else if (changed.includes("fps")) {
    payload.note = `Clip frames rescaled to ${resolved.fps}fps — re-read get_timeline before frame-based edits.`;
  }
  return ok(jsonString(payload));
}

export function setProjectSettings(editor: Editor, args: ToolArgs): ToolResult {
  const settings = validateProjectSettings(args).resolve(editor.timeline);
  return editor.perform("Set Project Settings (Agent)", () => applyResolvedProjectSettings(editor, settings));
}

/** Syncs timeline resolution with the first clip if needed; returns a note if changed, undefined otherwise. */
export function applySettingsIfNeededForAgent(editor: Editor, assets: readonly MediaAsset[]): string | undefined {
  const prevWidth = editor.timeline.width;
  const prevHeight = editor.timeline.height;

  // adoptFPS: false — only resolution syncs, fps stays unchanged.
  const notes: string[] = [];
  const action = checkProjectSettings(editor, assets, false);
  if (action.kind === "proceed") {
    if (editor.timeline.width !== prevWidth || editor.timeline.height !== prevHeight) {
      notes.push(`Set timeline to ${editor.timeline.width}×${editor.timeline.height} to match clip.`);
    }
  } else {
    applyTimelineSettings(editor, editor.timeline.fps, action.clipWidth, action.clipHeight);
    notes.push(`Matched timeline resolution to clip: ${action.clipWidth}×${action.clipHeight}.`);
  }

  const sourceFPS = assets.find((a) => a.type === "video")?.sourceFPS;
  const clipFPS = sourceFPS === undefined ? undefined : swiftRound(sourceFPS);
  if (clipFPS !== undefined && clipFPS !== editor.timeline.fps) {
    notes.push(
      `Clip is ${clipFPS}fps but project is ${editor.timeline.fps}fps; clips placed at ${editor.timeline.fps}fps and frame counts are interpreted at ${editor.timeline.fps}fps. To conform, call set_project_settings then re-read get_timeline.`,
    );
  }
  return notes.length === 0 ? undefined : notes.join(" ");
}
