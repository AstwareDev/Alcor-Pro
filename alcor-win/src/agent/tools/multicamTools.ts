import type { Editor } from "../../editor/editor";
import {
  angleSwitchRequest, createMulticamGroup, MulticamError, multicamProgramRows, multicamTrackIndexes, switchMulticamAngles,
  syncMulticamMembers, ungroupMulticam, type AngleSwitchRequest, type MulticamMemberSpec,
} from "../../editor/mutations/multicam";
import { multicamGroupById, multicamGroupOf } from "../../editor/mutations/multicamRules";
import { syncClips, syncDefaults, type SyncMode } from "../../editor/mutations/sync";
import { editorSyncServices, type SyncServices } from "../../audio/sourceTiming";
import {
  multicamMemberKinds, multicamMemberUsable, videoLayouts, videoLayoutSlots, type MulticamMemberKind, type MulticamSource, type MulticamMember, type VideoLayout,
} from "../../model";
import { swiftRound } from "../../util/math";
import { jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import {
  ToolError, argDouble, argInt, argString, argStringArray, isRecord, requireString, validateUnknownKeys,
} from "./toolArgs";
import { currentIdUniverse, expandingIdPrefixes } from "./toolExecutorShortId";
import { frameWindow } from "./toolExecutorAgentActivity";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Multicam.swift and ToolExecutor+Sync.swift.

/** Where the tools get decoding / correlation from; tests swap it for synthetic envelopes. */
export const multicamToolServices: { create: (editor: Editor) => SyncServices } = { create: editorSyncServices };

type Json = Record<string, unknown>;

function surfacing<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof MulticamError) throw new ToolError(e.message);
    throw e;
  }
}

// MARK: - manage_multicam

export async function manageMulticam({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["create", "ungroup"], "manage_multicam");
  const snapshot = timelineSnapshot(editor);
  if (args.create !== undefined) {
    if (!isRecord(args.create)) throw new ToolError("manage_multicam.create must be an object.");
    const created = await createSection(editor, args.create);
    return mutationResult(editor, snapshot, { extra: { created } });
  }
  if (args.ungroup !== undefined) {
    if (!isRecord(args.ungroup)) throw new ToolError("manage_multicam.ungroup must be an object.");
    return mutationResult(editor, snapshot, { extra: { ungrouped: ungroupSection(editor, args.ungroup) } });
  }
  throw new ToolError("Pass create or ungroup.");
}

async function createSection(editor: Editor, args: ToolArgs): Promise<Json> {
  validateUnknownKeys(args, ["name", "members", "master", "startFrame", "searchWindowSeconds"], "manage_multicam.create");
  const rawMembers = args.members;
  if (!Array.isArray(rawMembers) || rawMembers.length < 2 || !rawMembers.every(isRecord)) {
    throw new ToolError("create.members requires at least two entries (cameras and mics).");
  }

  const specs: MulticamMemberSpec[] = [];
  const seenRefs = new Set<string>();
  for (const [i, raw] of rawMembers.entries()) {
    const spec = memberSpec(editor, raw as ToolArgs, `create.members[${i}]`);
    if (seenRefs.has(spec.mediaRef)) throw new ToolError(`create.members[${i}]: duplicate mediaRef ${spec.mediaRef}`);
    seenRefs.add(spec.mediaRef);
    specs.push(spec);
  }

  const masterRef = resolveMasterRef(editor, argString(args, "master"), specs);
  const sync = await syncMulticamMembers(multicamToolServices.create(editor), {
    specs,
    masterRef,
    searchWindowSeconds: argDouble(args, "searchWindowSeconds") ?? syncDefaults.memberSearchWindowSeconds,
  });

  const { groupId, clipIds } = surfacing(() =>
    editor.perform("Create Multicam (Agent)", () =>
      createMulticamGroup(editor, { specs, syncMaps: sync.maps, masterRef, name: argString(args, "name"), startFrame: argInt(args, "startFrame") }),
    ),
  );

  const payload: Json = { groupId, members: memberRows(editor, groupId), clipIds };
  if (sync.failures.length > 0) payload.needsAttention = sync.failures.map((f) => ({ mediaRef: f.mediaRef, reason: f.reason }));
  return payload;
}

function ungroupSection(editor: Editor, args: ToolArgs): string {
  validateUnknownKeys(args, ["groupId"], "manage_multicam.ungroup");
  const groupId = requireGroup(editor, argString(args, "groupId"));
  editor.perform("Ungroup Multicam (Agent)", () => ungroupMulticam(editor, groupId));
  return groupId;
}

// MARK: - change_cam

export function changeCam({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["groupId", "clipId", "entries"], "change_cam");
  const groupId = resolveGroupId(editor, args);
  const rawEntries = args.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0 || !rawEntries.every(isRecord)) {
    throw new ToolError("entries requires at least one {range, angle} entry.");
  }

  const requests: AngleSwitchRequest[] = [];
  for (const [i, raw] of (rawEntries as ToolArgs[]).entries()) {
    const path = `entries[${i}]`;
    validateUnknownKeys(raw, ["range", "angle", "layout", "angles"], path);
    const range = raw.range;
    const a = Array.isArray(range) && range.length === 2 && typeof range[0] === "number" ? Math.trunc(range[0]) : undefined;
    const b = Array.isArray(range) && range.length === 2 && typeof range[1] === "number" ? Math.trunc(range[1]) : undefined;
    if (a === undefined || b === undefined || !(a < b)) throw new ToolError(`${path}: range must be [startFrame, endFrame) with start < end.`);
    const span = { lowerBound: a, upperBound: b };
    if (typeof raw.layout === "string") {
      if (raw.angle !== undefined && raw.angle !== null) throw new ToolError(`${path}: pass angle for a full-frame switch OR layout + angles, not both.`);
      const layoutRaw = raw.layout;
      const layout = (videoLayouts as readonly string[]).includes(layoutRaw) && layoutRaw !== "full" ? (layoutRaw as VideoLayout) : undefined;
      if (!layout) {
        throw new ToolError(
          `${path}: unknown layout '${layoutRaw}'. Valid: ${videoLayouts.filter((l) => l !== "full").join(", ")}. For full frame, pass angle instead.`,
        );
      }
      const angles = Array.isArray(raw.angles) && raw.angles.every((x) => typeof x === "string") ? (raw.angles as string[]) : undefined;
      if (!angles || angles.length === 0) {
        throw new ToolError(
          `${path}: layout needs angles — angleLabels in slot order (${videoLayoutSlots(layout).map((s) => s.id).join(", ")}); fewer than slots leaves cells empty.`,
        );
      }
      requests.push({ range: span, layout, angles });
    } else {
      requests.push(angleSwitchRequest(span, requireString(raw, "angle")));
    }
  }

  const snapshot = timelineSnapshot(editor);
  const outcome = surfacing(() => editor.perform("Switch Angle (Agent)", () => switchMulticamAngles(editor, groupId, requests)));

  const extra: Json = { groupId, switched: outcome.switched };
  if (outcome.merged > 0) extra.cutsMerged = outcome.merged;
  if (outcome.overlayClipIds.length > 0) extra.overlayClipIds = outcome.overlayClipIds;
  if (outcome.applied.length > 0) {
    const lo = Math.min(...outcome.applied.map((r) => r.lowerBound));
    const hi = Math.max(...outcome.applied.map((r) => r.upperBound));
    extra.program = multicamProgramRows(editor, groupId, { lowerBound: lo, upperBound: hi });
  }
  if (outcome.clamped.length > 0) {
    extra.clamped = outcome.clamped.map((c) => ({
      requested: [c.requested.lowerBound, c.requested.upperBound],
      applied: [c.applied.lowerBound, c.applied.upperBound],
      culprit: c.culprit,
    }));
  }
  if (outcome.skipped.length > 0) {
    extra.skipped = outcome.skipped.map((s) => ({ range: [s.range.lowerBound, s.range.upperBound], reason: s.reason }));
  }
  return mutationResult(editor, snapshot, { extra });
}

// MARK: - get_multicam

export function getMulticam({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["groupId", "clipId", "startFrame", "endFrame"], "get_multicam");
  const groupId = resolveGroupId(editor, args);
  const group = multicamGroupById(editor, groupId);
  if (!group) throw new ToolError(`No multicam group '${groupId}'. get_timeline lists multicamGroups.`);
  const window = frameWindow(args);
  const payload: Json = {
    groupId,
    name: group.name,
    members: memberRows(editor, groupId),
    program: multicamProgramRows(editor, groupId, window ? { lowerBound: window.start, upperBound: window.end } : undefined),
    trackIndexes: multicamTrackIndexes(editor, groupId),
  };
  return ok(jsonString(roundJSONFloatingPointNumbers(payload, 3)));
}

// MARK: - Helpers

function memberSpec(editor: Editor, raw: ToolArgs, path: string): MulticamMemberSpec {
  validateUnknownKeys(raw, ["mediaRef", "kind", "angleLabel", "offsetSeconds"], path);
  const ref = requireString(raw, "mediaRef");
  const kindRaw = requireString(raw, "kind");
  if (!(multicamMemberKinds as readonly string[]).includes(kindRaw)) throw new ToolError(`${path}: kind must be angle, mic, or both.`);
  const kind = kindRaw as MulticamMemberKind;
  const asset = editor.mediaAsset(ref);
  if (!asset) throw new ToolError(`${path} member not found: ${ref}`);
  switch (kind) {
    case "angle":
      if (asset.type !== "video") throw new ToolError(`${path}: angle members must be video.`);
      break;
    case "mic":
      if (!(asset.type === "audio" || (asset.type === "video" && asset.hasAudio))) throw new ToolError(`${path}: mic members need audio.`);
      break;
    case "both":
      if (!(asset.type === "video" && asset.hasAudio)) throw new ToolError(`${path}: 'both' members must be video with audio.`);
      break;
  }
  return { mediaRef: ref, kind, angleLabel: argString(raw, "angleLabel"), pinnedOffsetSeconds: argDouble(raw, "offsetSeconds") };
}

function requireGroup(editor: Editor, groupId: string | undefined): string {
  if (groupId === undefined) throw new ToolError("groupId is required.");
  if (!multicamGroupById(editor, groupId)) throw new ToolError(`No multicam group '${groupId}'. get_timeline lists multicamGroups.`);
  return groupId;
}

function resolveGroupId(editor: Editor, args: ToolArgs): string {
  const groupId = argString(args, "groupId");
  if (groupId !== undefined) return requireGroup(editor, groupId);
  const clipId = argString(args, "clipId");
  if (clipId !== undefined) {
    const clip = editor.clipFor(clipId);
    const group = clip ? multicamGroupOf(editor, clip) : undefined;
    if (!group) throw new ToolError(`Clip '${clipId}' is not part of a multicam group.`);
    return group.id;
  }
  throw new ToolError("Pass groupId or clipId.");
}

function resolveMasterRef(editor: Editor, master: string | undefined, specs: readonly MulticamMemberSpec[]): string {
  if (master !== undefined) {
    let expanded = master;
    try {
      const out = expandingIdPrefixes({ mediaRef: master }, currentIdUniverse(editor)).mediaRef;
      if (typeof out === "string") expanded = out;
    } catch {
      // ambiguous prefix: fall through to the label match
    }
    const spec = specs.find((s) => s.mediaRef === expanded || s.angleLabel?.toLowerCase() === master.toLowerCase());
    if (!spec) throw new ToolError(`master '${master}' doesn't match a member's angleLabel or mediaRef.`);
    if (spec.kind === "angle") throw new ToolError(`master '${master}' is an angle — its audio is scratch. Pick a mic/both member.`);
    return spec.mediaRef;
  }
  const pick = specs.find((s) => s.kind === "mic") ?? specs.find((s) => s.kind === "both") ?? specs[0];
  if (pick.kind === "angle") throw new ToolError("No mic member to sync against — mark one member as mic/both, or pin offsets explicitly.");
  return pick.mediaRef;
}

function memberRows(editor: Editor, groupId: string): Json[] {
  const group = multicamGroupById(editor, groupId);
  return group ? group.members.map((m) => memberRow(m, group)) : [];
}

function memberRow(m: MulticamMember, group: MulticamSource): Json {
  const row: Json = {
    angleLabel: m.angleLabel,
    kind: m.kind,
    mediaRef: m.mediaRef,
    offsetSeconds: m.sync.offsetSeconds,
    confidence: m.sync.confidence,
  };
  if (m.id === group.masterMemberId) row.master = true;
  if (m.sync.locked) row.pinned = true;
  if (!multicamMemberUsable(m)) row.unsynced = true;
  return row;
}

// MARK: - sync_clips

const syncModes = ["auto", "audio", "timecode"] as const;

export async function syncClipsTool({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["referenceClipId", "targetClipId", "targetClipIds", "mode", "searchWindowSeconds", "minConfidence"], "sync_clips");

  const referenceClipId = requireString(args, "referenceClipId");
  const targets = argStringArray(args, "targetClipIds");
  const single = argString(args, "targetClipId");
  if (single !== undefined) targets.push(single);
  if (targets.length === 0) throw new ToolError("sync_clips: provide targetClipId or targetClipIds.");
  if ([...targets, referenceClipId].some((id) => editor.clipFor(id)?.multicamGroupId !== undefined)) {
    throw new ToolError("sync_clips: multicam clips are already aligned by their group's sync maps — re-syncing would move them out of the group.");
  }

  let mode: SyncMode = "auto";
  const rawMode = argString(args, "mode");
  if (rawMode !== undefined) {
    if (!(syncModes as readonly string[]).includes(rawMode)) throw new ToolError("sync_clips: mode must be auto, audio, or timecode.");
    mode = rawMode as SyncMode;
  }
  const searchWindow = argDouble(args, "searchWindowSeconds");
  if (searchWindow !== undefined && (!Number.isFinite(searchWindow) || searchWindow <= 0)) {
    throw new ToolError("sync_clips: searchWindowSeconds must be finite and > 0.");
  }

  const snapshot = timelineSnapshot(editor);
  const report = await syncClips(editor, multicamToolServices.create(editor), {
    referenceClipId,
    targetClipIds: targets,
    mode,
    searchWindowSeconds: searchWindow,
    minConfidence: argDouble(args, "minConfidence") ?? syncDefaults.minConfidence,
    apply: (mutation) => {
      editor.perform("Synchronize Clips (Agent)", mutation);
    },
  });
  if (report.synced.length === 0) throw new ToolError(`sync_clips: ${report.failures[0]?.message ?? "no clips aligned"}`);

  const extra: Json = {
    referenceClipId,
    synced: report.synced.map((s) => ({
      clipId: s.clipId, offsetFrames: s.offsetFrames, confidence: swiftRound(s.confidence * 1000) / 1000, method: s.method,
    })),
  };
  if (report.shiftedFrames > 0) extra.shiftedFrames = report.shiftedFrames;
  if (report.retimed.length > 0) extra.driftCorrected = report.retimed.map((r) => ({ clipId: r.clipId, driftPpm: swiftRound(r.driftPpm * 10) / 10 }));
  if (report.retimeSkipped.length > 0) extra.driftCorrectionSkipped = report.retimeSkipped.map((r) => ({ clipId: r.clipId, reason: r.message }));
  if (report.failures.length > 0) extra.failed = report.failures.map((f) => ({ clipId: f.clipId, reason: f.message }));
  return mutationResult(editor, snapshot, { touched: report.synced.map((s) => s.clipId), extra });
}
