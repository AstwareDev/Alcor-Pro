import { clipTypeIsVisual } from "../model/clipType";
import { clipInterpolation, clipKeyframeFrames, type AnimatableProperty } from "../model/keyframe";
import type { MediaManifestEntry } from "../model/mediaManifest";
import { mediaResolverEntry, mediaResolverResolvePath, type MediaResolver } from "../model/mediaResolver";
import {
  makeTextStyle, textStyleDisplayText, textStyleScaledVisualStyle, type RGBA, type TextStyle,
} from "../model/textStyle";
import {
  clipRawOpacityAt, clipRotationAt, clipSizeAt, clipSourceDurationFrames, clipTextScaleAt, clipTransformAt, cropIsIdentity,
  timelineReachableTimelines, timelineTotalFrames,
  type Clip, type Timeline, type Transform,
} from "../model/timeline";
import { pathKey } from "../project/projectPaths";
import { swiftRound } from "../util/math";
import { roundedToPlaces, secondsToFrame } from "../util/timeFormatting";
import {
  compact, fileUrlAbsoluteString, formatFixed, lastPathComponent, pad2, renderXmlNode, sourceTimecodeRationalSeconds,
  xmlNode, type SourceTimecode, type XmlNode,
} from "./exportSupport";

/** The `version` attribute Resolve/FCP gate import on; the body is version-identical (every element exists since 1.1). */
export const fcpxmlVersions = ["1.10", "1.11", "1.12", "1.13", "1.14"] as const;
export type FCPXMLVersion = (typeof fcpxmlVersions)[number];

/** 1.10 is the broadest: every Resolve from 18 up accepts it. Higher versions need Resolve 21+. */
export const fcpxmlVersionDefault: FCPXMLVersion = "1.10";

export function fcpxmlVersionCompatibilityNote(v: FCPXMLVersion): string {
  switch (v) {
    case "1.10": return "DaVinci Resolve 18+, Final Cut Pro 10.6+";
    case "1.11": return "DaVinci Resolve 21+, Final Cut Pro 10.7+";
    case "1.12": return "DaVinci Resolve 21+, Final Cut Pro 10.8+";
    case "1.13": return "DaVinci Resolve 21+, Final Cut Pro 11+";
    case "1.14": return "DaVinci Resolve 21+, Final Cut Pro 12+";
  }
}

/** Resolve interprets several FCPXML values off-spec; Final Cut is spec-literal. Same structure, different value encoding. */
export const fcpxmlTargets = ["resolve", "fcp"] as const;
export type FCPXMLTarget = (typeof fcpxmlTargets)[number];

export const fcpxmlTargetDefault: FCPXMLTarget = "resolve";

export function fcpxmlTargetDisplayName(t: FCPXMLTarget): string {
  return t === "resolve" ? "DaVinci Resolve" : "Final Cut Pro";
}

/** Result of the host's font lookup (Swift: `NSFont` resolution); absent means the name-based fallback is used. */
export interface FCPXMLResolvedFont {
  familyName?: string;
  /** Face name from the font descriptor (e.g. "Bold"). */
  face?: string;
  isBold: boolean;
  isItalic: boolean;
}

export interface FCPXMLExportInput {
  timeline: Timeline;
  resolver: MediaResolver;
  resolveTimeline?: (id: string) => Timeline | undefined;
  version?: FCPXMLVersion;
  target?: FCPXMLTarget;
  /** Embedded source timecodes keyed by mediaRef (Swift: `SourceTimingReader`); see `fcpxmlExporterMediaRefs`. */
  startTimecodes?: ReadonlyMap<string, SourceTimecode>;
  /** Receives the font-scaled style; Swift resolves it through AppKit/CoreText. */
  resolveFont?: (style: TextStyle) => FCPXMLResolvedFont | undefined;
}

const maxNestDepth = 8; // NestFlattener.maxDepth

/** Media refs reachable from the timeline (including nested timelines): the set to probe for `startTimecodes`. */
export function fcpxmlExporterMediaRefs(
  timeline: Timeline,
  resolveTimeline: (id: string) => Timeline | undefined = () => undefined,
): Set<string> {
  const mediaRefs = new Set<string>();
  const queue = [timeline];
  const visited = new Set<string>();
  let i = 0;
  while (i < queue.length) {
    const t = queue[i] as Timeline;
    i += 1;
    if (visited.has(t.id)) continue;
    visited.add(t.id);
    for (const track of t.tracks) {
      for (const clip of track.clips) {
        if (clip.sourceClipType === "sequence") {
          const child = resolveTimeline(clip.mediaRef);
          if (child !== undefined) queue.push(child);
        } else {
          mediaRefs.add(clip.mediaRef);
        }
      }
    }
  }
  return mediaRefs;
}

/** Renders the FCPXML document (`FCPXMLExporter.render`); the caller writes it to disk. */
export function fcpxmlExporterRender(input: FCPXMLExportInput): string {
  return buildFCPXML(input);
}

interface EmittableClip {
  clip: Clip;
  lane: number;
  enabled: boolean;
}

interface Rational {
  num: number;
  den: number;
}

interface MediaResource {
  mediaRef: string;
  assetId: string;
  formatId?: string;
  compoundId?: string;
  entry: MediaManifestEntry;
  path: string;
  durationFrames: number;
  hasVideo: boolean;
  hasAudio: boolean;
  startTimecode: Rational;
}

interface Nest {
  mediaId: string;
  timeline: Timeline;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  return Math.max(1, x);
}

function formatNumber(value: number): string {
  const rounded = roundedToPlaces(value, 4);
  if (Number.isInteger(rounded)) return String(rounded);
  let s = formatFixed(rounded, 4);
  while (s.endsWith("0")) s = s.slice(0, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

function colorString(color: RGBA): string {
  return `${formatNumber(color.r)} ${formatNumber(color.g)} ${formatNumber(color.b)} ${formatNumber(color.a)}`;
}

function decibels(linear: number): number {
  return linear > 0 ? 20.0 * Math.log10(linear) : -96.0;
}

/** Approximates user-entered speed with a small exact fraction. */
function rationalSpeed(speed: number): { p: number; q: number } {
  let best = { p: 1, q: 1 };
  let bestErr = Number.POSITIVE_INFINITY;
  for (let q = 1; q <= 1000; q++) {
    const p = swiftRound(speed * q);
    if (!(p > 0)) continue;
    const err = Math.abs(speed - p / q);
    if (err < bestErr) {
      best = { p, q };
      bestErr = err;
      if (err === 0) break;
    }
  }
  return best;
}

function formatRateSuffix(rawFPS: number): string {
  const rounded = Math.max(1, swiftRound(rawFPS));
  const ntscRate = (rounded * 1000.0) / 1001.0;
  if (Math.abs(rawFPS - ntscRate) < Math.abs(rawFPS - rounded)) {
    const fps100 = swiftRound(ntscRate * 100.0);
    return `${Math.trunc(fps100 / 100)}${pad2(fps100 % 100)}`;
  }
  return `${rounded}`;
}

function frameDuration(rawFPS: number): string {
  const rounded = Math.max(1, swiftRound(rawFPS));
  const ntscRate = (rounded * 1000.0) / 1001.0;
  if (Math.abs(rawFPS - ntscRate) < Math.abs(rawFPS - rounded)) return `1001/${rounded * 1000}s`;
  return `1/${rounded}s`;
}

function recognizedVideoFormatName(width: number, height: number, rawFPS: number): string | undefined {
  const rate = formatRateSuffix(rawFPS);
  if (width === 1280 && height === 720) return `FFVideoFormat720p${rate}`;
  if (width === 1920 && height === 1080) return `FFVideoFormat1080p${rate}`;
  if (width === 3840 && height === 2160) return `FFVideoFormat3840x2160p${rate}`;
  if (width === 4096 && height === 2160) return `FFVideoFormat4096x2160p${rate}`;
  return undefined;
}

function videoFormatName(width: number, height: number, rawFPS: number): string {
  return recognizedVideoFormatName(width, height, rawFPS) ?? `FFVideoFormat${width}x${height}p${formatRateSuffix(rawFPS)}`;
}

function sequenceFormatName(width: number, height: number, rawFPS: number): string {
  return recognizedVideoFormatName(width, height, rawFPS) ?? "FFVideoFormatRateUndefined";
}

function fontFamilyFallback(fontName: string): string {
  const trimmed = fontName.replace(/^-+/, "");
  if (trimmed === "") return fontName;
  const dash = trimmed.indexOf("-");
  return dash < 0 ? trimmed : trimmed.slice(0, dash);
}

function fontFaceFallback(isBold: boolean, isItalic: boolean): string {
  if (isBold && isItalic) return "Bold Italic";
  if (isBold) return "Bold";
  if (isItalic) return "Italic";
  return "Regular";
}

function fontFace(style: TextStyle, resolved: FCPXMLResolvedFont | undefined): string {
  if (resolved !== undefined && resolved.isBold === style.isBold && resolved.isItalic === style.isItalic && resolved.face !== undefined) {
    return resolved.face;
  }
  return fontFaceFallback(style.isBold, style.isItalic);
}

// Resolve cannot relink sub-delimiters encoded as XML entities.
function mediaSrc(path: string): string {
  let out = "";
  for (const ch of fileUrlAbsoluteString(path)) {
    out += "'!$&()*+,;=".includes(ch) ? `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : ch;
  }
  return out;
}

function buildFCPXML(input: FCPXMLExportInput): string {
  const { timeline, resolver } = input;
  const resolveTimeline = input.resolveTimeline ?? (() => undefined);
  const version = input.version ?? fcpxmlVersionDefault;
  const target = input.target ?? fcpxmlTargetDefault;
  const startTimecodes = input.startTimecodes ?? new Map<string, SourceTimecode>();
  const fps = Math.max(1, timeline.fps);
  const seqWidth = timeline.width;
  const seqHeight = timeline.height;
  const sequenceFormatId = "r1";
  const titleEffectId = "titleBasic";

  const resourceIndex = new Map<string, number>();
  const resources: MediaResource[] = [];
  let nextTextStyleId = 1;
  const linkedAudioForVideo = new Map<string, Clip>();
  const redundantAudioClipIds = new Set<string>();
  const usedCompoundIds = new Set<string>();
  const nests: Nest[] = [];
  const nestIndex = new Map<string, string>();

  function gap(clips: EmittableClip[], duration: string): XmlNode {
    return xmlNode("gap", {
      attributes: [["name", "Timeline"], ["offset", "0s"], ["start", "0s"], ["duration", duration]],
      children: storyNodes(clips),
    });
  }

  function build(): string {
    collectNests();
    const clips = emittableClips(timeline);
    const nestedClips = nests.flatMap((n) => emittableClips(n.timeline));
    collectResources([...clips, ...nestedClips]);
    indexLinkedPairs([...clips, ...nestedClips]);
    markUsedCompounds([...clips, ...nestedClips]);
    const hasTitles = [...clips, ...nestedClips].some((i) => i.clip.mediaType === "text");
    const root = xmlNode("fcpxml", {
      attributes: [["version", version]],
      children: [resourcesNode(hasTitles), libraryNode(clips)],
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${renderXmlNode(root, 0)}`;
  }

  function collectNests(): void {
    const reachable = timelineReachableTimelines(timeline, resolveTimeline, maxNestDepth, (t) => timelineTotalFrames(t) > 0);
    for (const child of reachable) {
      const mediaId = `nest${nests.length + 1}`;
      nestIndex.set(child.id, mediaId);
      nests.push({ mediaId, timeline: child });
    }
  }

  function indexLinkedPairs(clips: EmittableClip[]): void {
    const byGroup = new Map<string, { videos: EmittableClip[]; audios: EmittableClip[] }>();
    const slot = (group: string): { videos: EmittableClip[]; audios: EmittableClip[] } => {
      let s = byGroup.get(group);
      if (s === undefined) {
        s = { videos: [], audios: [] };
        byGroup.set(group, s);
      }
      return s;
    };
    for (const item of clips) {
      const group = item.clip.linkGroupId;
      if (group === undefined) continue;
      switch (item.clip.mediaType) {
        case "video": case "image": case "sequence": slot(group).videos.push(item); break;
        case "audio": slot(group).audios.push(item); break;
        default: break;
      }
    }
    for (const pair of byGroup.values()) {
      if (pair.videos.length !== 1 || pair.audios.length !== 1) continue;
      const v = pair.videos[0] as EmittableClip;
      const a = pair.audios[0] as EmittableClip;
      if (
        v.clip.mediaRef !== a.clip.mediaRef || v.enabled !== a.enabled ||
        v.clip.startFrame !== a.clip.startFrame || v.clip.durationFrames !== a.clip.durationFrames ||
        v.clip.trimStartFrame !== a.clip.trimStartFrame || !(Math.abs(v.clip.speed - a.clip.speed) < 0.0001)
      ) continue;
      linkedAudioForVideo.set(v.clip.id, a.clip);
      redundantAudioClipIds.add(a.clip.id);
    }
  }

  // Emit compound resources only when referenced.
  function markUsedCompounds(clips: EmittableClip[]): void {
    for (const item of clips) {
      if (redundantAudioClipIds.has(item.clip.id)) continue;
      const i = resourceIndex.get(item.clip.mediaRef);
      if (i === undefined) continue;
      const compoundId = (resources[i] as MediaResource).compoundId;
      if (compoundId === undefined || linkedAudioForVideo.has(item.clip.id)) continue;
      usedCompoundIds.add(compoundId);
    }
  }

  function resourcesNode(hasTitles: boolean): XmlNode {
    const children: XmlNode[] = [
      xmlNode("format", {
        attributes: [
          ["id", sequenceFormatId],
          ["name", sequenceFormatName(seqWidth, seqHeight, fps)],
          ["frameDuration", frameDuration(fps)],
          ["width", `${seqWidth}`],
          ["height", `${seqHeight}`],
          ["colorSpace", "1-1-1 (Rec. 709)"],
        ],
      }),
    ];
    if (hasTitles) {
      children.push(xmlNode("effect", {
        attributes: [
          ["id", titleEffectId],
          ["name", "Basic Title"],
          ["uid", ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"],
        ],
      }));
    }
    children.push(...compact(resources.map(formatNode)));
    children.push(...resources.map(assetNode));
    children.push(...compact(resources.map(compoundClipNode)));
    children.push(...compact(nests.map(nestFormatNode)));
    children.push(...nests.map(nestMediaNode));
    return xmlNode("resources", { children });
  }

  function nestFormatId(nest: Nest): string {
    return nest.timeline.width === seqWidth && nest.timeline.height === seqHeight ? sequenceFormatId : `${nest.mediaId}Format`;
  }

  function nestFormatNode(nest: Nest): XmlNode | undefined {
    const formatId = nestFormatId(nest);
    if (formatId === sequenceFormatId) return undefined;
    return xmlNode("format", {
      attributes: [
        ["id", formatId],
        ["name", sequenceFormatName(nest.timeline.width, nest.timeline.height, fps)],
        ["frameDuration", frameDuration(fps)],
        ["width", `${nest.timeline.width}`],
        ["height", `${nest.timeline.height}`],
        ["colorSpace", "1-1-1 (Rec. 709)"],
      ],
    });
  }

  function nestMediaNode(nest: Nest): XmlNode {
    const duration = time(timelineTotalFrames(nest.timeline));
    const sequence = xmlNode("sequence", {
      attributes: [
        ["format", nestFormatId(nest)],
        ["duration", duration],
        ["tcStart", "0s"],
        ["tcFormat", "NDF"],
        ["audioLayout", "stereo"],
        ["audioRate", "48k"],
      ],
      children: [xmlNode("spine", { children: [gap(emittableClips(nest.timeline), duration)] })],
    });
    return xmlNode("media", { attributes: [["id", nest.mediaId], ["name", nest.timeline.name]], children: [sequence] });
  }

  function compoundClipNode(resource: MediaResource): XmlNode | undefined {
    const compoundId = resource.compoundId;
    if (compoundId === undefined || !usedCompoundIds.has(compoundId)) return undefined;
    const dur = time(resource.durationFrames);
    // Compound spines stay 0-based while reading from the asset timecode origin.
    const tcStart = rationalTime(resource.startTimecode.num, resource.startTimecode.den);
    const innerClip = xmlNode("asset-clip", {
      attributes: [
        ["ref", resource.assetId],
        ["name", fileName(resource)],
        ["duration", dur],
        ["start", tcStart],
        ["offset", "0s"],
        ["format", resource.formatId ?? sequenceFormatId],
      ],
    });
    const sequence = xmlNode("sequence", {
      attributes: [
        ["format", resource.formatId ?? sequenceFormatId],
        ["duration", dur],
        ["tcStart", "0s"],
        ["tcFormat", "NDF"],
      ],
      children: [xmlNode("spine", { children: [innerClip] })],
    });
    return xmlNode("media", { attributes: [["id", compoundId], ["name", fileName(resource)]], children: [sequence] });
  }

  function libraryNode(clips: EmittableClip[]): XmlNode {
    return xmlNode("library", {
      children: [xmlNode("event", { attributes: [["name", "Palmier Export"]], children: [projectNode(clips)] })],
    });
  }

  function projectNode(clips: EmittableClip[]): XmlNode {
    const total = timelineTotalFrames(timeline);
    const duration = time(total);
    const spine = total > 0 ? xmlNode("spine", { children: [gap(clips, duration)] }) : xmlNode("spine");
    return xmlNode("project", {
      attributes: [["name", timeline.name]],
      children: [
        xmlNode("sequence", {
          attributes: [
            ["format", sequenceFormatId],
            ["duration", duration],
            ["tcStart", "0s"],
            ["tcFormat", "NDF"],
            ["audioLayout", "stereo"],
            ["audioRate", "48k"],
          ],
          children: [spine],
        }),
      ],
    });
  }

  function storyNodes(clips: EmittableClip[]): XmlNode[] {
    const sorted = clips
      .filter((i) => !redundantAudioClipIds.has(i.clip.id))
      .sort((a, b) => (a.clip.startFrame !== b.clip.startFrame ? a.clip.startFrame - b.clip.startFrame : a.lane - b.lane));
    return compact(sorted.map((item) => {
      switch (item.clip.mediaType) {
        case "text": return titleNode(item);
        case "audio": case "video": case "image": case "sequence": return assetClipNode(item);
        case "lottie": case "subtitle": return undefined;
      }
    }));
  }

  function conformNode(): XmlNode {
    return xmlNode("adjust-conform", { attributes: [["type", "fit"]] });
  }

  function assetClipNode(item: EmittableClip): XmlNode | undefined {
    const clip = item.clip;

    if (clip.sourceClipType === "sequence") {
      const mediaId = nestIndex.get(clip.mediaRef);
      const child = resolveTimeline(clip.mediaRef);
      if (mediaId === undefined || child === undefined) return undefined;
      // Frozen carriers may outlive the child timeline.
      const duration = Math.min(clip.durationFrames, Math.max(0, timelineTotalFrames(child) - clip.trimStartFrame));
      if (!(duration > 0)) return undefined;
      const attrs: [string, string][] = [
        ["ref", mediaId],
        ["name", child.name],
        ["lane", `${item.lane}`],
        ["offset", time(clip.startFrame)],
        ["start", time(clip.trimStartFrame)],
        ["duration", time(duration)],
        ["enabled", item.enabled ? "1" : "0"],
      ];
      if (clip.mediaType === "audio") {
        attrs.push(["srcEnable", "audio"]);
        return xmlNode("ref-clip", { attributes: attrs, children: compact([volumeNode(clip)]) });
      }
      const nestLinkedAudio = linkedAudioForVideo.get(clip.id);
      if (nestLinkedAudio === undefined) attrs.push(["srcEnable", "video"]);
      return xmlNode("ref-clip", {
        attributes: attrs,
        children: compact([
          conformNode(),
          cropNode(clip),
          transformNode(clip),
          blendNode(clip),
          nestLinkedAudio !== undefined ? volumeNode(nestLinkedAudio) : undefined,
        ]),
      });
    }

    const i = resourceIndex.get(clip.mediaRef);
    if (i === undefined) return undefined;
    const resource = resources[i] as MediaResource;
    const linkedAudio = linkedAudioForVideo.get(clip.id);

    // Resolve honors srcEnable only on ref-clips.
    if (resource.compoundId !== undefined && linkedAudio === undefined) {
      const videoOnly = clip.mediaType !== "audio";
      const attrs: [string, string][] = [
        ["ref", resource.compoundId],
        ["name", fileName(resource)],
        ["lane", `${item.lane}`],
        ["offset", time(clip.startFrame)],
        ["start", clipStart(clip)],
        ["duration", time(clip.durationFrames)],
        ["enabled", item.enabled ? "1" : "0"],
        ["srcEnable", videoOnly ? "video" : "audio"],
      ];
      // Child order is fixed by the DTD.
      const children = videoOnly
        ? [timeMapNode(clip, resource.durationFrames), cropNode(clip), conformNode(), transformNode(clip), blendNode(clip)]
        : [timeMapNode(clip, resource.durationFrames), volumeNode(clip)];
      return xmlNode("ref-clip", { attributes: attrs, children: compact(children) });
    }

    const origin = resource.startTimecode;
    const visual = clip.mediaType !== "audio";
    const attrs: [string, string][] = [
      ["ref", resource.assetId],
      ["name", fileName(resource)],
      ["lane", `${item.lane}`],
      ["offset", time(clip.startFrame)],
      ["start", clipStart(clip, origin)],
      ["duration", time(clip.durationFrames)],
      ["enabled", item.enabled ? "1" : "0"],
    ];
    const children = [
      timeMapNode(clip, resource.durationFrames, origin),
      visual ? cropNode(clip) : undefined,
      visual ? conformNode() : undefined,
      visual ? transformNode(clip) : undefined,
      visual ? blendNode(clip) : undefined,
      resource.hasAudio ? volumeNode(linkedAudio ?? clip) : undefined,
    ];
    // Final Cut writes stills as video elements.
    return xmlNode(clip.mediaType === "image" ? "video" : "asset-clip", { attributes: attrs, children: compact(children) });
  }

  function titleNode(item: EmittableClip): XmlNode | undefined {
    const clip = item.clip;
    const content = clip.textContent;
    if (content === undefined || content === "") return undefined;
    const style = clip.textStyle ?? makeTextStyle();
    const styleId = `textStyle${nextTextStyleId}`;
    nextTextStyleId += 1;

    const textNodes: XmlNode[] = [
      xmlNode("text", {
        children: [xmlNode("text-style", { attributes: [["ref", styleId]], text: textStyleDisplayText(style, content) })],
      }),
      xmlNode("text-style-def", {
        attributes: [["id", styleId]],
        children: [xmlNode("text-style", { attributes: textStyleAttributes(style) })],
      }),
      ...titleTransformNodes(clip, style),
    ];
    const blend = blendNode(clip);
    if (blend !== undefined) textNodes.push(blend);
    return xmlNode("title", {
      attributes: [
        ["ref", titleEffectId],
        ["name", content],
        ["lane", `${item.lane}`],
        ["offset", time(clip.startFrame)],
        ["start", "0s"],
        ["duration", time(clip.durationFrames)],
        ["enabled", item.enabled ? "1" : "0"],
      ],
      children: textNodes,
    });
  }

  function blendNode(clip: Clip): XmlNode | undefined {
    const frames = clipKeyframeFrames(clip, "opacity");
    if (!(clip.opacity < 0.9995 || frames.length > 0)) return undefined;
    const children: XmlNode[] = [];
    if (frames.length > 0) {
      children.push(keyframeParam("amount", formatNumber(clip.opacity), clip, "opacity", frames, (f) => formatNumber(clipRawOpacityAt(clip, f))));
    }
    return xmlNode("adjust-blend", { attributes: [["amount", formatNumber(clip.opacity)]], children });
  }

  function transformNode(clip: Clip): XmlNode | undefined {
    const t = clip.transform;
    const posFrames = clipKeyframeFrames(clip, "position");
    const rotFrames = clipKeyframeFrames(clip, "rotation");
    const scaleFrames = clipKeyframeFrames(clip, "scale");
    const base = scaleValue(t.width, t.height, clip);
    const moved = Math.abs(t.centerX - 0.5) > 0.0005 || Math.abs(t.centerY - 0.5) > 0.0005;
    const rotated = Math.abs(t.rotation) > 0.005;
    const scaled = base !== "1 1";
    if (!(moved || rotated || scaled || posFrames.length > 0 || rotFrames.length > 0 || scaleFrames.length > 0)) return undefined;

    const fit = target === "resolve" ? fitFractions(clip) : { w: 1.0, h: 1.0 };
    const attrs: [string, string][] = [["scale", base]];
    if (rotated || rotFrames.length > 0) attrs.push(["rotation", formatNumber(-t.rotation)]);
    attrs.push(["anchor", "0 0"]);
    attrs.push(["position", positionValue(t, fit)]);

    const params: XmlNode[] = [];
    if (scaleFrames.length > 0) {
      params.push(keyframeParam("scale", base, clip, "scale", scaleFrames, (f) => {
        const s = clipSizeAt(clip, f);
        return scaleValue(s.width, s.height, clip);
      }));
    }
    if (posFrames.length > 0) {
      params.push(keyframeParam("position", positionValue(t, fit), clip, "position", posFrames, (f) => positionValue(clipTransformAt(clip, f), fit)));
    }
    if (rotFrames.length > 0) {
      params.push(keyframeParam("rotation", formatNumber(-t.rotation), clip, "rotation", rotFrames, (f) => formatNumber(-clipRotationAt(clip, f))));
    }
    return xmlNode("adjust-transform", { attributes: attrs, children: params });
  }

  /** Removes aspect-fit scaling from the exported user scale. */
  function scaleValue(width: number, height: number, clip: Clip): string {
    const fit = fitFractions(clip);
    let sx = width / fit.w;
    let sy = height / fit.h;
    if (clip.transform.flipHorizontal) sx = -sx;
    if (clip.transform.flipVertical) sy = -sy;
    return `${formatNumber(sx)} ${formatNumber(sy)}`;
  }

  function keyframeParam(
    name: string, base: string, clip: Clip, property: AnimatableProperty, frames: number[], value: (f: number) => string,
  ): XmlNode {
    const keyframes = [...frames].sort((a, b) => a - b).map((f) => {
      const attrs: [string, string][] = [["time", keyframeTime(f, clip)]];
      if (clipInterpolation(clip, property, f) === "linear") attrs.push(["curve", "linear"]);
      attrs.push(["value", value(f)]);
      return xmlNode("keyframe", { attributes: attrs });
    });
    return xmlNode("param", {
      attributes: [["name", name], ["value", base]],
      children: [xmlNode("keyframeAnimation", { children: keyframes })],
    });
  }

  /** Offsets retimed keyframes into the time map's output axis. */
  function keyframeTime(f: number, clip: Clip): string {
    if (!(Math.abs(clip.speed - 1.0) > 0.001)) return time(f - clip.startFrame);
    const { p, q } = rationalSpeed(clip.speed);
    const num = clip.trimStartFrame * q + (f - clip.startFrame) * p;
    return rationalTime(num, fps * p);
  }

  /** Uses Resolve trim units when source dimensions are known. */
  function cropNode(clip: Clip): XmlNode | undefined {
    const c = clip.crop;
    if (cropIsIdentity(c)) return undefined;
    let lr = 100.0;
    let tb = 100.0;
    const dims = target === "resolve" ? sourceDimensions(clip) : undefined;
    if (dims !== undefined) {
      const fit = Math.min(seqWidth / dims.sw, seqHeight / dims.sh);
      lr = (dims.sw * 100.0) / seqHeight;
      tb = 100.0 / fit;
    }
    return xmlNode("adjust-crop", {
      attributes: [["mode", "trim"]],
      children: [
        xmlNode("trim-rect", {
          attributes: [
            ["top", formatNumber(c.top * tb)],
            ["right", formatNumber(c.right * lr)],
            ["bottom", formatNumber(c.bottom * tb)],
            ["left", formatNumber(c.left * lr)],
          ],
        }),
      ],
    });
  }

  function volumeNode(clip: Clip): XmlNode | undefined {
    // Resolve drops keyframed volume on round-trip.
    if (!(Math.abs(clip.volume - 1.0) > 0.0005)) return undefined;
    return xmlNode("adjust-volume", { attributes: [["amount", formatNumber(decibels(clip.volume))]] });
  }

  /** Uses the time-map output axis for retimed clips and the source origin otherwise. */
  function clipStart(clip: Clip, origin: Rational = { num: 0, den: 1 }): string {
    if (!(Math.abs(clip.speed - 1.0) > 0.001)) return timeFrom(clip.trimStartFrame, origin);
    const { p, q } = rationalSpeed(clip.speed);
    return rationalTime(clip.trimStartFrame * q, fps * p);
  }

  /** Maps the full asset so retimed clips do not end on black frames. */
  function timeMapNode(clip: Clip, mediaFrames: number, origin: Rational = { num: 0, den: 1 }): XmlNode | undefined {
    if (!(Math.abs(clip.speed - 1.0) > 0.001 && mediaFrames > 0)) return undefined;
    const { p, q } = rationalSpeed(clip.speed);
    return xmlNode("timeMap", {
      attributes: [["frameSampling", "floor"]],
      children: [
        xmlNode("timept", { attributes: [["time", "0s"], ["value", rationalTime(origin.num, origin.den)], ["interp", "linear"]] }),
        xmlNode("timept", {
          attributes: [
            ["time", rationalTime(mediaFrames * q, fps * p)],
            ["value", timeFrom(mediaFrames, origin)],
            ["interp", "linear"],
          ],
        }),
      ],
    });
  }

  function rationalTime(num: number, den: number): string {
    if (num === 0) return "0s";
    const g = gcd(Math.abs(num), Math.abs(den));
    const n = num / g;
    const d = den / g;
    return d === 1 ? `${n}s` : `${n}/${d}s`;
  }

  function collectResources(clips: EmittableClip[]): void {
    interface Caps {
      mediaRefs: string[];
      hasVideo: boolean;
      hasAudio: boolean;
      duration: number;
      entry: MediaManifestEntry;
      path: string;
    }
    const order: string[] = [];
    const caps = new Map<string, Caps>();

    for (const item of clips) {
      const clip = item.clip;
      if (clip.mediaType === "text" || clip.mediaType === "lottie") continue;
      const entry = mediaResolverEntry(resolver, clip.mediaRef);
      const path = mediaResolverResolvePath(resolver, clip.mediaRef);
      if (entry === undefined || path === undefined) continue;

      const key = pathKey(path);
      const duration = sourceDurationFrames(entry, clip);
      const isVisual = clip.mediaType !== "audio";
      // Video resources include source audio when present.
      const isAudio = clip.mediaType === "audio" || (clip.mediaType === "video" && entry.hasAudio === true);
      let entryCaps = caps.get(key);
      if (entryCaps === undefined) {
        order.push(key);
        entryCaps = { mediaRefs: [], hasVideo: false, hasAudio: false, duration: 0, entry, path };
      }
      if (!entryCaps.mediaRefs.includes(clip.mediaRef)) entryCaps.mediaRefs.push(clip.mediaRef);
      entryCaps.hasVideo = entryCaps.hasVideo || isVisual;
      entryCaps.hasAudio = entryCaps.hasAudio || isAudio;
      entryCaps.duration = Math.max(entryCaps.duration, duration);
      caps.set(key, entryCaps);
    }

    for (const key of order) {
      const c = caps.get(key);
      if (c === undefined) continue;
      const id = resources.length + 1;
      for (const ref of c.mediaRefs) resourceIndex.set(ref, resources.length);
      const firstTimecode = c.mediaRefs.map((r) => startTimecodes.get(r)).find((tc) => tc !== undefined);
      const tc = firstTimecode !== undefined ? sourceTimecodeRationalSeconds(firstTimecode) : { num: 0, den: 1 };
      const resource: MediaResource = {
        mediaRef: c.mediaRefs[0] ?? c.entry.id,
        assetId: `asset${id}`,
        entry: c.entry,
        path: c.path,
        durationFrames: c.duration,
        hasVideo: c.hasVideo,
        hasAudio: c.hasAudio,
        startTimecode: tc,
      };
      if (c.hasVideo) resource.formatId = `r${id + 1}`;
      // Only A/V sources need srcEnable gating through a compound.
      if (c.hasVideo && c.hasAudio) resource.compoundId = `media${id}`;
      resources.push(resource);
    }
  }

  function formatNode(resource: MediaResource): XmlNode | undefined {
    if (resource.formatId === undefined) return undefined;
    const width = resource.entry.sourceWidth ?? seqWidth;
    const height = resource.entry.sourceHeight ?? seqHeight;
    const rawFPS = resource.entry.sourceFPS ?? fps;
    return xmlNode("format", {
      attributes: [
        ["id", resource.formatId],
        ["name", videoFormatName(width, height, rawFPS)],
        ["frameDuration", frameDuration(rawFPS)],
        ["width", `${width}`],
        ["height", `${height}`],
        ["colorSpace", "1-1-1 (Rec. 709)"],
      ],
    });
  }

  // Resolve relinks by the full filename, including its extension.
  function fileName(resource: MediaResource): string {
    return lastPathComponent(resource.path);
  }

  function assetNode(resource: MediaResource): XmlNode {
    const attrs: [string, string][] = [
      ["id", resource.assetId],
      ["name", fileName(resource)],
      ["start", rationalTime(resource.startTimecode.num, resource.startTimecode.den)],
      ["duration", time(resource.durationFrames)],
    ];
    if (resource.hasVideo) {
      attrs.push(["hasVideo", "1"]);
      attrs.push(["videoSources", "1"]);
      if (resource.formatId !== undefined) attrs.push(["format", resource.formatId]);
    }
    if (resource.hasAudio) {
      // Default audio metadata does not affect relinking.
      attrs.push(["hasAudio", "1"]);
      attrs.push(["audioSources", "1"]);
      attrs.push(["audioChannels", "2"]);
      attrs.push(["audioRate", "48000"]);
    }
    return xmlNode("asset", {
      attributes: attrs,
      children: [xmlNode("media-rep", { attributes: [["kind", "original-media"], ["src", mediaSrc(resource.path)]] })],
    });
  }

  function sourceDurationFrames(entry: MediaManifestEntry, clip: Clip): number {
    const manifestFrames = Math.max(0, secondsToFrame(entry.duration, fps));
    return Math.max(manifestFrames, clipSourceDurationFrames(clip));
  }

  function emittableClips(t: Timeline): EmittableClip[] {
    const visualTrackCount = t.tracks.filter((track) => clipTypeIsVisual(track.type)).length;
    let visualOrdinal = 0;
    let audioOrdinal = 0;
    const clips: EmittableClip[] = [];

    for (const track of t.tracks) {
      let lane: number;
      let enabled: boolean;
      if (clipTypeIsVisual(track.type)) {
        lane = visualTrackCount - visualOrdinal;
        enabled = !track.hidden;
        visualOrdinal += 1;
      } else if (track.type === "audio") {
        lane = -(audioOrdinal + 1);
        enabled = !track.muted;
        audioOrdinal += 1;
      } else {
        continue;
      }
      clips.push(
        ...track.clips
          .filter(isEmittable)
          .sort((a, b) => a.startFrame - b.startFrame)
          .map((clip) => ({ clip, lane, enabled })),
      );
    }
    return clips;
  }

  function isEmittable(clip: Clip): boolean {
    if (!(clip.durationFrames > 0)) return false;
    // Nest carriers require a resolved compound resource.
    if (clip.sourceClipType === "sequence") return nestIndex.has(clip.mediaRef);
    switch (clip.mediaType) {
      case "text": return clip.textContent !== undefined && clip.textContent !== "";
      case "lottie": case "sequence": case "subtitle": return false;
      case "audio": case "video": case "image": return mediaResolverResolvePath(resolver, clip.mediaRef) !== undefined;
    }
  }

  function time(frames: number): string {
    if (frames === 0) return "0s";
    const divisor = gcd(Math.abs(frames), fps);
    const numerator = frames / divisor;
    const denominator = fps / divisor;
    return denominator === 1 ? `${numerator}s` : `${numerator}/${denominator}s`;
  }

  /** Adds frame time to an exact source origin without NTSC drift. */
  function timeFrom(frames: number, origin: Rational): string {
    if (origin.num === 0) return time(frames);
    return rationalTime(frames * origin.den + origin.num * fps, fps * origin.den);
  }

  function textStyleAttributes(rawStyle: TextStyle): [string, string][] {
    const style = textStyleScaledVisualStyle(rawStyle);
    const resolved = input.resolveFont?.(style);
    const family = resolved?.familyName ?? fontFamilyFallback(style.fontName);
    const face = fontFace(style, resolved);
    const fontSize = style.fontSize * style.fontScale;
    const attrs: [string, string][] = [
      ["font", family],
      ["fontFace", face],
      ["fontSize", formatNumber(fontSize)],
      ["fontColor", colorString(style.color)],
      ["alignment", style.alignment],
    ];
    if (style.border.enabled) {
      attrs.push(["strokeColor", colorString(style.border.color)]);
      attrs.push(["strokeWidth", formatNumber(Math.max(0, style.border.width))]);
    }
    return attrs;
  }

  function titleTransformNodes(clip: Clip, style: TextStyle): XmlNode[] {
    const baseScale = `${formatNumber(style.widthScale)} ${formatNumber(style.heightScale)}`;
    const frames = clipKeyframeFrames(clip, "scale");
    const parameters: XmlNode[] = [];
    if (frames.length > 0) {
      const staticFontScale = Number.isFinite(style.fontScale) && style.fontScale > 0 ? style.fontScale : makeTextStyle().fontScale;
      parameters.push(keyframeParam("scale", baseScale, clip, "scale", frames, (frame) => {
        const ratio = clipTextScaleAt(clip, frame) / staticFontScale;
        return `${formatNumber(style.widthScale * ratio)} ${formatNumber(style.heightScale * ratio)}`;
      }));
    }
    return [
      conformNode(),
      xmlNode("adjust-transform", {
        attributes: [["scale", baseScale], ["anchor", "0 0"], ["position", positionValue(clip.transform)]],
        children: parameters,
      }),
    ];
  }

  function positionValue(transform: Transform, fit: { w: number; h: number } = { w: 1, h: 1 }): string {
    const unit = seqHeight / 100.0;
    const x = ((transform.centerX - 0.5) * seqWidth) / unit / fit.w;
    const y = ((0.5 - transform.centerY) * seqHeight) / unit / fit.h;
    return `${formatNumber(x)} ${formatNumber(y)}`;
  }

  function sourceDimensions(clip: Clip): { sw: number; sh: number } | undefined {
    const entry = mediaResolverEntry(resolver, clip.mediaRef);
    const sw = entry?.sourceWidth;
    const sh = entry?.sourceHeight;
    return sw !== undefined && sh !== undefined && sw > 0 && sh > 0 ? { sw, sh } : undefined;
  }

  /** Returns per-axis conform-fit fractions, or 1×1 without source dimensions. */
  function fitFractions(clip: Clip): { w: number; h: number } {
    const dims = sourceDimensions(clip);
    if (dims === undefined) return { w: 1, h: 1 };
    const sourceAspect = dims.sw / dims.sh;
    const frameAspect = seqWidth / seqHeight;
    return sourceAspect >= frameAspect ? { w: 1, h: frameAspect / sourceAspect } : { w: sourceAspect / frameAspect, h: 1 };
  }

  return build();
}
