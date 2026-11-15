// Test fixtures (port of Tests/PalmierProTests/Fixtures.swift). Only imported by *.test.ts.
import { makeClip, makeTimeline, makeTrack, type Clip, type Timeline, type Track } from "./timeline";
import type { ClipType } from "./clipType";
import { newId } from "../util/id";

export function fixtureClip(p: {
  id?: string;
  mediaRef?: string;
  mediaType?: ClipType;
  start: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number;
  speed?: number;
  volume?: number;
}): Clip {
  const mediaType = p.mediaType ?? "video";
  return makeClip({
    id: p.id ?? newId(),
    mediaRef: p.mediaRef ?? "media-1",
    mediaType,
    sourceClipType: mediaType,
    startFrame: p.start,
    durationFrames: p.duration,
    trimStartFrame: p.trimStart ?? 0,
    trimEndFrame: p.trimEnd ?? 0,
    speed: p.speed ?? 1.0,
    volume: p.volume ?? 1.0,
  });
}

export function fixtureVideoTrack(p: { id?: string; clips?: Clip[] } = {}): Track {
  return makeTrack({ id: p.id ?? newId(), type: "video", clips: p.clips ?? [] });
}

export function fixtureAudioTrack(p: { id?: string; clips?: Clip[] } = {}): Track {
  return makeTrack({ id: p.id ?? newId(), type: "audio", clips: p.clips ?? [] });
}

export function fixtureTimeline(p: { fps?: number; tracks?: Track[] } = {}): Timeline {
  return makeTimeline({ fps: p.fps ?? 30, tracks: p.tracks ?? [] });
}

/** `JSONDecoder().decode(T, JSONEncoder().encode(value))` */
export function roundTrip<T>(value: T, decode: (json: unknown) => T): T {
  return decode(JSON.parse(JSON.stringify(value)));
}
