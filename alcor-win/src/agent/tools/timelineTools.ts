import type { Editor } from "../../editor/editor";
import { timelineFor } from "../../editor/mutations/core";
import { activateTimeline, createTimeline, duplicateTimeline, renameTimeline } from "../../editor/mutations/timelines";
import { multicamAngles, multicamMics, timelineMarkerIntersects, timelineTotalFrames, type Timeline } from "../../model";
import { displayedTimelineMarkers } from "../../timeline/view/timelineMarkerCommands";
import { revealTimelineTabBarIfMultiple } from "../../timeline/view/timelineTabs";
import { timelineDefinitions } from "./definitions/timelineDefinitions";
import { jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { manageMarkers } from "./markerTools";
import { setProjectSettings } from "./projectSettingsTools";
import { compactTracks, rawTimelineDict, timelineEntries, timelineMarkerDict, type Json } from "./timelinePayload";
import { frameWindow } from "./toolExecutorAgentActivity";
import { ToolError, argInt, argString, validateUnknownKeys } from "./toolArgs";
import { ToolExecutor } from "./toolExecutor";
import { defineTools, definitionNamed, type ToolArgs, type ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Timeline.swift (get_timeline, create_timeline, set_active_timeline) and
// ToolExecutor+InspectTimeline.swift.

export function getTimeline({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["startFrame", "endFrame", "captionDetail"], "get_timeline");
  const window = frameWindow(args);
  const captionDetail = typeof args.captionDetail === "boolean" ? args.captionDetail : false;

  const dict = rawTimelineDict(editor.timeline);
  delete dict.settingsConfigured;
  if (Array.isArray(dict.tracks)) dict.tracks = compactTracks(dict.tracks as Json[], editor, window, captionDetail);
  const markers = displayedTimelineMarkers(editor).filter((m) => !window || timelineMarkerIntersects(m, window.start, window.end));
  if (markers.length === 0) delete dict.markers;
  else dict.markers = markers.map(timelineMarkerDict);
  const totalFrames = timelineTotalFrames(editor.timeline);
  dict.totalFrames = totalFrames;
  dict.durationSeconds = totalFrames / Math.max(editor.timeline.fps, 1);
  if (window) dict.window = [window.start, Math.min(window.end, totalFrames)];
  dict.currentFrame = editor.ui.currentFrame;
  dict.canGenerate = ToolExecutor.canGenerate;
  const referenced = new Set(editor.timelines.flatMap((t) => t.tracks.flatMap((tr) => tr.clips.flatMap((c) => (c.multicamGroupId ? [c.multicamGroupId] : [])))));
  const liveGroups = editor.doc.multicamGroups.filter((g) => referenced.has(g.id));
  if (liveGroups.length > 0) {
    dict.multicamGroups = liveGroups.map((g) => ({
      groupId: g.id,
      name: g.name,
      angles: multicamAngles(g).map((m) => m.angleLabel),
      mics: multicamMics(g).map((m) => m.angleLabel),
    }));
  }
  if (editor.timelines.length > 1) dict.timelines = timelineEntries(editor);
  return ok(jsonString(roundJSONFloatingPointNumbers(dict, 3)));
}

export function createTimelineTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["name", "from"], "create_timeline");
  const name = argString(args, "name");
  const fromRef = argString(args, "from");
  let id: string;
  let note: string;
  if (fromRef !== undefined) {
    const source = timelineFor(editor, fromRef);
    if (!source) throw new ToolError(`No timeline with id '${fromRef}'. get_media lists the project's timelines.`);
    id = editor.perform("Duplicate Timeline (Agent)", () => {
      const newId = duplicateTimeline(editor, fromRef);
      if (newId === undefined) throw new ToolError(`Couldn't duplicate "${source.name}".`);
      if (name !== undefined) renameTimeline(editor, newId, name);
      return newId;
    });
    note = `Duplicated "${source.name}" and switched to the copy. Its clip and track ids are new — re-read get_timeline before editing.`;
  } else {
    id = editor.perform("Create Timeline (Agent)", () => createTimeline(editor, name));
    note = "Empty and now active; all edit tools target it.";
  }
  revealTimelineTabBarIfMultiple(editor);
  return ok(jsonString({ timelineId: id, name: timelineFor(editor, id)?.name ?? "", active: true, note }));
}

export function setActiveTimeline({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["timelineId"], "set_active_timeline");
  const id = argString(args, "timelineId");
  if (id === undefined) throw new ToolError("timelineId is required");
  const target = timelineFor(editor, id);
  if (!target) throw new ToolError(`No timeline with id '${id}'. get_media lists the project's timelines.`);
  const payload: Json = {
    timelineId: target.id,
    name: target.name,
    active: true,
    totalFrames: timelineTotalFrames(target),
    fps: target.fps,
    trackCount: target.tracks.length,
  };
  if (editor.doc.activeTimelineId === target.id) {
    payload.note = "Already the active timeline.";
  } else {
    activateTimeline(editor, target.id);
    payload.note = "Re-read get_timeline — clip and track ids from the previous timeline no longer apply.";
  }
  revealTimelineTabBarIfMultiple(editor);
  return ok(jsonString(payload));
}

// MARK: - inspect_timeline

const inspectTimelineDefaultFrames = 6;
const inspectTimelineMaxFrames = 12;
const inspectTimelineMaxDimension = 512;

/** Ids of visual clips on screen at `frame`, top track first; caption clips report their group id once. */
export function visibleClips(frame: number, timeline: Timeline): string[] {
  const ids: string[] = [];
  const seenGroups = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.type !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (!(clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames)) continue;
      if (clip.captionGroupId !== undefined) {
        if (!seenGroups.has(clip.captionGroupId)) {
          seenGroups.add(clip.captionGroupId);
          ids.push(clip.captionGroupId);
        }
      } else {
        ids.push(clip.id);
      }
    }
  }
  return ids;
}

function fit(width: number, height: number, longestEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > longestEdge)) return { width, height };
  const scale = longestEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function inspectTimeline({ executor, editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["startFrame", "endFrame", "maxFrames"], "inspect_timeline");
  const timeline = editor.timeline;
  const totalFrames = timelineTotalFrames(timeline);
  if (!(totalFrames > 0)) throw new ToolError("Timeline is empty — nothing to render.");

  const startFrame = argInt(args, "startFrame") ?? 0;
  if (!(startFrame >= 0 && startFrame < totalFrames)) throw new ToolError(`startFrame ${startFrame} out of range [0, ${totalFrames}).`);

  let sampledFrames: number[];
  const rawEnd = argInt(args, "endFrame");
  if (rawEnd !== undefined && rawEnd !== 0) {
    const endFrame = Math.min(rawEnd, totalFrames);
    if (!(endFrame > startFrame)) throw new ToolError(`endFrame must be greater than startFrame (${startFrame}).`);
    const span = endFrame - startFrame;
    const count = Math.max(1, Math.min(argInt(args, "maxFrames") ?? inspectTimelineDefaultFrames, inspectTimelineMaxFrames, span));
    sampledFrames = Array.from({ length: count }, (_, i) => startFrame + Math.floor((span * (i + 0.5)) / count));
  } else {
    sampledFrames = [startFrame];
  }

  const render = executor.host?.renderTimelineFrame;
  if (!render) throw new ToolError("Failed to render timeline frames.");
  const renderSize = fit(timeline.width, timeline.height, inspectTimelineMaxDimension);
  const content: ToolResult["content"] = [];
  const renderedFrames: number[] = [];
  for (const frame of sampledFrames) {
    const jpeg = await render.call(executor.host, editor, frame, inspectTimelineMaxDimension);
    if (jpeg === null) continue;
    content.push({ kind: "image", base64: jpeg, mediaType: "image/jpeg" });
    renderedFrames.push(frame);
  }
  if (content.length === 0) throw new ToolError("Failed to render timeline frames.");

  const meta = {
    fps: timeline.fps,
    width: renderSize.width,
    height: renderSize.height,
    totalFrames,
    coordinateGrid: "0-1, origin top-left",
    frames: renderedFrames.map((frame) => ({ frame, clips: visibleClips(frame, timeline) })),
  };
  content.push({ kind: "text", text: jsonString(meta) });
  return { content, isError: false };
}

const find = (name: string) => definitionNamed(timelineDefinitions, name);

defineTools("timeline", [
    { definition: find("get_timeline"), run: getTimeline, readsInactiveProject: true },
    { definition: find("inspect_timeline"), run: inspectTimeline, readsInactiveProject: true },
    { definition: find("create_timeline"), run: createTimelineTool },
    { definition: find("set_active_timeline"), run: setActiveTimeline },
    { definition: find("manage_markers"), run: manageMarkers },
    {
      definition: find("set_project_settings"),
      run: ({ editor }: { editor: Editor }, args) => setProjectSettings(editor, args),
      publishesTimelineChanges: true,
    },
]);
