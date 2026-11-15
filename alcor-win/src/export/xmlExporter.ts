import { clipTypeIsVisual } from "../model/clipType";
import { clipKeyframeFrames } from "../model/keyframe";
import type { MediaManifestEntry } from "../model/mediaManifest";
import {
  mediaResolverDisplayName, mediaResolverEntry, mediaResolverResolvePath, type MediaResolver,
} from "../model/mediaResolver";
import {
  clipCropAt, clipEndFrame, clipFadeFrames, clipRawOpacityAt, clipRawVolumeAt, clipRotationAt, clipSizeAt,
  clipSourceDurationFrames, clipSourceFramesConsumed, clipTransformAt, cropIsIdentity,
  timelineReachableTimelines, timelineTotalFrames,
  type Clip, type Crop, type FadeEdge, type Timeline, type Track, type Transform,
} from "../model/timeline";
import { swiftRound } from "../util/math";
import { secondsToFrame } from "../util/timeFormatting";
import {
  compact, fileUrlAbsoluteString, formatFixed, lastPathComponent, pad2, renderXmlNode, sourceTimecodeSeconds,
  xmlNode, type SourceTimecode, type XmlNode,
} from "./exportSupport";

export interface XMLExportInput {
  timeline: Timeline;
  resolver: MediaResolver;
  resolveTimeline?: (id: string) => Timeline | undefined;
  /** Embedded source timecodes keyed by mediaRef (Swift: `SourceTimingReader`); see `xmlExporterMediaRefs`. */
  startFrameCache?: ReadonlyMap<string, SourceTimecode>;
}

export interface TimecodeTags {
  base: number;
  ntsc: boolean;
  frame: number;
  dropFrame: boolean;
  string: string;
}

/** Media refs reachable from the timeline (including nested timelines): the set to probe for `startFrameCache`. */
export function xmlExporterMediaRefs(
  timeline: Timeline,
  resolveTimeline: (id: string) => Timeline | undefined = () => undefined,
): Set<string> {
  const mediaRefs = new Set<string>();
  for (const t of [timeline, ...timelineReachableTimelines(timeline, resolveTimeline)]) {
    for (const track of t.tracks) {
      for (const clip of track.clips) if (clip.sourceClipType !== "sequence") mediaRefs.add(clip.mediaRef);
    }
  }
  return mediaRefs;
}

/** Renders the XMEML 4 document (`XMLExporter.render`); the caller writes it to disk. */
export function xmlExporterRender(input: XMLExportInput): string {
  return buildXMEML(input);
}

/** Builds file timecode fields from embedded metadata or the video rate. */
export function xmlExporterTimecodeTags(
  source: SourceTimecode | undefined, videoTimebase: number, videoNtsc: boolean,
): TimecodeTags {
  // BWF time references use samples, so rescale them to the video rate.
  if (source !== undefined && source.quanta > 240) {
    const effectiveFPS = videoNtsc ? (videoTimebase * 1000) / 1001 : videoTimebase;
    const dropFrame = videoNtsc && videoTimebase % 30 === 0;
    const frame = swiftRound(sourceTimecodeSeconds(source) * effectiveFPS);
    return {
      base: videoTimebase, ntsc: videoNtsc, frame, dropFrame,
      string: xmlExporterFormatTimecode(frame, videoTimebase, dropFrame),
    };
  }
  const base = source?.quanta ?? videoTimebase;
  const dropFrame = source?.dropFrame ?? (videoNtsc && videoTimebase % 30 === 0);
  const ntsc = dropFrame ? true : videoNtsc;
  const frame = source?.frame ?? 0;
  return { base, ntsc, frame, dropFrame, string: xmlExporterFormatTimecode(frame, base, dropFrame) };
}

/** Frame count → SMPTE string; drop-frame (29.97/59.94) uses `;` separators and skips dropped frames. */
export function xmlExporterFormatTimecode(frame: number, fps: number, dropFrame: boolean): string {
  if (!(fps > 0)) return "00:00:00:00";
  let f = frame;
  if (dropFrame) {
    const drop = swiftRound(fps * 0.066666);
    // Drop-frame ten-minute blocks contain nine shortened minutes.
    const perMinute = fps * 60 - drop;
    const per10 = perMinute * 10 + drop;
    const d = Math.trunc(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.trunc((m - drop) / perMinute) : 0);
  }
  const sep = dropFrame ? ";" : ":";
  const ff = f % fps;
  const ss = Math.trunc(f / fps) % 60;
  const mm = Math.trunc(f / (fps * 60)) % 60;
  const hh = Math.trunc(f / (fps * 3600));
  return [hh, mm, ss, ff].map(pad2).join(sep);
}

interface ClipAddress {
  trackIndex: number;
  clipIndex: number;
  isAudio: boolean;
}

interface Kf {
  when: number;
  value: number;
}

function el(name: string, children: XmlNode[] = []): XmlNode {
  return xmlNode(name, { children });
}

function elAttrs(name: string, attributes: [string, string][], children: XmlNode[] = []): XmlNode {
  return xmlNode(name, { attributes, children });
}

function leaf(name: string, value: string | number): XmlNode {
  return xmlNode(name, { text: String(value) });
}

function bool(name: string, value: boolean): XmlNode {
  return xmlNode(name, { text: value ? "TRUE" : "FALSE" });
}

function filter(effectNode: XmlNode): XmlNode {
  return el("filter", [effectNode]);
}

function rate(timebase: number, ntsc = false): XmlNode {
  return el("rate", [leaf("timebase", timebase), bool("ntsc", ntsc)]);
}

function effect(
  name: string, id: string, type: string, mediatype: string, category?: string, body: XmlNode[] = [],
): XmlNode {
  const children = [leaf("name", name), leaf("effectid", id)];
  if (category !== undefined) children.push(leaf("effectcategory", category));
  children.push(leaf("effecttype", type));
  children.push(leaf("mediatype", mediatype));
  children.push(...body);
  return el("effect", children);
}

function parameter(
  id: string, name: string, min: string | undefined, max: string | undefined, value: XmlNode,
  keyframes: { when: number; value: XmlNode }[] = [],
): XmlNode {
  const children = [leaf("parameterid", id), leaf("name", name)];
  if (min !== undefined) children.push(leaf("valuemin", min));
  if (max !== undefined) children.push(leaf("valuemax", max));
  children.push(value);
  children.push(...keyframes.map((k) => el("keyframe", [leaf("when", k.when), k.value])));
  return el("parameter", children);
}

function scalarParam(
  id: string, name: string, min: string, max: string, base: number, keyframes: Kf[] = [], digits = 2,
): XmlNode {
  return parameter(
    id, name, min, max, leaf("value", formatFixed(base, digits)),
    keyframes.map((k) => ({ when: k.when, value: leaf("value", formatFixed(k.value, digits)) })),
  );
}

function centerParam(base: { x: number; y: number }, keyframes: { when: number; x: number; y: number }[] = []): XmlNode {
  const vec = (x: number, y: number): XmlNode => el("value", [leaf("horiz", formatFixed(x, 5)), leaf("vert", formatFixed(y, 5))]);
  return parameter("center", "Center", undefined, undefined, vec(base.x, base.y), keyframes.map((k) => ({ when: k.when, value: vec(k.x, k.y) })));
}

/** Converts a real frame rate to FCP7 timebase and NTSC fields. */
function rateTags(rawFps: number): { timebase: number; ntsc: boolean } {
  const timebase = Math.max(1, swiftRound(rawFps));
  const ntscRate = (timebase * 1000.0) / 1001.0;
  return { timebase, ntsc: Math.abs(rawFps - ntscRate) < Math.abs(rawFps - timebase) };
}

function masterclipId(clip: Clip, isAudio: boolean): string {
  if (clip.linkGroupId !== undefined) return `masterclip-${clip.linkGroupId}`;
  return `masterclip-${clip.mediaRef}-${isAudio ? "audio" : "video"}`;
}

function buildXMEML(input: XMLExportInput): string {
  const { timeline, resolver } = input;
  const resolveTimeline = input.resolveTimeline ?? (() => undefined);
  const startFrameCache = input.startFrameCache ?? new Map<string, SourceTimecode>();
  const fps = timeline.fps;
  const seqWidth = timeline.width;
  let curSeqWidth = timeline.width;

  const emittedFiles = new Set<string>();
  let clipAddresses = new Map<string, ClipAddress>();
  let clipsByLinkGroup = new Map<string, Clip[]>();
  // Repeated nests reference the first embedded sequence.
  const sequenceIds = new Map<string, string>();
  const emittedSequences = new Set<string>();

  function build(): string {
    sequenceIds.set(timeline.id, "sequence-1");
    emittedSequences.add(timeline.id);
    const root = elAttrs("xmeml", [["version", "4"]], [sequenceNode("sequence-1", timeline)]);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n${renderXmlNode(root, 0)}`;
  }

  /** Builds a root or nested sequence with isolated link state. */
  function sequenceNode(id: string, seqTimeline: Timeline): XmlNode {
    const savedAddresses = clipAddresses;
    const savedGroups = clipsByLinkGroup;
    const savedSeqWidth = curSeqWidth;
    clipAddresses = new Map();
    clipsByLinkGroup = new Map();
    curSeqWidth = seqTimeline.width;
    try {
      // FCP XML orders video tracks bottom→top; our model stores them top→bottom.
      const videoTracks = seqTimeline.tracks.filter((t) => clipTypeIsVisual(t.type)).reverse();
      const audioTracks = seqTimeline.tracks.filter((t) => t.type === "audio");
      const sortedVideo = videoTracks.map(sortEmittable);
      const sortedAudio = audioTracks.map(sortEmittable);

      indexAddresses(sortedVideo, false);
      indexAddresses(sortedAudio, true);
      indexLinkGroups(seqTimeline);

      const videoTrackNodes = videoTracks.map((t, i) => trackNode(t, sortedVideo[i] as Clip[], false));
      const audioTrackNodes = audioTracks.map((t, i) => trackNode(t, sortedAudio[i] as Clip[], true));

      return elAttrs("sequence", [["id", id]], [
        leaf("name", seqTimeline.name),
        leaf("duration", timelineTotalFrames(seqTimeline)),
        rate(fps),
        timecodeNode(),
        el("media", [
          el("video", [videoFormatNode(seqTimeline.width, seqTimeline.height), ...videoTrackNodes]),
          el("audio", [leaf("numOutputChannels", 2), audioFormatNode(), audioOutputsNode(), ...audioTrackNodes]),
        ]),
      ]);
    } finally {
      clipAddresses = savedAddresses;
      clipsByLinkGroup = savedGroups;
      curSeqWidth = savedSeqWidth;
    }
  }

  function timecodeNode(): XmlNode {
    return el("timecode", [
      rate(fps),
      leaf("string", "00:00:00:00"),
      leaf("frame", 0),
      leaf("source", "source"),
      leaf("displayformat", "NDF"),
    ]);
  }

  function videoFormatNode(width: number, height: number): XmlNode {
    return el("format", [el("samplecharacteristics", [
      leaf("width", width),
      leaf("height", height),
      bool("anamorphic", false),
      leaf("pixelaspectratio", "square"),
      leaf("fielddominance", "none"),
      rate(fps),
    ])]);
  }

  function audioFormatNode(): XmlNode {
    return el("format", [el("samplecharacteristics", [leaf("samplerate", 48000), leaf("depth", 16)])]);
  }

  function audioOutputsNode(): XmlNode {
    return el("outputs", [el("group", [
      leaf("index", 1),
      leaf("numchannels", 2),
      leaf("downmix", 0),
      el("channel", [leaf("index", 1)]),
      el("channel", [leaf("index", 2)]),
    ])]);
  }

  function trackNode(track: Track, sortedClips: Clip[], isAudio: boolean): XmlNode {
    const enabled = isAudio ? !track.muted : !track.hidden;
    const children: XmlNode[] = [bool("enabled", enabled), bool("locked", false)];
    for (const clip of sortedClips) {
      const fadeIn = fadeTransition(clip, "left", isAudio);
      if (fadeIn !== undefined) children.push(fadeIn);
      children.push(clipItemNode(clip, isAudio));
      const fadeOut = fadeTransition(clip, "right", isAudio);
      if (fadeOut !== undefined) children.push(fadeOut);
    }
    return el("track", children);
  }

  function clipItemNode(clip: Clip, isAudio: boolean): XmlNode {
    if (clip.sourceClipType === "sequence") return nestClipItemNode(clip, isAudio);
    // Clipitem rate/in/out/duration are in FILE-rate units; start/end stay sequence frames.
    // Resolve conforms in/out against the file's own rate — timeline-rate values land the
    // in-point off by the rate ratio on rate-mismatched sources.
    const { timebase, ntsc } = rateTags(mediaResolverEntry(resolver, clip.mediaRef)?.sourceFPS ?? fps);
    const fileFPS = ntsc ? (timebase * 1000.0) / 1001.0 : timebase;
    const scale = fileFPS / fps;
    const matchesTimeline = Math.abs(scale - 1) < 0.0001;
    const fileFrames = (timelineFrames: number): number => (matchesTimeline ? timelineFrames : swiftRound(timelineFrames * scale));
    const sourceDuration = sourceDurationFrames(clip.mediaRef) ?? clipSourceDurationFrames(clip);
    // Time Remap handles speed through source in/out values.
    const inPoint = fileFrames(clip.trimStartFrame);
    const outPoint = fileFrames(clip.trimStartFrame + clipSourceFramesConsumed(clip));

    const children: XmlNode[] = [
      leaf("masterclipid", masterclipId(clip, isAudio)),
      leaf("name", mediaResolverDisplayName(resolver, clip.mediaRef)),
      bool("enabled", true),
      leaf("duration", fileFrames(sourceDuration)),
      matchesTimeline ? rate(fps) : rate(timebase, ntsc),
      leaf("start", clip.startFrame),
      leaf("end", clipEndFrame(clip)),
      leaf("in", inPoint),
      leaf("out", outPoint),
      fileNode(clip.mediaRef, isAudio),
    ];
    const remap = timeRemapFilter(clip.speed, isAudio);
    if (remap !== undefined) children.push(remap);
    children.push(...(isAudio ? volumeFilters(clip) : videoFilters(clip)));
    children.push(...linkNodes(clip));
    return elAttrs("clipitem", [["id", `clipitem-${clip.id}`]], children);
  }

  /** Embeds a nested sequence once, then references it by ID. */
  function nestClipItemNode(clip: Clip, isAudio: boolean): XmlNode {
    const child = resolveTimeline(clip.mediaRef);
    if (child === undefined) throw new Error(`nested timeline ${clip.mediaRef} must resolve (sortEmittable invariant)`);
    let seqId = sequenceIds.get(clip.mediaRef);
    if (seqId === undefined) {
      seqId = `sequence-${sequenceIds.size + 1}`;
      sequenceIds.set(clip.mediaRef, seqId);
    }
    const firstUse = !emittedSequences.has(clip.mediaRef);
    emittedSequences.add(clip.mediaRef);
    const sequence = firstUse ? sequenceNode(seqId, child) : elAttrs("sequence", [["id", seqId]]);

    const inPoint = clip.trimStartFrame;
    const childFrames = timelineTotalFrames(child);
    const outPoint = Math.min(inPoint + clip.durationFrames, childFrames);

    const children: XmlNode[] = [
      leaf("masterclipid", masterclipId(clip, isAudio)),
      leaf("name", child.name),
      bool("enabled", true),
      leaf("duration", childFrames),
      rate(fps),
      leaf("start", clip.startFrame),
      leaf("end", clip.startFrame + (outPoint - inPoint)),
      leaf("in", inPoint),
      leaf("out", outPoint),
      sequence,
    ];
    children.push(...(isAudio ? volumeFilters(clip) : videoFilters(clip)));
    children.push(...linkNodes(clip));
    return elAttrs("clipitem", [["id", `clipitem-${clip.id}`]], children);
  }

  /** Emits media-specific file IDs and collapses repeated definitions to references. */
  function fileNode(mediaRef: string, isAudio: boolean): XmlNode {
    const fileId = `file-${mediaRef}-${isAudio ? "audio" : "video"}`;
    const key = `${mediaRef}\u0000${isAudio}`;
    if (emittedFiles.has(key)) return elAttrs("file", [["id", fileId]]);
    emittedFiles.add(key);

    const entry = mediaResolverEntry(resolver, mediaRef);
    const path = mediaResolverResolvePath(resolver, mediaRef);
    // Resolve matches media by exact filename + extension.
    const fileName = path !== undefined ? lastPathComponent(path) : (entry?.name ?? mediaRef);
    // Resolve needs Premiere's extra-slash host form; the canonical single-slash one fails.
    const pathUrl = path !== undefined ? fileUrlAbsoluteString(path).replaceAll("file://", "file://localhost//") : `media/${mediaRef}`;
    // Stills decode as one frame.
    const isImage = entry?.type === "image";
    const { timebase, ntsc } = rateTags(entry?.sourceFPS ?? fps);
    // Duration in the file's own rate units, consistent with the rate element it sits beside.
    const fileFPS = ntsc ? (timebase * 1000.0) / 1001.0 : timebase;
    const durationFrames = isImage ? 1 : entry !== undefined ? Math.max(0, swiftRound(entry.duration * fileFPS)) : 0;

    const media: XmlNode = isAudio
      ? el("media", [el("audio", [
        el("samplecharacteristics", [leaf("samplerate", 48000), leaf("depth", 16)]),
        leaf("channelcount", 2),
      ])])
      : el("media", [el("video", [
        ...(isImage ? [leaf("duration", 1)] : []),
        el("samplecharacteristics", [
          leaf("width", entry?.sourceWidth ?? seqWidth),
          leaf("height", entry?.sourceHeight ?? timeline.height),
          bool("anamorphic", false),
          leaf("pixelaspectratio", "square"),
          leaf("fielddominance", "none"),
          rate(timebase, ntsc),
        ]),
      ])]);

    // Resolve requires the timecode element.
    const tc = xmlExporterTimecodeTags(startFrameCache.get(mediaRef), timebase, ntsc);
    const timecode = el("timecode", [
      rate(tc.base, tc.ntsc),
      leaf("string", tc.string),
      leaf("frame", tc.frame),
      leaf("displayformat", tc.dropFrame ? "DF" : "NDF"),
    ]);
    return elAttrs("file", [["id", fileId]], [
      leaf("name", fileName),
      leaf("pathurl", pathUrl),
      rate(timebase, ntsc),
      leaf("duration", durationFrames),
      timecode,
      media,
    ]);
  }

  /** Linked clips emit a `<link>` per partner so Premiere rebuilds the A/V pair. */
  function linkNodes(clip: Clip): XmlNode[] {
    const group = clip.linkGroupId;
    if (group === undefined) return [];
    const partners = clipsByLinkGroup.get(group);
    if (partners === undefined || partners.length <= 1) return [];
    return compact(partners.map((partner) => {
      const addr = clipAddresses.get(partner.id);
      if (addr === undefined) return undefined;
      return el("link", [
        leaf("linkclipref", `clipitem-${partner.id}`),
        leaf("mediatype", addr.isAudio ? "audio" : "video"),
        leaf("trackindex", addr.trackIndex),
        leaf("clipindex", addr.clipIndex),
      ]);
    }));
  }

  /** A fade exports as a single-sided dissolve to black/silence (no clip-to-clip model). */
  function fadeTransition(clip: Clip, edge: FadeEdge, isAudio: boolean): XmlNode | undefined {
    const frames = clipFadeFrames(clip, edge);
    if (!(frames > 0)) return undefined;

    let start: number;
    let end: number;
    let alignment: string;
    let cutFrames: number;
    if (edge === "left") {
      start = clip.startFrame; end = clip.startFrame + frames; alignment = "start-black"; cutFrames = 0;
    } else {
      start = clipEndFrame(clip) - frames; end = clipEndFrame(clip); alignment = "end-black"; cutFrames = frames;
    }

    const children: XmlNode[] = [leaf("start", start), leaf("end", end), leaf("alignment", alignment)];
    if (isAudio) {
      children.push(rate(fps));
      children.push(effect("Cross Fade ( 0dB)", "KGAudioTransCrossFade0dB", "transition", "audio"));
    } else {
      // Premiere stores fade cut points in 254016000000 ticks per second.
      const cutPointTicks = BigInt(cutFrames) * (254_016_000_000n / BigInt(fps));
      children.push(leaf("cutPointTicks", cutPointTicks.toString()));
      children.push(rate(fps));
      children.push(effect("Cross Dissolve", "Cross Dissolve", "transition", "video", "Dissolve", [
        leaf("wipecode", 0),
        leaf("wipeaccuracy", 100),
        leaf("startratio", 0),
        leaf("endratio", 1),
        bool("reverse", false),
      ]));
    }
    return el("transitionitem", children);
  }

  /** Premiere needs this to apply speed; it won't infer it from the in/out vs start/end ratio. */
  function timeRemapFilter(speed: number, isAudio: boolean): XmlNode | undefined {
    if (speed === 1.0) return undefined;
    return filter(effect("Time Remap", "timeremap", "motion", isAudio ? "audio" : "video", undefined, [
      parameter("variablespeed", "variablespeed", "0", "1", leaf("value", 0)),
      parameter("speed", "speed", "-100000", "100000", leaf("value", formatFixed(speed * 100, 4))),
      parameter("reverse", "reverse", undefined, undefined, bool("value", false)),
      parameter("frameblending", "frameblending", undefined, undefined, bool("value", false)),
    ]));
  }

  /** Exports fade-independent linear gain, clamped to Premiere's maximum. */
  function volumeFilters(clip: Clip): XmlNode[] {
    const clampLevel = (v: number): number => Math.max(0, Math.min(v, 3.98));
    const frames = clipKeyframeFrames(clip, "volume");
    let level: XmlNode;
    if (frames.length === 0) {
      if (clip.volume === 1.0) return [];
      level = scalarParam("level", "Level", "0", "3.98107", clampLevel(clip.volume), [], 4);
    } else {
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: clampLevel(clipRawVolumeAt(clip, f)) }));
      level = scalarParam("level", "Level", "0", "3.98107", (kfs[0] as Kf).value, kfs, 4);
    }
    return [filter(effect("Audio Levels", "audiolevels", "audio", "audio", undefined, [level]))];
  }

  function videoFilters(clip: Clip): XmlNode[] {
    return compact([motionFilter(clip), cropFilter(clip), opacityFilter(clip)]);
  }

  /** Emits nondefault Basic Motion parameters. */
  function motionFilter(clip: Clip): XmlNode | undefined {
    const sourceWidth = mediaResolverEntry(resolver, clip.mediaRef)?.sourceWidth ?? 0;
    // Nested transforms use the child sequence canvas.
    const scalePct = (width: number): number => (sourceWidth > 0 ? (curSeqWidth / sourceWidth) * width * 100 : width * 100);
    // FCP7 center uses normalized coordinates (0 = center), not pixels.
    const center = (t: Transform): { x: number; y: number } => ({ x: t.centerX - 0.5, y: t.centerY - 0.5 });

    // Center depends on position + scale, so sample all transform params at the union of frames.
    const frames = [...new Set([
      ...clipKeyframeFrames(clip, "position"),
      ...clipKeyframeFrames(clip, "scale"),
      ...clipKeyframeFrames(clip, "rotation"),
    ])].sort((a, b) => a - b);

    let params: XmlNode[] = [];
    if (frames.length === 0) {
      const t = clip.transform;
      const c = center(t);
      const scaled = scalePct(t.width);
      const rotated = -t.rotation;
      const needsCenter = Math.abs(c.x) > 0.001 || Math.abs(c.y) > 0.001;
      const needsScale = Math.abs(scaled - 100) > 0.1;
      const needsRotation = Math.abs(rotated) > 0.05;
      if (!(needsCenter || needsScale || needsRotation)) return undefined;
      if (needsScale) params.push(scalarParam("scale", "Scale", "0", "1000", scaled));
      if (needsRotation) params.push(scalarParam("rotation", "Rotation", "-100000", "100000", rotated));
      if (needsCenter) params.push(centerParam(c));
    } else {
      const scaleKfs = frames.map((f) => ({ when: f - clip.startFrame, value: scalePct(clipSizeAt(clip, f).width) }));
      const rotationKfs = frames.map((f) => ({ when: f - clip.startFrame, value: -clipRotationAt(clip, f) }));
      const centerKfs = frames.map((f) => {
        const c = center(clipTransformAt(clip, f));
        return { when: f - clip.startFrame, x: c.x, y: c.y };
      });
      const firstCenter = centerKfs[0] as { x: number; y: number };
      params = [
        scalarParam("scale", "Scale", "0", "1000", (scaleKfs[0] as Kf).value, scaleKfs),
        scalarParam("rotation", "Rotation", "-100000", "100000", (rotationKfs[0] as Kf).value, rotationKfs),
        centerParam({ x: firstCenter.x, y: firstCenter.y }, centerKfs),
      ];
    }
    return filter(effect("Basic Motion", "basic", "motion", "video", undefined, params));
  }

  /** Converts crop fractions to FCP7 percentages. */
  function cropFilter(clip: Clip): XmlNode | undefined {
    const frames = clipKeyframeFrames(clip, "crop");
    if (frames.length === 0 && cropIsIdentity(clip.crop)) return undefined;

    const edge = (id: keyof Crop): XmlNode => {
      if (frames.length === 0) return scalarParam(id, id, "0", "100", clip.crop[id] * 100);
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: clipCropAt(clip, f)[id] * 100 }));
      return scalarParam(id, id, "0", "100", (kfs[0] as Kf).value, kfs);
    };
    const params = [edge("left"), edge("right"), edge("top"), edge("bottom")];
    return filter(effect("Crop", "crop", "motion", "video", "motion", params));
  }

  /** Emits opacity separately from Basic Motion. */
  function opacityFilter(clip: Clip): XmlNode | undefined {
    const frames = clipKeyframeFrames(clip, "opacity");
    let opacity: XmlNode;
    if (frames.length === 0) {
      if (clip.opacity === 1.0) return undefined;
      opacity = scalarParam("opacity", "Opacity", "0", "100", clip.opacity * 100, [], 1);
    } else {
      const kfs = frames.map((f) => ({ when: f - clip.startFrame, value: clipRawOpacityAt(clip, f) * 100 }));
      opacity = scalarParam("opacity", "Opacity", "0", "100", (kfs[0] as Kf).value, kfs, 1);
    }
    return filter(effect("Opacity", "opacity", "motion", "video", undefined, [opacity]));
  }

  /** Drops unresolved clips before assigning link indices. */
  function sortEmittable(track: Track): Clip[] {
    return track.clips
      .filter((clip) => {
        // Drop carriers trimmed beyond the child timeline.
        if (clip.sourceClipType === "sequence") {
          const child = resolveTimeline(clip.mediaRef);
          return clip.trimStartFrame < (child !== undefined ? timelineTotalFrames(child) : 0);
        }
        return mediaResolverResolvePath(resolver, clip.mediaRef) !== undefined;
      })
      .sort((a, b) => a.startFrame - b.startFrame);
  }

  function indexAddresses(sortedTracks: Clip[][], isAudio: boolean): void {
    sortedTracks.forEach((clips, ti) => {
      clips.forEach((clip, ci) => {
        clipAddresses.set(clip.id, { trackIndex: ti + 1, clipIndex: ci + 1, isAudio });
      });
    });
  }

  function indexLinkGroups(t: Timeline): void {
    for (const track of t.tracks) {
      for (const clip of track.clips) {
        const group = clip.linkGroupId;
        if (group === undefined) continue;
        const list = clipsByLinkGroup.get(group);
        if (list === undefined) clipsByLinkGroup.set(group, [clip]);
        else list.push(clip);
      }
    }
  }

  function sourceDurationFrames(mediaRef: string): number | undefined {
    const entry: MediaManifestEntry | undefined = mediaResolverEntry(resolver, mediaRef);
    if (entry === undefined) return undefined;
    return Math.max(0, secondsToFrame(entry.duration, fps));
  }

  return build();
}
