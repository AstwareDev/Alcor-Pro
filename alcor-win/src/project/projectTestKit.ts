// Test helpers (port of the bundle builders in VideoProjectLoadTests). Only imported by *.test.ts.
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { makeMediaManifest, makeMediaManifestEntry, makeProjectSource, type MediaManifest } from "../model";
import { MemoryFileSystem } from "./memoryFileSystem";

export function sampleManifest(): MediaManifest {
  return makeMediaManifest({
    entries: [
      makeMediaManifestEntry({
        id: "a", name: "A", type: "video", source: makeProjectSource("media/a.mp4"), duration: 1,
      }),
    ],
  });
}

/** A legacy-shaped package: `project.json` holds a bare timeline. */
export function makeBundle(fs: MemoryFileSystem, path: string, tracks = 1): void {
  const timeline = fixtureTimeline({
    tracks: Array.from({ length: tracks }, () => fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 30 })] })),
  });
  fs.seedText(`${path}/project.json`, JSON.stringify(timeline));
}
