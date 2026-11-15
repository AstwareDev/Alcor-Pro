import { newId } from "../util/id";
import { swiftRound } from "../util/math";
import { asObject, getInt, getString, getWith, optEnum } from "../util/jsonDecode";
import { decodeRGBA, makeRGBA, type RGBA } from "./textStyle";

export const timelineMarkerStatuses = ["open", "review", "resolved"] as const;
export type TimelineMarkerStatus = (typeof timelineMarkerStatuses)[number];

export const timelineMarkerMaximumNameLength = 120;
export const timelineMarkerMaximumCommentLength = 4_000;

export function timelineMarkerDefaultColor(): RGBA {
  return makeRGBA({ r: 0, g: 0.478, b: 1, a: 1 });
}

export interface TimelineMarker {
  id: string;
  name: string;
  startFrame: number;
  durationFrames: number;
  color: RGBA;
  comment: string;
  status: TimelineMarkerStatus;
}

export function makeTimelineMarker(p: Partial<TimelineMarker> & { name: string; startFrame: number }): TimelineMarker {
  return {
    id: p.id ?? newId(),
    name: p.name,
    startFrame: p.startFrame,
    durationFrames: p.durationFrames ?? 0,
    color: p.color ?? timelineMarkerDefaultColor(),
    comment: p.comment ?? "",
    status: p.status ?? "open",
  };
}

export function timelineMarkerEndFrame(m: TimelineMarker): number {
  return m.startFrame + m.durationFrames;
}

export function timelineMarkerIsRange(m: TimelineMarker): boolean {
  return m.durationFrames > 0;
}

/** `range` is a half-open Swift `Range<Int>` [lowerBound, upperBound). */
export function timelineMarkerIntersects(m: TimelineMarker, lowerBound: number, upperBound: number): boolean {
  return timelineMarkerIsRange(m)
    ? m.startFrame < upperBound && timelineMarkerEndFrame(m) > lowerBound
    : m.startFrame >= lowerBound && m.startFrame < upperBound;
}

export function timelineMarkerRescaleFrames(m: TimelineMarker, scale: number): void {
  const scaledEnd = swiftRound(timelineMarkerEndFrame(m) * scale);
  m.startFrame = Math.max(0, swiftRound(m.startFrame * scale));
  m.durationFrames = timelineMarkerIsRange(m) ? Math.max(1, scaledEnd - m.startFrame) : 0;
}

/** Every key is required except `status` (defaults to open). */
export function decodeTimelineMarker(json: unknown): TimelineMarker {
  const c = asObject(json, "TimelineMarker");
  return {
    id: getString(c, "id"),
    name: getString(c, "name"),
    startFrame: getInt(c, "startFrame"),
    durationFrames: getInt(c, "durationFrames"),
    color: getWith(c, "color", decodeRGBA),
    comment: getString(c, "comment"),
    status: optEnum(c, "status", timelineMarkerStatuses) ?? "open",
  };
}

export type TimelineMarkerValidationError = "invalidName" | "invalidComment" | "invalidRange";
