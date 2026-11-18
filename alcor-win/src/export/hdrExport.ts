import { canEncodeVideo, type VideoEncodingAdditionalOptions } from "mediabunny";
import {
  exportTargetVideoBitrate, hdrTransferDefault, videoCodecIsHDR, videoCodecMediabunnyId,
  type HdrTransfer, type RenderSize, type VideoCodec, type VideoExportOptions,
} from "./exportOptions";

/*
 * 10-bit HDR export. The compositor renders SDR (sRGB, 8-bit RGBA); each frame is converted here to BT.2020 + HLG/PQ
 * 10-bit 4:2:0 and tagged, like HDRVideoExporter.swift does with CoreImage. The result is SDR content carried in an
 * HDR container (SDR white at the BT.2408 reference level), not true HDR grading.
 */

export type HdrVideoCodec = Extract<VideoCodec, "HEVC 10-bit HDR" | "VP9 10-bit HDR">;

export const hdrVideoCodecs: readonly HdrVideoCodec[] = ["HEVC 10-bit HDR", "VP9 10-bit HDR"];

export function hdrTransferOf(options: Pick<VideoExportOptions, "hdrTransfer">): HdrTransfer {
  return options.hdrTransfer ?? hdrTransferDefault;
}

// MARK: - Codec strings

// [max luma picture size, max luma sample rate, level], smallest first. HEVC level is general_level_idc (30 x level).
const hevcLevels: readonly (readonly [number, number, number])[] = [
  [2_228_224, 66_846_720, 120], [2_228_224, 133_693_440, 123],
  [8_912_896, 267_386_880, 150], [8_912_896, 534_773_760, 153], [8_912_896, 1_069_547_520, 156],
  [35_651_584, 1_069_547_520, 180], [35_651_584, 2_139_095_040, 183], [35_651_584, 4_278_190_080, 186],
];

const vp9Levels: readonly (readonly [number, number, number])[] = [
  [2_228_224, 70_778_880, 40], [2_228_224, 83_558_400, 41], [2_228_224, 160_432_128, 42],
  [8_912_896, 267_386_880, 50], [8_912_896, 534_773_760, 51], [8_912_896, 1_069_547_520, 52],
  [35_651_584, 1_069_547_520, 60], [35_651_584, 2_139_095_040, 61], [35_651_584, 4_278_190_080, 62],
];

function pickLevel(table: readonly (readonly [number, number, number])[], size: RenderSize, fps: number): number {
  const picture = size.width * size.height;
  const rate = picture * fps;
  const hit = table.find(([maxPicture, maxRate]) => picture <= maxPicture && rate <= maxRate);
  return (hit ?? (table[table.length - 1] as readonly [number, number, number]))[2];
}

/** WebCodecs codec string for the 10-bit profile: HEVC Main10 (`hev1.2.4`) or VP9 profile 2 (`vp09.02`). */
export function hdrFullCodecString(codec: HdrVideoCodec, size: RenderSize, fps: number): string {
  if (codec === "HEVC 10-bit HDR") return `hev1.2.4.L${pickLevel(hevcLevels, size, fps)}.B0`;
  return `vp09.02.${pickLevel(vp9Levels, size, fps)}.10`;
}

// MARK: - Colour tagging

export function hdrColorSpace(transfer: HdrTransfer): VideoColorSpaceInit {
  // lib.dom's union predates the BT.2020 / PQ / HLG values that Chromium accepts.
  return { primaries: "bt2020", transfer, matrix: "bt2020-ncl", fullRange: false } as unknown as VideoColorSpaceInit;
}

// MARK: - Runtime support

const probeSize: RenderSize = { width: 1920, height: 1080 };
const probeFps = 30;

interface VideoProbe {
  width: number;
  height: number;
  bitrate: number;
  frameRate: number;
}

/** Encode options shared by the support probe and the real export. */
export function hdrEncodeProbe(codec: HdrVideoCodec, size: RenderSize, fps: number): VideoEncodingAdditionalOptions & VideoProbe {
  return {
    width: size.width,
    height: size.height,
    bitrate: exportTargetVideoBitrate(codec, size),
    frameRate: fps,
    fullCodecString: hdrFullCodecString(codec, size, fps),
    // Software HEVC encoding does not exist in the browser; VP9 10-bit only has the software encoder.
    hardwareAcceleration: videoCodecMediabunnyId(codec) === "hevc" ? "prefer-hardware" : "no-preference",
  };
}

let supportMemo: Promise<readonly HdrVideoCodec[]> | undefined;

/** The HDR codecs this runtime can encode at 1080p30 (memoized; the export re-checks at its real size). */
export function supportedHdrCodecs(): Promise<readonly HdrVideoCodec[]> {
  supportMemo ??= Promise.all(hdrVideoCodecs.map(async (codec) => {
    try {
      return (await canEncodeVideo(videoCodecMediabunnyId(codec), hdrEncodeProbe(codec, probeSize, probeFps))) ? codec : null;
    } catch {
      return null;
    }
  })).then((r) => r.filter((c): c is HdrVideoCodec => c !== null));
  return supportMemo;
}

export function isHdrVideoCodec(c: VideoCodec): c is HdrVideoCodec {
  return videoCodecIsHDR(c);
}

// MARK: - Pixel conversion (sRGB RGBA8 -> BT.2020 HLG/PQ I420P10, limited range)

const lutSize = 16384;

const srgbToLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  srgbToLinear[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

const pqM1 = 2610 / 16384;
const pqM2 = (2523 / 4096) * 128;
const pqC1 = 3424 / 4096;
const pqC2 = (2413 / 4096) * 32;
const pqC3 = (2392 / 4096) * 32;

/** BT.2408: SDR reference white sits at 203 nits (PQ) / 75% signal on a 1000-nit display (HLG). */
const sdrWhiteNits = 203;

function pqOetf(nits: number): number {
  const y = (Math.max(0, nits) / 10_000) ** pqM1;
  return ((pqC1 + pqC2 * y) / (1 + pqC3 * y)) ** pqM2;
}

function hlgOetf(e: number): number {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c;
}

/** Encoded signal (0...1) for `lutSize + 1` SDR linear-light steps in 0...1, plus a repeated guard entry for rounding. */
export function buildHdrTransferLut(transfer: HdrTransfer): Float32Array {
  const lut = new Float32Array(lutSize + 2);
  for (let i = 0; i <= lutSize; i++) {
    const lin = i / lutSize;
    // HLG: undo the 1.2 system gamma of a 1000-nit display so SDR white lands on 75%.
    lut[i] = transfer === "pq" ? pqOetf(lin * sdrWhiteNits) : hlgOetf((lin * (sdrWhiteNits / 1000)) ** (1 / 1.2));
  }
  lut[lutSize + 1] = lut[lutSize] as number;
  return lut;
}

const kr = 0.2627;
const kb = 0.0593;
const kg = 1 - kr - kb;
const cbScale = 2 * (1 - kb);
const crScale = 2 * (1 - kr);

/**
 * Converts opaque sRGB RGBA8 frames to 10-bit limited-range BT.2020 non-constant-luminance 4:2:0 (plane order Y, U, V,
 * `I420P10`). Reuses its LUT; the output buffer belongs to the caller. Width and height must be even.
 */
export function createHdrConverter(width: number, height: number, transfer: HdrTransfer): (rgba: Uint8Array, out: Uint16Array) => void {
  const lut = buildHdrTransferLut(transfer);
  const planeU = width * height;
  const planeV = planeU + planeU / 4;
  const rowBytes = width * 4;
  return (rgba, out) => {
    // Hot loop: everything inlined into locals (a helper per pixel costs ~3x).
    for (let y = 0; y < height; y += 2) {
      let chroma = planeU + (y / 2) * (width / 2);
      for (let x = 0; x < width; x += 2) {
        let cb = 0;
        let cr = 0;
        for (let k = 0; k < 4; k++) {
          const p = (y + (k >> 1)) * rowBytes + (x + (k & 1)) * 4;
          const r = srgbToLinear[rgba[p] as number] as number;
          const g = srgbToLinear[rgba[p + 1] as number] as number;
          const b = srgbToLinear[rgba[p + 2] as number] as number;
          let t = (0.6274039 * r + 0.3292830 * g + 0.0433131 * b) * lutSize;
          let i = (t + 0.5) | 0;
          const rr = lut[i] as number;
          t = (0.0690973 * r + 0.9195404 * g + 0.0113623 * b) * lutSize;
          i = (t + 0.5) | 0;
          const gg = lut[i] as number;
          t = (0.0163914 * r + 0.0880133 * g + 0.8955953 * b) * lutSize;
          i = (t + 0.5) | 0;
          const bb = lut[i] as number;
          const yy = kr * rr + kg * gg + kb * bb;
          out[((y + (k >> 1)) * width) + x + (k & 1)] = 64 + 876 * yy + 0.5;
          cb += bb - yy;
          cr += rr - yy;
        }
        out[chroma] = 512 + (896 / 4 / cbScale) * cb + 0.5;
        out[planeV + chroma - planeU] = 512 + (896 / 4 / crScale) * cr + 0.5;
        chroma++;
      }
    }
  };
}
