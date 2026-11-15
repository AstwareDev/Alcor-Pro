import { describe, expect, it } from "vitest";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { makeKeyframe, makeKeyframeTrack, makeAnimPair } from "../model/keyframe";
import { makeExternalSource, makeMediaManifest, makeMediaManifestEntry, type MediaManifestEntry } from "../model/mediaManifest";
import { joinPath, makeMediaResolver, type MediaResolver } from "../model/mediaResolver";
import {
  makeClip, makeCrop, makeTransform, timelineTotalFrames, type Clip, type Timeline,
} from "../model/timeline";
import { makeSourceTimecode } from "./exportSupport";
import {
  xmlExporterFormatTimecode, xmlExporterRender, xmlExporterTimecodeTags,
} from "./xmlExporter";

const tmp = "/tmp";

/** Every external file "exists" (the Swift tests create empty files for each entry). */
function makeResolver(entries: MediaManifestEntry[]): MediaResolver {
  const manifest = makeMediaManifest({ entries });
  return makeMediaResolver({ manifest: () => manifest, projectPath: () => undefined, fileExists: () => true });
}

function videoManifestEntry(id: string, dir: string): MediaManifestEntry {
  return makeMediaManifestEntry({ id, name: id, type: "video", source: makeExternalSource(joinPath(dir, `${id}.mp4`)), duration: 1 });
}

function audioManifestEntry(id: string, dir: string): MediaManifestEntry {
  return makeMediaManifestEntry({ id, name: id, type: "audio", source: makeExternalSource(joinPath(dir, `${id}.m4a`)), duration: 1 });
}

function exportXml(timeline: Timeline, resolver: MediaResolver): string {
  return xmlExporterRender({ timeline, resolver });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("XMLExporter", () => {
  // MARK: - Header / sequence shell

  it("headerHasXmemlVersionAndSequenceShell", () => {
    const xml = exportXml(fixtureTimeline(), makeResolver([]));

    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true);
    expect(xml).toContain("<xmeml version=\"4\">");
    expect(xml).toContain("<sequence id=\"sequence-1\">");
    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<width>1920</width>");
    expect(xml).toContain("<height>1080</height>");
    expect(xml).toContain("</xmeml>");
  });

  it("headerReportsTimelineFpsAndCanvasDimensions", () => {
    const timeline = fixtureTimeline({ fps: 24 });
    timeline.width = 1280;
    timeline.height = 720;
    const xml = exportXml(timeline, makeResolver([]));

    expect(xml).toContain("<timebase>24</timebase>");
    expect(xml).toContain("<width>1280</width>");
    expect(xml).toContain("<height>720</height>");
  });

  it("emptyTimelineProducesZeroDuration", () => {
    const xml = exportXml(fixtureTimeline(), makeResolver([]));
    expect(xml).toContain("<duration>0</duration>");
  });

  // MARK: - Clip emission

  it("videoClipEmitsClipitemWithStartAndEnd", () => {
    const entry = makeMediaManifestEntry({
      id: "media-video", name: "MyVideo", type: "video", source: makeExternalSource("/tmp/video.mp4"), duration: 5.0,
    });
    const clip = fixtureClip({ id: "clip-1", mediaRef: "media-video", start: 30, duration: 60 });
    const xml = exportXml(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), makeResolver([entry]));

    expect(xml).toContain("<clipitem id=\"clipitem-clip-1\">");
    expect(xml).toContain("<name>MyVideo</name>");
    expect(xml).toContain("<start>30</start>");
    expect(xml).toContain("<end>90</end>"); // 30 + 60
  });

  it("clipsReferencingUnresolvableMediaAreSkipped", () => {
    const clip = fixtureClip({ id: "ghost-clip", mediaRef: "missing-media", start: 0, duration: 30 });
    const xml = exportXml(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), makeResolver([]));

    expect(xml).not.toContain("ghost-clip");
    expect(xml).not.toContain("clipitem");
  });

  it("repeatedMediaRefEmitsFileOnceThenReferences", () => {
    const entry = makeMediaManifestEntry({
      id: "shared-media", name: "Shared", type: "video", source: makeExternalSource("/tmp/video.mp4"), duration: 10.0,
    });
    const clip1 = fixtureClip({ id: "c1", mediaRef: "shared-media", start: 0, duration: 30 });
    const clip2 = fixtureClip({ id: "c2", mediaRef: "shared-media", start: 60, duration: 30 });
    const xml = exportXml(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip1, clip2] })] }), makeResolver([entry]));

    expect(count(xml, "<file id=\"file-shared-media-video\">")).toBe(1);
    expect(count(xml, "<file id=\"file-shared-media-video\"/>")).toBe(1);
  });

  // MARK: - Audio clips

  it("audioClipAppearsInAudioSectionOnly", () => {
    const clip = fixtureClip({ id: "audio-clip", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] }),
      makeResolver([audioManifestEntry("media-a", tmp)]),
    );

    const audioSec = xml.indexOf("<audio>");
    const videoSec = xml.indexOf("<video>");
    expect(audioSec).toBeGreaterThanOrEqual(0);
    expect(videoSec).toBeGreaterThanOrEqual(0);
    const clipitem = xml.indexOf("audio-clip");
    expect(clipitem).toBeGreaterThanOrEqual(0);
    // The audio-clip clipitem must appear AFTER <audio>, not in the <video> section.
    expect(clipitem).toBeGreaterThan(audioSec);
    expect(clipitem).toBeGreaterThan(videoSec + "<video>".length); // audio clipitem leaked into the video section
  });

  // MARK: - Links

  it("linkedClipsEmitCrossReferences", () => {
    const resolver = makeResolver([
      makeMediaManifestEntry({ id: "media-v", name: "v", type: "video", source: makeExternalSource("/tmp/v.mp4"), duration: 1 }),
      makeMediaManifestEntry({ id: "media-a", name: "a", type: "audio", source: makeExternalSource("/tmp/a.m4a"), duration: 1 }),
    ]);
    const videoClip = fixtureClip({ id: "vc", mediaRef: "media-v", mediaType: "video", start: 0, duration: 30 });
    videoClip.linkGroupId = "group-1";
    const audioClip = fixtureClip({ id: "ac", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 30 });
    audioClip.linkGroupId = "group-1";
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [videoClip] }), fixtureAudioTrack({ clips: [audioClip] })] }),
      resolver,
    );

    expect(xml).toContain("<linkclipref>clipitem-vc</linkclipref>");
    expect(xml).toContain("<linkclipref>clipitem-ac</linkclipref>");
    expect(xml).toContain("<mediatype>video</mediatype>");
    expect(xml).toContain("<mediatype>audio</mediatype>");
  });

  it("unlinkedClipsEmitNoLinkBlocks", () => {
    const clip = fixtureClip({ id: "lone", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).not.toContain("<link>");
    expect(xml).not.toContain("<linkclipref>");
  });

  // MARK: - Filters

  it("speedNotOneEmitsTimeRemapFilter", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 60, speed: 2.0 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).toContain("<effectid>timeremap</effectid>");
    expect(xml).toContain("<value>200.0000</value>");
  });

  it("speedOneEmitsNoTimeRemapFilter", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 60, speed: 1.0 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).not.toContain("timeremap");
  });

  it("volumeNotOneEmitsAudioLevelsFilter", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60, volume: 0.5 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] }),
      makeResolver([audioManifestEntry("media-a", tmp)]),
    );

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<value>0.5000</value>");
  });

  it("volumeAtUnityEmitsNoAudioLevelsFilter", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 60, volume: 1.0 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureAudioTrack({ clips: [clip] })] }),
      makeResolver([audioManifestEntry("media-a", tmp)]),
    );

    expect(xml).not.toContain("audiolevels");
  });

  it("opacityNotOneEmitsDedicatedOpacityEffect", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 30 });
    clip.opacity = 0.5;
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).toContain("<effectid>opacity</effectid>");
    expect(xml).toContain("<parameterid>opacity</parameterid>");
    expect(xml).toContain("<value>50.0</value>");
  });

  it("nonDefaultTransformEmitsMotionFilterWithMatchingParams", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 30 });
    clip.transform = makeTransform({ centerX: 0.6, centerY: 0.4, width: 0.5, height: 0.5, rotation: 45 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).toContain("<effectid>basic</effectid>");
    expect(xml).toContain("<parameterid>scale</parameterid>");
    expect(xml).toContain("<parameterid>rotation</parameterid>");
    expect(xml).toContain("<parameterid>center</parameterid>");
    expect(xml).toContain("<value>-45.00</value>");
    expect(xml).toContain("<value>50.00</value>");
  });

  it("defaultClipEmitsNoMotionFilter", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).not.toContain("<effectid>basic</effectid>");
  });

  // MARK: - Text clips

  it("textClipsAreNotEmitted", () => {
    const videoClip = fixtureClip({ id: "vc", mediaRef: "media-v", start: 0, duration: 30 });
    const textClip = fixtureClip({ id: "tc", mediaRef: "text-no-manifest", mediaType: "text", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [videoClip, textClip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).not.toContain("clipitem-tc");
    expect(xml).toContain("clipitem-vc");
  });

  // MARK: - Track enabled state

  it("mutedAudioTrackEmitsEnabledFalse", () => {
    const track = fixtureAudioTrack({
      clips: [fixtureClip({ id: "ac", mediaRef: "media-a", mediaType: "audio", start: 0, duration: 30 })],
    });
    track.muted = true;
    const xml = exportXml(fixtureTimeline({ tracks: [track] }), makeResolver([audioManifestEntry("media-a", tmp)]));

    const audioSec = xml.slice(xml.indexOf("<audio>"));
    expect(audioSec).toContain("<enabled>FALSE</enabled>");
  });

  it("hiddenVideoTrackEmitsEnabledFalse", () => {
    const track = fixtureVideoTrack({ clips: [fixtureClip({ id: "vc", mediaRef: "media-v", start: 0, duration: 30 })] });
    track.hidden = true;
    const xml = exportXml(fixtureTimeline({ tracks: [track] }), makeResolver([videoManifestEntry("media-v", tmp)]));

    const videoSec = xml.slice(xml.indexOf("<video>"), xml.indexOf("</video>") + "</video>".length);
    expect(videoSec).toContain("<enabled>FALSE</enabled>");
  });

  // MARK: - Escaping

  it("specialCharsInClipNameAreXMLEscaped", () => {
    const entry = makeMediaManifestEntry({
      id: "media-v", name: "A & B < C > \"D\" 'E'", type: "video", source: makeExternalSource("/tmp/v.mp4"), duration: 1,
    });
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = exportXml(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), makeResolver([entry]));

    expect(xml).toContain("A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;");
    expect(xml).not.toContain("A & B");
  });

  // MARK: - Trim handling

  it("trimStartIsReflectedInInOutPoints", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "media-v", start: 0, duration: 60, trimStart: 10 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).toContain("<in>10</in>");
    expect(xml).toContain("<out>70</out>");
  });

  // MARK: - Timeline duration

  it("sequenceDurationEqualsTimelineTotalFrames", () => {
    const clipA = fixtureClip({ id: "a", mediaRef: "media-v", start: 0, duration: 50 });
    const clipB = fixtureClip({ id: "b", mediaRef: "media-v", start: 100, duration: 80 }); // ends at 180
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clipA, clipB] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    expect(xml).toContain("<duration>180</duration>");
  });

  it("multipleClipsOnSameTrackAreSortedByStartFrame", () => {
    const later = fixtureClip({ id: "later", mediaRef: "media-v", start: 100, duration: 30 });
    const earlier = fixtureClip({ id: "earlier", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [later, earlier] })] }),
      makeResolver([videoManifestEntry("media-v", tmp)]),
    );

    const earlyIdx = xml.indexOf("earlier");
    const laterIdx = xml.indexOf("later");
    expect(earlyIdx).toBeGreaterThanOrEqual(0);
    expect(laterIdx).toBeGreaterThanOrEqual(0);
    expect(earlyIdx).toBeLessThan(laterIdx);
  });

  it("videoTracksAreReversedForFCPConvention", () => {
    const entry = makeMediaManifestEntry({ id: "media-v", name: "v", type: "video", source: makeExternalSource("/tmp/v.mp4"), duration: 5.0 });
    const topClip = fixtureClip({ id: "top-clip", mediaRef: "media-v", start: 0, duration: 30 });
    const bottomClip = fixtureClip({ id: "bottom-clip", mediaRef: "media-v", start: 0, duration: 30 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [topClip] }), fixtureVideoTrack({ clips: [bottomClip] })] }),
      makeResolver([entry]),
    );

    const bottom = xml.indexOf("bottom-clip");
    const top = xml.indexOf("top-clip");
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThan(top);
  });

  // MARK: - Keyframes, crop, transitions, NTSC

  function fixtureResolver(sourceFPS?: number): MediaResolver {
    const entry = makeMediaManifestEntry({
      id: "media-1", name: "Clip", type: "video", source: makeExternalSource("/tmp/kf.mov"), duration: 5,
      sourceWidth: 3840, sourceHeight: 2160,
    });
    if (sourceFPS !== undefined) entry.sourceFPS = sourceFPS;
    return makeResolver([entry]);
  }

  function exportClip(clip: Clip, resolver: MediaResolver): string {
    const track = clip.mediaType === "audio" ? fixtureAudioTrack({ clips: [clip] }) : fixtureVideoTrack({ clips: [clip] });
    return exportXml(fixtureTimeline({ tracks: [track] }), resolver);
  }

  it("positionKeyframesEmitVaryingCenter", () => {
    // topLeft (0,0) -> center (0.5,0.5) -> export (0,0); topLeft (0.5,0.5) -> center (1,1) -> (0.5,0.5).
    const clip = fixtureClip({ start: 0, duration: 200 });
    clip.positionTrack = makeKeyframeTrack([
      makeKeyframe(0, makeAnimPair(0.0, 0.0)),
      makeKeyframe(100, makeAnimPair(0.5, 0.5)),
    ]);
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<parameterid>center</parameterid>");
    expect(xml).toContain("<horiz>0.50000</horiz>");
    expect(xml).toContain("<vert>0.50000</vert>");
  });

  it("opacityKeyframesEmittedWithClipRelativeWhen", () => {
    const clip = fixtureClip({ start: 100, duration: 200 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(30, 1.0), makeKeyframe(150, 0.5)]);
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>opacity</effectid>");
    expect(xml).toContain("<when>30</when>");
    expect(xml).toContain("<value>100.0</value>");
    expect(xml).toContain("<when>150</when>");
    expect(xml).toContain("<value>50.0</value>");
  });

  it("volumeKeyframesEmittedOnAudioClip", () => {
    const clip = fixtureClip({ mediaType: "audio", start: 0, duration: 100 });
    clip.volumeTrack = makeKeyframeTrack([makeKeyframe(0, 0), makeKeyframe(50, -6)]);
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<when>0</when>");
    expect(xml).toContain("<when>50</when>");
    expect(xml).toContain("<keyframe>");
  });

  it("fadesEmitSingleSidedCrossDissolveTransitions", () => {
    const clip = fixtureClip({ start: 100, duration: 200 });
    clip.fadeInFrames = 30;
    clip.fadeOutFrames = 20;
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>Cross Dissolve</effectid>");
    expect(xml).toContain("<alignment>start-black</alignment>");
    expect(xml).toContain("<start>100</start>");
    expect(xml).toContain("<end>130</end>");
    expect(xml).toContain("<alignment>end-black</alignment>");
    expect(xml).toContain("<start>280</start>");
    expect(xml).toContain("<end>300</end>");
    // The transition precedes its clipitem in document order.
    expect(xml.indexOf("start-black")).toBeLessThan(xml.indexOf("<clipitem"));
  });

  it("audioClipFadesEmitCrossFadeTransitions", () => {
    const clip = fixtureClip({ mediaType: "audio", start: 0, duration: 100 });
    clip.fadeInFrames = 10;
    clip.fadeOutFrames = 15;
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>KGAudioTransCrossFade0dB</effectid>");
    expect(xml).toContain("<mediatype>audio</mediatype>");
    expect(xml).not.toContain("Cross Dissolve");
    expect(xml).not.toContain("<wipecode>");
    expect(xml).toContain("<start>0</start>");
    expect(xml).toContain("<end>10</end>");
    expect(xml).toContain("<start>85</start>");
    expect(xml).toContain("<end>100</end>");
  });

  it("noFadeEmitsNoTransition", () => {
    const xml = exportClip(fixtureClip({ start: 0, duration: 100 }), fixtureResolver());
    expect(xml).not.toContain("<transitionitem>");
  });

  it("staticCropEmitsCropFilterAsPercentages", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.crop = makeCrop({ left: 0.1, top: 0.25, right: 0.2, bottom: 0.05 });
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>crop</effectid>");
    expect(xml).toContain("<parameterid>left</parameterid>");
    expect(xml).toContain("<value>10.00</value>");
    expect(xml).toContain("<value>25.00</value>");
    expect(xml).not.toContain("<keyframe>");
  });

  it("cropKeyframesEmitClipRelativeWhen", () => {
    const clip = fixtureClip({ start: 40, duration: 200 });
    clip.cropTrack = makeKeyframeTrack([
      makeKeyframe(0, makeCrop()),
      makeKeyframe(60, makeCrop({ left: 0.5, top: 0, right: 0, bottom: 0 })),
    ]);
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>crop</effectid>");
    expect(xml).toContain("<when>0</when>");
    expect(xml).toContain("<when>60</when>");
    expect(xml).toContain("<value>50.00</value>");
  });

  it("identityCropEmitsNoFilter", () => {
    const xml = exportClip(fixtureClip({ start: 0, duration: 100 }), fixtureResolver());
    expect(xml).not.toContain("<effectid>crop</effectid>");
  });

  it("ntscSourceMarksFileRateTrue", () => {
    const xml = exportClip(fixtureClip({ start: 0, duration: 100 }), fixtureResolver(30000.0 / 1001.0));
    expect(xml).toContain("<ntsc>TRUE</ntsc>"); // the source file
    expect(xml).toContain("<ntsc>FALSE</ntsc>"); // the sequence
  });

  it("cleanFpsSourceStaysNtscFalse", () => {
    const xml = exportClip(fixtureClip({ start: 0, duration: 100 }), fixtureResolver(30.0));
    expect(xml).not.toContain("<ntsc>TRUE</ntsc>");
  });

  it("noKeyframesStillEmitsStaticValueOnly", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacity = 0.5;
    const xml = exportClip(clip, fixtureResolver());

    expect(xml).toContain("<effectid>opacity</effectid>");
    expect(xml).not.toContain("<keyframe>");
  });

  // MARK: - File-rate in/out (PAL-166 follow-up: Resolve rejected timeline-rate in/out)

  it("slowerSourceEmitsFileRateInOutAndDuration", () => {
    // 29.97 source on a 60fps timeline: trim 240 timeline frames = 4s ~ 119.88 -> 120 file frames.
    const entry = makeMediaManifestEntry({
      id: "rx", name: "rx", type: "video", source: makeExternalSource("/tmp/rx.mp4"), duration: 15.2,
    });
    entry.sourceFPS = 29.97;
    const clip = fixtureClip({ id: "c", mediaRef: "rx", start: 300, duration: 300, trimStart: 240 });
    const timeline = fixtureTimeline({ fps: 60, tracks: [fixtureVideoTrack({ clips: [clip] })] });
    timeline.width = 1920;
    timeline.height = 1080;
    const xml = exportXml(timeline, makeResolver([entry]));

    expect(xml).toContain("<in>120</in>");
    expect(xml).toContain("<out>270</out>");
    expect(xml).toContain("<start>300</start>");
    expect(xml).toContain("<end>600</end>");
    expect(xml).toContain("<duration>456</duration>");
  });

  it("matchingRateKeepsTimelineFrameInOut", () => {
    const clip = fixtureClip({ id: "c", mediaRef: "same", start: 0, duration: 30, trimStart: 12 });
    const xml = exportXml(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }),
      makeResolver([videoManifestEntry("same", tmp)]),
    );

    expect(xml).toContain("<in>12</in>");
    expect(xml).toContain("<out>42</out>");
  });
});

describe("XMLExporter — nested timelines", () => {
  function videoEntry(id: string): MediaManifestEntry {
    return makeMediaManifestEntry({
      id, name: id, type: "video", source: makeExternalSource(`/tmp/${id}-0000.mp4`), duration: 5,
    });
  }

  function carrier(child: Timeline, start: number, duration?: number, trimStart = 0): Clip {
    return makeClip({
      mediaRef: child.id, mediaType: "sequence", sourceClipType: "sequence", startFrame: start,
      durationFrames: duration ?? timelineTotalFrames(child), trimStartFrame: trimStart,
    });
  }

  function render(parent: Timeline, timelines: Timeline[], resolver: MediaResolver): string {
    const byId = new Map(timelines.map((t) => [t.id, t]));
    return xmlExporterRender({ timeline: parent, resolver, resolveTimeline: (id) => byId.get(id) });
  }

  function clipitemMentioning(xml: string, needle: string): string {
    return xml.split("<clipitem").find((s) => s.includes(needle)) ?? "";
  }

  it("nestEmitsInlineSequenceInsideClipitem", () => {
    const resolver = makeResolver([videoEntry("v1")]);
    const child = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })] })] });
    child.name = "Intro";
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(child, 30)] })] });

    const xml = render(parent, [child, parent], resolver);

    expect(xml).toContain("<sequence id=\"sequence-2\">");
    expect(xml).toContain("<name>Intro</name>");
    const clipitem = clipitemMentioning(xml, "sequence-2");
    expect(clipitem).toContain("<start>30</start>");
    expect(clipitem).toContain("<end>90</end>");
    expect(clipitem).toContain("<in>0</in>");
    expect(clipitem).toContain("<out>60</out>");
    expect(xml).toContain("<pathurl>");
  });

  it("secondCarrierReferencesTheSequenceById", () => {
    const resolver = makeResolver([videoEntry("v1")]);
    const child = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })] })] });
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(child, 0), carrier(child, 60)] })] });

    const xml = render(parent, [child, parent], resolver);

    expect(count(xml, "<sequence id=\"sequence-2\">")).toBe(1);
    expect(count(xml, "<sequence id=\"sequence-2\"/>")).toBe(1);
  });

  it("twoLevelNestingEmitsBothSequences", () => {
    const resolver = makeResolver([videoEntry("v1")]);
    const grandchild = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v1", start: 0, duration: 30 })] })] });
    grandchild.name = "Deep";
    const child = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(grandchild, 0)] })] });
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(child, 0)] })] });

    const xml = render(parent, [grandchild, child, parent], resolver);

    expect(xml).toContain("<sequence id=\"sequence-2\">");
    expect(xml).toContain("<sequence id=\"sequence-3\">");
    expect(xml).toContain("<name>Deep</name>");
  });

  it("frozenCarrierClampsToChildContent", () => {
    const resolver = makeResolver([videoEntry("v1")]);
    const child = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v1", start: 0, duration: 60 })] })] });
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(child, 0, 100, 10)] })] });

    const xml = render(parent, [child, parent], resolver);

    const clipitem = clipitemMentioning(xml, "sequence-2");
    expect(clipitem).toContain("<in>10</in>");
    expect(clipitem).toContain("<out>60</out>");
    expect(clipitem).toContain("<end>50</end>");
  });

  it("emptyOrMissingChildDropsCarrier", () => {
    const resolver = makeResolver([]);
    const empty = fixtureTimeline();
    const missing = fixtureClip({ mediaRef: "no-such-timeline", start: 60, duration: 30 });
    missing.mediaType = "sequence";
    missing.sourceClipType = "sequence";
    const parent = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [carrier(empty, 0, 30), missing] })] });

    const xml = render(parent, [empty, parent], resolver);

    expect(xml).not.toContain("<clipitem");
    expect(xml).not.toContain("sequence-2");
  });

  it("linkedCarrierPairEmitsLinkedClipitems", () => {
    const resolver = makeResolver([videoEntry("v1")]);
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

    const xml = render(parent, [child, parent], resolver);

    expect(count(xml, "<sequence id=\"sequence-2\">")).toBe(1);
    expect(count(xml, "<sequence id=\"sequence-2\"/>")).toBe(1);
    expect(xml).toContain(`<linkclipref>clipitem-${video.id}</linkclipref>`);
    expect(xml).toContain(`<linkclipref>clipitem-${audio.id}</linkclipref>`);
  });
});

describe("XMLExporter timecode", () => {
  // MARK: - timecodeTags follows the track, not the video rate

  it("nonDropSourceEmitsNonDropTimecodeRegardlessOfVideoNtsc", () => {
    const tc = xmlExporterTimecodeTags(makeSourceTimecode({ frame: 1968620, quanta: 30, dropFrame: false }), 30, true);
    expect(tc.base).toBe(30);
    expect(tc.ntsc).toBe(true);
    expect(tc.dropFrame).toBe(false);
    expect(tc.string).toBe("18:13:40:20");
    expect(tc.string).not.toContain(";");
  });

  it("dropFrameSourceOn60pUsesTrackQuantaNotVideoRate", () => {
    const tc = xmlExporterTimecodeTags(makeSourceTimecode({ frame: 42966, quanta: 30, dropFrame: true }), 60, true);
    expect(tc.base).toBe(30);
    expect(tc.dropFrame).toBe(true);
    expect(tc.frame).toBe(42966);
    expect(tc.string).toBe("00;23;53;18");
  });

  it("cleanThirtyFpsSourceStaysNonNtsc", () => {
    const tc = xmlExporterTimecodeTags(makeSourceTimecode({ frame: 0, quanta: 30, dropFrame: false }), 30, false);
    expect(tc.ntsc).toBe(false);
    expect(tc.string).toBe("00:00:00:00");
  });

  it("noTimecodeTrackFallsBackToVideoRateAndZero", () => {
    const tc = xmlExporterTimecodeTags(undefined, 30, true);
    expect(tc.frame).toBe(0);
    expect(tc.base).toBe(30);
    expect(tc.dropFrame).toBe(true);
    expect(tc.string).toBe("00;00;00;00");
  });

  // MARK: - formatTimecode math

  it("nonDropFormattingRollsFieldsAtFps", () => {
    expect(xmlExporterFormatTimecode(0, 25, false)).toBe("00:00:00:00");
    expect(xmlExporterFormatTimecode(1688098, 25, false)).toBe("18:45:23:23");
    expect(xmlExporterFormatTimecode(24 * 3600, 24, false)).toBe("01:00:00:00");
  });

  it("dropFrameSkipsDroppedFrameNumbers", () => {
    expect(xmlExporterFormatTimecode(0, 30, true)).toBe("00;00;00;00");
    expect(xmlExporterFormatTimecode(42966, 30, true)).toBe("00;23;53;18");
  });

  it("zeroFpsDoesNotCrash", () => {
    expect(xmlExporterFormatTimecode(100, 0, false)).toBe("00:00:00:00");
  });
});
