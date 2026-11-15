import { clipTypeFromFileExtension, type ClipType } from "../model";
import { pathExtension } from "./paths";

/** `ClipType(fileExtension: url.pathExtension.lowercased())` */
export function clipTypeForPath(path: string): ClipType | undefined {
  return clipTypeFromFileExtension(pathExtension(path).toLowerCase());
}

export const lottieSniffByteLimit = 256 * 1024;
const jsonSignatureKeys = ["layers", "v", "w", "h", "op"] as const;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function containsJsonKey(key: string, text: string): boolean {
  return new RegExp(`"${key}"\\s*:`).test(text);
}

/**
 * `LottieVideoGenerator.isLottie` on the file's leading bytes: a `.lottie` must be a zip archive, a `.json`
 * must carry the Bodymovin comp signature within the first 256 KiB.
 */
export function isLottieHeader(path: string, head: Uint8Array): boolean {
  if (pathExtension(path).toLowerCase() === "lottie") {
    return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  }
  const first = head.find((b) => !isJsonWhitespace(b));
  if (first !== 0x7b) return false;
  const text = new TextDecoder().decode(head.subarray(0, lottieSniffByteLimit));
  return jsonSignatureKeys.every((k) => containsJsonKey(k, text));
}

export interface LottieMeta {
  width: number;
  height: number;
  framerate: number;
  duration: number;
}

/** Bodymovin comp fields: w, h, fr (frame rate), ip/op (in/out points); duration = (op - ip) / fr. */
export function parseLottieJson(text: string): LottieMeta | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const { w, h, fr, ip, op } = o;
  if (![w, h, fr, ip, op].every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  const framerate = fr as number;
  const width = w as number;
  const height = h as number;
  if (!(framerate > 0) || !(width > 0) || !(height > 0) || !Array.isArray(o["layers"])) return undefined;
  const frames = (op as number) - (ip as number);
  return { width: Math.trunc(width), height: Math.trunc(height), framerate, duration: frames / framerate };
}
