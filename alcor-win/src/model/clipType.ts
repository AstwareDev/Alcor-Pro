import { decodeEnum } from "../util/jsonDecode";

export const clipTypes = ["video", "audio", "image", "text", "lottie", "sequence", "subtitle"] as const;

export type ClipType = (typeof clipTypes)[number];

const sfSymbolNames: Record<ClipType, string> = {
  video: "video",
  audio: "waveform",
  image: "photo",
  text: "textformat",
  lottie: "sparkles",
  sequence: "film.stack",
  subtitle: "captions.bubble",
};

export function clipTypeSfSymbolName(type: ClipType): string {
  return sfSymbolNames[type];
}

const trackLabels: Record<ClipType, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  text: "Text",
  lottie: "Lottie",
  sequence: "Video",
  subtitle: "Subtitle",
};

export function clipTypeTrackLabel(type: ClipType): string {
  return trackLabels[type];
}

export function clipTypeTrackLabelPrefix(type: ClipType): string {
  return Array.from(trackLabels[type])[0] ?? "";
}

export function clipTypeIsVisual(type: ClipType): boolean {
  return type !== "audio" && type !== "subtitle";
}

export function clipTypeIsCompatible(type: ClipType, other: ClipType): boolean {
  return type === other || (clipTypeIsVisual(type) && clipTypeIsVisual(other));
}

/** `ClipType(fileExtension:)`. Matching is case-sensitive, like the Swift switch; callers pass a lowercased extension. */
export function clipTypeFromFileExtension(ext: string): ClipType | undefined {
  switch (ext) {
    case "mov": case "mp4": case "m4v": return "video";
    case "mp3": case "wav": case "aac": case "m4a": case "aiff": case "aif": case "aifc": case "caf": case "flac": return "audio";
    case "png": case "jpg": case "jpeg": case "tiff": case "heic": case "webp": return "image";
    case "json": case "lottie": return "lottie";
    case "srt": case "vtt": return "subtitle";
    default: return undefined;
  }
}

export function decodeClipType(json: unknown): ClipType {
  return decodeEnum(json, clipTypes, "ClipType");
}
