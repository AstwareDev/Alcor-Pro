import { describe, expect, it } from "vitest";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { makeAnimPair, makeKeyframe, makeKeyframeTrack } from "../model/keyframe";
import { makeExternalSource, makeMediaManifest, makeMediaManifestEntry, type MediaManifestEntry } from "../model/mediaManifest";
import { joinPath, makeMediaResolver, type MediaResolver } from "../model/mediaResolver";
import { makeTextOutline, makeTextStyle, makeRGBA } from "../model/textStyle";
import {
  makeClip, makeCrop, makeTransform, timelineTotalFrames, type Clip, type Timeline,
} from "../model/timeline";
import { makeSourceTimecode, sourceTimecodeFrames, type SourceTimecode } from "./exportSupport";
import {
  fcpxmlExporterMediaRefs, fcpxmlExporterRender, fcpxmlTargetDisplayName, fcpxmlVersionCompatibilityNote,
  fcpxmlVersionDefault, fcpxmlVersions, type FCPXMLTarget, type FCPXMLVersion,
} from "./fcpxmlExporter";

const tmp = "/tmp";

/** Every external file "exists" (the Swift tests create empty files for each entry). */
function makeResolver(entries: MediaManifestEntry[]): MediaResolver {
  const manifest = makeMediaManifest({ entries });
  return makeMediaResolver({ manifest: () => manifest, projectPath: () => undefined, fileExists: () => true });
}

function videoEntry(
  id: string, dir: string, o: { duration?: number; sourceWidth?: number; sourceHeight?: number; hasAudio?: boolean } = {},
): MediaManifestEntry {
  const entry = makeMediaManifestEntry({
    id, name: id, type: "video", source: makeExternalSource(joinPath(dir, `${id}.mp4`)),
    duration: o.duration ?? 5, sourceWidth: o.sourceWidth ?? 1920, sourceHeight: o.sourceHeight ?? 1080,
  });
  if (o.hasAudio !== undefined) entry.hasAudio = o.hasAudio;
  return entry;
}

function audioEntry(id: string, dir: string, duration = 5): MediaManifestEntry {
  return makeMediaManifestEntry({ id, name: id, type: "audio", source: makeExternalSource(joinPath(dir, `${id}.m4a`)), duration });
}

function render(
  timeline: Timeline, resolver: MediaResolver,
  o: { version?: FCPXMLVersion; target?: FCPXMLTarget; startTimecodes?: ReadonlyMap<string, SourceTimecode> } = {},
): string {
  return fcpxmlExporterRender({ timeline, resolver, ...o });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function between(xml: string, start: string, end: string): string {
  const after = xml.split(start)[1];
  return after === undefined ? "" : (after.split(end)[0] ?? "");
}

function videoTimeline(clips: Clip[]): Timeline {
  return fixtureTimeline({ tracks: [fixtureVideoTrack({ clips })] });
}

describe("FCPXMLExporter", () => {
  // MARK: - Document structure

  it("headerHasFcpxmlProjectSequenceAndResources", () => {
    const timeline = fixtureTimeline();
    const xml = render(timeline, makeResolver([]));

    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true);
    expect(xml).toContain("<!DOCTYPE fcpxml>");
    expect(xml).toContain("<fcpxml version=\"1.10\">");
    expect(xml).toContain("<resources>");
    expect(xml).toContain("<format id=\"r1\"");
    expect(xml).toContain("name=\"FFVideoFormat1080p30\"");
    expect(xml).toContain("colorSpace=\"1-1-1 (Rec. 709)\"");
    expect(xml).toContain("<library>");
    expect(xml).toContain("<event name=\"Alcor Export\">");
    expect(xml).toContain(`<project name="${timeline.name}">`);
    expect(xml).toContain("<sequence format=\"r1\" duration=\"0s\"");
    expect(xml).toContain("<spine/>");
  });

  it("explicitVersionIsHonoredInHeader", () => {
    const xml = render(fixtureTimeline(), makeResolver([]), { version: "1.14" });
    expect(xml).toContain("<fcpxml version=\"1.14\">");
  });

  it("exportEnumsExposeSwiftRawValuesAndMetadata", () => {
    expect(fcpxmlVersions).toEqual(["1.10", "1.11", "1.12", "1.13", "1.14"]);
    expect(fcpxmlVersionDefault).toBe("1.10");
    expect(fcpxmlVersionCompatibilityNote("1.14")).toBe("DaVinci Resolve 21+, Final Cut Pro 12+");
    expect(fcpxmlTargetDisplayName("resolve")).toBe("DaVinci Resolve");
    expect(fcpxmlTargetDisplayName("fcp")).toBe("Final Cut Pro");
  });

  it("clipsReferencingUnresolvableMediaAreSkipped", () => {
    const clip = fixtureClip({ id: "ghost", mediaRef: "missing", start: 0, duration: 30 });
    const xml = render(videoTimeline([clip]), makeResolver([]));

    expect(xml).not.toContain("<asset-clip");
    expect(xml).not.toContain("<ref-clip");
    expect(xml).not.toContain("<media id=");
    expect(xml).not.toContain("ghost");
  });

  it("repeatedMediaRefEmitsOneAssetResource", () => {
    const clipA = fixtureClip({ id: "a", mediaRef: "shared", start: 0, duration: 30 });
    const clipB = fixtureClip({ id: "b", mediaRef: "shared", start: 60, duration: 30 });
    const xml = render(videoTimeline([clipA, clipB]), makeResolver([videoEntry("shared", tmp)]));

    expect(count(xml, "<asset id=\"asset")).toBe(1); // one shared asset
    expect(count(xml, "<media id=\"media")).toBe(0); // audio-less source needs no compound
    expect(count(xml, "<asset-clip ref=\"asset1\"")).toBe(2); // two flat asset-clips reference it
  });

  it("distinctMediaRefsWithSameSourceFileEmitOneAssetResource", () => {
    const source = "/tmp/shared-source-1234.mp4";
    const mk = (id: string, name: string): MediaManifestEntry => {
      const e = makeMediaManifestEntry({
        id, name, type: "video", source: makeExternalSource(source), duration: 5, sourceWidth: 1920, sourceHeight: 1080,
      });
      e.hasAudio = true;
      return e;
    };
    const clipA = fixtureClip({ id: "a", mediaRef: "shared-a", start: 0, duration: 30 });
    const clipB = fixtureClip({ id: "b", mediaRef: "shared-b", start: 60, duration: 30 });
    const xml = render(videoTimeline([clipA, clipB]), makeResolver([mk("shared-a", "A"), mk("shared-b", "B")]));

    expect(count(xml, "<asset id=\"asset")).toBe(1);
    expect(count(xml, "<media id=\"media")).toBe(1);
    // Both refs collapse onto the one asset; each ref-clip is named for the shared file (with extension).
    expect(count(xml, "<ref-clip ref=\"media1\" name=\"shared-source-1234.mp4\"")).toBe(2);
    expect(xml).not.toContain("<asset id=\"asset2\"");
  });

  it("apostropheInSourcePathPercentEncodesInMediaRep", () => {
    // Resolve's relinker fails on &apos; — the apostrophe must land as %27.
    const clip = fixtureClip({ id: "c", mediaRef: "sam's clip", start: 0, duration: 30 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("sam's clip", tmp)]));
    const rep = between(xml, "<media-rep", "/>");

    expect(rep).toContain("%27");
    expect(rep).not.toContain("&apos;");
  });

  it("stillImageEmitsVideoElementWithTransform", () => {
    const entry = makeMediaManifestEntry({
      id: "broll", name: "broll", type: "image", source: makeExternalSource("/tmp/broll.png"), duration: 0,
      sourceWidth: 1920, sourceHeight: 1080,
    });
    const clip = fixtureClip({ id: "c", mediaRef: "broll", mediaType: "image", start: 0, duration: 30 });
    clip.transform = makeTransform({ centerX: 0.25, centerY: 0.75 });
    const xml = render(videoTimeline([clip]), makeResolver([entry]));

    expect(xml).toContain("<video ref=\"asset1\" name=\"broll.png\" lane=\"1\"");
    expect(xml).not.toContain("<ref-clip");
    expect(xml).not.toContain("<media id=");
    expect(xml).toContain("<adjust-transform scale=\"1 1\" anchor=\"0 0\" position=\"-44.4444 -25\"/>");
  });

  it("assetResourcesOmitSyntheticUID", () => {
    const clip = fixtureClip({ id: "clip", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));
    const asset = between(xml, "<asset id=\"asset1\"", "</asset>");

    expect(asset).not.toContain("uid=");
    expect(xml).not.toContain("io.palmier.media.asset");
  });

  it("oneSidedAvClipWrapsAssetInFullMediaCompoundClip", () => {
    // The compound must hold the FULL media (5s), independent of the clip's trim/duration.
    const clip = fixtureClip({ id: "c", mediaRef: "media-v", start: 0, duration: 30, trimStart: 20 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]));
    const compound = between(xml, "<media id=\"media1\"", "</media>");

    expect(compound).toContain("<sequence format=\"r2\" duration=\"5s\"");
    expect(compound).toContain("<asset-clip ref=\"asset1\" name=\"media-v.mp4\" duration=\"5s\" start=\"0s\" offset=\"0s\" format=\"r2\"/>");
    expect(xml).toContain("<ref-clip ref=\"media1\"");
    expect(xml).toContain("srcEnable=\"video\"");
    expect(xml).toContain("<adjust-conform type=\"fit\"/>");
  });

  it("audiolessVideoEmitsFlatAssetClipWithoutCompound", () => {
    const clip = fixtureClip({ id: "c", mediaRef: "media-v", start: 0, duration: 30, trimStart: 20 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).not.toContain("<media id=");
    expect(xml).not.toContain("<ref-clip");
    expect(xml).toContain("<asset-clip ref=\"asset1\" name=\"media-v.mp4\" lane=\"1\"");
    expect(xml).toContain("<adjust-conform type=\"fit\"/>");
  });

  it("sameMediaRefVideoAndAudioShareOneAsset", () => {
    const video = fixtureClip({ id: "video", mediaRef: "media-v", mediaType: "video", start: 0, duration: 30 });
    const audio = fixtureClip({ id: "audio", mediaRef: "media-v", mediaType: "audio", start: 0, duration: 30 });
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [video] }), fixtureAudioTrack({ clips: [audio] })] });
    const xml = render(timeline, makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]));

    expect(xml).not.toContain("<asset id=\"asset2\"");
    const asset = between(xml, "<asset id=\"asset1\"", "</asset>");
    expect(asset).toContain("hasVideo=\"1\"");
    expect(asset).toContain("format=\"r2\"");
    expect(asset).toContain("videoSources=\"1\"");
    expect(asset).toContain("hasAudio=\"1\"");
    expect(asset).toContain("audioSources=\"1\"");
    expect(asset).toContain("audioChannels=\"2\"");
    expect(asset).toContain("audioRate=\"48000\"");
    expect(xml).toContain("<ref-clip ref=\"media1\" name=\"media-v.mp4\" lane=\"1\"");
    expect(xml).toContain("srcEnable=\"video\"");
    expect(xml).toContain("<ref-clip ref=\"media1\" name=\"media-v.mp4\" lane=\"-1\"");
    expect(xml).toContain("srcEnable=\"audio\"");
  });

  it("linkedAvPairCollapsesToOneFlatAssetClip", () => {
    const video = fixtureClip({ id: "video", mediaRef: "media-v", mediaType: "video", start: 0, duration: 30 });
    const audio = fixtureClip({ id: "audio", mediaRef: "media-v", mediaType: "audio", start: 0, duration: 30, volume: 0.5 });
    video.linkGroupId = "pair";
    audio.linkGroupId = "pair";
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [video] }), fixtureAudioTrack({ clips: [audio] })] });
    const xml = render(timeline, makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]));

    expect(xml).toContain("<asset-clip ref=\"asset1\" name=\"media-v.mp4\" lane=\"1\"");
    expect(xml).not.toContain("<ref-clip");
    expect(xml).not.toContain("<media id=");
    expect(xml).not.toContain("lane=\"-1\"");
    expect(xml).not.toContain("srcEnable=");
    expect(xml).toContain("<adjust-volume amount=\"-6.0206\"/>");
  });

  it("mutedAudioTrackKeepsLinkedPairSeparate", () => {
    const video = fixtureClip({ id: "video", mediaRef: "media-v", mediaType: "video", start: 0, duration: 30 });
    const audio = fixtureClip({ id: "audio", mediaRef: "media-v", mediaType: "audio", start: 0, duration: 30 });
    video.linkGroupId = "pair";
    audio.linkGroupId = "pair";
    const audioTrack = fixtureAudioTrack({ clips: [audio] });
    audioTrack.muted = true;
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [video] }), audioTrack] });
    const xml = render(timeline, makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]));

    expect(xml).toContain("<ref-clip ref=\"media1\" name=\"media-v.mp4\" lane=\"1\"");
    expect(xml).toContain("srcEnable=\"video\"");
    expect(xml).toContain("<ref-clip ref=\"media1\" name=\"media-v.mp4\" lane=\"-1\"");
    expect(xml).toContain("srcEnable=\"audio\"");
    expect(xml).toContain("enabled=\"0\"");
  });

  it("visualTrackLanesPreserveTopOverBottom", () => {
    const top = fixtureClip({ id: "top", mediaRef: "media-v", start: 0, duration: 30 });
    const bottom = fixtureClip({ id: "bottom", mediaRef: "media-v", start: 0, duration: 30 });
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [top] }), fixtureVideoTrack({ clips: [bottom] })] });
    const xml = render(timeline, makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("name=\"media-v.mp4\" lane=\"2\" offset=\"0s\"");
    expect(xml).toContain("name=\"media-v.mp4\" lane=\"1\" offset=\"0s\"");
  });

  it("mediaRefsToProbeCoverNestedTimelines", () => {
    const child = videoTimeline([fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })]);
    const carrier = makeClip({
      mediaRef: child.id, mediaType: "sequence", sourceClipType: "sequence", startFrame: 0, durationFrames: timelineTotalFrames(child),
    });
    const parent = videoTimeline([carrier, fixtureClip({ mediaRef: "v2", start: 60, duration: 30 })]);

    const refs = fcpxmlExporterMediaRefs(parent, (id) => (id === child.id ? child : undefined));

    expect([...refs].sort()).toEqual(["v1", "v2"]);
  });

  // MARK: - Timing & speed

  it("videoClipEmitsFlatAssetClipWithOffsetStartAndDuration", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 30, duration: 60, trimStart: 10 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<asset-clip ref=\"asset1\" name=\"media-v.mp4\" lane=\"1\"");
    expect(xml).toContain("offset=\"1s\"");
    expect(xml).toContain("start=\"1/3s\"");
    expect(xml).toContain("duration=\"2s\"");
    expect(xml).not.toContain("<timeMap");
  });

  it("speedChangeEmitsWholeMediaTimeMap", () => {
    // 5s media @ 30fps = 150 source frames; 2x speed-up, trimStart 10, 60-frame output.
    const clip = fixtureClip({ id: "fast", mediaRef: "media-v", start: 0, duration: 60, trimStart: 10, speed: 2.0 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("offset=\"0s\" start=\"1/6s\" duration=\"2s\"");
    expect(xml).toContain("<timeMap frameSampling=\"floor\">");
    expect(xml).toContain("<timept time=\"0s\" value=\"0s\" interp=\"linear\"/>");
    expect(xml).toContain("<timept time=\"5/2s\" value=\"5s\" interp=\"linear\"/>");
  });

  it("slowMotionEmitsWholeMediaTimeMap", () => {
    const clip = fixtureClip({ id: "slow", mediaRef: "media-v", start: 0, duration: 60, trimStart: 30, speed: 0.5 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("start=\"2s\"");
    expect(xml).toContain("<timept time=\"10s\" value=\"5s\" interp=\"linear\"/>");
  });

  it("retimedKeyframeTimeIsOffsetByStart", () => {
    const clip = fixtureClip({ id: "z", mediaRef: "media-v", start: 0, duration: 60, trimStart: 10, speed: 2.0 });
    clip.scaleTrack = makeKeyframeTrack([
      makeKeyframe(0, makeAnimPair(0.5, 0.5), "linear"),
      makeKeyframe(15, makeAnimPair(1, 1), "linear"),
    ]);
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("start=\"1/6s\"");
    expect(xml).toContain("<keyframe time=\"1/6s\"");
    expect(xml).toContain("<keyframe time=\"2/3s\"");
  });

  // MARK: - Source timecode

  it("embeddedTimecodeConvertsToTimelineFrames", () => {
    // 00:00:14:44 @ 50fps -> 744 quanta-frames; at a 50fps timeline that's 744/50 = 372/25s.
    const tc = makeSourceTimecode({ frame: 744, quanta: 50, dropFrame: false });
    expect(sourceTimecodeFrames(tc, 50)).toBe(744);
    // A 25fps timeline halves it (14.88s -> 372 frames).
    expect(sourceTimecodeFrames(tc, 25)).toBe(372);
  });

  it("assetAndCompoundStartCarryEmbeddedTimecode", () => {
    const clip = fixtureClip({ id: "c", mediaRef: "media-v", start: 0, duration: 30, trimStart: 10 });
    const tc = makeSourceTimecode({ frame: 744, quanta: 50, dropFrame: false });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]), {
      startTimecodes: new Map([["media-v", tc]]),
    });

    expect(xml).toContain("<asset id=\"asset1\" name=\"media-v.mp4\" start=\"372/25s\"");
    expect(xml).toContain("start=\"372/25s\" offset=\"0s\"");
    expect(xml).toContain("<ref-clip ref=\"media1\" name=\"media-v.mp4\" lane=\"1\" offset=\"0s\" start=\"1/3s\"");
  });

  it("absentTimecodeKeepsZeroBasedStarts", () => {
    const clip = fixtureClip({ id: "c", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp, { hasAudio: true })]));

    expect(xml).toContain("<asset id=\"asset1\" name=\"media-v.mp4\" start=\"0s\"");
  });

  it("unspeededTrimmedKeyframeStaysClipRelative", () => {
    const clip = fixtureClip({ id: "t", mediaRef: "media-v", start: 0, duration: 60, trimStart: 10 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(30, 1.0, "linear")]);
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).not.toContain("<timeMap");
    expect(xml).toContain("<keyframe time=\"0s\" curve=\"linear\" value=\"0\"/>"); // not 1/3s
    expect(xml).toContain("<keyframe time=\"1s\" curve=\"linear\" value=\"1\"/>");
  });

  // MARK: - Transform, scale, flip

  it("fittedVideoEmitsNoTransform", () => {
    const entry = videoEntry("media-v", tmp, { sourceWidth: 3413, sourceHeight: 607 });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ width: 1, height: 1920 / 1080 / (3413 / 607) });
    const xml = render(videoTimeline([clip]), makeResolver([entry]));

    expect(xml).toContain("<format id=\"r2\" name=\"FFVideoFormat3413x607p30\" frameDuration=\"1/30s\" width=\"3413\" height=\"607\" colorSpace=\"1-1-1 (Rec. 709)\"/>");
    expect(xml).not.toContain("<adjust-transform");
  });

  it("ntscSourceFormatUsesFinalCutRateSuffix", () => {
    const entry = videoEntry("media-v", tmp);
    entry.sourceFPS = 29.97;
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const xml = render(videoTimeline([clip]), makeResolver([entry]));

    expect(xml).toContain("<format id=\"r2\" name=\"FFVideoFormat1080p2997\" frameDuration=\"1001/30000s\" width=\"1920\" height=\"1080\" colorSpace=\"1-1-1 (Rec. 709)\"/>");
  });

  it("customTimelineFormatUsesFinalCutGenericPresetName", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const timeline = videoTimeline([clip]);
    timeline.width = 1080;
    timeline.height = 1920;
    const xml = render(timeline, makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<format id=\"r1\" name=\"FFVideoFormatRateUndefined\" frameDuration=\"1/30s\" width=\"1080\" height=\"1920\" colorSpace=\"1-1-1 (Rec. 709)\"/>");
    expect(xml).toContain("<sequence format=\"r1\"");
  });

  it("centeredUnrotatedVideoOmitsTransform", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).not.toContain("<adjust-transform");
  });

  it("videoTransformExportsPositionAndRotation", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ centerX: 0.25, centerY: 0.75, rotation: 30 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-transform scale=\"1 1\" rotation=\"-30\" anchor=\"0 0\" position=\"-44.4444 -25\"/>");
  });

  it("scaledVideoExportsScaleRelativeToFit", () => {
    const entry = videoEntry("media-v", tmp, { sourceWidth: 3413, sourceHeight: 607 });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const fitHeight = 1920 / 1080 / (3413 / 607);
    clip.transform = makeTransform({ width: 0.5, height: fitHeight * 0.5 });
    const xml = render(videoTimeline([clip]), makeResolver([entry]));

    expect(xml).toContain("<adjust-transform scale=\"0.5 0.5\" anchor=\"0 0\" position=\"0 0\"/>");
  });

  it("matchedAspectScaleExportsFractionDirectly", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ width: 0.5, height: 0.5 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-transform scale=\"0.5 0.5\" anchor=\"0 0\" position=\"0 0\"/>");
  });

  it("horizontalFlipExportsNegativeScale", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ flipHorizontal: true });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-transform scale=\"-1 1\" anchor=\"0 0\" position=\"0 0\"/>");
  });

  it("fittedClipPositionDividesOutConformFit", () => {
    // 16:9 in 9:16: fitH = 81/256, so centerY 0.75 -> -25*256/81 = -79.0123; x unaffected (fitW 1).
    const entry = videoEntry("media-v", tmp, { sourceWidth: 1280, sourceHeight: 720 });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ centerX: 0.75, centerY: 0.75, width: 1, height: 81 / 256 });
    const timeline = videoTimeline([clip]);
    timeline.width = 1080;
    timeline.height = 1920;
    const xml = render(timeline, makeResolver([entry]));

    expect(xml).toContain("<adjust-transform scale=\"1 1\" anchor=\"0 0\" position=\"14.0625 -79.0123\"/>");
  });

  it("fcpTargetWritesSpecLiteralPositionAndCrop", () => {
    const entry = videoEntry("media-v", tmp, { sourceWidth: 1280, sourceHeight: 720 });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.transform = makeTransform({ centerX: 0.75, centerY: 0.75, width: 1, height: 81 / 256 });
    clip.crop = makeCrop({ left: 0.2, top: 0.05, right: 0.1, bottom: 0.05 });
    const timeline = videoTimeline([clip]);
    timeline.width = 1080;
    timeline.height = 1920;
    const xml = render(timeline, makeResolver([entry]), { target: "fcp" });

    expect(xml).toContain("position=\"14.0625 -25\"");
    expect(xml).toContain("<trim-rect top=\"5\" right=\"10\" bottom=\"5\" left=\"20\"/>");
  });

  it("positionKeyframesExportAsParamAnimation", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.positionTrack = makeKeyframeTrack([
      makeKeyframe(0, makeAnimPair(0, 0), "linear"),
      makeKeyframe(30, makeAnimPair(0, 0.25), "linear"),
    ]);
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<param name=\"position\" value=\"0 0\">");
    expect(xml).toContain("<keyframeAnimation>");
    expect(xml).toContain("<keyframe time=\"0s\" curve=\"linear\" value=\"0 0\"/>");
    expect(xml).toContain("<keyframe time=\"1s\" curve=\"linear\" value=\"0 -25\"/>");
  });

  // MARK: - Crop

  it("cropExportsTrimRectInResolveUnits", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.crop = makeCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-crop mode=\"trim\">");
    expect(xml).toContain("<trim-rect top=\"20\" right=\"53.3333\" bottom=\"40\" left=\"17.7778\"/>");
  });

  it("cropOfWideSourceInPortraitSequenceMatchesResolveEncoding", () => {
    const entry = videoEntry("media-v", tmp, { sourceWidth: 1280, sourceHeight: 720 });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.crop = makeCrop({ left: 0.2, top: 0.05, right: 0.1, bottom: 0.05 });
    const timeline = videoTimeline([clip]);
    timeline.width = 1080;
    timeline.height = 1920;
    const xml = render(timeline, makeResolver([entry]));

    expect(xml).toContain("<trim-rect top=\"5.9259\" right=\"6.6667\" bottom=\"5.9259\" left=\"13.3333\"/>");
  });

  it("identityCropOmitsAdjustCrop", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).not.toContain("<adjust-crop");
  });

  // MARK: - Opacity

  it("clipOpacityExportsAdjustBlend", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.opacity = 0.25;
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-blend amount=\"0.25\"/>");
  });

  it("fullyOpaqueClipOmitsAdjustBlend", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).not.toContain("<adjust-blend");
  });

  it("opacityKeyframesExportInsideAdjustBlend", () => {
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-v", start: 0, duration: 60 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(30, 1.0, "linear")]);
    const xml = render(videoTimeline([clip]), makeResolver([videoEntry("media-v", tmp)]));

    expect(xml).toContain("<adjust-blend amount=\"1\">");
    expect(xml).toContain("<param name=\"amount\" value=\"1\">");
    expect(xml).toContain("<keyframe time=\"0s\" curve=\"linear\" value=\"0\"/>");
    expect(xml).toContain("<keyframe time=\"1s\" curve=\"linear\" value=\"1\"/>");
  });

  // MARK: - Volume

  it("reducedVolumeExportsAdjustVolumeInDecibels", () => {
    const clip = fixtureClip({ id: "clip-a", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60 });
    clip.volume = 0.5;
    const timeline = fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] });
    const xml = render(timeline, makeResolver([audioEntry("media-a", tmp)]));

    expect(xml).toContain("<adjust-volume amount=\"-6.0206\"/>"); // 20*log10(0.5)
  });

  it("unityVolumeOmitsAdjustVolume", () => {
    const clip = fixtureClip({ id: "clip-a", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60 });
    const timeline = fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] });
    const xml = render(timeline, makeResolver([audioEntry("media-a", tmp)]));

    expect(xml).not.toContain("<adjust-volume");
  });

  it("volumeKeyframesCollapseToStaticLevel", () => {
    const clip = fixtureClip({ id: "clip-a", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60 });
    clip.volume = 0.5;
    clip.volumeTrack = makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(30, -6.0, "linear")]);
    const timeline = fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] });
    const xml = render(timeline, makeResolver([audioEntry("media-a", tmp)]));

    expect(xml).toContain("<adjust-volume amount=\"-6.0206\"/>"); // self-closing -> no keyframeAnimation
  });

  // MARK: - Deliberately not exported

  it("fadesAndChannelLayoutAreNotExported", () => {
    const audio = fixtureClip({ id: "audio", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60 });
    audio.fadeInFrames = 15;
    const timeline = fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [audio] })] });
    const xml = render(timeline, makeResolver([audioEntry("media-a", tmp)]));

    expect(xml).toContain("<asset-clip ref=\"asset1\"");
    expect(xml).not.toContain("srcEnable=");
    expect(xml).not.toContain("<fadeIn");
    expect(xml).not.toContain("<audio-channel-source");
  });

  // MARK: - Titles

  function textClip(content: string, o: { start?: number; duration?: number } = {}): Clip {
    const clip = fixtureClip({ id: "title", mediaRef: "text", mediaType: "text", start: o.start ?? 0, duration: o.duration ?? 60 });
    clip.textContent = content;
    return clip;
  }

  it("textClipEmitsTitleAndEscapedText", () => {
    const text = textClip("A & B", { start: 30 });
    text.textStyle = makeTextStyle({ fontName: "Helvetica", fontSize: 48, isBold: false, alignment: "left" });
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("<effect id=\"titleBasic\"");
    expect(xml).toContain("<title ref=\"titleBasic\" name=\"A &amp; B\"");
    expect(xml).toContain("<text-style ref=\"textStyle1\">A &amp; B</text-style>");
    expect(xml).toContain("font=\"Helvetica\"");
    expect(xml).toContain("fontFace=\"Regular\"");
    expect(xml).toContain("fontSize=\"48\"");
    expect(xml).toContain("alignment=\"left\"");
  });

  it("postScriptFontNameExportsFamilyAndFaceForResolveTitles", () => {
    const text = textClip("Caption");
    text.textStyle = makeTextStyle({ fontName: "Helvetica-Bold", isBold: true });
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("font=\"Helvetica\"");
    expect(xml).toContain("fontFace=\"Bold\"");
  });

  it("explicitFontTraitsOverridePostScriptFontFaceForResolveTitles", () => {
    const text = textClip("Caption");
    text.textStyle = makeTextStyle({ fontName: "Helvetica-Bold", isBold: false, isItalic: false });
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("font=\"Helvetica\"");
    expect(xml).toContain("fontFace=\"Regular\"");
  });

  it("textBorderExportsStrokeColorAndWidth", () => {
    const text = textClip("HOOK");
    text.textStyle = makeTextStyle({
      fontSize: 96,
      border: makeTextOutline({ enabled: true, color: makeRGBA({ r: 0, g: 0, b: 0, a: 1 }), width: 7 }),
      fontScale: 2,
    });
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("strokeColor=\"0 0 0 1\"");
    expect(xml).toContain("strokeWidth=\"14\"");
  });

  it("disabledBorderOmitsStroke", () => {
    const text = textClip("HOOK");
    text.textStyle = makeTextStyle();
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).not.toContain("strokeColor=");
    expect(xml).not.toContain("strokeWidth=");
  });

  it("textScaleExportsAsIndependentTitleTransform", () => {
    const text = textClip("WIDE");
    text.textStyle = makeTextStyle({ widthScale: 1.5, heightScale: 0.75 });
    text.transform = makeTransform({ width: 0.2, height: 0.1 });
    text.scaleTrack = makeKeyframeTrack([
      makeKeyframe(0, makeAnimPair(0.2, 0.1), "linear"),
      makeKeyframe(30, makeAnimPair(0.4, 0.2), "linear"),
    ]);
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("<param name=\"scale\" value=\"1.5 0.75\">");
    expect(xml).toContain("<keyframe time=\"0s\" curve=\"linear\" value=\"1.5 0.75\"/>");
    expect(xml).toContain("<keyframe time=\"1s\" curve=\"linear\" value=\"3 1.5\"/>");
  });

  it("titleFontSizeDoesNotScaleWithSequenceHeight", () => {
    const text = textClip("Caption");
    text.textStyle = makeTextStyle({ fontSize: 48 });
    const timeline = videoTimeline([text]);
    timeline.width = 720;
    timeline.height = 1280;
    const xml = render(timeline, makeResolver([]));

    expect(xml).toContain("fontSize=\"48\"");
    expect(xml).toContain("<adjust-transform scale=\"1 1\" anchor=\"0 0\" position=\"0 0\"/>");
  });

  it("textBoxTransformExportsTitlePositionAndOpacity", () => {
    const text = textClip("Caption");
    text.opacity = 0.5;
    text.transform = makeTransform({ centerX: 0.25, centerY: 0.75, width: 0.2, height: 0.1, rotation: 15 });
    const xml = render(videoTimeline([text]), makeResolver([]));

    expect(xml).toContain("<title ref=\"titleBasic\" name=\"Caption\"");
    expect(xml).toContain("<text-style ref=\"textStyle1\">Caption</text-style>");
    expect(xml).toContain("<adjust-conform type=\"fit\"/>");
    expect(xml).toContain("<adjust-transform scale=\"1 1\" anchor=\"0 0\" position=\"-44.4444 -25\"/>");
    expect(xml).not.toContain("<param name=\"Position\"");
    expect(xml).toContain("<adjust-blend amount=\"0.5\"/>");
  });
});

describe("FCPXMLExporter — nested timelines", () => {
  function videoEntryUnique(id: string, hasAudio?: boolean): MediaManifestEntry {
    const entry = makeMediaManifestEntry({
      id, name: id, type: "video", source: makeExternalSource(`/tmp/${id}-0000.mp4`), duration: 5,
      sourceWidth: 1920, sourceHeight: 1080,
    });
    if (hasAudio !== undefined) entry.hasAudio = hasAudio;
    return entry;
  }

  function carrier(child: Timeline, start: number, duration?: number, trimStart = 0): Clip {
    return makeClip({
      mediaRef: child.id, mediaType: "sequence", sourceClipType: "sequence", startFrame: start,
      durationFrames: duration ?? timelineTotalFrames(child), trimStartFrame: trimStart,
    });
  }

  function renderNested(parent: Timeline, timelines: Timeline[], resolver: MediaResolver): string {
    const byId = new Map(timelines.map((t) => [t.id, t]));
    return fcpxmlExporterRender({ timeline: parent, resolver, resolveTimeline: (id) => byId.get(id) });
  }

  function lineWith(xml: string, needle: string): string {
    return xml.split("\n").find((l) => l.includes(needle)) ?? "";
  }

  it("nestEmitsCompoundResourceAndRefClip", () => {
    const resolver = makeResolver([videoEntryUnique("v1")]);
    const child = videoTimeline([fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })]);
    child.name = "Intro";
    const parent = videoTimeline([carrier(child, 30)]);

    const xml = renderNested(parent, [child, parent], resolver);

    expect(xml).toContain("<media id=\"nest1\" name=\"Intro\">");
    expect(xml).toContain("<ref-clip ref=\"nest1\"");
    const refClipLine = lineWith(xml, "<ref-clip ref=\"nest1\"");
    expect(refClipLine).toContain("srcEnable=\"video\"");
    expect(refClipLine).toContain("offset=\"1s\"");
    expect(refClipLine).toContain("duration=\"2s\"");
    expect(xml).toContain("<asset-clip ref=\"asset1\"");
  });

  it("linkedCarrierPairCollapsesIntoOneRefClip", () => {
    const resolver = makeResolver([videoEntryUnique("v1", true)]);
    const child = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })] }),
        fixtureAudioTrack({ clips: [fixtureClip({ mediaRef: "v1", mediaType: "audio", start: 0, duration: 60 })] }),
      ],
    });
    const video = carrier(child, 0);
    const audio = fixtureClip({ mediaRef: child.id, mediaType: "audio", start: 0, duration: 60 });
    audio.sourceClipType = "sequence";
    video.linkGroupId = "g1";
    audio.linkGroupId = "g1";
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [video] }), fixtureAudioTrack({ clips: [audio] })] });

    const xml = renderNested(parent, [child, parent], resolver);

    expect(count(xml, "<ref-clip ref=\"nest1\"")).toBe(1);
    expect(lineWith(xml, "<ref-clip ref=\"nest1\"")).not.toContain("srcEnable");
  });

  it("twoLevelNestingEmitsBothCompounds", () => {
    const resolver = makeResolver([videoEntryUnique("v1")]);
    const grandchild = videoTimeline([fixtureClip({ mediaRef: "v1", start: 0, duration: 30 })]);
    grandchild.name = "Deep";
    const child = videoTimeline([carrier(grandchild, 0)]);
    const parent = videoTimeline([carrier(child, 0)]);

    const xml = renderNested(parent, [grandchild, child, parent], resolver);

    expect(xml).toContain("<media id=\"nest1\"");
    expect(xml).toContain("<media id=\"nest2\" name=\"Deep\">");
    expect(xml).toContain("<ref-clip ref=\"nest2\"");
  });

  it("frozenCarrierClampsToChildContent", () => {
    const resolver = makeResolver([videoEntryUnique("v1")]);
    const child = videoTimeline([fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })]);
    // Carrier frozen at 100 frames with 10 trimmed off the head: only 50 frames of content remain.
    const parent = videoTimeline([carrier(child, 0, 100, 10)]);

    const xml = renderNested(parent, [child, parent], resolver);

    const refClipLine = lineWith(xml, "<ref-clip ref=\"nest1\"");
    expect(refClipLine).toContain("start=\"1/3s\"");
    expect(refClipLine).toContain("duration=\"5/3s\"");
  });

  it("emptyOrMissingChildDropsCarrier", () => {
    const resolver = makeResolver([]);
    const empty = fixtureTimeline();
    const missing = fixtureClip({ mediaRef: "no-such-timeline", start: 60, duration: 30 });
    missing.mediaType = "sequence";
    missing.sourceClipType = "sequence";
    const parent = videoTimeline([carrier(empty, 0, 30), missing]);

    const xml = renderNested(parent, [empty, parent], resolver);

    expect(xml).not.toContain("<media id=\"nest");
    expect(xml).not.toContain("<ref-clip");
  });
});
