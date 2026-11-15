import { getPoster } from "../../media/thumbnails";
import type { MediaAsset } from "../../model";

// The only browser-dependent part of inspect_color: turns frames into the RGBA grid that colorScopes.ts measures.

export const scopeGridEdge = 256;
export const rawFrameLongestEdge = 512;
const jpegQuality = 0.8;

export interface MeasuredFrame {
  /** `gridEdge`² RGBA8 pixels, the frame stretched to a square like ColorScopes.measure. */
  rgba: Uint8ClampedArray;
  jpegBase64: string;
}

export interface ColorFrameIO {
  /** Decodes a rendered timeline frame (base64 JPEG) into the scope grid. */
  gridFromJpeg(base64: string, gridEdge: number): Promise<Uint8ClampedArray | undefined>;
  /** A raw asset's frame (no effects) with its JPEG; undefined when it can't be decoded. */
  rawAssetFrame(asset: MediaAsset, gridEdge: number): Promise<MeasuredFrame | undefined>;
}

function gridOf(source: ImageBitmap, n: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(n, n);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(source, 0, 0, n, n);
  return ctx.getImageData(0, 0, n, n).data;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function jpegOf(source: ImageBitmap): Promise<string> {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(source, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: jpegQuality });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export const colorFrameIO: ColorFrameIO = {
  async gridFromJpeg(base64, gridEdge) {
    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      try {
        return gridOf(bitmap, gridEdge);
      } finally {
        bitmap.close();
      }
    } catch {
      return undefined;
    }
  },
  async rawAssetFrame(asset, gridEdge) {
    try {
      const bitmap = await getPoster(asset.url, { type: asset.type, maxSize: rawFrameLongestEdge });
      if (!bitmap) return undefined;
      return { rgba: gridOf(bitmap, gridEdge), jpegBase64: await jpegOf(bitmap) };
    } catch {
      return undefined;
    }
  },
};
