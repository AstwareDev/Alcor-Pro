// The built-in sample: made only from generated content (text titles with animations, a pill "shape", colour solids and a
// synthesised arpeggio), so it ships no media and needs no download. Files are produced when the sample is opened.
import {
  Defaults, makeClip, makeMediaManifest, makeMediaManifestEntry, makeProjectFile, makeProjectSource,
  makeRGBA, makeTextAnimation, makeTextBackground, makeTextStyle, makeTimeline, makeTrack, makeTransform,
  type Clip, type MediaManifestEntry, type ProjectFile,
} from "../model";
import { synthPng, synthWav, type Note, type Rgb } from "./syntheticMedia";

export interface BuiltSample {
  title: string;
  project: ProjectFile;
  manifest: ReturnType<typeof makeMediaManifest>;
  /** Package-relative path and contents of each generated media file. */
  files: { relativePath: string; bytes: Uint8Array }[];
}

const fps = 30;
const seconds = 8;
const frames = fps * seconds;
const width = 1280;
const height = 720;

const lime = makeRGBA({ r: 0.776, g: 0.957, b: 0.196, a: 1 });
const ink = makeRGBA({ r: 0.043, g: 0.043, b: 0.047, a: 1 });
const white = makeRGBA({ r: 0.96, g: 0.97, b: 0.95, a: 1 });

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round((a[i] as number) + ((b[i] as number) - (a[i] as number)) * t)) as unknown as Rgb;

/** C minor pentatonic arpeggio, one bar per two seconds. */
function arpeggio(): Note[] {
  const scale = [261.63, 311.13, 392, 466.16, 523.25, 392, 311.13, 466.16];
  const notes: Note[] = [];
  for (let i = 0; i < 16; i++) notes.push({ at: i * 0.5, seconds: 1.1, hz: scale[i % scale.length] as number, gain: 0.5 });
  notes.push({ at: 0, seconds: 8, hz: 65.41, gain: 0.25 });
  return notes;
}

interface TextOptions {
  start: number;
  duration: number;
  text: string;
  size: number;
  centerY: number;
  box: { width: number; height: number };
  animation: "popIn" | "slideUp" | "typewriter";
  color?: typeof white;
  bold?: boolean;
  background?: boolean;
}

function textClip(o: TextOptions): Clip {
  return makeClip({
    mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: o.start, durationFrames: o.duration,
    textContent: o.text,
    textStyle: makeTextStyle({
      fontSize: o.size, isBold: o.bold ?? true, color: o.color ?? white,
      background: o.background
        ? makeTextBackground({ enabled: true, color: lime, paddingX: 36, paddingY: 18, cornerRadius: 40 })
        : makeTextBackground(),
    }),
    textAnimation: makeTextAnimation({ preset: o.animation }),
    transform: makeTransform({ centerY: o.centerY, width: o.box.width, height: o.box.height }),
    fadeOutFrames: 12,
  });
}

function imageEntry(id: string, name: string, relativePath: string, w: number, h: number): MediaManifestEntry {
  return makeMediaManifestEntry({
    id, name, type: "image", source: makeProjectSource(relativePath), duration: Defaults.imageDurationSeconds, sourceWidth: w, sourceHeight: h,
  });
}

export function buildGeneratedSample(): BuiltSample {
  const backdropId = "sample-backdrop";
  const cardId = "sample-card";
  const musicId = "sample-music";

  const backdrop = synthPng(8, 72, (_x, y) => mix([20, 22, 18], [58, 74, 30], y / 71));
  const card = synthPng(8, 8, () => [24, 24, 28]);

  const cardClip = makeClip({
    mediaRef: cardId, mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: frames, opacity: 0.85, fadeInFrames: 20,
    transform: makeTransform({ width: 0.72, height: 0.5 }),
  });

  const timeline = makeTimeline({
    name: "Welcome", fps, width, height, settingsConfigured: true,
    tracks: [
      makeTrack({ type: "text", name: "Titles", clips: [
        textClip({ start: 0, duration: 120, text: "ALCOR PRO", size: 190, centerY: 0.42, box: { width: 0.85, height: 0.3 }, animation: "popIn" }),
        textClip({ start: 120, duration: 120, text: "Cut. Grade. Create.", size: 120, centerY: 0.42, box: { width: 0.85, height: 0.25 }, animation: "typewriter" }),
      ] }),
      makeTrack({ type: "text", name: "Shape", clips: [
        textClip({ start: 30, duration: 210, text: "DARKROOM", size: 44, centerY: 0.66, box: { width: 0.3, height: 0.11 }, animation: "slideUp", color: ink, background: true }),
      ] }),
      makeTrack({ type: "image", name: "Solids", clips: [cardClip] }),
      makeTrack({ type: "image", name: "Backdrop", clips: [
        makeClip({ mediaRef: backdropId, mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: frames }),
      ] }),
      makeTrack({ type: "audio", name: "Music", clips: [
        makeClip({ mediaRef: musicId, mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: frames, volume: 0.8, fadeInFrames: 15, fadeOutFrames: 45 }),
      ] }),
    ],
  });

  const manifest = makeMediaManifest({
    entries: [
      imageEntry(backdropId, "Backdrop", "media/backdrop.png", 8, 72),
      imageEntry(cardId, "Card", "media/card.png", 8, 8),
      makeMediaManifestEntry({ id: musicId, name: "Arpeggio", type: "audio", source: makeProjectSource("media/arpeggio.wav"), duration: seconds, hasAudio: true }),
    ],
  });

  return {
    title: "Welcome to Alcor",
    project: makeProjectFile({ timelines: [timeline], activeTimelineId: timeline.id, openTimelineIds: [timeline.id] }),
    manifest,
    files: [
      { relativePath: "media/backdrop.png", bytes: backdrop },
      { relativePath: "media/card.png", bytes: card },
      { relativePath: "media/arpeggio.wav", bytes: synthWav(arpeggio(), seconds) },
    ],
  };
}
