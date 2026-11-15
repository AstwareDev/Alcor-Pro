import {
  asObject, attempt, DecodingError, decodeDouble, decodeRecord, decodeString, getArray, getInt, getString,
  optArray, optString, optWith,
} from "../util/jsonDecode";
import { decodeMulticamSource, type MulticamSource } from "./multicamSource";
import { decodeTimeline, decodeTimelineViewState, type Timeline, type TimelineViewState } from "./timeline";

/** Persisted per-project speaker identity. `centroid` is `[Float]` in Swift. */
export interface SpeakerRegistryEntry {
  id: number;
  name: string;
  color: number[];
  centroid: number[];
}

export function decodeSpeakerRegistryEntry(json: unknown): SpeakerRegistryEntry {
  const c = asObject(json, "SpeakerRegistryEntry");
  return {
    id: getInt(c, "id"),
    name: getString(c, "name"),
    color: getArray(c, "color", (e) => decodeDouble(e, "color")),
    centroid: getArray(c, "centroid", (e) => decodeDouble(e, "centroid")),
  };
}

/** Root of project.json. Legacy projects stored a bare Timeline; decode falls back and wraps. */
export interface ProjectFile {
  timelines: Timeline[];
  activeTimelineId?: string;
  openTimelineIds?: string[];
  viewStates?: Record<string, TimelineViewState>;
  speakers?: SpeakerRegistryEntry[];
  multicamGroups?: MulticamSource[];
}

export function makeProjectFile(p: Partial<ProjectFile> & { timelines: Timeline[] }): ProjectFile {
  const f: ProjectFile = { timelines: p.timelines };
  if (p.activeTimelineId !== undefined) f.activeTimelineId = p.activeTimelineId;
  if (p.openTimelineIds !== undefined) f.openTimelineIds = p.openTimelineIds;
  if (p.viewStates !== undefined) f.viewStates = p.viewStates;
  if (p.speakers !== undefined) f.speakers = p.speakers;
  if (p.multicamGroups !== undefined) f.multicamGroups = p.multicamGroups;
  return f;
}

function decodeProjectFileStrict(json: unknown): ProjectFile {
  const c = asObject(json, "ProjectFile");
  return makeProjectFile({
    timelines: getArray(c, "timelines", decodeTimeline),
    activeTimelineId: optString(c, "activeTimelineId"),
    openTimelineIds: optArray(c, "openTimelineIds", (e) => decodeString(e, "openTimelineIds")),
    viewStates: optWith(c, "viewStates", (v) => decodeRecord(v, decodeTimelineViewState, "viewStates")),
    speakers: optArray(c, "speakers", decodeSpeakerRegistryEntry),
    multicamGroups: optArray(c, "multicamGroups", decodeMulticamSource),
  });
}

/**
 * `ProjectFile.decode(_:)`. Throws `DecodingError` for unreadable files; a bare legacy Timeline is wrapped
 * into a single-timeline project.
 */
export function decodeProjectFile(json: unknown): ProjectFile {
  try {
    const file = decodeProjectFileStrict(json);
    if (file.timelines.length === 0) throw new DecodingError("project has no timelines");
    return file;
  } catch (error) {
    if (!(error instanceof DecodingError)) throw error;
    // Legacy files are a bare Timeline; anything else rethrows the real error.
    const legacy = attempt(() => decodeTimeline(json));
    if (legacy === undefined) throw error;
    return makeProjectFile({ timelines: [legacy], activeTimelineId: legacy.id, openTimelineIds: [legacy.id] });
  }
}

/** Convenience for the raw `project.json` text. */
export function decodeProjectFileText(text: string): ProjectFile {
  return decodeProjectFile(JSON.parse(text));
}
