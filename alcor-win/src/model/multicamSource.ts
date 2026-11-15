import { newId } from "../util/id";
import { swiftRound } from "../util/math";
import { asObject, getArray, getBool, getDouble, getEnum, getString, getWith } from "../util/jsonDecode";
import type { Clip } from "./timeline";

export const multicamMemberKinds = ["angle", "mic", "both"] as const;
export type MulticamMemberKind = (typeof multicamMemberKinds)[number];

export interface MulticamSyncMap {
  offsetSeconds: number;
  confidence: number;
  locked: boolean;
}

export function makeMulticamSyncMap(p: Partial<MulticamSyncMap> = {}): MulticamSyncMap {
  return { offsetSeconds: p.offsetSeconds ?? 0, confidence: p.confidence ?? 0, locked: p.locked ?? false };
}

export function decodeMulticamSyncMap(json: unknown): MulticamSyncMap {
  const c = asObject(json, "SyncMap");
  return { offsetSeconds: getDouble(c, "offsetSeconds"), confidence: getDouble(c, "confidence"), locked: getBool(c, "locked") };
}

export interface MulticamMember {
  id: string;
  mediaRef: string;
  kind: MulticamMemberKind;
  angleLabel: string;
  sync: MulticamSyncMap;
}

export function makeMulticamMember(
  p: Partial<MulticamMember> & { mediaRef: string; kind: MulticamMemberKind; angleLabel: string },
): MulticamMember {
  return {
    id: p.id ?? newId(),
    mediaRef: p.mediaRef,
    kind: p.kind,
    angleLabel: p.angleLabel,
    sync: p.sync ?? makeMulticamSyncMap(),
  };
}

export function decodeMulticamMember(json: unknown): MulticamMember {
  const c = asObject(json, "Member");
  return {
    id: getString(c, "id"),
    mediaRef: getString(c, "mediaRef"),
    kind: getEnum(c, "kind", multicamMemberKinds),
    angleLabel: getString(c, "angleLabel"),
    sync: getWith(c, "sync", decodeMulticamSyncMap),
  };
}

export function multicamMemberProvidesVideo(m: MulticamMember): boolean {
  return m.kind !== "mic";
}

export function multicamMemberProvidesAudio(m: MulticamMember): boolean {
  return m.kind !== "angle";
}

export function multicamMemberUsable(m: MulticamMember): boolean {
  return m.sync.confidence > 0 || m.sync.locked;
}

export function multicamMemberOffsetFrames(m: MulticamMember, fps: number): number {
  return swiftRound(m.sync.offsetSeconds * fps);
}

export function multicamMemberAnchorFrame(m: MulticamMember, clip: Clip, fps: number): number {
  return clip.startFrame - clip.trimStartFrame - multicamMemberOffsetFrames(m, fps);
}

/** Half-open frame range [lowerBound, upperBound). */
export function multicamMemberCoverage(
  m: MulticamMember,
  sourceDuration: number,
  fps: number,
): { lowerBound: number; upperBound: number } {
  const start = swiftRound(m.sync.offsetSeconds * fps);
  const end = swiftRound((m.sync.offsetSeconds + sourceDuration) * fps);
  return { lowerBound: start, upperBound: Math.max(start, end) };
}

export function multicamMemberTrimFrame(m: MulticamMember, groupFrame: number, fps: number): number {
  return swiftRound((groupFrame / fps - m.sync.offsetSeconds) * fps);
}

export interface MulticamSource {
  id: string;
  name: string;
  members: MulticamMember[];
  masterMemberId: string;
}

export function makeMulticamSource(p: Partial<MulticamSource> = {}): MulticamSource {
  return { id: p.id ?? newId(), name: p.name ?? "", members: p.members ?? [], masterMemberId: p.masterMemberId ?? "" };
}

export function decodeMulticamSource(json: unknown): MulticamSource {
  const c = asObject(json, "MulticamSource");
  return {
    id: getString(c, "id"),
    name: getString(c, "name"),
    members: getArray(c, "members", decodeMulticamMember),
    masterMemberId: getString(c, "masterMemberId"),
  };
}

export function multicamMaster(s: MulticamSource): MulticamMember | undefined {
  return s.members.find((m) => m.id === s.masterMemberId);
}

export function multicamAngles(s: MulticamSource): MulticamMember[] {
  return s.members.filter((m) => multicamMemberProvidesVideo(m) && multicamMemberUsable(m));
}

export function multicamMics(s: MulticamSource): MulticamMember[] {
  return s.members.filter((m) => multicamMemberProvidesAudio(m) && multicamMemberUsable(m));
}

/** Case-insensitive label match (Swift `caseInsensitiveCompare`). */
export function multicamMemberLabeled(s: MulticamSource, label: string): MulticamMember | undefined {
  const l = label.toLowerCase();
  return s.members.find((m) => m.angleLabel.toLowerCase() === l);
}

export function multicamMemberWithMediaRef(s: MulticamSource, mediaRef: string): MulticamMember | undefined {
  return s.members.find((m) => m.mediaRef === mediaRef);
}
